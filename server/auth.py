"""Sessions, roles, PINs and the per-role op allow-list (hospital-sim-ui/PROTOCOL.md v2; docs/ui/04 §3, §5; 02 L-3).

Roles are ordered clinical < operator < technician. Every WebSocket op is checked against OP_ROLE (the minimum role)
on the server; the app only hides buttons. PINs are stored as PBKDF2-SHA256 hashes in config/auth.yaml.

CLI:  python hospital-sim-ui/server/auth.py hash <pin>             print a hash for auth.yaml
      python hospital-sim-ui/server/auth.py set-pin <role> <pin>    write the role PIN hash into config/auth.yaml
"""
import hashlib
import hmac
import os
import secrets
import sys
import time

import yaml

ROLES = ('clinical', 'operator', 'technician')
RANK = {r: i for i, r in enumerate(ROLES)}
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CONFIG = os.path.join(HERE, 'config', 'auth.yaml')

# minimum role per op (docs/ui/04 §5). Ops missing here are refused ("unknown op").
C, O, T = 'clinical', 'operator', 'technician'
OP_ROLE = {
    # session / liveness
    'hello': C, 'ping': C, 'heartbeat': C, 'login': C, 'badge_login': C, 'logout': C,
    # safety: every role, every device, lease or not
    'stop': C, 'stop_reason': C, 'power_off': C, 'estop': C, 'resume': C,
    'alarm_ack': C, 'incident_create': C, 'event_log': C,
    # clinical tasks
    'send_to': C, 'cancel_task': C, 'instrument_request': C, 'undo': C,
    # read-only data
    'places_list': C, 'instruments_list': C, 'checks_run': C, 'checks_record': C, 'checks_status': C,
    'handover_card': C, 'lease_status': C, 'get_map': C, 'maps_list': C, 'routes_list': C, 'zones_list': C,
    # mission_command: clinical may pause / abort only (checked in mission_command_role)
    'mission_command': C,
    # operator
    'lease_acquire': O, 'lease_release': O, 'lease_steal': O,
    'set_mode': O, 'key': O, 'cmd_vel': O,
    'nav_goal': O, 'nav_waypoints': O, 'nav_pause': O, 'nav_resume': O, 'nav_cancel': O, 'initial_pose': O,
    'map_load': O, 'mission_request': O, 'route_save': O, 'route_delete': O,
    'manip_hold': O, 'hand': O,
    # technician
    'stack_start': T, 'stack_stop': T, 'map_save': T, 'map_delete': T,
    'audit_list': T, 'audit_verify': T, 'incidents_list': T, 'incident_get': T,
    'alarm_suppress': T, 'alarm_stats': T, 'logs_get': T, 'incident_link': T,
}
CLINICAL_MISSION_COMMANDS = {'pause', 'abort'}

# ops that move the robot: while someone holds the control lease only the holder may send them
MOTION_OPS = {'set_mode', 'key', 'cmd_vel', 'nav_goal', 'nav_waypoints', 'nav_resume', 'send_to',
              'instrument_request', 'mission_request', 'manip_hold', 'hand'}
MOTION_MISSION_COMMANDS = {'start', 'resume'}          # + goto:<loc>
CAMERA_NODE_KEYS = {'c', 'f', 'h', 'u'}                # camera teleop node keys: no motion
NON_MOTION_MODES = {'STAND', 'DAMP', 'HOLD', 0, 1, 6}  # set_mode targets that anyone with the role may request


def required_role(op, msg=None):
    r = OP_ROLE.get(op)
    if op == 'mission_command' and msg is not None:
        cmd = str(msg.get('command', '')).strip()
        if cmd not in CLINICAL_MISSION_COMMANDS:
            return O
    return r


def allowed(role, op, msg=None):
    need = required_role(op, msg)
    if need is None:
        return False, None
    return RANK.get(role, -1) >= RANK[need], need


def allowed_ops(role):
    return sorted(op for op, need in OP_ROLE.items() if RANK.get(role, -1) >= RANK[need])


def is_motion(op, msg):
    """True if this op would move the robot (lease rule)."""
    if op == 'key':
        k = str(msg.get('key', '')).lower()
        return k not in CAMERA_NODE_KEYS and k not in ('x', 'o', 'space')
    if op == 'set_mode':
        m = msg.get('mode')
        return (m.upper() if isinstance(m, str) else m) not in NON_MOTION_MODES
    if op == 'mission_command':
        cmd = str(msg.get('command', '')).strip()
        return cmd in MOTION_MISSION_COMMANDS or cmd.startswith('goto:')
    return op in MOTION_OPS


# ------------------------------------------------------------------ PIN hashing
def hash_pin(pin, salt=None, iterations=120_000):
    salt = salt or secrets.token_hex(8)
    dk = hashlib.pbkdf2_hmac('sha256', str(pin).encode(), bytes.fromhex(salt), iterations)
    return f'pbkdf2_sha256${iterations}${salt}${dk.hex()}'


def check_pin(pin, stored):
    if not stored:
        return False
    try:
        algo, it, salt, h = stored.split('$')
        assert algo == 'pbkdf2_sha256'
    except (ValueError, AssertionError):
        return False
    dk = hashlib.pbkdf2_hmac('sha256', str(pin).encode(), bytes.fromhex(salt), int(it))
    return hmac.compare_digest(dk.hex(), h)


class Auth:
    """Role config + sessions (token -> session). Time is injectable for tests."""

    def __init__(self, path=None, clock=time.time):
        self.path = path or DEFAULT_CONFIG
        self.clock = clock
        with open(self.path) as f:
            self.cfg = yaml.safe_load(f) or {}
        self.roles = self.cfg.get('roles', {})
        self.users = self.cfg.get('users', []) or []
        lk = self.cfg.get('lockout', {})
        self.max_attempts = int(lk.get('max_attempts', 5))
        self.window = float(lk.get('window_s', 300))
        self.lock_s = float(lk.get('lock_s', 60))
        self.fails = {}          # device_id -> [times]
        self.locked_until = {}
        self.sessions = {}       # token -> session dict

    def idle_timeout(self, role):
        return float(self.roles.get(role, {}).get('idle_timeout_s', 0) or 0)

    # ------------------------------------------------------------------ sessions
    def new_session(self, device_id, device_name='', room='', role='clinical', user=None):
        tok = secrets.token_urlsafe(24)
        now = self.clock()
        s = {'token': tok, 'id': tok[:8], 'role': role, 'user': user, 'device_id': device_id,
             'device_name': device_name or device_id, 'room': room, 'created': now, 'last_activity': now,
             'role_since': now}
        self.sessions[tok] = s
        return s

    def resume(self, token, device_id):
        s = self.sessions.get(token or '')
        if s is None or s['device_id'] != device_id:
            return None
        self.expire_idle(s)
        return s

    def touch(self, s):
        s['last_activity'] = self.clock()

    def expire_idle(self, s):
        """Drop to clinical after the role's idle timeout. Returns True if the role changed."""
        t = self.idle_timeout(s['role'])
        if s['role'] != 'clinical' and t > 0 and self.clock() - s['last_activity'] > t:
            s['role'], s['user'], s['role_since'] = 'clinical', None, self.clock()
            return True
        return False

    def idle_left(self, s):
        t = self.idle_timeout(s['role'])
        if s['role'] == 'clinical' or t <= 0:
            return None
        return max(0.0, t - (self.clock() - s['last_activity']))

    def public(self, s):
        return {'id': s['id'], 'token': s['token'], 'role': s['role'], 'user': s['user'],
                'device_id': s['device_id'], 'device_name': s['device_name'], 'room': s['room'],
                'idle_timeout_s': self.idle_timeout(s['role']) or None,
                'idle_left_s': None if self.idle_left(s) is None else round(self.idle_left(s)),
                'allowed_ops': allowed_ops(s['role'])}

    # ------------------------------------------------------------------ login
    def _locked(self, device_id):
        return self.clock() < self.locked_until.get(device_id, 0)

    def _fail(self, device_id):
        now = self.clock()
        f = [t for t in self.fails.get(device_id, []) if now - t < self.window] + [now]
        self.fails[device_id] = f
        if len(f) >= self.max_attempts:
            self.locked_until[device_id] = now + self.lock_s
            self.fails[device_id] = []

    def login(self, s, role, pin, user=None, badge=None):
        """Returns (ok, message, code). On success the session's role/user change."""
        if role not in ROLES:
            return False, f'unknown role {role!r}', 'bad_role'
        if self._locked(s['device_id']):
            return False, 'too many wrong PINs: wait a minute', 'locked'
        rc = self.roles.get(role, {})
        if role == 'clinical' and not rc.get('pin'):
            s.update(role='clinical', user=user, role_since=self.clock())
            self.touch(s)
            return True, 'clinical', None
        who = None
        for u in self.users:
            if u.get('role') == role and check_pin(pin, u.get('pin')) and (not user or user == u.get('name')):
                who = u.get('name')
                if rc.get('two_factor') and u.get('badge') != badge:
                    return False, 'badge required as well (two-factor)', 'need_badge'
                break
        if who is None and check_pin(pin, rc.get('pin')):
            if rc.get('two_factor'):
                return False, 'technician sign-in needs a personal badge + PIN', 'need_badge'
            who = user or None
        elif who is None:
            self._fail(s['device_id'])
            return False, 'wrong PIN', 'bad_pin'
        s.update(role=role, user=who, role_since=self.clock())
        self.touch(s)
        return True, f'signed in as {role}' + (f' ({who})' if who else ''), None

    def badge_login(self, s, badge, pin=None):
        """Badge stub: a badge maps to a user; operator badges sign in directly, technician needs the PIN too
        when two_factor is on."""
        for u in self.users:
            if u.get('badge') and u.get('badge') == badge:
                role = u.get('role', 'clinical')
                if self.roles.get(role, {}).get('two_factor') and not check_pin(pin, u.get('pin')):
                    return False, 'badge accepted: enter your PIN', 'need_pin'
                s.update(role=role, user=u.get('name'), role_since=self.clock())
                self.touch(s)
                return True, f"signed in as {role} ({u.get('name')})", None
        self._fail(s['device_id'])
        return False, 'unknown badge', 'bad_badge'

    def logout(self, s):
        s.update(role='clinical', user=None, role_since=self.clock())


def _write_role_pin(role, pin, path=DEFAULT_CONFIG):
    with open(path) as f:
        cfg = yaml.safe_load(f)
    cfg.setdefault('roles', {}).setdefault(role, {})['pin'] = hash_pin(pin)
    with open(path, 'w') as f:
        yaml.safe_dump(cfg, f, sort_keys=False)


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == 'hash':
        print(hash_pin(sys.argv[2]))
    elif len(sys.argv) == 4 and sys.argv[1] == 'set-pin':
        _write_role_pin(sys.argv[2], sys.argv[3])
        print(f'PIN for {sys.argv[2]} updated in {DEFAULT_CONFIG}')
    else:
        print(__doc__)
