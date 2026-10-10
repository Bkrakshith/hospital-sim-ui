"""Mission page support for the dashboard bridge (ROS side): scrub-nurse mission status / commands / instrument
requests (docs/interfaces.md 6) and the on-demand head-camera MJPEG with the target instrument highlighted.

Head camera: /g1/head_camera/image_raw is subscribed only while a browser shows the stream (the sim renders only
while someone subscribes), throttled to `max_fps`, JPEG-encoded with an overlay:
  * target instrument (the mission's current instrument) projected from ground truth (/sim/objects + pelvis ground
    truth + TF pelvis -> d435_color_optical_frame) = a thick amber line tip -> handle, labelled "(GT)"; the other
    instruments thin grey. Ground truth is a sim-only cheat, labelled as such on the image.
  * perception detections (/g1/perception/detections, bbox_obb in pixels) as green rotated boxes, when published.
"""
import json
import math
import threading
import time

import numpy as np
from sensor_msgs.msg import CameraInfo, Image
from nav_msgs.msg import Odometry
from std_msgs.msg import String

try:
    from g1_interfaces.srv import RequestInstrument
    HAVE_REQUEST = True
except ImportError:
    RequestInstrument = None
    HAVE_REQUEST = False

OPTICAL = 'd435_color_optical_frame'


def _qmat(w, x, y, z):
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


class MissionLink:
    def __init__(self, node, emit, log, cb, max_fps=10.0):
        self.node, self.emit, self.log, self.cb = node, emit, log, cb
        self.status = None
        self.status_t = 0.0
        self.objects = {}
        self.detections = []
        self.det_t = 0.0
        self.pelvis = None
        self.pelvis_t = 0.0
        self.K = None
        self.max_fps = max_fps
        self.head = {'jpeg': None, 'seq': 0, 'stamp': 0.0, 'fps': 0.0, 'viewers': 0, 'subscribed': False,
                     'size': None}
        self._times = []
        self._last_frame = 0.0
        self._img_sub = None
        self._last_viewer = 0.0
        self._lock = threading.Lock()
        self.on_frame = None          # app hook (thread-safe notify)
        sub = node.create_subscription
        sub(String, '/g1/mission/status', self._on_status, 10, callback_group=cb)
        sub(String, '/sim/objects', self._on_objects, 5, callback_group=cb)
        sub(String, '/g1/perception/detections', self._on_dets, 5, callback_group=cb)
        sub(Odometry, '/sim/ground_truth', self._on_gt, 5, callback_group=cb)
        sub(CameraInfo, '/g1/head_camera/camera_info', self._on_info, 2, callback_group=cb)
        self.pub_cmd = node.create_publisher(String, '/g1/mission/command', 10)
        self.req_cli = node.create_client(RequestInstrument, '/g1/mission/request_instrument',
                                          callback_group=cb) if HAVE_REQUEST else None
        node.create_timer(1.0, self._sub_housekeeping, callback_group=cb)

    # ------------------------------------------------------------------ mission
    def _on_status(self, msg):
        try:
            st = json.loads(msg.data)
        except ValueError:
            return
        prev = self.status
        self.status, self.status_t = st, time.time()
        self.emit({'type': 'mission', **st})
        if prev is None or prev.get('state') != st.get('state'):
            lvl = {'failed': 'error', 'aborted': 'warn'}.get(st.get('state'), 'info')
            self.log(lvl, 'mission', f"{st.get('state')}: {st.get('message', '')}")

    def command(self, cmd):
        self.pub_cmd.publish(String(data=cmd))

    def request_available(self):
        return bool(self.req_cli and self.req_cli.service_is_ready())

    def request(self, instrument, requester='ui'):
        if not self.request_available():
            raise RuntimeError('/g1/mission/request_instrument not available (is g1_mission running?)')
        req = RequestInstrument.Request()
        req.instrument, req.requester = instrument, requester
        return self.req_cli.call_async(req)

    def info(self):
        return {'status_age': round(time.time() - self.status_t, 1) if self.status_t else None,
                'request_service': self.request_available(),
                'head_camera': {'fps': round(self.head['fps'], 1), 'viewers': self.head['viewers'],
                                'age': round(time.time() - self.head['stamp'], 2) if self.head['stamp'] else None,
                                'subscribed': self.head['subscribed'], 'size': self.head['size']},
                'detections_age': round(time.time() - self.det_t, 1) if self.det_t else None}

    # ------------------------------------------------------------------ inputs for the overlay
    def _on_objects(self, msg):
        try:
            self.objects = json.loads(msg.data)
        except ValueError:
            pass

    def _on_dets(self, msg):
        try:
            self.detections, self.det_t = json.loads(msg.data), time.time()
        except ValueError:
            pass

    def _on_gt(self, msg):
        p, o = msg.pose.pose.position, msg.pose.pose.orientation
        T = np.eye(4)
        T[:3, :3] = _qmat(o.w, o.x, o.y, o.z)
        T[:3, 3] = [p.x, p.y, p.z]
        self.pelvis = T
        self.pelvis_t = time.time()

    def _on_info(self, msg):
        self.K = np.array(msg.k, float).reshape(3, 3)

    # ------------------------------------------------------------------ on-demand head camera
    def viewer(self, delta):
        with self._lock:
            self.head['viewers'] = max(0, self.head['viewers'] + delta)
            self._last_viewer = time.time()
            if self.head['viewers'] > 0 and self._img_sub is None:
                self._img_sub = self.node.create_subscription(Image, '/g1/head_camera/image_raw', self._on_image, 2,
                                                              callback_group=self.cb)
                self.head['subscribed'] = True
                self.log('info', 'mission', 'head camera stream on (sim renders while subscribed)')

    def _sub_housekeeping(self):
        with self._lock:
            if self._img_sub is not None and self.head['viewers'] == 0 and time.time() - self._last_viewer > 5.0:
                self.node.destroy_subscription(self._img_sub)
                self._img_sub = None
                self.head['subscribed'] = False
                self.log('info', 'mission', 'head camera stream off (no viewers)')

    def _on_image(self, msg):
        now = time.time()
        if now - self._last_frame < 1.0 / self.max_fps:
            return
        self._last_frame = now
        try:
            import cv2
            a = np.frombuffer(msg.data, np.uint8).reshape(msg.height, msg.width, 3)
            bgr = a[:, :, ::-1].copy() if msg.encoding == 'rgb8' else a.copy()
            self._overlay(bgr)
            ok, jpg = cv2.imencode('.jpg', bgr, [cv2.IMWRITE_JPEG_QUALITY, 80])
            if not ok:
                return
        except Exception as e:  # noqa: BLE001
            self.log('warn', 'mission', f'head camera frame: {e}')
            return
        self._times = [t for t in self._times if now - t < 2.0] + [now]
        h = self.head
        h['jpeg'], h['seq'], h['stamp'], h['size'] = jpg.tobytes(), h['seq'] + 1, now, [msg.width, msg.height]
        h['fps'] = (len(self._times) - 1) / max(now - self._times[0], 1e-3) if len(self._times) > 1 else 0.0
        if self.on_frame:
            self.on_frame(h['seq'])

    def _cam_T(self):
        """World -> optical transform from pelvis ground truth + TF pelvis -> optical (None if unknown)."""
        if self.pelvis is None:
            return None
        try:
            from rclpy.time import Time
            t = self.node.tf_buffer.lookup_transform('pelvis', OPTICAL, Time())
        except Exception:  # noqa: BLE001
            return None
        tr, r = t.transform.translation, t.transform.rotation
        T_po = np.eye(4)
        T_po[:3, :3] = _qmat(r.w, r.x, r.y, r.z)
        T_po[:3, 3] = [tr.x, tr.y, tr.z]
        T_wo = self.pelvis @ T_po
        Ti = np.eye(4)
        Ti[:3, :3] = T_wo[:3, :3].T
        Ti[:3, 3] = -T_wo[:3, :3].T @ T_wo[:3, 3]
        return Ti

    def _project(self, T_ow, p):
        q = T_ow[:3, :3] @ p + T_ow[:3, 3]
        if q[2] < 0.05:
            return None
        uv = self.K @ (q / q[2])
        return int(round(uv[0])), int(round(uv[1]))

    def _overlay(self, img):
        import cv2
        st = self.status or {}
        target = st.get('instrument')
        info = st.get('instrument_info', {})
        T_ow = self._cam_T() if self.K is not None else None
        amber, grey, green = (0, 176, 255), (190, 190, 190), (80, 200, 60)
        if T_ow is not None:
            for name, e in self.objects.items():
                if e.get('type') != 'instrument' or e.get('held_by') == 'surgeon':
                    continue
                p = np.array(e['pose'][:3])
                R = _qmat(*e['pose'][3:7])
                L = float(info.get(name, {}).get('handle_z', 0.17))
                a, b = self._project(T_ow, p), self._project(T_ow, p + R[:, 2] * L)
                if a is None or b is None:
                    continue
                if name == target:
                    cv2.line(img, a, b, amber, 5, cv2.LINE_AA)
                    cv2.circle(img, b, 7, amber, 2, cv2.LINE_AA)
                    cv2.putText(img, f'{name} (GT)', (b[0] + 10, b[1] - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.55,
                                (0, 0, 0), 2, cv2.LINE_AA)
                    cv2.putText(img, f'{name} (GT)', (b[0] + 10, b[1] - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.55, amber, 1,
                                cv2.LINE_AA)
                else:
                    cv2.line(img, a, b, grey, 1, cv2.LINE_AA)
        if self.det_t and time.time() - self.det_t < 2.0:
            for d in self.detections:
                obb = d.get('bbox_obb')
                if not obb or len(obb) < 5:
                    continue
                cx, cy, w, h, ang = obb[:5]
                # hospital-sim-perception/README.md: angle in degrees [0, 180), w = long side, image x right / y down
                box = cv2.boxPoints(((cx, cy), (w, h), float(ang))).astype(np.int32)
                col = amber if d.get('label') == target else green
                cv2.polylines(img, [box], True, col, 2, cv2.LINE_AA)
                cv2.putText(img, f"{d.get('label', '?')} {d.get('score', 0):.2f}", tuple(box[1]),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.45, col, 1, cv2.LINE_AA)
        tag = 'target: ' + (target or '-') + ('   [GT overlay = sim cheat]' if T_ow is not None else '')
        (tw, th), _ = cv2.getTextSize(tag, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
        y = img.shape[0] - 10
        cv2.rectangle(img, (4, y - th - 6), (12 + tw, y + 5), (20, 20, 20), -1)
        cv2.putText(img, tag, (8, y), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
