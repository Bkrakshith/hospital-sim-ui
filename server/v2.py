"""v2 WebSocket ops for the iPad app (hospital-sim-ui/PROTOCOL.md v2): sessions and roles, the control lease, Stop / Resume /
Power off, alarms, closed-loop requests with undo, places, instruments, start-of-day checks, handover card,
incidents and the audit log. Mixed into app.Dashboard (which owns the WebSocket hub and the v1 ops)."""
import asyncio
import json
import math
import os
import secrets
import time

from . import catalog as cat
from .auth import ROLES, RANK, allowed, is_motion
from .checks import run_checks

HOLD, DAMP, STAND = 6, 0, 1
MODE_INFO = {
    'DAMP': {'family': 'off', 'label': 'Powered down'},
    'STAND': {'family': 'standby', 'label': 'Standing by'},
    'HOLD': {'family': 'stopped', 'label': 'Stopped'},
    'LOCO': {'family': 'person', 'label': 'Manual walking'},
    'MANIP': {'family': 'person', 'label': 'Manual arms'},
    'NAV': {'family': 'robot', 'label': 'Driving'},
    'AUTO': {'family': 'robot', 'label': 'Working on a task'},
}
READ_OPS = {'ping', 'heartbeat', 'places_list', 'instruments_list', 'lease_status', 'get_map', 'maps_list',
            'routes_list', 'zones_list', 'checks_status', 'handover_card', 'audit_list', 'audit_verify',
            'incidents_list', 'incident_get', 'alarm_stats', 'logs_get', 'checks_run'}
COALESCE_OPS = {'key', 'cmd_vel'}          # high rate: at most one audit line per client per second
MANUAL_MODES = {'LOCO', 'MANIP', 2, 3}
MANUAL_KEYS = set('lwsadqem')              # keys that start or drive manual motion (need the lease in v2)
# mission tree step (substring, lower case) -> plain-language sentence ({i} = instrument name)
# Eponymous instrument names keep their capital mid-sentence ("the Mayo scissors", "the needle driver").
_EPONYMS = ('Mayo', 'Adson', 'Veress', 'Kelly', 'Metzenbaum', 'Hegar', 'Kocher', 'Allis', 'Babcock', 'DeBakey')


def _in_sentence(name):
    if not name or name.split()[0] in _EPONYMS:
        return name or ''
    return name[0].lower() + name[1:]


STEP_TEXT = [('waitforrequest', 'Ready for an instrument request'), ('locate', 'Finding the {i}'),
             ('pick', 'Picking up the {i}'), ('carry', 'Bringing the {i} to the surgeon'),
             ('tosurgeon', 'Bringing the {i} to the surgeon'), ('handover', 'Handing the {i} to the surgeon'),
             ('retract', 'Moving the arm back'), ('returntoready', 'Moving the arm back'),
             ('backtotable', 'Going back to the instrument table'), ('recover', 'Recovering after a problem'),
             ('reachstation', 'Going to the instrument table'), ('goto', 'Going to the instrument table'),
             ('toready', 'Getting ready at the instrument table'), ('finealign', 'Lining up at the table'),
             ('ensureauto', 'Starting the task')]
STOP_REASONS = ('person_in_way', 'wrong_task', 'behaving_oddly', 'other')


class V2Mixin:
    # ================================================================== identity helpers
    def src(self, c):
        return 'ui:' + c['session']['device_id']

    def display(self, c):
        s = c['session']
        return s['device_name'] + (f" · {s['user']}" if s.get('user') else '')

    def who(self, c):
        s = c['session']
        return {'device_id': s['device_id'], 'device_name': s['device_name'], 'role': s['role'], 'user': s['user']}

    def lease(self):
        return self.bridge.latest.get('lease') or {}

    def lease_holder(self):
        return self.lease().get('holder') or ''

    def mode_now(self):
        m = self.bridge.latest['mode'] if self.bridge else None
        return m['name'] if m else None

    def manager(self):
        m = self.bridge.latest.get('manager')
        return m if isinstance(m, dict) else {}

    def device_label(self, source):
        """'ui:ipad-1' -> 'iPad OR-1 (R. Kumar)' using connected / known devices."""
        if not source:
            return '?'
        if source.startswith('ui:'):
            d = self.devices.get(source[3:])
            if d:
                return d['name'] + (f" ({d['user']})" if d.get('user') else '')
            return source[3:]
        return {'keyboard': 'robot keyboard', 'watchdog': 'safety watchdog (controller lost)',
                'estop_hw': 'hardware e-stop', 'lease': 'control handover', 'safety': 'robot safety (fall)',
                'mission': 'robot task', 'init': 'start-up'}.get(source, source)

    # ================================================================== session plumbing
    def new_client_session(self, c, request):
        peer = (request.remote or '')
        c['loopback_http'] = (request.scheme == 'http' and peer in ('127.0.0.1', '::1', 'localhost'))
        c['v2'] = False
        dev = f'console-{os.urandom(3).hex()}'
        role = self.opts.localhost_role if c['loopback_http'] else 'clinical'
        c['session'] = self.auth.new_session(dev, f'Console {peer}', '', role=role)
        c['last_hb'] = None
        c['audit_last'] = {}
        self._register_device(c)

    def _register_device(self, c):
        s = c['session']
        self.devices[s['device_id']] = {'name': s['device_name'], 'room': s['room'], 'role': s['role'],
                                        'user': s['user'], 'connected': True, 'v2': c.get('v2', False)}

    def push_session(self, c):
        s = self.auth.public(c['session'])
        s['lease_holder'] = self.lease_holder() == self.src(c)
        self.send(c, {'type': 'session', **s})
        self._register_device(c)

    def send(self, c, msg):
        try:
            c['q'].put_nowait(json.dumps(msg, separators=(',', ':'), default=str))
        except asyncio.QueueFull:
            pass

    def hello_v2(self):
        return {'mode_info': MODE_INFO, 'roles': list(ROLES), 'stop_reasons': list(STOP_REASONS),
                'places': cat.places_for(self.places, 'clinical'), 'zones': cat.load_zones(),
                'timeline': list(self.timeline)[-100:], 'undo_s': self.pending.undo_s,
                'heartbeat_hz_min': 5, 'watchdog_s': 1.0, 'versions': self.versions()}

    def versions(self):
        c = self.bridge.latest.get('controller') or {}
        app_v = None
        for p in ('VERSION', 'version.txt'):
            fp = os.path.join(self.opts.app_dir, p)
            if os.path.isfile(fp):
                app_v = open(fp).read().strip()
        return {'protocol': 2, 'server': '2.0.0', 'app': app_v, 'policy': c.get('policy'),
                'placeholder': c.get('placeholder'), 'map': self.active_map,
                'ros_distro': os.environ.get('ROS_DISTRO'), 'sim': bool(self.bridge.latest.get('sim'))}

    # ================================================================== the gate (every op)
    async def gated(self, c, msg):
        op = str(msg.get('op'))
        s = c['session']
        if self.auth.expire_idle(s):
            self.push_session(c)
        ok_role, need = allowed(s['role'], op, msg)
        if need is None and not hasattr(self, 'op_' + op):
            return False, f'unknown op {op!r}', {'code': 'unknown_op'}
        if not ok_role:
            res = (False, f"'{op}' is not allowed for role {s['role']}"
                   + (f' (needs {need})' if need else ''), {'code': 'forbidden', 'need': need})
            self.audit_op(c, op, msg, res, refused=True)
            return res
        if is_motion(op, msg):
            holder = self.lease_holder()
            if holder and holder != self.src(c):
                res = (False, f"{self.lease().get('display') or holder} is in control: ask them or take control",
                       {'code': 'lease', 'holder': self.lease()})
                self.audit_op(c, op, msg, res, refused=True)
                return res
            if c['v2'] and self._manual(op, msg) and holder != self.src(c):
                res = (False, 'take control first (lease_acquire)', {'code': 'need_lease'})
                self.audit_op(c, op, msg, res, refused=True)
                return res
        if op not in ('heartbeat', 'ping'):
            self.auth.touch(s)
        res = await self.handle(c, msg)
        if op not in ('heartbeat', 'ping'):
            self.audit_op(c, op, msg, res)
            if op not in READ_OPS:
                self.alarms.note_command()
        return res

    def _manual(self, op, msg):
        if op == 'cmd_vel':
            return True
        if op == 'key':
            return str(msg.get('key', '')).lower() in MANUAL_KEYS
        if op == 'set_mode':
            m = msg.get('mode')
            return (m.upper() if isinstance(m, str) else m) in MANUAL_MODES
        return False

    def audit_op(self, c, op, msg, res, refused=False):
        if op in READ_OPS and not refused:
            return
        now = time.time()
        if op in COALESCE_OPS and not refused:
            last = c['audit_last'].get(op)
            if last and now - last[0] < 1.0:
                last[1] += 1
                return
            n = last[1] if last else 0
            c['audit_last'][op] = [now, 0]
        else:
            n = 0
        ok, message, _data = res
        s = c['session']
        from .audit import scrub
        e = self.audit.append(device=s['device_id'], device_name=s['device_name'], role=s['role'], user=s['user'],
                              lease_holder=self.lease_holder(), op=op, args=scrub(msg), ok=bool(ok),
                              refused=refused, message=str(message)[:300], mode=self.mode_now(),
                              **({'coalesced': n} if n else {}))
        self.ring.add('command', {k: e[k] for k in ('seq', 'device', 'role', 'user', 'op', 'args', 'ok',
                                                    'refused', 'message', 'mode')})

    # ================================================================== session ops
    async def op_hello(self, m, c):
        dev = str(m.get('device_id') or '').strip()[:64]
        if not dev:
            return False, 'device_id required', None
        c['v2'] = int(m.get('protocol', 2)) >= 2
        s = self.auth.resume(m.get('token'), dev)
        if s is None:
            role = self.opts.localhost_role if c.get('loopback_http') else 'clinical'
            s = self.auth.new_session(dev, str(m.get('device_name') or dev)[:48], str(m.get('room') or '')[:48],
                                      role=role)
        else:
            s['device_name'] = str(m.get('device_name') or s['device_name'])[:48]
            s['room'] = str(m.get('room') or s['room'])[:48]
        old = c['session']['device_id']
        if old != dev and old in self.devices and old.startswith('console-'):
            self.devices.pop(old, None)
        c['session'] = s
        c['app'] = {'app': m.get('app'), 'version': m.get('version')}
        self.push_session(c)
        self.send(c, self.lease_msg(c))
        self.send(c, self.alarms.view(s['role']))
        return True, f"hello {s['device_name']}: role {s['role']}", {'session': self.auth.public(s)}

    async def op_heartbeat(self, m, c):
        c['last_hb'] = time.time()
        if self.lease_holder() == self.src(c):
            self.bridge.publish_heartbeat(self.src(c))
        return True, '', None

    async def op_login(self, m, c):
        ok, message, code = self.auth.login(c['session'], str(m.get('role', '')), str(m.get('pin', '')),
                                            m.get('user'), m.get('badge'))
        self.push_session(c)
        return ok, message, {'code': code, 'session': self.auth.public(c['session'])}

    async def op_badge_login(self, m, c):
        ok, message, code = self.auth.badge_login(c['session'], str(m.get('badge', '')), m.get('pin'))
        self.push_session(c)
        return ok, message, {'code': code, 'session': self.auth.public(c['session'])}

    async def op_logout(self, m, c):
        if self.lease_holder() == self.src(c):
            await self._lease_call(c, 'release')
        self.auth.logout(c['session'])
        self.push_session(c)
        return True, 'signed out: clinical', {'session': self.auth.public(c['session'])}

    # ================================================================== lease
    def lease_msg(self, c):
        L = self.lease()
        holder = None
        if L.get('holder'):
            did = L['holder'][3:] if L['holder'].startswith('ui:') else None
            d = self.devices.get(did or '', {})
            holder = {'id': L['holder'], 'device_id': did, 'device_name': d.get('name') or L.get('display'),
                      'display': L.get('display'), 'role': L.get('role'), 'user': d.get('user'),
                      'held_for': L.get('held_for'), 'expires_in': L.get('expires_in'),
                      'implicit': L.get('implicit'), 'reason': L.get('reason')}
        return {'type': 'lease', 'holder': holder, 'you': bool(holder) and holder['id'] == self.src(c)}

    async def _lease_call(self, c, op, reason=''):
        try:
            res = await self.wait_rcl(self.bridge.call_lease(op, self.src(c), c['session']['role'], self.display(c),
                                                             reason), 3.0)
        except asyncio.TimeoutError:
            return False, 'lease service timed out', None
        except Exception as e:  # noqa: BLE001
            return False, str(e), None
        if res.ok and op in ('acquire', 'steal'):
            self.bridge.publish_heartbeat(self.src(c))
        return bool(res.ok), res.message, {'holder': res.holder, 'display': res.display,
                                           'expires_in': round(res.expires_in, 1)}

    async def op_lease_acquire(self, m, c):
        return await self._lease_call(c, 'acquire', str(m.get('reason') or ''))

    async def op_lease_release(self, m, c):
        return await self._lease_call(c, 'release')

    async def op_lease_steal(self, m, c):
        reason = str(m.get('reason') or '').strip()
        if not reason:
            return False, 'a reason is required to take control', {'code': 'need_reason'}
        prev = self.lease_holder()
        ok, message, data = await self._lease_call(c, 'steal', reason)
        if ok and prev and prev != self.src(c):
            for cl in self.clients:
                if self.src(cl) == prev:
                    self.send(cl, {'type': 'toast', 'level': 'warn',
                                   'msg': f'{self.display(c)} took control: {reason}'})
            self.add_event('lease', f'{self.display(c)} took control from {self.device_label(prev)}: {reason}',
                           self.who(c))
        return ok, message, data

    async def op_lease_status(self, m, c):
        return True, '', self.lease_msg(c)

    def on_lease_changed(self):
        L = self.lease()
        cur = L.get('holder') or ''
        if cur != self._last_lease_holder:
            txt = (f'{self.device_label(cur)} is in control' if cur else 'Nobody holds control')
            self.add_event('lease', txt, None)
            self.ring.add('lease', L)
            self._last_lease_holder = cur
        for cl in list(self.clients):
            self.send(cl, self.lease_msg(cl))

    # ================================================================== stop / resume / power off
    async def op_stop(self, m, c):
        reason = m.get('reason')
        self.hold_ctx = {'t': time.time(), 'source': self.src(c), 'by': self.who(c), 'reason': reason}
        try:
            ok, message = await self.set_mode(HOLD, source=self.src(c))
        except Exception as e:  # noqa: BLE001
            ok, message = False, str(e)
        if not ok and 'powered off' not in message:
            # belt and braces: the key topic is always handled by the manager (HOLD from anyone)
            self.bridge.publish_key('o')
            message = f'stop sent on the key topic ({message})'
            ok = True
        self.bridge.publish_cmd_vel(0, 0, 0)
        await self._pause_nav_for_hold()
        self.log('warn', 'ui', f'STOP by {self.display(c)} ({c["session"]["role"]})')
        return True, message, {'hold': self.hold_state()}

    async def op_stop_reason(self, m, c):
        r = str(m.get('reason', 'other'))
        if r not in STOP_REASONS:
            return False, f'reason must be one of {STOP_REASONS}', None
        if self.hold_ctx:
            self.hold_ctx['reason'] = r
            self.hold_ctx['note'] = str(m.get('note') or '')[:200]
        self.add_event('stop_reason', f'Stop reason: {r.replace("_", " ")}', self.who(c))
        return True, 'reason recorded', None

    async def op_power_off(self, m, c):
        self.bridge.publish_cmd_vel(0, 0, 0)
        if self.bridge.nav['state'] in ('active', 'sending'):
            self.bridge.cancel_nav()
        try:
            ok, message = await self.set_mode(DAMP, source=self.src(c))
        except Exception as e:  # noqa: BLE001
            ok, message = False, str(e)
        if not ok:
            self.bridge.publish_key('x')
            message = f'power off sent on the key topic ({message})'
        self.alarms.raise_('power_off', by=f' by {self.display(c)}')
        self.log('warn', 'ui', f'POWER OFF by {self.display(c)}')
        return True, message, None

    async def op_estop(self, m, c):        # v1 alias
        return await self.op_power_off(m, c)

    async def _pause_nav_for_hold(self):
        if self.bridge.nav['state'] in ('active', 'sending'):
            fut = self.bridge.cancel_nav(pause=True)
            self.nav_paused_by_hold = True
            if fut is not None:
                try:
                    await self.wait_rcl(fut, 2.0)
                except Exception:  # noqa: BLE001
                    pass

    def hold_state(self):
        mode = self.bridge.latest['mode']
        if not mode or mode['mode'] != HOLD:
            return None
        mh = self.manager().get('hold') or {}
        src = mode.get('source', '')
        ctx = self.hold_ctx if (self.hold_ctx and self.hold_ctx.get('source') == src) else None
        held_from = mh.get('from')
        mission = self.bridge.mission.status or {}
        task = None
        if held_from == 'AUTO' and mission.get('paused_by_hold'):
            kind = mission.get('kind', '')
            if kind.startswith('goto:'):
                p = self.place_by_location(kind[5:])
                d = self.distance_to(p)
                task = {'kind': 'mission', 'place': p['id'] if p else kind[5:],
                        'text': f"Continue to {p['name'] if p else kind[5:]}" + (f' ({d:.0f} m)' if d else '')}
            else:
                inst = mission.get('instrument')
                task = {'kind': 'mission', 'text': 'Continue the instrument task'
                        + (f" ({self.inst_name(inst)})" if inst else '')}
        elif held_from == 'NAV' and self.bridge.nav['state'] == 'paused':
            fb = self.bridge.nav.get('feedback') or {}
            d = fb.get('distance_remaining')
            name = self.nav_place
            task = {'kind': 'nav', 'place': name,
                    'text': (f'Continue to {name}' if name else 'Continue driving')
                    + (f' ({d:.0f} m)' if d else '')}
        estop = self.manager().get('estop') or {}
        return {'since': (ctx or {}).get('t') or mh.get('since'), 'source': src,
                'by': (ctx or {}).get('by') or {'label': self.device_label(src)},
                'by_label': self.device_label(src), 'reason': (ctx or {}).get('reason'),
                'detail': mode.get('detail'), 'held_from': held_from, 'resume_task': task,
                'resume_blocked': 'Release the hardware e-stop first' if estop.get('pressed') else None}

    async def op_resume(self, m, c):
        to = m.get('to', 'stand')
        if self.mode_now() != 'HOLD':
            return False, f'robot is not stopped (mode {self.mode_now()})', None
        h = self.hold_state() or {}
        if h.get('resume_blocked'):
            return False, h['resume_blocked'], None
        task = h.get('resume_task')
        if to == 'task' and task:
            if task['kind'] == 'mission':
                self.bridge.mission.command('resume')
                for _ in range(40):
                    await asyncio.sleep(0.1)
                    if self.mode_now() == 'AUTO':
                        return True, 'task resumed', {'did': task['text']}
                return False, (self.bridge.mission.status or {}).get('message', 'mission did not resume'), None
            if task['kind'] == 'nav':
                ok, message = await self.set_mode(STAND, source=self.src(c))
                if not ok:
                    return False, message, None
                for _ in range(40):          # wait out a (short) arm blend
                    if not self.manager().get('blending'):
                        break
                    await asyncio.sleep(0.1)
                self.nav_paused_by_hold = False
                ok, message, _ = await self.op_nav_resume({}, c)
                return ok, message, {'did': task['text']}
        ok, message = await self.set_mode(STAND, source=self.src(c))
        return ok, message, {'did': 'Standing by (arms return to rest)'}

    # ================================================================== MANIP arms hold, gripper override
    async def _await_manager(self, pred, timeout=1.5):
        t0 = time.time()
        while time.time() - t0 < timeout:
            if pred(self.manager()):
                return True
            await asyncio.sleep(0.05)
        return False

    async def op_manip_hold(self, m, c):
        on = bool(m.get('on', True))
        if self.mode_now() != 'MANIP':
            return False, f'arms hold is only possible while using the arms (mode {self.mode_now()})', None
        self.bridge.publish_arms_hold(on, self.src(c))
        ok = await self._await_manager(lambda mg: bool(mg.get('arms_hold')) == on)
        msg = self.manager().get('last_message', '')
        if ok:
            self.add_event('arms_hold', 'Arms held' if on else 'Arms follow the operator again', self.who(c))
        return ok, msg or ('arms held' if on else 'arms released'), {'arms_hold': bool(self.manager().get('arms_hold'))}

    async def op_hand(self, m, c):
        side = m.get('side')
        if side not in ('left', 'right'):
            return False, 'side must be left or right', None
        try:
            close = float(m.get('close'))
        except (TypeError, ValueError):
            return False, 'close must be a number 0 (open) .. 1 (closed)', None
        if not 0.0 <= close <= 1.0:
            return False, 'close must be 0 (open) .. 1 (closed)', None
        if not self.manager().get('hand_override_allowed'):
            return False, ('gripper override only while stopped (HOLD) or with the arms held in manual arms '
                           f'(mode {self.mode_now()})'), {'code': 'not_now'}
        before = (self.manager().get('hand_override') or {}).get('t')
        self.bridge.publish_hand_override(side, close, self.src(c))
        ok = await self._await_manager(lambda mg: (mg.get('hand_override') or {}).get('t') != before)
        msg = self.manager().get('last_message', '')
        if ok:
            self.add_event('hand_override', f"{side.capitalize()} hand {'closed' if close > 0.5 else 'opened'} "
                                            f'by {self.display(c)}', self.who(c))
        return ok, msg, {'hand_override': self.manager().get('hand_override')}

    # ================================================================== alarms
    async def op_alarm_ack(self, m, c):
        return (*self.alarms.acknowledge(int(m.get('alarm_id', -1)), self.display(c), c['session']['device_id']), None)

    async def op_alarm_suppress(self, m, c):
        return (*self.alarms.suppress(str(m.get('code', ''))), None)

    async def op_alarm_stats(self, m, c):
        return True, '', {'stats': self.alarms.budget(), 'history': self.alarms.history[-50:]}

    def on_alarms_changed(self):
        self._alarms_dirty = True

    def flush_alarms(self):
        if not self._alarms_dirty:
            return
        self._alarms_dirty = False
        for cl in list(self.clients):
            self.send(cl, self.alarms.view(cl['session']['role']))
        self.ring.add('alarms', [{k: a[k] for k in ('code', 'priority', 'condition_active', 'acknowledged')}
                                 for a in self.alarms.active.values()])
        self.update_light()

    def update_light(self):
        d = self.alarms.light(self.mode_now())
        if d != self._light:
            self._light = d
            self.bridge.publish_light(d)

    def add_event(self, kind, text, by):
        e = {'type': 'event', 't': round(time.time(), 2), 'kind': kind, 'text': text, 'by': by}
        self.timeline.append(e)
        self.ring.add('event', e)
        self.broadcast(e)

    def say(self, text):
        self.bridge.say(text)
        self.ring.add('say', text)

    # ================================================================== requests with undo
    def place_by_id(self, pid):
        return next((p for p in self.places if p['id'] == pid), None)

    def place_by_location(self, loc):
        return next((p for p in self.places if p['location'] == loc and p['id'] == loc), None) or \
            next((p for p in self.places if p['location'] == loc), None)

    def inst_name(self, iid):
        e = self.instruments_cat.get(iid)
        return e['name'] if e else str(iid).replace('_', ' ')

    def _can_dispatch(self):
        mode = self.mode_now()
        if mode == 'HOLD':
            return 'Robot is stopped: resume first'
        if mode in ('DAMP', None):
            return 'Robot is powered down'
        if mode in ('LOCO', 'MANIP'):
            return 'Someone is driving the robot by hand'
        return None

    async def op_send_to(self, m, c):
        p = self.place_by_id(str(m.get('place', '')))
        if p is None:
            return False, f"unknown place {m.get('place')!r}", None
        if c['session']['role'] not in p['allowed_roles']:
            return False, f"{p['name']} is not available for role {c['session']['role']}", {'code': 'forbidden'}
        why = self._can_dispatch()
        if why:
            return False, why, None
        text = f"Going to {p['name']}"

        async def dispatch():
            why2 = self._can_dispatch()
            if why2:
                return False, why2
            return await self._goto(p, c)
        pend = self.pending.add('send_to', text, dispatch, by=self.who(c), speak=text, args={'place': p['id']})
        self.say(text)
        return True, text, {'pending': pend}

    async def _goto(self, p, c):
        st = self.bridge.mission.status
        if st is not None:
            if st.get('state') in ('running', 'paused'):
                return False, f"Robot is busy ({st.get('kind')}): cancel it first"
            if self.mode_now() == 'NAV':
                await self.op_nav_cancel({}, c)
                await self.set_mode(STAND, source=self.src(c))
            self.bridge.mission.command(f"goto:{p['location']}")
            self.add_event('send_to', f"Going to {p['name']}", self.who(c))
            return True, f"going to {p['name']}"
        # no mission executive: plain Nav2 goal
        ok, message, _ = await self.op_nav_goal({'x': p['x'], 'y': p['y'], 'yaw': p['yaw'] or 0.0}, c)
        self.nav_place = p['name'] if ok else None
        if ok:
            self.add_event('send_to', f"Going to {p['name']}", self.who(c))
        return ok, message

    async def op_instrument_request(self, m, c):
        iid = str(m.get('instrument', '')).strip()
        inst = self.instruments_cat.get(iid)
        if inst is None:
            return False, f'unknown instrument {iid!r}', None
        state = next((i for i in self.instrument_list() if i['id'] == iid), {})
        if state.get('rack_count') == 0:
            return False, f"No {_in_sentence(inst['name'])} on the rack: hand it to the scrub nurse manually", \
                {'code': 'not_on_rack'}
        why = self._can_dispatch()
        if why and not (self.mode_now() == 'AUTO'):
            return False, why, None
        if not self.bridge.mission.request_available():
            return False, 'the scrub-assist task is not running on the robot', {'code': 'no_mission'}
        requester = str(m.get('requester') or 'surgeon')[:24]
        text, speak = cat.readback_instrument(inst, requester)

        async def dispatch():
            try:
                res = await self.wait_rcl(self.bridge.mission.request(iid, requester), 5.0)
            except Exception as e:  # noqa: BLE001
                return False, str(e)
            if res.accepted:
                self.add_event('instrument', f"Requested {inst['name']} for {requester}", self.who(c))
            return bool(res.accepted), res.message
        pend = self.pending.add('instrument_request', text, dispatch, by=self.who(c), speak=speak,
                                args={'instrument': iid, 'requester': requester})
        self.say(speak)
        return True, text, {'pending': pend}

    async def op_undo(self, m, c):
        ok, message = self.pending.undo(str(m.get('pending_id', '')), self.who(c))
        if ok:
            self.say('Cancelled')
        return ok, message, None

    async def op_cancel_task(self, m, c):
        did = []
        for p in self.pending.list():
            self.pending.undo(p['id'], self.who(c))
            did.append(f"undid {p['text']}")
        st = self.bridge.mission.status or {}
        if st.get('state') in ('running', 'paused'):
            self.bridge.mission.command('abort')
            did.append(f"cancelled {st.get('kind')}")
        if self.bridge.nav['state'] in ('active', 'sending', 'paused'):
            await self.op_nav_cancel({}, c)
            did.append('cancelled navigation')
        if self.mode_now() in ('NAV',):
            await self.set_mode(STAND, source=self.src(c))
        if not did:
            return True, 'nothing to cancel', {'did': []}
        self.add_event('cancel', 'Task cancelled', self.who(c))
        return True, '; '.join(did), {'did': did}

    # ================================================================== data
    async def op_places_list(self, m, c):
        return True, '', {'places': cat.places_for(self.places, c['session']['role'])}

    def instrument_list(self):
        return cat.instrument_state(self.instruments_cat, self.bridge.mission.objects, self.bridge.mission.status)

    async def op_instruments_list(self, m, c):
        return True, '', {'instruments': self.instrument_list()}

    async def op_zones_list(self, m, c):
        return True, '', cat.load_zones()

    def check_snapshot(self):
        b = self.bridge
        th = b.topic_health()
        mg = self.manager()
        st = th.get('/g1/teleop/manager_status')
        bat = b.latest.get('battery') or {}
        temps = b.latest.get('temps') or {}
        amcl = b.latest.get('amcl_pose')
        pose = b.robot_pose()
        estop = dict(mg.get('estop') or {})
        if not estop:
            e = b.estop
            estop = {'alive': e['last'] is not None and time.time() - e['last'] < 0.5, 'pressed': e['pressed'],
                     'reason': 'no manager status'}
        v = self.versions()
        return {'manager_age': st, 'estop': estop, 'estop_test_t': b.estop.get('test_t'),
                'battery_soc': bat.get('soc'), 'controller': b.latest.get('controller'),
                'temp_max': temps.get('max'), 'scan_age': th.get('/scan'), 'camera_age': th.get('camera'),
                'localised': bool(pose and pose.get('frame') == 'map'), 'amcl_std': (amcl or {}).get('std_xy'),
                'active_map': self.active_map,
                'versions_text': f"server {v['server']} · app {v['app'] or '?'} · policy {v['policy'] or '?'}"}

    async def op_checks_run(self, m, c):
        r = run_checks(self.check_snapshot())
        self.last_checks = r
        return True, 'ready' if r['ready'] else 'not ready', r

    async def op_checks_record(self, m, c):
        part = m.get('part', 'nurse')
        if part not in ('nurse', 'technician'):
            return False, 'part must be nurse or technician', None
        if part == 'technician' and RANK[c['session']['role']] < RANK['technician']:
            return False, 'the technician part needs a technician sign-in', {'code': 'forbidden'}
        answers = m.get('answers') or {}
        results = self.last_checks or run_checks(self.check_snapshot())
        ok = all(bool(v) for v in answers.values()) and (part == 'nurse' or results['ready'])
        rec = {'t': time.time(), 'part': part, 'answers': answers, 'ok': ok, 'by': self.who(c),
               'results': [{k: i[k] for k in ('id', 'status', 'value')} for i in results['items']]}
        self.checks_store.record(rec)
        self.add_event('checks', f"Start-of-day {part} check {'passed' if ok else 'NOT passed'}", self.who(c))
        return True, 'recorded', {'ok': ok}

    async def op_checks_status(self, m, c):
        recs = self.checks_store.today()
        nurse = [r for r in recs if r['part'] == 'nurse' and r['ok']]
        tech = [r for r in recs if r['part'] == 'technician' and r['ok']]
        return True, '', {'today': recs[-10:], 'nurse_ok': bool(nurse), 'technician_ok': bool(tech),
                          'ready_for_today': bool(nurse) and bool(tech)}

    async def op_handover_card(self, m, c):
        now = time.time()
        since = m.get('since') or (now - 12 * 3600)
        ents = self.audit.tail(limit=5000, since_t=since)
        trips = sum(1 for e in ents if e.get('op') == 'send_to' and e.get('ok'))
        mission = self.bridge.mission.status or {}
        handed = [h for h in (mission.get('history') or []) if h.get('success')]
        incidents = [i for i in self.incidents.list() if (i.get('created') or 0) >= since]
        bat = self.bridge.latest.get('battery') or {}
        mode = self.bridge.latest['mode'] or {}
        return True, '', {
            'since': since, 'now': now, 'mode': mode.get('name'),
            'mode_label': MODE_INFO.get(mode.get('name'), {}).get('label'),
            'task': {'mission': mission.get('state'), 'kind': mission.get('kind'), 'step': mission.get('step')}
            if mission else None,
            'lease': self.lease_msg(c)['holder'], 'trips': trips,
            'instruments_handed': [{'name': self.inst_name(h['instrument']), 'instrument': h['instrument'],
                                    't': h.get('t') or self.handed_seen.get(self._hkey(h)),
                                    'duration': h.get('duration')} for h in handed
                                   if (h.get('t') or self.handed_seen.get(self._hkey(h)) or now) >= since],
            'instrument_counts': mission.get('counts'),
            'alarms_open': [{k: a[k] for k in ('priority', 'what', 'since')}
                            for a in self.alarms.active.values() if not a['tech_only']],
            'alarms_today': sum(s['raised'] for s in self.alarms.stats.values()),
            'incidents_open': [{k: i.get(k) for k in ('id', 'created_iso', 'chips')} for i in incidents
                               if i.get('status') == 'open'],
            'battery': bat.get('soc'), 'suppressed': sorted(self.alarms.suppressed),
            'notes': [e['text'] for e in list(self.timeline)[-8:]]}

    async def op_event_log(self, m, c):
        kind = str(m.get('kind', 'note'))[:24]
        text = str(m.get('text', ''))[:200]
        self.add_event(kind, text, self.who(c))
        return True, 'logged', None

    # ================================================================== incidents / audit / logs
    def incident_state(self):
        b = self.bridge
        return {'mode': b.latest['mode'], 'manager': self.manager(), 'controller': b.latest.get('controller'),
                'lease': self.lease(), 'hold': self.hold_state(), 'nav': dict(b.nav),
                'mission': {k: (b.mission.status or {}).get(k) for k in ('state', 'kind', 'step', 'instrument',
                                                                           'message', 'history', 'counts')},
                'alarms': self.alarms.view('technician')['active'], 'pose': b.robot_pose(),
                'battery': b.latest.get('battery'), 'temps': b.latest.get('temps'), 'topics': b.topic_health(),
                'clients': len(self.clients), 'devices': self.devices}

    async def op_incident_create(self, m, c):
        chips = [str(x)[:24] for x in (m.get('chips') or [])][:8]
        iid, path, meta = self.incidents.create(self.ring, {
            'by': self.who(c), 'chips': chips, 'note': str(m.get('note') or '')[:500],
            'versions': self.versions(), 'state': self.incident_state()})
        self.add_event('incident', f'{iid} sent to technician', self.who(c))
        for cl in self.clients:
            if cl['session']['role'] == 'technician':
                self.send(cl, {'type': 'toast', 'level': 'warn', 'msg': f"{iid} from {self.display(c)}: "
                                                                          f"{', '.join(chips) or 'problem'}"})
        return True, f'{iid}: technician notified', {'id': iid, 'file': os.path.relpath(path, self.opts.ui_dir)}

    async def op_incident_link(self, m, c):
        """One-time, 60 s download link: keeps the session token out of URLs and server logs."""
        iid = str(m.get('incident_id', ''))
        if self.incidents.path(iid) is None:
            return False, 'no such incident', None
        now = time.time()
        self.dl_tokens = {k: v for k, v in self.dl_tokens.items() if v[1] > now}
        tok = secrets.token_urlsafe(18)
        self.dl_tokens[tok] = (iid, now + 60.0)
        return True, '', {'url': f'/api/incidents/{iid}.zip?dl={tok}', 'expires_in': 60, 'one_time': True}

    def take_download_token(self, tok, iid):
        v = self.dl_tokens.pop(tok or '', None)
        return v is not None and v[0] == iid and v[1] > time.time()

    async def op_incidents_list(self, m, c):
        return True, '', {'incidents': self.incidents.list()}

    async def op_incident_get(self, m, c):
        d = self.incidents.get(str(m.get('incident_id', '')))
        if d is None:
            return False, 'no such incident', None
        return True, '', d

    async def op_audit_list(self, m, c):
        lim = max(1, min(2000, int(m.get('limit', 200))))
        return True, '', {'entries': self.audit.tail(lim, m.get('before_seq'))}

    async def op_audit_verify(self, m, c):
        r = self.audit.verify()
        return r['ok'], 'chain intact' if r['ok'] else f"chain broken at seq {r['bad_seq']}: {r['reason']}", r

    async def op_logs_get(self, m, c):
        return True, '', {'entries': list(self.logs)[-int(m.get('limit', 400)):]}

    # ================================================================== task sentence, history
    def distance_to(self, place):
        pose = self.bridge.robot_pose()
        if not place or not pose or pose.get('frame') != 'map' or place.get('x') is None:
            return None
        return math.hypot(place['x'] - pose['x'], place['y'] - pose['y'])

    def nearest_place(self, tol=0.8):
        best = None
        for p in self.places:
            d = self.distance_to(p)
            if d is not None and d < tol and (best is None or d < best[0]):
                best = (d, p)
        return best[1] if best else None

    def task_state(self):
        """Plain-language sentence for what the robot is doing now (state.task)."""
        mode = self.mode_now()
        mg = self.manager()
        mission = self.bridge.mission.status or {}
        nav = self.bridge.nav
        out = {'kind': (mode or 'unknown').lower(), 'text': '', 'place': None, 'distance': None, 'eta': None}
        L = self.lease()
        holder = self.device_label(L.get('holder')) if L.get('holder') else None
        if mode is None:
            out['text'] = 'No contact with the robot'
        elif mode == 'DAMP':
            out['text'] = 'Powered down'
        elif mode == 'HOLD':
            h = self.hold_state() or {}
            out['text'] = f"Stopped by {h.get('by_label') or '?'}"
            if h.get('resume_task'):
                out['paused_task'] = h['resume_task']['text'].replace('Continue ', '', 1)
        elif mode == 'LOCO':
            out['text'] = 'Manual walking' + (f' — {holder}' if holder else '')
        elif mode == 'MANIP':
            out['text'] = 'Manual arms' + (f' — {holder}' if holder else '') + \
                (' (arms held)' if mg.get('arms_hold') else '')
        elif mode == 'NAV':
            fb = nav.get('feedback') or {}
            g = nav.get('goal') or {}
            dest = self.nav_place or (f"point ({g['x']:.1f}, {g['y']:.1f})" if g else 'the route')
            out.update(place=self.nav_place, distance=fb.get('distance_remaining'), eta=fb.get('eta'))
            if nav['state'] in ('active', 'sending'):
                out['text'] = f'Going to {dest}'
            else:
                out['text'] = 'Navigation ready'
        elif mode == 'AUTO':
            kind = mission.get('kind', '')
            if kind.startswith('goto:'):
                p = self.place_by_location(kind[5:])
                out.update(kind='goto', place=p['id'] if p else kind[5:], distance=self.distance_to(p))
                out['text'] = f"Going to {p['name'] if p else kind[5:]}"
            else:
                step = (mission.get('step') or '').lower().replace('_', '')
                inst = _in_sentence(self.inst_name(mission.get('instrument'))) if mission.get('instrument') else \
                    'instrument'
                txt = next((t for k, t in STEP_TEXT if k in step), 'Working on the instrument task')
                out.update(kind='scrub_assist', text=txt.format(i=inst), step=mission.get('step'))
            if mission.get('state') == 'paused':
                out['text'] = 'Paused: ' + out['text'][0].lower() + out['text'][1:]
        elif mode == 'STAND':
            p = self.nearest_place()
            out['place'] = p['id'] if p else None
            out['text'] = 'Arms returning to rest' if mg.get('blending') else \
                ('Standing by' + (f" at {p['name']}" if p else ''))
        if out['distance'] is not None:
            out['distance'] = round(out['distance'], 1)
            if out['text'].startswith('Going to'):
                out['text'] += f" · {out['distance']:.0f} m"
                if out['eta']:
                    out['text'] += f" · ~{out['eta']:.0f} s"
        out['label'] = MODE_INFO.get(mode, {}).get('label')
        return out

    def _hkey(self, h):
        return f"{h.get('instrument')}|{h.get('duration')}|{h.get('success')}"

    def track_mission_history(self):
        """New mission results: timestamps for the handover card; a failed request -> Medium alarm + event;
        a success clears grasp_failed / handover_failed."""
        st = self.bridge.mission.status
        if not st:
            return
        counts = st.get('counts') or {}
        total = int(counts.get('ok', 0)) + int(counts.get('failed', 0))
        if self._hist_total is None or total < self._hist_total:      # first status / mission node restarted
            self._hist_total = total
            return
        new = total - self._hist_total
        self._hist_total = total
        for h in (st.get('history') or [])[-new:] if new > 0 else []:
            self.handed_seen.setdefault(self._hkey(h), round(time.time(), 1))
            name = self.inst_name(h.get('instrument'))
            if h.get('success'):
                self.add_event('handed', f'Handed {name}', None)
                for code in ('grasp_failed', 'handover_failed'):
                    self.alarms.clear(code)            # Medium, not latched: removed
                continue
            why = h.get('message') or 'failed'
            low = why.lower()
            code = 'grasp_failed' if ('pick' in low or 'locate' in low) else 'handover_failed'
            self.alarms.raise_event(code, what=f'{name} ({why})' if code == 'handover_failed' else name)
            self.add_event('task_failed', f'{name}: {why}', None)

    # ================================================================== periodic (1 Hz) + state
    def alarm_snapshot(self):
        b = self.bridge
        th = b.topic_health()
        mg = self.manager()
        est = mg.get('estop') or {}
        bat = b.latest.get('battery') or {}
        temps = b.latest.get('temps') or {}
        mission = b.mission.status or {}
        nav_fb = b.nav.get('feedback') or {}
        if not self.clients:
            self._no_client_since = self._no_client_since or time.time()
        else:
            self._no_client_since = None
        return {'mode': self.mode_now(), 'controller': b.latest.get('controller'),
                'estop_pressed': bool(est.get('pressed')) and not est.get('dev_override'),
                'estop_missing': bool(est) and not est.get('alive') and not est.get('dev_override'),
                'link_lost': (th.get('/g1/teleop/manager_status') or 99) > 2.5,
                'battery_soc': bat.get('soc'), 'temp_max': temps.get('max'), 'temp_hottest': temps.get('hottest'),
                'camera_age': th.get('camera'), 'camera_expected': False,
                'amcl_std': (b.latest.get('amcl_pose') or {}).get('std_xy'),
                'nav_blocked': (nav_fb.get('recoveries') or 0) >= 3 and b.nav['state'] == 'active',
                'mission_state': mission.get('state'), 'clients': len(self.clients),
                'no_client_for': time.time() - self._no_client_since if self._no_client_since else 0.0}

    def every_second(self):
        now = time.time()
        for cl in list(self.clients):
            if self.auth.expire_idle(cl['session']):
                self.push_session(cl)
                self.send(cl, {'type': 'toast', 'level': 'info', 'msg': 'Signed out after inactivity: Clinical'})
                if self.lease_holder() == self.src(cl):
                    asyncio.ensure_future(self._lease_call(cl, 'release'))
        self.track_mission_history()
        self.alarms.evaluate(self.alarm_snapshot())
        self.flush_alarms()
        self.update_light()
        b = self.bridge
        self.ring.add('sample', {'controller': b.latest.get('controller'), 'manager': {
            k: self.manager().get(k) for k in ('mode', 'source', 'detail', 'cmd_vel', 'estop', 'lease', 'zone')},
            'pose': b.robot_pose(), 'battery': b.latest.get('battery'), 'nav': b.nav.get('state'),
            'mission': (b.mission.status or {}).get('state')})
        inst = self.instrument_list()
        key = json.dumps(inst, sort_keys=True)
        if key != self._inst_key:
            self._inst_key = key
            self.broadcast({'type': 'instruments', 'instruments': inst})
        for d in self.devices.values():
            d['connected'] = False
        for cl in self.clients:
            did = cl['session']['device_id']
            self._register_device(cl)
            self.devices[did]['heartbeat_age'] = None if cl['last_hb'] is None else round(now - cl['last_hb'], 1)

    def state_v2(self):
        mg = self.manager()
        est = mg.get('estop') or {}
        locked = list(mg.get('motion_locked') or [])
        return {'hold': self.hold_state(), 'lease': self.lease(),
                'motion': {'locked': bool(locked), 'reasons': locked, 'estop': est, 'zone': mg.get('zone'),
                           'manual_cap': mg.get('manual_cap'),
                           'link_ok': (self.bridge.topic_health().get('/g1/teleop/manager_status') or 99) < 2.5},
                'devices': self.devices, 'session_count': len(self.clients),
                'proximity': self.bridge.proximity(), 'task': self.task_state(),
                'arms_hold': bool(mg.get('arms_hold')), 'hand_override_allowed': bool(mg.get('hand_override_allowed')),
                'pending': self.pending.list(),
                'mission_paused_by_hold': bool((self.bridge.mission.status or {}).get('paused_by_hold'))}

    def on_mode_changed(self, prev, m):
        """Server-side reactions to a /g1/mode change (asyncio thread)."""
        name, src = m['name'], m.get('source', '')
        self.ring.add('mode', m)
        label = MODE_INFO.get(name, {}).get('label', name)
        by = self.device_label(src)
        if prev is None or prev['name'] != name:
            self.add_event('mode', f'Now: {label} — by {by}', {'source': src})
        if name == 'HOLD' and (prev is None or prev['name'] != 'HOLD'):
            asyncio.ensure_future(self._pause_nav_for_hold())
            self.say('Stopped')
            if src == 'watchdog':
                self.alarms.raise_event('manual_control_lost')
        elif prev is not None and prev['name'] == 'HOLD' and name in ('STAND', 'AUTO'):
            self.say('Resuming')
        if name == 'DAMP' and (prev is None or prev['name'] != 'DAMP'):
            if src == 'safety':
                self.alarms.raise_event('fall')
            elif not src.startswith('ui:') and src != 'init':
                self.alarms.raise_('power_off', by=f' by {by}')
        self.update_light()
