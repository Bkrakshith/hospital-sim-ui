#!/usr/bin/env python3
"""Mock G1 for developing / demoing the dashboard without the MuJoCo sim.

Publishes the contract topics a running sim + controller + camera teleop would publish, so the
dashboard AND the real slam_toolbox / Nav2 stacks can run against it:

  /clock (wall time), /odom + TF odom->pelvis, static TF pelvis->mid360_link, /scan (ray-cast in
  a 2-D hospital world), /g1/controller/status, /g1/teleop/tracking_status,
  /g1/teleop/camera/annotated/compressed (synthetic JPEG), /battery_state

and, unless --no-manager, runs the REAL g1_teleop_manager (ManagerNode, in this process), so the mode FSM incl.
HOLD, the control lease, the UI heartbeat watchdog, the e-stop interlock and the speed zones behave exactly as on
the robot (docs/interfaces.md 3.2-3.5). The mock body follows the manager's /g1/cmd_vel.
Robot stubs (g1_mujoco_sim.stubs, as in the sim): /g1/estop/heartbeat at 10 Hz (/sim/estop presses it,
/sim/estop_link kills it), /g1/indicator/light and /g1/speech/say are logged.

World: rasterised from g1-mujoco-sim/hospital_g1.xml (the MuJoCo sim's hospital; same frame and spawn as
the sim), or the approximate hospital-sim-env/isaac/scene/layout.py walls with --layout. The robot is a 0.25 m disc that stops
at walls; the scan is a 2-D ray cast at the obstacle band (0.08..1.8 m).
"""
import argparse
import io
import json
import math
import os
import sys
import threading
import time

import numpy as np
import rclpy
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy, qos_profile_sensor_data

from builtin_interfaces.msg import Time as TimeMsg
from geometry_msgs.msg import TransformStamped, Twist
from nav_msgs.msg import Odometry
from rosgraph_msgs.msg import Clock
from sensor_msgs.msg import BatteryState, CompressedImage, LaserScan
from std_msgs.msg import String
from tf2_ros import StaticTransformBroadcaster, TransformBroadcaster

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ.get('HG1_ROOT') or os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, 'ros2_ws', 'src', 'hospital-sim-ros2', 'g1_navigation', 'scripts'))
import rasterize_world  # noqa: E402

try:
    from g1_interfaces.msg import Mode
    from g1_interfaces.srv import SetMode
except ImportError:
    Mode = SetMode = None

DAMP, STAND, LOCO, MANIP, NAV, AUTO, HOLD = range(7)
NAMES = ['DAMP', 'STAND', 'LOCO', 'MANIP', 'NAV', 'AUTO', 'HOLD']
LIM = {'vx': (-0.5, 0.8), 'vy': (-0.4, 0.4), 'wz': (-1.0, 1.0)}
LATCHED = QoSProfile(depth=1, reliability=ReliabilityPolicy.RELIABLE,
                     durability=DurabilityPolicy.TRANSIENT_LOCAL)


def stamp(t):
    m = TimeMsg()
    m.sec = int(t)
    m.nanosec = int((t - int(t)) * 1e9)
    return m


class MockRobot(Node):
    def __init__(self, a):
        super().__init__('mock_g1')
        self.a = a
        grid = rasterize_world.rasterize_mjcf(a.mjcf) if a.mjcf else rasterize_world.rasterize_layout()
        self.world = grid
        self.world_src = os.path.basename(a.mjcf) if a.mjcf else 'layout approx'
        self.occ = grid.occ
        # robot state in the world frame; odom frame = pose at start
        self.x, self.y, self.th = a.start
        self.odom0 = (self.x, self.y, self.th)
        self.v = np.zeros(3)             # body-frame (vx, vy, wz) actually executed
        self.lock = threading.Lock()
        # emulated manager
        self.mode, self.mode_src, self.mode_detail = DAMP, 'startup', 'mock manager'
        self.key_cmd = np.zeros(3)
        self.key_t = 0.0
        self.tele_cmd = np.zeros(3)
        self.tele_t = 0.0
        self.nav_cmd = np.zeros(3)
        self.nav_t = 0.0
        self.blend_until = 0.0
        self.t0 = time.time()
        self.battery = 0.92
        self.calibrated = False
        self.framing_on = True
        self.last_key = ''
        self.last_msg = ''
        self.cmd_out = np.zeros(3)

        self.tfb = TransformBroadcaster(self)
        self.static_tfb = StaticTransformBroadcaster(self)
        self._send_static()
        self.pub_clock = self.create_publisher(Clock, '/clock', 10) if a.clock else None
        self.pub_odom = self.create_publisher(Odometry, '/odom', 10)
        self.pub_scan = self.create_publisher(LaserScan, '/scan', qos_profile_sensor_data)
        self.pub_ctrl = self.create_publisher(String, '/g1/controller/status', 10)
        self.pub_track = self.create_publisher(String, '/g1/teleop/tracking_status', 10)
        self.pub_cam = self.create_publisher(CompressedImage, '/g1/teleop/camera/annotated/compressed',
                                             qos_profile_sensor_data)
        self.pub_batt = self.create_publisher(BatteryState, '/battery_state', 10)
        self.pub_mgr = None

        # camera teleop node keys (c f h u) are emulated here; everything else is the real manager's job
        self.create_subscription(String, '/g1/teleop/key', self._on_key, 10)
        # the body follows the arbiter output (the real manager, in-process unless --no-manager)
        self.create_subscription(Twist, '/g1/cmd_vel', self._on_arbiter, 10)
        if Mode is not None:
            self.create_subscription(Mode, '/g1/mode', self._on_real_mode, LATCHED)
        self.stubs = None
        if not a.no_estop:
            from g1_mujoco_sim.stubs import RobotStubs
            self.stubs = RobotStubs(self)

        self.dt = 0.02
        self.create_timer(self.dt, self._step)
        self.create_timer(0.1, self._publish_scan)
        self.create_timer(0.5, self._publish_status)
        if not a.no_camera:
            self.create_timer(1.0 / a.camera_fps, self._publish_camera)
        if self.pub_clock:
            self.create_timer(0.01, self._publish_clock)
        self._font = None
        self.get_logger().info(f'mock G1 up: world={self.world_src} ({grid.w}x{grid.h}), '
                               f'start={a.start}, manager={"external" if a.no_manager else "real (in-process)"}, '
                               f'e-stop stub={"off" if a.no_estop else "on"}')

    # ------------------------------------------------------------------ camera teleop node keys
    def _on_key(self, msg):
        k = msg.data.strip().lower() or 'space'
        self.last_key = k
        # keys of the camera teleop node (g1-webcam-teleop/xr_teleoperate webcam)
        if k == 'c':
            self.calibrated = True
            return
        if k == 'u':
            self.calibrated = False
            return
        if k == 'f':
            self.framing_on = not self.framing_on
            return
        if k == 'h':
            return

    def _on_tele(self, msg):
        with self.lock:
            self.tele_cmd[:] = (msg.linear.x, msg.linear.y, msg.angular.z)
            self.tele_t = time.time()

    def _on_nav(self, msg):
        with self.lock:
            self.nav_cmd[:] = (msg.linear.x, msg.linear.y, msg.angular.z)
            self.nav_t = time.time()

    def _on_arbiter(self, msg):  # --no-manager: follow the real manager's output
        with self.lock:
            self.tele_cmd[:] = (msg.linear.x, msg.linear.y, msg.angular.z)
            self.tele_t = time.time()

    def _on_real_mode(self, msg):
        self.mode = int(msg.mode)

    def _command(self, now):
        return self.tele_cmd.copy() if now - self.tele_t < 0.5 else np.zeros(3)

    # ------------------------------------------------------------------ physics
    def _free(self, x, y, r=0.25):
        g = self.world
        i = int((x - g.x0) / g.res)
        j = int((y - g.y0) / g.res)
        k = int(math.ceil(r / g.res))
        if i - k < 0 or j - k < 0 or i + k >= g.w or j + k >= g.h:
            return False
        patch = self.occ[j - k:j + k + 1, i - k:i + k + 1]
        yy, xx = np.mgrid[-k:k + 1, -k:k + 1]
        return not np.any(patch & ((xx * xx + yy * yy) * g.res * g.res <= r * r))

    def _step(self):
        now = time.time()
        with self.lock:
            cmd = self._command(now)
            cmd[0] = np.clip(cmd[0], *LIM['vx'])
            cmd[1] = np.clip(cmd[1], *LIM['vy'])
            cmd[2] = np.clip(cmd[2], *LIM['wz'])
            alpha = self.dt / 0.3                         # first-order lag ~ the policy's tracking
            self.v += alpha * (cmd - self.v)
            c, s = math.cos(self.th), math.sin(self.th)
            nx = self.x + (c * self.v[0] - s * self.v[1]) * self.dt
            ny = self.y + (s * self.v[0] + c * self.v[1]) * self.dt
            if self._free(nx, ny):
                self.x, self.y = nx, ny
            else:
                self.v[:2] = 0
            self.th = (self.th + self.v[2] * self.dt + math.pi) % (2 * math.pi) - math.pi
            self.cmd_out = cmd
        self._publish_odom(now)

    def _odom_pose(self):
        x0, y0, t0 = self.odom0
        dx, dy = self.x - x0, self.y - y0
        c, s = math.cos(-t0), math.sin(-t0)
        return c * dx - s * dy, s * dx + c * dy, self.th - t0

    def _publish_odom(self, now):
        ox, oy, oth = self._odom_pose()
        # a walking humanoid sways; add a small periodic lateral / yaw oscillation to the pose
        sway = 0.01 * math.sin(now * 2 * math.pi * 1.6) * min(1.0, abs(self.v[0]) * 3)
        q = (0.0, 0.0, math.sin(oth / 2), math.cos(oth / 2))
        t = TransformStamped()
        t.header.stamp = stamp(now)
        t.header.frame_id = 'odom'
        t.child_frame_id = 'pelvis'
        t.transform.translation.x = ox - math.sin(oth) * sway
        t.transform.translation.y = oy + math.cos(oth) * sway
        t.transform.translation.z = 0.79
        t.transform.rotation.x, t.transform.rotation.y, t.transform.rotation.z, t.transform.rotation.w = q
        self.tfb.sendTransform(t)
        o = Odometry()
        o.header = t.header
        o.child_frame_id = 'pelvis'
        o.pose.pose.position.x = t.transform.translation.x
        o.pose.pose.position.y = t.transform.translation.y
        o.pose.pose.position.z = 0.79
        o.pose.pose.orientation = t.transform.rotation
        o.twist.twist.linear.x, o.twist.twist.linear.y, o.twist.twist.angular.z = map(float, self.v)
        self.pub_odom.publish(o)

    def _send_static(self):
        t = TransformStamped()
        t.header.stamp = stamp(time.time())
        t.header.frame_id = 'pelvis'
        t.child_frame_id = 'mid360_link'
        t.transform.translation.x = 0.05
        t.transform.translation.z = 0.45
        t.transform.rotation.w = 1.0
        self.static_tfb.sendTransform(t)

    # ------------------------------------------------------------------ sensors
    def _publish_scan(self):
        n = 720
        rmax, rmin = 15.0, 0.1
        g = self.world
        ang = -math.pi + np.arange(n) * (2 * math.pi / n)
        sx = self.x + 0.05 * math.cos(self.th)
        sy = self.y + 0.05 * math.sin(self.th)
        dirs = ang + self.th
        steps = np.arange(rmin, rmax, g.res * 0.5)
        px = sx + np.outer(np.cos(dirs), steps)
        py = sy + np.outer(np.sin(dirs), steps)
        ii = ((px - g.x0) / g.res).astype(np.int32)
        jj = ((py - g.y0) / g.res).astype(np.int32)
        inside = (ii >= 0) & (jj >= 0) & (ii < g.w) & (jj < g.h)
        hit = np.zeros_like(inside)
        hit[inside] = self.occ[jj[inside], ii[inside]]
        first = np.where(hit.any(axis=1), hit.argmax(axis=1), -1)
        r = np.where(first >= 0, steps[np.clip(first, 0, None)], np.inf)
        r = np.where(np.isfinite(r), r + np.random.normal(0, 0.01, n), r)
        m = LaserScan()
        m.header.stamp = stamp(time.time())
        m.header.frame_id = 'mid360_link'
        m.angle_min, m.angle_max = -math.pi, math.pi - 2 * math.pi / n
        m.angle_increment = 2 * math.pi / n
        m.scan_time, m.time_increment = 0.1, 0.0
        m.range_min, m.range_max = rmin, rmax
        m.ranges = r.astype(np.float32).tolist()
        self.pub_scan.publish(m)

    def _hands(self, now):
        """Scripted hand visibility: right hand drops out for 2 s every 10 s."""
        phase = (now - self.t0) % 10.0
        return [True, not (6.0 < phase < 8.0)]

    def _publish_status(self):
        now = time.time()
        hands = self._hands(now)
        ctrl = {'policy': 'mock_policy', 'placeholder': True, 'fall_detected': False,
                'loop_hz': 50.0, 'mode': NAMES[self.mode], 'mock': True,
                'cmd_vel': [round(float(v), 2) for v in self.v]}
        self.pub_ctrl.publish(String(data=json.dumps(ctrl)))
        framing = ('tracking' if all(hands) else 'searching') if self.framing_on else 'off'
        t = now - self.t0
        conf = {s: {'arm': 0.9 if v else 0.1, 'hand': round(0.85 + 0.1 * math.sin(t + i), 2) if v else 0.0,
                    'arm_state': 'tracked' if v else 'lost', 'hand_state': 'tracked' if v else 'lost'}
                for i, (s, v) in enumerate(zip(('left', 'right'), hands))}
        track = {'hands_visible': hands, 'arms_visible': hands, 'fps': float(self.a.camera_fps),
                 'framing': framing if not self.a.no_camera else 'off',
                 'framing_detail': 'following both hands' if framing == 'tracking' else 'widening to find hands' if framing == 'searching' else 'disabled',
                 'calibrated': self.calibrated, 'latency_ms': round(62 + 8 * math.sin(t), 1), 'confidence': conf,
                 'ptz': {'yaw_right_deg': round(6 * math.sin(t * 0.3), 1), 'pitch_up_deg': -4.0, 'zoom': 110},
                 'message': 'mock tracker' + ('' if self.calibrated else ' (not calibrated: hold neutral pose, press c)')}
        self.pub_track.publish(String(data=json.dumps(track)))
        self.battery = max(0.05, self.battery - 0.00005)
        b = BatteryState()
        b.header.stamp = stamp(now)
        b.voltage = 44.0 + 6.4 * self.battery
        b.current = -3.2 if self.mode != DAMP else -0.8
        b.percentage = self.battery
        b.present = True
        self.pub_batt.publish(b)

    def _publish_clock(self):
        c = Clock()
        c.clock = stamp(time.time())
        self.pub_clock.publish(c)

    def _publish_camera(self):
        from PIL import Image, ImageDraw
        now = time.time()
        W, H = 960, 540
        img = Image.new('RGB', (W, H), (28, 32, 40))
        d = ImageDraw.Draw(img)
        # a simple "room": floor gradient and a table edge
        y0 = int(H * 0.55)
        for yy in range(y0, H, 8):
            c = 40 + (yy - y0) // 6
            d.rectangle([0, yy, W, yy + 8], fill=(c, c + 4, c + 10))
        d.rectangle([int(W * 0.1), int(H * 0.67), int(W * 0.9), int(H * 0.73)], fill=(120, 110, 100))
        hands = self._hands(now)
        t = now - self.t0
        for side, visible in ((0, hands[0]), (1, hands[1])):
            if not visible:
                continue
            cx = W * (0.32 if side == 0 else 0.68) + W * 0.06 * math.sin(t * 1.3 + side)
            cy = H * 0.45 + H * 0.07 * math.cos(t * 0.9 + side * 2)
            col = (80, 200, 255) if side == 0 else (255, 170, 60)
            # shoulder -> elbow -> wrist
            sx_ = W * (0.35 if side == 0 else 0.65)
            pts = [(sx_, 30), ((sx_ + cx) / 2 + (-45 if side == 0 else 45), (30 + cy) / 2), (cx, cy)]
            d.line(pts, fill=col, width=6)
            for p in pts:
                d.ellipse([p[0] - 7, p[1] - 7, p[0] + 7, p[1] + 7], fill=col)
            for f in range(5):  # fingers
                a = -math.pi / 2 + (f - 2) * 0.35 + (0.4 if side else -0.4)
                curl = 0.5 + 0.5 * math.sin(t * 2 + f)
                L = 46 - 18 * curl
                fx, fy = cx + L * math.cos(a), cy + L * math.sin(a)
                d.line([(cx, cy), (fx, fy)], fill=col, width=3)
                d.ellipse([fx - 4, fy - 4, fx + 4, fy + 4], fill=(255, 255, 255))
        d.rectangle([0, H - 24, W, H], fill=(0, 0, 0))
        d.text((8, H - 18), f'MOCK CAMERA  {time.strftime("%H:%M:%S")}  mode={NAMES[self.mode]}  '
               f'L={"ok" if hands[0] else "--"} R={"ok" if hands[1] else "--"}  '
               f'{"calibrated" if self.calibrated else "NOT calibrated"}  framing={"on" if self.framing_on else "off"}',
               fill=(230, 230, 230))
        buf = io.BytesIO()
        img.save(buf, format='JPEG', quality=70)
        m = CompressedImage()
        m.header.stamp = stamp(now)
        m.header.frame_id = 'obsbot'
        m.format = 'jpeg'
        m.data = buf.getvalue()
        self.pub_cam.publish(m)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sim_world = os.path.join(ROOT, 'g1-mujoco-sim', 'hospital_g1.xml')
    ap.add_argument('--mjcf', default=sim_world if os.path.isfile(sim_world) else None,
                    help='MuJoCo world to rasterise (default: the sim hospital, g1-mujoco-sim/hospital_g1.xml)')
    ap.add_argument('--layout', action='store_true',
                    help='use the approximate hospital-sim-env/isaac/scene/layout.py walls instead of the MuJoCo world')
    ap.add_argument('--start', type=float, nargs=3, default=None, metavar=('X', 'Y', 'YAW'),
                    help='start pose in the world frame (default: the sim spawn corridor_west, facing east)')
    ap.add_argument('--no-manager', action='store_true',
                    help='do not start g1_teleop_manager in-process (use when one is already running)')
    ap.add_argument('--no-estop', action='store_true',
                    help='no simulated hardware e-stop heartbeat (motion stays locked, as on a robot without one)')
    ap.add_argument('--dev-ignore-estop', action='store_true',
                    help='DEV ONLY: in-process manager with DEV_ONLY_ignore_estop_heartbeat:=true')
    ap.add_argument('--no-camera', action='store_true')
    ap.add_argument('--camera-fps', type=float, default=14.0)
    ap.add_argument('--no-clock', dest='clock', action='store_false', help='do not publish /clock')
    argv = sys.argv[1:]
    if '--ros-args' in argv:
        argv = argv[:argv.index('--ros-args')]
    a = ap.parse_args(argv)
    if a.layout:
        a.mjcf = None
    if a.start is None:
        # same spawn as g1_bringup sim.launch.py (corridor_west, world frame); wing-local (1, -8) for --layout
        a.start = [8.93, -12.45, 0.0] if a.mjcf else [1.0, -8.0, 0.0]
    rclpy.init()
    node = MockRobot(a)
    ex = rclpy.executors.MultiThreadedExecutor(num_threads=3)
    ex.add_node(node)
    mgr = None
    if not a.no_manager:
        from rclpy.parameter import Parameter
        from g1_teleop_manager.manager_node import ManagerNode
        mgr = ManagerNode(parameter_overrides=[
            Parameter('DEV_ONLY_ignore_estop_heartbeat', value=bool(a.dev_ignore_estop))])
        ex.add_node(mgr)
    try:
        ex.spin()
    except (KeyboardInterrupt, rclpy.executors.ExternalShutdownException):
        pass
    finally:
        if mgr is not None:
            mgr.destroy_node()
        node.destroy_node()
        rclpy.try_shutdown()


if __name__ == '__main__':
    main()
