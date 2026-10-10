"""aiohttp web server + WebSocket hub for the G1 dashboard and the iPad app (see hospital-sim-ui/PROTOCOL.md v1 + v2).

v1 ops live here; the v2 ops (sessions, lease, stop/resume, alarms, undo, places, instruments, checks, incidents,
audit) are in v2.py. Every op goes through V2Mixin.gated (role allow-list, lease rule, audit)."""
import asyncio
import base64
import collections
import json
import logging
import math
import os
import signal
import time

from aiohttp import web, WSMsgType

from . import catalog as cat
from . import maps as mapstore
from .alarms import AlarmManager
from .audit import AuditLog
from .auth import Auth
from .bridge import HAVE_G1_INTERFACES, HAVE_NAV2, MODE_IDS, MODE_NAMES
from .checks import CheckRecords
from .incidents import IncidentStore, RingBuffer
from .pending import PendingCommands
from .stacks import StackManager
from .v2 import V2Mixin

PROTOCOL_VERSION = 2
LIMITS = {'vx': [-0.5, 0.8], 'vy': [-0.4, 0.4], 'wz': [-1.0, 1.0]}
KEYS = {  # docs/interfaces.md section 3.3
    'r': 'ready (DAMP -> STAND)', 'l': 'start locomotion (STAND -> LOCO)',
    'w': 'forward', 's': 'backward', 'a': 'strafe left', 'd': 'strafe right',
    'q': 'turn left', 'e': 'turn right', 'space': 'zero velocity',
    'p': 'pause (LOCO/NAV/AUTO -> STAND)', 'm': 'start camera teleop (STAND -> MANIP)',
    'n': 'stop camera teleop (MANIP -> STAND)', 'g': 'navigation (STAND -> NAV)', 'x': 'power off (any -> DAMP)',
    'o': 'STOP / hold (any -> HOLD)',
}
# extra keys handled by the camera teleop node (g1-webcam-teleop/xr_teleoperate webcam), not by the manager
TELEOP_NODE_KEYS = {'c': 'calibrate (hold a neutral pose)', 'f': 'auto-framing on/off', 'h': 're-centre camera',
                    'u': 'clear calibration'}
TRANSITIONS = {'DAMP': ['STAND'], 'STAND': ['LOCO', 'MANIP', 'NAV', 'AUTO', 'DAMP'], 'LOCO': ['STAND'],
               'MANIP': ['STAND'], 'NAV': ['STAND'], 'AUTO': ['STAND'],
               'HOLD': ['STAND', 'AUTO']}  # + any -> DAMP, any (not DAMP) -> HOLD; HOLD -> AUTO only if held from AUTO
MANAGER_KEYS = set('rlwsadqepmngxo') | {'space'}
MISSION_COMMANDS = ('start', 'abort', 'pause', 'resume', 'reset', 'clear_queue')  # + goto:<location>

log = logging.getLogger('g1_dashboard')


class Dashboard(V2Mixin):
    def __init__(self, opts):
        self.opts = opts
        ui = opts.ui_dir
        self.auth = Auth(opts.auth_config)
        dd = getattr(opts, 'data_dir', None) or os.path.join(ui, 'server')
        self.audit = AuditLog(os.path.join(dd, 'audit'))
        self.alarms = AlarmManager(on_change=self.on_alarms_changed, say=self.say)
        self.pending = PendingCommands(undo_s=opts.undo_s, on_event=self._on_pending)
        self.ring = RingBuffer(seconds=300.0)
        self.incidents = IncidentStore(os.path.join(dd, 'incidents'))
        self.checks_store = CheckRecords(os.path.join(dd, 'data'))
        self.places = cat.load_places()
        self.instruments_cat = cat.load_instruments()
        self.timeline = collections.deque(maxlen=300)
        self.devices = {}
        self.hold_ctx = None
        self.nav_paused_by_hold = False
        self.last_checks = None
        self._alarms_dirty = True
        self._light = None
        self._inst_key = ''
        self._last_lease_holder = None
        self._no_client_since = None
        self.nav_place = None          # display name of the place the current Nav2 goal came from (send_to)
        self.dl_tokens = {}            # one-time incident download tokens -> (id, expiry)
        self.handed_seen = {}          # mission history entry -> time the server saw it
        self._hist_total = None
        self.loop = None
        self.clients = []
        self.logs = collections.deque(maxlen=2000)
        self.bridge = None
        self.stacks = StackManager(self.log, use_sim_time=opts.use_sim_time)
        self.cam_cond = None
        self.head_cond = None
        self.sent_map_version = -1
        self.sent_path_version = -1
        self.active_map = None     # name of the map loaded into map_server (if any)
        self._recent = {}

    # ------------------------------------------------------------------ thread-safe hooks
    def log(self, level, source, text):
        now = time.time()
        # collapse floods of the same line (e.g. a node warning every second) to one per 30 s
        if level != 'debug':
            key = (source, text)
            seen = self._recent.get(key)
            if seen and now - seen[0] < 30.0:
                seen[1] += 1
                return
            if seen and seen[1]:
                text = f'{text}  (repeated {seen[1]}x in the last {now - seen[0]:.0f} s)'
            self._recent[key] = [now, 0]
            if len(self._recent) > 500:
                self._recent = {k: v for k, v in self._recent.items() if now - v[0] < 30.0}
        entry = {'type': 'log', 't': now, 'level': level, 'src': source, 'msg': text}
        if self.loop is None:
            self.logs.append(entry)
            return
        if level in ('warn', 'error', 'info'):
            getattr(log, 'warning' if level == 'warn' else level)(f'[{source}] {text}')
        self.loop.call_soon_threadsafe(self._push_log, entry)

    def _push_log(self, entry):
        self.logs.append(entry)
        self.broadcast(entry)

    def emit(self, msg):
        if self.loop is not None:
            self.loop.call_soon_threadsafe(self._on_emit, msg)

    def _on_emit(self, msg):
        """Bridge events on the asyncio side: server reactions first, then the browsers."""
        t = msg.get('type')
        if t == '_lease_changed':
            self.on_lease_changed()
            return
        if t == 'mode':
            prev = self._prev_mode
            self._prev_mode = msg
            try:
                self.on_mode_changed(prev, msg)
            except Exception:  # noqa: BLE001
                log.exception('mode hook')
        self.broadcast(msg)

    def _on_pending(self, msg):
        self.ring.add(msg['type'], msg)
        if msg['type'] == 'pending_done':
            self.log('info' if msg['ok'] else 'warn', 'ui',
                     f"{msg['kind']} {'undone' if msg.get('cancelled') else 'sent'}: {msg['text']} "
                     f"({msg['message']})")
            self.audit.append(device='server', role='server', user=None, lease_holder=self.lease_holder(),
                              op='dispatch:' + msg['kind'], args={'pending_id': msg['id'], 'text': msg['text']},
                              ok=bool(msg['ok']), cancelled=bool(msg.get('cancelled')),
                              message=str(msg['message'])[:300], mode=self.mode_now())
        self.broadcast(msg)

    def broadcast(self, msg):
        data = json.dumps(msg, separators=(',', ':'), default=str)
        for c in list(self.clients):
            try:
                c['q'].put_nowait(data)
            except asyncio.QueueFull:
                pass

    def _camera_frame(self, seq):
        self.loop.call_soon_threadsafe(self._notify_camera)

    def _notify_camera(self):
        async def n():
            async with self.cam_cond:
                self.cam_cond.notify_all()
        asyncio.ensure_future(n())

    def _head_frame(self, seq):
        self.loop.call_soon_threadsafe(self._notify_head)

    def _notify_head(self):
        async def n():
            async with self.head_cond:
                self.head_cond.notify_all()
        asyncio.ensure_future(n())

    # ------------------------------------------------------------------ periodic publishers
    def mode_name(self):
        m = self.bridge.latest['mode'] if self.bridge else None
        return m['name'] if m else None

    def state_msg(self):
        b = self.bridge
        nodes = b.graph_nodes()
        stacks = self.stacks.info()
        # stacks started outside the dashboard (e.g. from a terminal) are shown as external
        if stacks['slam']['state'] in ('stopped', 'failed') and 'slam_toolbox' in nodes:
            stacks['slam']['state'] = 'external'
        if stacks['nav']['state'] in ('stopped', 'failed') and 'bt_navigator' in nodes:
            stacks['nav']['state'] = 'external'
        nav = dict(b.nav)
        nav['server_ready'] = b.nav_available()
        return {
            'type': 'state', 't': time.time(),
            'mode': b.latest['mode'], 'controller': b.latest['controller'],
            'tracking': b.latest['tracking'], 'battery': b.latest['battery'],
            'manager': b.latest['manager'], 'sim': b.latest['sim'],
            'temps': b.latest['temps'], 'amcl': b.latest['amcl_pose'],
            'stacks': stacks, 'nav': nav, 'active_map': self.active_map,
            'topics': b.topic_health(),
            'camera': {'fps': round(b.camera['fps'], 1), 'age': round(time.time() - b.camera['stamp'], 2)
                       if b.camera['stamp'] else None},
            'services': {'set_mode': bool(b.set_mode_cli and b.set_mode_cli.service_is_ready()),
                         'navigate': b.nav_available(), 'g1_interfaces': HAVE_G1_INTERFACES},
            'nodes': sorted(n for n in nodes if not n.startswith('_'))[:80],
            'mission_link': b.mission.info(),
            **self.state_v2(),
        }

    async def ticker(self):
        """Sample ROS state at fixed rates and push to browsers."""
        n = 0
        while True:
            await asyncio.sleep(0.1)
            n += 1
            if not self.clients:
                if n % 10 == 5:
                    try:
                        self.every_second()
                    except Exception as e:  # noqa: BLE001
                        log.exception('every_second: %s', e)
                continue
            b = self.bridge
            try:
                pose = b.robot_pose()
                if pose:
                    self.broadcast({'type': 'pose', **{k: (round(v, 3) if isinstance(v, float) else v)
                                                        for k, v in pose.items()}})
                if n % 2 == 1:
                    px = b.proximity()
                    if px:
                        self.broadcast({'type': 'proximity', **px})
                if n % 2 == 0:
                    frame = pose['frame'] if pose else 'map'
                    pts = b.scan_points(frame)
                    if pts is not None:
                        self.broadcast({'type': 'scan', 'frame': frame, 'pts': pts})
                if n % 5 == 0:
                    self.broadcast(self.state_msg())
                    pv = b.latest['path_version']
                    if pv != self.sent_path_version and b.latest['path']:
                        self.sent_path_version = pv
                        self.broadcast({'type': 'path', **b.latest['path']})
                if n % 10 == 0:
                    self.send_map_if_new()
                if n % 10 == 5:
                    self.every_second()
            except Exception as e:  # never let the ticker die
                log.exception('ticker: %s', e)

    def map_msg(self):
        with self.bridge.lock:
            m = self.bridge.latest['map']
            v = self.bridge.latest['map_version']
        if m is None:
            return None, v
        png = mapstore.encode_grid_png(m['data'])
        return {'type': 'map', 'frame': m['frame'], 'width': m['width'], 'height': m['height'],
                'resolution': m['resolution'], 'origin': m['origin'], 'version': v,
                'png': base64.b64encode(png).decode()}, v

    def send_map_if_new(self, force_client=None):
        if self.bridge.latest['map_version'] == self.sent_map_version and force_client is None:
            return
        msg, v = self.map_msg()
        if msg is None:
            return
        if force_client is not None:
            force_client['q'].put_nowait(json.dumps(msg))
        else:
            self.sent_map_version = v
            self.broadcast(msg)

    # ------------------------------------------------------------------ helpers
    async def wait_rcl(self, fut, timeout=5.0):
        """Await an rclpy Future from asyncio."""
        af = self.loop.create_future()

        def done(f):
            def setres():
                if af.done():
                    return
                try:
                    af.set_result(f.result())
                except Exception as e:
                    af.set_exception(e)
            self.loop.call_soon_threadsafe(setres)
        fut.add_done_callback(done)
        return await asyncio.wait_for(af, timeout)

    async def set_mode(self, mode, source='ui'):
        if isinstance(mode, str):
            if mode.upper() not in MODE_IDS:
                return False, f'unknown mode {mode}'
            mode = MODE_IDS[mode.upper()]
        try:
            res = await self.wait_rcl(self.bridge.call_set_mode(mode, source), 3.0)
        except asyncio.TimeoutError:
            return False, 'SetMode timed out'
        except Exception as e:
            return False, str(e)
        name = MODE_NAMES.get(mode, mode)
        self.log('info' if res.accepted else 'warn', 'ui',
                 f"SetMode {name}: {'accepted' if res.accepted else 'REJECTED'} {res.message}")
        return bool(res.accepted), res.message

    async def ensure_nav_mode(self, source='ui'):
        cur = self.mode_name()
        if cur == 'NAV':
            return True, ''
        return await self.set_mode('NAV', source=source)

    def maps_dir(self):
        return self.opts.maps_dir

    # ------------------------------------------------------------------ command handlers
    async def handle(self, client, msg):  # (called by V2Mixin.gated after the role / lease checks)
        op = msg.get('op')
        h = getattr(self, 'op_' + str(op), None)
        if h is None:
            return False, f'unknown op {op!r}', None
        return await h(msg, client)

    async def op_ping(self, m, c):
        return True, 'pong', {'t': time.time()}

    async def op_set_mode(self, m, c):
        mode = m.get('mode')
        if mode in ('HOLD', 6):
            return await self.op_stop(m, c)
        if mode in ('DAMP', 0):
            return await self.op_power_off(m, c)
        ok, message = await self.set_mode(mode, source=self.src(c))
        return ok, message, None

    async def op_key(self, m, c):
        key = str(m.get('key', '')).lower()
        if key == ' ':
            key = 'space'
        if key not in KEYS and key not in TELEOP_NODE_KEYS:
            return False, f'key {key!r} is not in the contract', None
        if key == 'o':
            return await self.op_stop(m, c)
        if key == 'x':
            return await self.op_power_off(m, c)
        if key in MANAGER_KEYS:
            # manager keys carry the device identity (lease rule in the manager)
            self.bridge.publish_key_ui(key, self.src(c))
        else:
            self.bridge.publish_key(key)          # camera teleop node keys (c f h u)
        return True, '', None

    async def op_cmd_vel(self, m, c):
        def clamp(v, lim):
            v = float(v or 0.0)
            return 0.0 if math.isnan(v) else max(lim[0], min(lim[1], v))
        vx, vy, wz = clamp(m.get('vx'), LIMITS['vx']), clamp(m.get('vy'), LIMITS['vy']), clamp(m.get('wz'), LIMITS['wz'])
        self.bridge.publish_cmd_vel(vx, vy, wz)
        return True, '', None

    async def op_initial_pose(self, m, c):
        self.bridge.publish_initial_pose(m['x'], m['y'], m.get('yaw', 0.0))
        self.log('info', 'ui', f"initial pose set to ({m['x']:.2f}, {m['y']:.2f}, {m.get('yaw', 0):.2f})")
        return True, 'initial pose published', None

    async def _nav_precheck(self, c=None):
        if not HAVE_NAV2:
            return 'nav2_msgs not available'
        if not self.bridge.nav_available():
            return 'Nav2 is not running (start navigation first)'
        ok, message = await self.ensure_nav_mode(self.src(c) if c else 'ui')
        if not ok:
            return f'cannot enter NAV mode: {message}'
        return None

    async def op_nav_goal(self, m, c):
        self.nav_place = None
        err = await self._nav_precheck(c)
        if err:
            return False, err, None
        if self.bridge._goal_handle is not None:
            await self.wait_rcl(self.bridge.cancel_nav(), 3.0)
        fut = self.bridge.send_nav_goal(float(m['x']), float(m['y']), float(m.get('yaw', 0.0)))
        gh = await self.wait_rcl(fut, 5.0)
        if not gh.accepted:
            return False, 'goal rejected by Nav2', None
        self.log('info', 'ui', f"nav goal ({m['x']:.2f}, {m['y']:.2f})")
        return True, 'goal accepted', None

    async def op_nav_waypoints(self, m, c):
        poses = m.get('poses') or []
        if not poses:
            return False, 'no waypoints', None
        err = await self._nav_precheck(c)
        if err:
            return False, err, None
        if self.bridge._goal_handle is not None:
            await self.wait_rcl(self.bridge.cancel_nav(), 3.0)
        gh = await self.wait_rcl(self.bridge.send_waypoints(poses, int(m.get('start', 0))), 5.0)
        if not gh.accepted:
            return False, 'waypoints rejected by Nav2', None
        self.log('info', 'ui', f'following {len(poses)} waypoints')
        return True, f'following {len(poses)} waypoints', None

    async def op_nav_pause(self, m, c):
        fut = self.bridge.cancel_nav(pause=True)
        if fut is not None:
            await self.wait_rcl(fut, 3.0)
        return True, 'paused', None

    async def op_nav_resume(self, m, c):
        nav = self.bridge.nav
        if nav['state'] != 'paused':
            return False, 'nothing to resume', None
        if nav['kind'] == 'waypoints':
            return await self.op_nav_waypoints({'poses': nav['waypoints'], 'start': nav['index']}, c)
        if nav['goal']:
            return await self.op_nav_goal(nav['goal'], c)
        return False, 'nothing to resume', None

    async def op_nav_cancel(self, m, c):
        fut = self.bridge.cancel_nav()
        if fut is not None:
            try:
                await self.wait_rcl(fut, 3.0)
            except asyncio.TimeoutError:
                pass
        self.bridge.nav.update(state='idle', goal=None, waypoints=[], index=0, feedback={})
        return True, 'navigation canceled', None

    async def op_stack_start(self, m, c):
        name = m.get('stack')
        b = self.bridge
        if name == 'slam':
            nav = self.stacks.stacks['nav']
            if nav.state in ('starting', 'running') and nav.args.get('localization') == 'amcl':
                return False, 'stop navigation (AMCL localisation) before mapping', None
            await self.stacks.start_slam(ready_check=lambda: 'slam_toolbox' in b.graph_nodes())
            self.active_map = None
            return True, 'SLAM starting', None
        if name == 'nav':
            map_name = m.get('map')
            yaml_path = None
            if map_name:
                yaml_path = os.path.join(self.maps_dir(), mapstore.sanitize(map_name) + '.yaml')
                if not os.path.isfile(yaml_path):
                    return False, f'map {map_name} not found', None
                slam = self.stacks.stacks['slam']
                if slam.state in ('starting', 'running'):
                    return False, 'SLAM is running: stop it (and save the map) before localising on a saved map', None
            else:
                slam = self.stacks.stacks['slam']
                if slam.state not in ('starting', 'running') and 'slam_toolbox' not in b.graph_nodes():
                    return False, 'choose a map (or start SLAM to navigate while mapping)', None
            await self.stacks.start_nav(yaml_path, ready_check=b.nav_available)
            self.active_map = map_name
            return True, 'navigation starting' + (f' on {map_name}' if map_name else ' (on SLAM map)'), None
        if name == 'mock':
            await self.stacks.start_mock(self.opts.mock_script, self.opts.mock_args)
            return True, 'mock robot starting', None
        return False, f'unknown stack {name}', None

    async def op_stack_stop(self, m, c):
        name = m.get('stack')
        if name not in self.stacks.stacks:
            return False, f'unknown stack {name}', None
        if name == 'nav':
            self.bridge.cancel_nav()
            self.active_map = None
        await self.stacks.stop(name)
        return True, f'{name} stopped', None

    async def op_map_save(self, m, c):
        name = mapstore.sanitize(m.get('name'))
        with self.bridge.lock:
            mp = self.bridge.latest['map']
        if mp is None:
            return False, 'no /map received yet', None
        path = mapstore.save_map(self.maps_dir(), name, mp['data'], mp['resolution'], mp['origin'],
                                 source='slam_toolbox' if self.stacks.stacks['slam'].state == 'running' else '/map')
        extra = ''
        fut = self.bridge.serialize_posegraph(os.path.join(self.maps_dir(), name))
        if fut is not None:
            try:
                res = await self.wait_rcl(fut, 10.0)
                extra = ' + pose graph' if res.result == 0 else \
                    ' (slam_toolbox could not serialize the pose graph; the pgm/yaml map is fine)'
            except Exception as e:
                extra = f' (pose graph not saved: {e})'
        self.log('info', 'ui', f'map saved: {path}{extra}')
        return True, f'saved {name}{extra}', {'yaml': path}

    async def op_maps_list(self, m, c):
        return True, '', {'maps': mapstore.list_maps(self.maps_dir()), 'dir': self.maps_dir()}

    async def op_map_load(self, m, c):
        """Localise on a saved map: swap it into a running map_server, or start navigation."""
        name = mapstore.sanitize(m.get('name'))
        yaml_path = os.path.join(self.maps_dir(), name + '.yaml')
        if not os.path.isfile(yaml_path):
            return False, f'map {name} not found', None
        nav = self.stacks.stacks['nav']
        if nav.state in ('starting', 'running') and nav.args.get('localization') == 'amcl':
            fut = self.bridge.load_map_service(yaml_path)
            if fut is not None:
                res = await self.wait_rcl(fut, 10.0)
                if res.result == 0:
                    self.active_map = name
                    nav.args['map'] = name
                    return True, f'map {name} loaded into map_server (set the initial pose)', None
                return False, f'map_server could not load {name} (code {res.result})', None
        return await self.op_stack_start({'stack': 'nav', 'map': name}, c)

    async def op_map_delete(self, m, c):
        name = mapstore.sanitize(m.get('name'))
        removed = []
        for ext in ('.yaml', '.pgm', '.posegraph', '.data', '.waypoints.json'):
            p = os.path.join(self.maps_dir(), name + ext)
            if os.path.isfile(p):
                os.remove(p)
                removed.append(ext)
        return bool(removed), f'deleted {name}' if removed else f'{name} not found', None

    async def op_routes_list(self, m, c):
        return True, '', {'routes': mapstore.load_routes(self.maps_dir(), m['map'])}

    async def op_route_save(self, m, c):
        routes = mapstore.save_route(self.maps_dir(), m['map'], m['name'], m['poses'])
        return True, f"route {m['name']} saved", {'routes': routes}

    async def op_route_delete(self, m, c):
        routes = mapstore.delete_route(self.maps_dir(), m['map'], m['name'])
        return True, f"route {m['name']} deleted", {'routes': routes}

    async def op_get_map(self, m, c):
        self.send_map_if_new(force_client=c)
        return True, '', None

    # ---- scrub-nurse mission (g1_mission, docs/interfaces.md 6)
    async def op_mission_command(self, m, c):
        cmd = str(m.get('command', '')).strip()
        if cmd not in MISSION_COMMANDS and not cmd.startswith('goto:'):
            return False, f'unknown mission command {cmd!r}', None
        if self.bridge.mission.status is None:
            return False, 'no /g1/mission/status: is g1_mission running (mission.launch.py)?', None
        self.bridge.mission.command(cmd)
        self.log('info', 'ui', f'mission command: {cmd}')
        return True, f'sent {cmd}', None

    async def op_mission_request(self, m, c):
        inst = str(m.get('instrument', '')).strip()
        if not inst:
            return False, 'no instrument', None
        try:
            res = await self.wait_rcl(self.bridge.mission.request(inst, 'ui'), 5.0)
        except asyncio.TimeoutError:
            return False, 'request timed out', None
        except Exception as e:
            return False, str(e), None
        self.log('info' if res.accepted else 'warn', 'ui', f'instrument request {inst}: {res.message}')
        return bool(res.accepted), res.message, None

    # ------------------------------------------------------------------ HTTP handlers
    async def ws_handler(self, request):
        ws = web.WebSocketResponse(heartbeat=20, max_msg_size=4 * 1024 * 1024)
        await ws.prepare(request)
        client = {'ws': ws, 'q': asyncio.Queue(maxsize=300)}
        self.new_client_session(client, request)
        self.clients.append(client)
        writer = asyncio.ensure_future(self._writer(client))
        hello = {'type': 'hello', 'protocol': PROTOCOL_VERSION, 'mock': self.opts.mock,
                 'session': self.auth.public(client['session']), **self.hello_v2(),
                 'use_sim_time': self.opts.use_sim_time, 'maps_dir': self.maps_dir(),
                 'modes': MODE_NAMES, 'transitions': TRANSITIONS, 'keys': KEYS, 'teleop_keys': TELEOP_NODE_KEYS,
                 'limits': LIMITS,
                 'key_repeat_ms': self.opts.key_repeat_ms, 'base_frame': self.opts.base_frame,
                 'nav2': HAVE_NAV2, 'g1_interfaces': HAVE_G1_INTERFACES}
        client['q'].put_nowait(json.dumps(hello))
        client['q'].put_nowait(json.dumps({'type': 'logs', 'entries': list(self.logs)[-400:]}))
        client['q'].put_nowait(json.dumps(self.state_msg(), default=str))
        client['q'].put_nowait(json.dumps(self.lease_msg(client)))
        client['q'].put_nowait(json.dumps(self.alarms.view(client['session']['role']), default=str))
        m = self.bridge.latest['mode']
        if m:
            client['q'].put_nowait(json.dumps({'type': 'mode', **m}))
        if self.bridge.mission.status is not None:
            client['q'].put_nowait(json.dumps({'type': 'mission', **self.bridge.mission.status}))
        self.send_map_if_new(force_client=client)
        if self.bridge.latest['path']:
            client['q'].put_nowait(json.dumps({'type': 'path', **self.bridge.latest['path']}))
        try:
            async for raw in ws:
                if raw.type != WSMsgType.TEXT:
                    continue
                try:
                    msg = json.loads(raw.data)
                except ValueError:
                    continue
                asyncio.ensure_future(self._dispatch(client, msg))
        finally:
            self.clients.remove(client)
            writer.cancel()
            d = self.devices.get(client['session']['device_id'])
            if d is not None:
                d['connected'] = False
            # a closed tab must not leave the robot walking on a stale joystick command
            if not self.clients:
                self.bridge.publish_cmd_vel(0, 0, 0)
        return ws

    async def _dispatch(self, client, msg):
        rid = msg.get('id')
        try:
            ok, message, data = await self.gated(client, msg)
        except Exception as e:
            log.exception('op %s failed', msg.get('op'))
            ok, message, data = False, f'{type(e).__name__}: {e}', None
        if rid is not None:
            try:
                client['q'].put_nowait(json.dumps({'type': 'result', 'id': rid, 'op': msg.get('op'),
                                                   'ok': ok, 'message': message, 'data': data}, default=str))
            except asyncio.QueueFull:
                pass

    async def _writer(self, client):
        ws, q = client['ws'], client['q']
        try:
            while True:
                data = await q.get()
                await ws.send_str(data)
        except (ConnectionResetError, asyncio.CancelledError, RuntimeError):
            pass

    async def mjpeg_handler(self, request):
        boundary = 'g1frame'
        resp = web.StreamResponse(headers={
            'Content-Type': f'multipart/x-mixed-replace; boundary={boundary}',
            'Cache-Control': 'no-cache, no-store', 'Pragma': 'no-cache'})
        await resp.prepare(request)
        cam = self.bridge.camera
        last = -1
        try:
            while True:
                if cam['seq'] == last or cam['jpeg'] is None:
                    try:
                        async with self.cam_cond:
                            await asyncio.wait_for(self.cam_cond.wait(), 2.0)
                    except asyncio.TimeoutError:
                        pass
                    if cam['jpeg'] is None:
                        continue
                    if cam['seq'] == last:
                        continue
                last = cam['seq']
                jpeg = cam['jpeg']
                await resp.write(b'--' + boundary.encode() + b'\r\nContent-Type: image/jpeg\r\n'
                                 b'Content-Length: ' + str(len(jpeg)).encode() + b'\r\n\r\n' + jpeg + b'\r\n')
        except (ConnectionResetError, asyncio.CancelledError):
            pass
        return resp

    async def head_mjpeg_handler(self, request):
        """Head RGB camera (/g1/head_camera/image_raw) as MJPEG. Subscribed only while at least one client
        watches (the sim renders the camera only while subscribed)."""
        boundary = 'g1head'
        resp = web.StreamResponse(headers={
            'Content-Type': f'multipart/x-mixed-replace; boundary={boundary}',
            'Cache-Control': 'no-cache, no-store', 'Pragma': 'no-cache'})
        await resp.prepare(request)
        link = self.bridge.mission
        cam = link.head
        link.viewer(+1)
        last = -1
        try:
            while True:
                if cam['seq'] == last or cam['jpeg'] is None:
                    try:
                        async with self.head_cond:
                            await asyncio.wait_for(self.head_cond.wait(), 2.0)
                    except asyncio.TimeoutError:
                        pass
                    if cam['jpeg'] is None or cam['seq'] == last:
                        continue
                last = cam['seq']
                jpeg = cam['jpeg']
                await resp.write(b'--' + boundary.encode() + b'\r\nContent-Type: image/jpeg\r\n'
                                 b'Content-Length: ' + str(len(jpeg)).encode() + b'\r\n\r\n' + jpeg + b'\r\n')
        except (ConnectionResetError, asyncio.CancelledError):
            pass
        finally:
            link.viewer(-1)
        return resp

    async def head_snapshot_handler(self, request):
        jpeg = self.bridge.mission.head['jpeg']
        if jpeg is None:
            raise web.HTTPNotFound(text='no head camera frame yet (open /stream/head_camera.mjpg first)')
        return web.Response(body=jpeg, content_type='image/jpeg', headers={'Cache-Control': 'no-cache'})

    async def snapshot_handler(self, request):
        jpeg = self.bridge.camera['jpeg']
        if jpeg is None:
            raise web.HTTPNotFound(text='no camera frame yet')
        return web.Response(body=jpeg, content_type='image/jpeg', headers={'Cache-Control': 'no-cache'})

    async def map_png_handler(self, request):
        name = request.match_info['name']
        theme = request.query.get('theme', 'light')
        try:
            png = mapstore.map_preview_png(self.maps_dir(), name, theme)
        except (ValueError, FileNotFoundError, KeyError):
            raise web.HTTPNotFound()
        return web.Response(body=png, content_type='image/png', headers={'Cache-Control': 'no-cache'})

    async def health_handler(self, request):
        return web.json_response({'ok': True, 'protocol': PROTOCOL_VERSION, 'clients': len(self.clients),
                                  'stacks': self.stacks.info(), 'topics': self.bridge.topic_health()})

    async def index_handler(self, request):
        """The iPad app (hospital-sim-ui/app) at /; a placeholder until hospital-sim-ui/app/index.html exists."""
        p = os.path.join(self.opts.app_dir, 'index.html')
        if os.path.isfile(p):
            return web.FileResponse(p, headers={'Cache-Control': 'no-cache'})
        return web.Response(content_type='text/html', text=PLACEHOLDER)

    async def console_handler(self, request):
        return web.FileResponse(os.path.join(self.opts.web_dir, 'index.html'),
                                headers={'Cache-Control': 'no-cache'})

    async def ca_handler(self, request):
        p = os.path.join(self.opts.ui_dir, 'server', 'tls', 'out', 'ca.crt')
        if not os.path.isfile(p):
            raise web.HTTPNotFound(text='no CA yet: run hospital-sim-ui/server/tls/make_cert.sh')
        return web.FileResponse(p, headers={'Content-Type': 'application/x-x509-ca-cert',
                                            'Content-Disposition': 'attachment; filename="G1-robot-CA.crt"'})

    async def incident_zip_handler(self, request):
        iid = request.match_info['iid']
        if 'dl' in request.query:
            if not self.take_download_token(request.query['dl'], iid):
                raise web.HTTPForbidden(text='download link expired or already used: ask for a new one')
        else:   # DEPRECATED: session token in the URL (ends up in logs); use the incident_link op
            s = next((x for x in self.auth.sessions.values() if x['token'] == request.query.get('token')), None)
            if s is None or s['role'] != 'technician':
                raise web.HTTPForbidden(text='use the incident_link op for a one-time download link')
            log.warning('incident %s downloaded with a session token in the URL (deprecated)', iid)
        p = self.incidents.path(iid)
        if p is None:
            raise web.HTTPNotFound()
        return web.FileResponse(p, headers={'Content-Type': 'application/zip'})

    def make_app(self):
        app = web.Application()
        app.router.add_get('/', self.index_handler)
        app.router.add_get('/console', lambda r: web.HTTPFound('/console/'))
        app.router.add_get('/console/', self.console_handler)
        app.router.add_get('/tls/ca.crt', self.ca_handler)
        app.router.add_get('/api/incidents/{iid}.zip', self.incident_zip_handler)
        app.router.add_get('/ws', self.ws_handler)
        app.router.add_get('/stream/camera.mjpg', self.mjpeg_handler)
        app.router.add_get('/api/camera/snapshot.jpg', self.snapshot_handler)
        app.router.add_get('/stream/head_camera.mjpg', self.head_mjpeg_handler)
        app.router.add_get('/api/head_camera/snapshot.jpg', self.head_snapshot_handler)
        app.router.add_get('/api/maps/{name}.png', self.map_png_handler)
        app.router.add_get('/api/health', self.health_handler)
        app.router.add_static('/console/', self.opts.web_dir, show_index=False, append_version=False)
        if os.path.isdir(self.opts.app_dir):
            app.router.add_static('/', self.opts.app_dir, show_index=False, append_version=False)

        @web.middleware
        async def nocache(request, handler):
            resp = await handler(request)
            if request.path.endswith(('.js', '.css', '.html')):
                resp.headers['Cache-Control'] = 'no-cache'
            return resp
        app.middlewares.append(nocache)
        app.on_startup.append(self._on_startup)
        app.on_shutdown.append(self._on_shutdown)
        return app

    async def _on_startup(self, app):
        self.loop = asyncio.get_running_loop()
        self.cam_cond = asyncio.Condition()
        self.head_cond = asyncio.Condition()
        self.bridge.on_camera_frame = self._camera_frame
        self.bridge.mission.on_frame = self._head_frame
        self._ticker = asyncio.ensure_future(self.ticker())
        if self.opts.exit_with_parent:
            asyncio.ensure_future(self._parent_watch(os.getppid()))
        if self.opts.mock:
            await self.stacks.start_mock(self.opts.mock_script, self.opts.mock_args)
        self._prev_mode = None
        urls = [f'http://{self.opts.http_host}:{self.opts.port}']
        if self.opts.tls_ready:
            urls.append(f'https://{self.opts.host}:{self.opts.https_port}')
        self.log('info', 'server', f"dashboard up on {' and '.join(urls)} "
                 f'(mock={self.opts.mock}, use_sim_time={self.opts.use_sim_time}); app at /, console at /console/')
        self.update_light()

    async def _parent_watch(self, ppid):
        while True:
            await asyncio.sleep(1.0)
            if os.getppid() != ppid:
                self.log('warn', 'server', 'parent process exited: shutting down')
                os.kill(os.getpid(), signal.SIGINT)
                return

    async def _on_shutdown(self, app):
        self._ticker.cancel()
        for c in list(self.clients):
            await c['ws'].close()
        await self.stacks.stop_all()


PLACEHOLDER = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>G1 robot</title>
<style>body{font:18px -apple-system,system-ui,sans-serif;margin:2rem;background:#f4f5f7;color:#1b1f24}
a{color:#0b5cad}code{background:#e6e8eb;padding:2px 4px;border-radius:4px}</style></head><body>
<h1>G1 iPad app: not installed yet</h1>
<p>The iPad app (<code>hospital-sim-ui/app/index.html</code>) has not been built yet. The engineering console is at
<a href="/console/">/console/</a>. WebSocket protocol: <code>hospital-sim-ui/PROTOCOL.md</code> (v2).</p>
<p>iPad certificate: <a href="/tls/ca.crt">download the robot CA</a> (see hospital-sim-ui/README.md).</p></body></html>"""
