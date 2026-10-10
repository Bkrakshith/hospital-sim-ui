"""rclpy side of the dashboard: subscriptions, publishers, service/action clients.

The node spins in a background thread (MultiThreadedExecutor). Callbacks only store the latest
data in `self.latest` / small buffers; the aiohttp side samples them at fixed rates (see app.py).
Anything that must reach the browser immediately (mode change, logs, camera frames) is handed to
the asyncio loop with `loop.call_soon_threadsafe`.
"""
import json
import math
import threading
import time

import numpy as np
import rclpy
from rclpy.action import ActionClient
from rclpy.callback_groups import ReentrantCallbackGroup
from rclpy.executors import MultiThreadedExecutor
from rclpy.node import Node
from rclpy.parameter import Parameter
from rclpy.qos import (DurabilityPolicy, HistoryPolicy, QoSProfile, ReliabilityPolicy,
                       qos_profile_sensor_data)
from rclpy.time import Time

from geometry_msgs.msg import PoseStamped, PoseWithCovarianceStamped, Twist
from nav_msgs.msg import OccupancyGrid, Odometry, Path
from rcl_interfaces.msg import Log
from sensor_msgs.msg import BatteryState, CompressedImage, LaserScan
from std_msgs.msg import Bool, String
import tf2_ros

try:
    from g1_interfaces.msg import Mode
    from g1_interfaces.srv import SetMode
    HAVE_G1_INTERFACES = True
except ImportError:  # the workspace has not been built yet
    Mode = SetMode = None
    HAVE_G1_INTERFACES = False
try:
    from g1_interfaces.srv import ControlLease
except ImportError:
    ControlLease = None

try:
    from nav2_msgs.action import FollowWaypoints, NavigateToPose
    from nav2_msgs.srv import LoadMap
    HAVE_NAV2 = True
except ImportError:
    HAVE_NAV2 = False

try:
    from unitree_hg.msg import BmsState, LowState
    HAVE_UNITREE_HG = True
except ImportError:
    HAVE_UNITREE_HG = False

try:
    from slam_toolbox.srv import SerializePoseGraph
    HAVE_SLAM_SRV = True
except ImportError:
    HAVE_SLAM_SRV = False

MODE_NAMES = {0: 'DAMP', 1: 'STAND', 2: 'LOCO', 3: 'MANIP', 4: 'NAV', 5: 'AUTO', 6: 'HOLD'}
MODE_IDS = {v: k for k, v in MODE_NAMES.items()}

JOINT_NAMES = [
    'left_hip_pitch', 'left_hip_roll', 'left_hip_yaw', 'left_knee', 'left_ankle_pitch',
    'left_ankle_roll', 'right_hip_pitch', 'right_hip_roll', 'right_hip_yaw', 'right_knee',
    'right_ankle_pitch', 'right_ankle_roll', 'waist_yaw', 'waist_roll', 'waist_pitch',
    'left_shoulder_pitch', 'left_shoulder_roll', 'left_shoulder_yaw', 'left_elbow',
    'left_wrist_roll', 'left_wrist_pitch', 'left_wrist_yaw', 'right_shoulder_pitch',
    'right_shoulder_roll', 'right_shoulder_yaw', 'right_elbow', 'right_wrist_roll',
    'right_wrist_pitch', 'right_wrist_yaw']

LATCHED = QoSProfile(depth=1, reliability=ReliabilityPolicy.RELIABLE,
                     durability=DurabilityPolicy.TRANSIENT_LOCAL, history=HistoryPolicy.KEEP_LAST)
BEST_EFFORT_1 = QoSProfile(depth=1, reliability=ReliabilityPolicy.BEST_EFFORT,
                           history=HistoryPolicy.KEEP_LAST)

# action goal status codes (action_msgs/GoalStatus)
GOAL_STATUS = {0: 'unknown', 1: 'accepted', 2: 'executing', 3: 'canceling', 4: 'succeeded',
               5: 'canceled', 6: 'aborted'}


def yaw_from_quat(q):
    return math.atan2(2.0 * (q.w * q.z + q.x * q.y), 1.0 - 2.0 * (q.y * q.y + q.z * q.z))


def quat_from_yaw(yaw):
    return 0.0, 0.0, math.sin(yaw / 2.0), math.cos(yaw / 2.0)


class RosBridge(Node):
    def __init__(self, opts, emit, log):
        """emit(msg_dict) and log(level, source, text) are thread-safe hooks into the web side."""
        overrides = [Parameter('use_sim_time', value=bool(opts.use_sim_time))]
        super().__init__('g1_dashboard', parameter_overrides=overrides)
        self.opts = opts
        self.emit = emit
        self.log = log
        self.base_frame = opts.base_frame
        self.cb = ReentrantCallbackGroup()
        self.lock = threading.Lock()
        self.seen = {}           # topic -> last receive wall time
        self.latest = {
            'mode': None, 'controller': None, 'tracking': None, 'odom': None, 'scan': None,
            'map': None, 'map_version': 0, 'path': None, 'path_version': 0, 'battery': None,
            'temps': None, 'amcl_pose': None, 'manager': None, 'sim': None, 'lease': None,
        }
        self.estop = {'last': None, 'pressed': False, 'press_t': None, 'test_t': None}
        self.mode_listeners = []     # callables(prev, new) run on the asyncio side via emit hook (app sets)
        self.camera = {'jpeg': None, 'seq': 0, 'stamp': 0.0, 'fps': 0.0, 'format': ''}
        self._cam_times = []
        self.on_camera_frame = None   # set by app: called (from ROS thread) with seq
        self.nav = {'state': 'idle', 'goal': None, 'waypoints': [], 'index': 0, 'feedback': {},
                    'kind': None, 'message': ''}
        self._goal_handle = None
        self._lowstate_n = 0

        self.tf_buffer = tf2_ros.Buffer(cache_time=rclpy.duration.Duration(seconds=10.0))
        self.tf_listener = tf2_ros.TransformListener(self.tf_buffer, self, spin_thread=False)

        # ---------------------------------------------------------------- subscriptions
        sub = self.create_subscription
        sub(OccupancyGrid, '/map', self._on_map, LATCHED, callback_group=self.cb)
        sub(LaserScan, '/scan', self._on_scan, qos_profile_sensor_data, callback_group=self.cb)
        sub(Odometry, '/odom', self._on_odom, qos_profile_sensor_data, callback_group=self.cb)
        sub(Path, '/plan', self._on_path, 10, callback_group=self.cb)
        sub(String, '/g1/controller/status', self._on_controller, 10, callback_group=self.cb)
        sub(String, '/g1/teleop/tracking_status', self._on_tracking, 10, callback_group=self.cb)
        sub(String, '/g1/teleop/manager_status', self._on_manager, 10, callback_group=self.cb)
        sub(String, '/sim/status', self._on_sim, 10, callback_group=self.cb)
        sub(CompressedImage, '/g1/teleop/camera/annotated/compressed', self._on_camera,
            BEST_EFFORT_1, callback_group=self.cb)
        sub(BatteryState, '/battery_state', self._on_battery, 10, callback_group=self.cb)
        sub(PoseWithCovarianceStamped, '/amcl_pose', self._on_amcl, LATCHED, callback_group=self.cb)
        sub(Log, '/rosout', self._on_rosout, QoSProfile(depth=100), callback_group=self.cb)
        if HAVE_G1_INTERFACES:
            sub(Mode, '/g1/mode', self._on_mode, LATCHED, callback_group=self.cb)
        else:
            self.get_logger().warn('g1_interfaces not found: mode display and SetMode disabled')
        sub(String, '/g1/control/lease_state', self._on_lease, LATCHED, callback_group=self.cb)
        sub(Bool, '/g1/estop/heartbeat', self._on_estop, 20, callback_group=self.cb)
        if HAVE_UNITREE_HG:
            sub(LowState, '/lowstate', self._on_lowstate, BEST_EFFORT_1, callback_group=self.cb)
            sub(BmsState, '/lf/bmsstate', self._on_bms, 10, callback_group=self.cb)

        # ---------------------------------------------------------------- publishers
        self.pub_key = self.create_publisher(String, '/g1/teleop/key', 10)
        self.pub_cmd = self.create_publisher(Twist, '/g1/cmd_vel_teleop', 10)
        self.pub_init = self.create_publisher(PoseWithCovarianceStamped, '/initialpose', 10)
        self.pub_key_ui = self.create_publisher(String, '/g1/teleop/key_ui', 50)
        self.pub_hb = self.create_publisher(String, '/g1/ui/heartbeat', 50)
        self.pub_arms_hold = self.create_publisher(String, '/g1/teleop/arms_hold', 10)
        self.pub_hand_override = self.create_publisher(String, '/g1/teleop/hand_override', 10)
        self.pub_light = self.create_publisher(String, '/g1/indicator/light', LATCHED)
        self.pub_say = self.create_publisher(String, '/g1/speech/say', 10)
        self.lease_cli = (self.create_client(ControlLease, '/g1/control/lease', callback_group=self.cb)
                          if ControlLease is not None else None)
        self._hb_seq = 0

        # ---------------------------------------------------------------- clients
        self.set_mode_cli = (self.create_client(SetMode, '/g1/set_mode', callback_group=self.cb)
                             if HAVE_G1_INTERFACES else None)
        if HAVE_NAV2:
            self.nav_to_pose = ActionClient(self, NavigateToPose, '/navigate_to_pose',
                                            callback_group=self.cb)
            self.follow_wps = ActionClient(self, FollowWaypoints, '/follow_waypoints',
                                           callback_group=self.cb)
            self.load_map_cli = self.create_client(LoadMap, '/map_server/load_map',
                                                   callback_group=self.cb)
        self.serialize_cli = (self.create_client(SerializePoseGraph, '/slam_toolbox/serialize_map',
                                                 callback_group=self.cb) if HAVE_SLAM_SRV else None)

        # scrub-nurse mission status / commands / requests + on-demand head camera (Mission page)
        from .mission import MissionLink
        self.mission = MissionLink(self, emit, log, self.cb)

        self._exec = MultiThreadedExecutor(num_threads=4)
        self._exec.add_node(self)
        self._thread = threading.Thread(target=self._spin, daemon=True, name='ros-spin')

    # ======================================================================== lifecycle
    def start(self):
        self._thread.start()

    def _spin(self):
        try:
            self._exec.spin()
        except Exception as e:  # shutdown races
            if rclpy.ok():
                self.log('error', 'bridge', f'executor stopped: {e}')

    def shutdown(self):
        try:
            self._exec.shutdown(timeout_sec=1.0)
        except Exception:
            pass

    def _mark(self, topic):
        self.seen[topic] = time.time()

    # ======================================================================== callbacks
    def _on_map(self, msg):
        self._mark('/map')
        info = msg.info
        q = info.origin.orientation
        with self.lock:
            self.latest['map'] = {
                'frame': msg.header.frame_id or 'map', 'width': info.width, 'height': info.height,
                'resolution': info.resolution,
                'origin': [info.origin.position.x, info.origin.position.y, yaw_from_quat(q)],
                'data': np.asarray(msg.data, dtype=np.int8).reshape(info.height, info.width),
                'stamp': time.time(),
            }
            self.latest['map_version'] += 1

    def _on_scan(self, msg):
        self._mark('/scan')
        self.latest['scan'] = msg

    def _on_odom(self, msg):
        self._mark('/odom')
        self.latest['odom'] = msg

    def _on_path(self, msg):
        self._mark('/plan')
        pts = [(p.pose.position.x, p.pose.position.y) for p in msg.poses]
        if len(pts) > 400:  # decimate long paths
            step = len(pts) / 400.0
            pts = [pts[int(i * step)] for i in range(400)] + [pts[-1]]
        with self.lock:
            self.latest['path'] = {'frame': msg.header.frame_id or 'map', 'pts': pts,
                                   'stamp': time.time()}
            self.latest['path_version'] += 1

    def _on_mode(self, msg):
        self._mark('/g1/mode')
        m = {'mode': int(msg.mode), 'name': MODE_NAMES.get(int(msg.mode), str(msg.mode)),
             'source': msg.source, 'detail': msg.detail, 'stamp': time.time()}
        prev = self.latest['mode']
        self.latest['mode'] = m
        self.emit({'type': 'mode', **m})
        if prev is None or prev['mode'] != m['mode']:
            prev_name = prev['name'] if prev else '-'
            self.log('info', 'mode', f"{prev_name} -> {m['name']} ({m['source']}) {m['detail']}")

    def _on_lease(self, msg):
        self._mark('/g1/control/lease_state')
        try:
            self.latest['lease'] = json.loads(msg.data)
        except ValueError:
            return
        self.emit({'type': '_lease_changed'})

    def _on_estop(self, msg):
        self._mark('/g1/estop/heartbeat')
        now = time.time()
        e = self.estop
        pressed = not bool(msg.data)
        if pressed and not e['pressed']:
            e['press_t'] = now
        if not pressed and e['pressed'] and e['press_t'] is not None:
            e['test_t'] = now           # a full press + release was seen (start-of-day e-stop test)
        e['pressed'], e['last'] = pressed, now

    def _json_status(self, key, topic, msg):
        self._mark(topic)
        try:
            self.latest[key] = json.loads(msg.data)
        except ValueError:
            self.latest[key] = {'raw': msg.data}

    def _on_controller(self, msg):
        self._json_status('controller', '/g1/controller/status', msg)

    def _on_tracking(self, msg):
        self._json_status('tracking', '/g1/teleop/tracking_status', msg)

    def _on_manager(self, msg):
        self._json_status('manager', '/g1/teleop/manager_status', msg)
        m = self.latest['manager']
        if isinstance(m, dict):
            m.pop('tracking', None)  # duplicate of /g1/teleop/tracking_status
            txt = m.get('last_message') or ''
            if txt and txt != getattr(self, '_last_mgr_msg', ''):
                self.log('warn' if 'ignored' in txt or 'reject' in txt else 'info', 'manager', txt)
            self._last_mgr_msg = txt

    def _on_sim(self, msg):
        self._json_status('sim', '/sim/status', msg)

    def _on_camera(self, msg):
        self._mark('camera')
        now = time.time()
        self._cam_times = [t for t in self._cam_times if now - t < 2.0] + [now]
        c = self.camera
        c['jpeg'] = bytes(msg.data)
        c['seq'] += 1
        c['stamp'] = now
        c['fps'] = (len(self._cam_times) - 1) / max(now - self._cam_times[0], 1e-3) \
            if len(self._cam_times) > 1 else 0.0
        c['format'] = msg.format
        if self.on_camera_frame:
            self.on_camera_frame(c['seq'])

    def _on_battery(self, msg):
        self._mark('/battery_state')
        pct = msg.percentage
        if pct is not None and not math.isnan(pct) and pct <= 1.0:
            pct *= 100.0
        self.latest['battery'] = {'soc': None if math.isnan(pct) else round(pct, 1),
                                  'voltage': round(msg.voltage, 2),
                                  'current': None if math.isnan(msg.current) else round(msg.current, 2),
                                  'source': '/battery_state'}

    def _on_bms(self, msg):
        self._mark('/lf/bmsstate')
        self.latest['battery'] = {'soc': int(msg.soc), 'voltage': None, 'current': msg.current / 1000.0,
                                  'source': '/lf/bmsstate'}

    def _on_lowstate(self, msg):
        self._lowstate_n += 1
        self._mark('/lowstate')
        if self._lowstate_n % 250:  # 2 Hz is plenty for temperatures
            return
        temps = [max(int(m.temperature[0]), int(m.temperature[1])) for m in msg.motor_state[:29]]
        if max(temps) <= 0:  # the sim does not model motor temperatures
            self.latest['temps'] = None
            return
        i = int(np.argmax(temps))
        self.latest['temps'] = {'max': temps[i], 'hottest': JOINT_NAMES[i], 'joints': temps,
                                'voltage': round(float(msg.motor_state[0].vol), 1)}

    def _on_amcl(self, msg):
        self._mark('/amcl_pose')
        p = msg.pose.pose
        cov = msg.pose.covariance
        self.latest['amcl_pose'] = {'x': p.position.x, 'y': p.position.y,
                                    'yaw': yaw_from_quat(p.orientation),
                                    'std_xy': math.sqrt(max(cov[0], cov[7], 0.0))}

    def _on_rosout(self, msg):
        if msg.name == self.get_name():
            return
        level = {10: 'debug', 20: 'info', 30: 'warn', 40: 'error', 50: 'error'}.get(msg.level, 'info')
        if level == 'debug':
            return
        self.log(level, msg.name, msg.msg)

    # ======================================================================== sampling helpers
    def lookup_xy_yaw(self, target, source):
        try:
            t = self.tf_buffer.lookup_transform(target, source, Time())
        except Exception:
            return None
        tr = t.transform.translation
        return tr.x, tr.y, yaw_from_quat(t.transform.rotation)

    def gt_map_pose(self):
        """Sim only: pelvis from /sim/ground_truth (world frame = map frame of hospital_gt), when no map TF exists
        (e.g. mission.launch.py fixed_base:=true runs no AMCL). None if not fresh."""
        m = self.mission
        if m.pelvis is None or time.time() - m.pelvis_t > 2.0:
            return None
        T = m.pelvis
        return float(T[0, 3]), float(T[1, 3]), math.atan2(T[1, 0], T[0, 0])

    def robot_pose(self):
        """Pose of the base frame in map (preferred; sim ground truth if there is no map TF) or odom; None if
        nothing is known."""
        p = self.lookup_xy_yaw('map', self.base_frame)
        if p is None:
            g = self.gt_map_pose()
            if g is not None:
                out = {'frame': 'map', 'x': g[0], 'y': g[1], 'yaw': g[2], 'source': 'sim_ground_truth'}
                o = self.latest['odom']
                if o is not None:
                    tw = o.twist.twist
                    out.update(vx=tw.linear.x, vy=tw.linear.y, wz=tw.angular.z)
                return out
        for frame in ('map', 'odom'):
            p = self.lookup_xy_yaw(frame, self.base_frame)
            if p is not None:
                out = {'frame': frame, 'x': p[0], 'y': p[1], 'yaw': p[2]}
                o = self.latest['odom']
                if o is not None:
                    tw = o.twist.twist
                    out.update(vx=tw.linear.x, vy=tw.linear.y, wz=tw.angular.z)
                return out
        # no TF at all: fall back to raw odometry
        o = self.latest['odom']
        if o is not None:
            p = o.pose.pose
            tw = o.twist.twist
            return {'frame': 'odom', 'x': p.position.x, 'y': p.position.y,
                    'yaw': yaw_from_quat(p.orientation), 'vx': tw.linear.x, 'vy': tw.linear.y,
                    'wz': tw.angular.z, 'tf': False}
        return None

    def scan_points(self, frame, max_points=540):
        """Latest /scan as a flat [x0, y0, x1, y1, ...] list in `frame` (cm precision)."""
        s = self.latest['scan']
        if s is None:
            return None
        tf = self.lookup_xy_yaw(frame, s.header.frame_id)
        if tf is None and frame == 'map':
            g, b = self.gt_map_pose(), self.lookup_xy_yaw(self.base_frame, s.header.frame_id)
            if g is not None and b is not None:        # map (ground truth) o pelvis -> laser
                c, sn = math.cos(g[2]), math.sin(g[2])
                tf = (g[0] + c * b[0] - sn * b[1], g[1] + sn * b[0] + c * b[1], g[2] + b[2])
        if tf is None:
            return None
        r = np.asarray(s.ranges, dtype=np.float32)
        a = s.angle_min + np.arange(len(r), dtype=np.float32) * s.angle_increment
        ok = np.isfinite(r) & (r > max(s.range_min, 0.05)) & (r < s.range_max)
        r, a = r[ok], a[ok]
        if len(r) > max_points:
            idx = np.linspace(0, len(r) - 1, max_points).astype(int)
            r, a = r[idx], a[idx]
        x0, y0, th = tf
        xs = x0 + r * np.cos(a + th)
        ys = y0 + r * np.sin(a + th)
        return np.round(np.stack([xs, ys], axis=1).ravel(), 2).tolist()

    def proximity(self, front_deg=30.0, side_deg=110.0):
        """Nearest obstacle per sector {left, front, right} in m from the latest /scan (scan frame, x forward,
        z up); null = no return in range. The robot's own body is ignored by the scan's range_min."""
        s = self.latest['scan']
        if s is None:
            return None
        r = np.asarray(s.ranges, dtype=np.float32)
        a = s.angle_min + np.arange(len(r), dtype=np.float32) * s.angle_increment
        a = (a + np.pi) % (2 * np.pi) - np.pi
        ok = np.isfinite(r) & (r > max(s.range_min, 0.05)) & (r < s.range_max)
        fd, sd = math.radians(front_deg), math.radians(side_deg)
        sectors = {'left': (a > fd) & (a <= sd), 'front': np.abs(a) <= fd, 'right': (a < -fd) & (a >= -sd)}
        out = {}
        for k, m in sectors.items():
            v = r[ok & m]
            out[k] = round(float(v.min()), 2) if len(v) else None
        age = time.time() - self.seen.get('/scan', 0)
        return {'sectors': [out['left'], out['front'], out['right']], 'named': out,
                'order': ['left', 'front', 'right'], 'source': '/scan', 'age': round(age, 2),
                'frame': s.header.frame_id, 'front_deg': front_deg, 'side_deg': side_deg}

    def topic_health(self):
        now = time.time()
        return {k: round(now - v, 2) for k, v in self.seen.items()}

    def graph_nodes(self):
        try:
            return set(n for n, _ns in self.get_node_names_and_namespaces())
        except Exception:
            return set()

    # ======================================================================== commands
    def publish_key(self, key):
        self.pub_key.publish(String(data=key))

    def publish_key_ui(self, key, holder):
        self.pub_key_ui.publish(String(data=json.dumps({'key': key, 'holder': holder})))

    def publish_arms_hold(self, on, holder):
        self.pub_arms_hold.publish(String(data=json.dumps({'on': bool(on), 'holder': holder})))

    def publish_hand_override(self, side, close, holder):
        self.pub_hand_override.publish(String(data=json.dumps({'side': side, 'close': float(close),
                                                                'holder': holder})))

    def publish_heartbeat(self, holder):
        self._hb_seq += 1
        self.pub_hb.publish(String(data=json.dumps({'holder': holder, 'seq': self._hb_seq})))

    def publish_light(self, d):
        self.pub_light.publish(String(data=json.dumps(d)))

    def say(self, text):
        self.pub_say.publish(String(data=text))

    def call_lease(self, op, holder='', role='', display='', reason=''):
        if self.lease_cli is None:
            raise RuntimeError('g1_interfaces has no ControlLease: rebuild the workspace')
        if not self.lease_cli.service_is_ready():
            raise RuntimeError('/g1/control/lease is not available (is g1_teleop_manager running?)')
        req = ControlLease.Request()
        req.op, req.holder, req.role, req.display, req.reason = op, holder, role, display, reason
        return self.lease_cli.call_async(req)

    def publish_cmd_vel(self, vx, vy, wz):
        t = Twist()
        t.linear.x, t.linear.y, t.angular.z = float(vx), float(vy), float(wz)
        self.pub_cmd.publish(t)

    def publish_initial_pose(self, x, y, yaw, frame='map'):
        m = PoseWithCovarianceStamped()
        m.header.frame_id = frame
        m.header.stamp = self.get_clock().now().to_msg()
        m.pose.pose.position.x, m.pose.pose.position.y = float(x), float(y)
        q = quat_from_yaw(float(yaw))
        o = m.pose.pose.orientation
        o.x, o.y, o.z, o.w = q
        cov = [0.0] * 36
        cov[0] = cov[7] = 0.25 ** 2
        cov[35] = (math.pi / 12) ** 2
        m.pose.covariance = cov
        self.pub_init.publish(m)

    def call_set_mode(self, mode, source='ui'):
        """Returns an rclpy Future, or raises if the service is unavailable."""
        if not HAVE_G1_INTERFACES:
            raise RuntimeError('g1_interfaces is not built: cannot call /g1/set_mode')
        if not self.set_mode_cli.service_is_ready():
            raise RuntimeError('/g1/set_mode is not available (is g1_teleop_manager running?)')
        req = SetMode.Request()
        req.mode = int(mode)
        req.source = source
        return self.set_mode_cli.call_async(req)

    def _pose_stamped(self, x, y, yaw, frame='map'):
        p = PoseStamped()
        p.header.frame_id = frame
        p.header.stamp = self.get_clock().now().to_msg()
        p.pose.position.x, p.pose.position.y = float(x), float(y)
        q = quat_from_yaw(float(yaw))
        o = p.pose.orientation
        o.x, o.y, o.z, o.w = q
        return p

    def nav_available(self):
        return HAVE_NAV2 and self.nav_to_pose.server_is_ready()

    def send_nav_goal(self, x, y, yaw):
        """Returns a Future of the goal handle."""
        goal = NavigateToPose.Goal()
        goal.pose = self._pose_stamped(x, y, yaw)
        self.nav.update(state='sending', goal={'x': x, 'y': y, 'yaw': yaw}, kind='goal',
                        feedback={}, message='')
        fut = self.nav_to_pose.send_goal_async(goal, feedback_callback=self._on_nav_feedback)
        fut.add_done_callback(self._on_goal_response)
        return fut

    def send_waypoints(self, poses, start_index=0):
        goal = FollowWaypoints.Goal()
        goal.poses = [self._pose_stamped(p['x'], p['y'], p.get('yaw', 0.0))
                      for p in poses[start_index:]]
        self.nav.update(state='sending', kind='waypoints', waypoints=list(poses),
                        index=start_index, offset=start_index, goal=None, feedback={}, message='')
        fut = self.follow_wps.send_goal_async(goal, feedback_callback=self._on_wp_feedback)
        fut.add_done_callback(self._on_goal_response)
        return fut

    def _on_goal_response(self, fut):
        try:
            gh = fut.result()
        except Exception as e:
            self.nav.update(state='failed', message=str(e))
            return
        if not gh.accepted:
            self.nav.update(state='rejected', message='goal rejected by Nav2')
            self.log('warn', 'nav', 'goal rejected by Nav2')
            return
        self._goal_handle = gh
        self.nav['state'] = 'active'
        gh.get_result_async().add_done_callback(lambda f, gh=gh: self._on_result(gh, f))

    def _on_nav_feedback(self, fb):
        f = fb.feedback
        self.nav['feedback'] = {
            'distance_remaining': round(f.distance_remaining, 2),
            'eta': round(f.estimated_time_remaining.sec + f.estimated_time_remaining.nanosec * 1e-9, 1),
            'recoveries': int(f.number_of_recoveries),
            'elapsed': round(f.navigation_time.sec + f.navigation_time.nanosec * 1e-9, 1),
        }

    def _on_wp_feedback(self, fb):
        self.nav['index'] = self.nav.get('offset', 0) + int(fb.feedback.current_waypoint)

    def _on_result(self, gh, fut):
        if gh is not self._goal_handle:
            return
        try:
            res = fut.result()
            status = GOAL_STATUS.get(res.status, str(res.status))
        except Exception as e:
            status = 'failed'
            self.nav['message'] = str(e)
            res = None
        if self.nav['state'] == 'paused':
            return
        if self.nav['kind'] == 'waypoints' and res is not None and status == 'succeeded':
            missed = list(getattr(res.result, 'missed_waypoints', []))
            if missed:
                self.nav['message'] = f'missed waypoints: {missed}'
            self.nav['index'] = len(self.nav['waypoints'])
        self.nav['state'] = status
        self._goal_handle = None
        lvl = 'info' if status == 'succeeded' else 'warn'
        self.log(lvl, 'nav', f"navigation {self.nav['kind']} {status} {self.nav.get('message', '')}")
        self.emit({'type': 'toast', 'level': 'success' if status == 'succeeded' else 'warn',
                   'msg': f"Navigation {status}"})

    def cancel_nav(self, pause=False):
        gh = self._goal_handle
        self.nav['state'] = 'paused' if pause else 'canceling'
        if gh is None:
            if not pause:
                self.nav['state'] = 'idle'
            return None
        fut = gh.cancel_goal_async()

        def done(_f):
            if not pause:
                self.nav['state'] = 'canceled'
            self._goal_handle = None
        fut.add_done_callback(done)
        return fut

    def load_map_service(self, yaml_path):
        if not (HAVE_NAV2 and self.load_map_cli.service_is_ready()):
            return None
        req = LoadMap.Request()
        req.map_url = yaml_path
        return self.load_map_cli.call_async(req)

    def serialize_posegraph(self, base_path):
        if not (self.serialize_cli and self.serialize_cli.service_is_ready()):
            return None
        req = SerializePoseGraph.Request()
        req.filename = base_path
        return self.serialize_cli.call_async(req)
