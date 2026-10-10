"""Unit tests for the v2 server modules (no ROS): role allow-list, sessions/PINs, audit hash chain, undo window,
alarm manager, incidents, catalogue, checks.   Run:  .venv/bin/python -m pytest -q hospital-sim-ui/server/tests"""
import asyncio
import json
import os
import sys
import zipfile

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from server import auth as A  # noqa: E402
from server.alarms import AlarmManager, CATALOG  # noqa: E402
from server.audit import AuditLog  # noqa: E402
from server.checks import run_checks  # noqa: E402
from server.incidents import IncidentStore, RingBuffer  # noqa: E402
from server.pending import PendingCommands  # noqa: E402
from server import catalog as cat  # noqa: E402


class Clock:
    def __init__(self, t=1000.0):
        self.t = t

    def __call__(self):
        return self.t


# ---------------------------------------------------------------- allow-list
TECH_OPS = ['stack_start', 'stack_stop', 'map_save', 'map_delete', 'audit_list', 'audit_verify', 'incidents_list',
            'incident_get', 'alarm_suppress', 'alarm_stats', 'logs_get']
OPER_OPS = ['lease_acquire', 'lease_steal', 'set_mode', 'key', 'cmd_vel', 'nav_goal', 'initial_pose',
            'mission_request', 'route_save']
EVERYONE = ['stop', 'power_off', 'resume', 'alarm_ack', 'incident_create', 'send_to', 'instrument_request',
            'undo', 'cancel_task', 'heartbeat', 'login']


@pytest.mark.parametrize('op', TECH_OPS)
def test_clinical_and_operator_cannot_run_technician_ops(op):
    assert not A.allowed('clinical', op)[0]
    assert not A.allowed('operator', op)[0]
    assert A.allowed('technician', op)[0]


@pytest.mark.parametrize('op', OPER_OPS)
def test_clinical_cannot_run_operator_ops(op):
    ok, need = A.allowed('clinical', op)
    assert not ok and need == 'operator'
    assert A.allowed('operator', op)[0] and A.allowed('technician', op)[0]


@pytest.mark.parametrize('op', EVERYONE)
def test_stop_and_clinical_ops_for_everyone(op):
    for r in A.ROLES:
        assert A.allowed(r, op)[0], (r, op)


def test_unknown_op_refused_and_unknown_role():
    assert A.allowed('technician', 'rm_rf') == (False, None)
    assert not A.allowed('admin', 'stop')[0]


def test_clinical_mission_command_pause_abort_only():
    assert A.allowed('clinical', 'mission_command', {'command': 'pause'})[0]
    assert A.allowed('clinical', 'mission_command', {'command': 'abort'})[0]
    assert not A.allowed('clinical', 'mission_command', {'command': 'start'})[0]
    assert not A.allowed('clinical', 'mission_command', {'command': 'goto:theatre_door'})[0]


def test_motion_classification():
    assert A.is_motion('cmd_vel', {}) and A.is_motion('send_to', {})
    assert A.is_motion('key', {'key': 'w'}) and A.is_motion('key', {'key': 'l'})
    assert not A.is_motion('key', {'key': 'c'}) and not A.is_motion('key', {'key': 'x'})
    assert not A.is_motion('key', {'key': 'o'})
    assert A.is_motion('set_mode', {'mode': 'LOCO'}) and A.is_motion('set_mode', {'mode': 4})
    assert not A.is_motion('set_mode', {'mode': 'HOLD'}) and not A.is_motion('set_mode', {'mode': 'STAND'})
    assert not A.is_motion('stop', {}) and not A.is_motion('power_off', {}) and not A.is_motion('resume', {})
    assert A.is_motion('mission_command', {'command': 'goto:x'}) and not A.is_motion('mission_command',
                                                                                       {'command': 'pause'})


def test_allow_list_covers_every_server_op():
    from server.app import Dashboard
    ops = {n[3:] for n in dir(Dashboard) if n.startswith('op_')}
    missing = ops - set(A.OP_ROLE)
    assert not missing, f'ops without a role: {missing}'


# ---------------------------------------------------------------- sessions / PINs
@pytest.fixture
def auth(tmp_path):
    p = tmp_path / 'auth.yaml'
    p.write_text(f"""roles:
  clinical: {{pin: null, idle_timeout_s: 0}}
  operator: {{pin: "{A.hash_pin('123456')}", idle_timeout_s: 600}}
  technician: {{pin: "{A.hash_pin('987654')}", idle_timeout_s: 300, two_factor: false}}
users:
  - {{name: R. Kumar, role: operator, pin: "{A.hash_pin('246810')}", badge: B1}}
lockout: {{max_attempts: 3, window_s: 300, lock_s: 60}}
""")
    return A.Auth(str(p), clock=Clock())


def test_pin_hash_roundtrip():
    h = A.hash_pin('4321')
    assert A.check_pin('4321', h) and not A.check_pin('4322', h) and not A.check_pin('4321', None)
    assert '4321' not in h


def test_login_roles_and_idle_fallback(auth):
    s = auth.new_session('ipad-1', 'iPad 1')
    assert s['role'] == 'clinical'
    assert auth.login(s, 'operator', '000000')[2] == 'bad_pin' and s['role'] == 'clinical'
    ok, msg, _ = auth.login(s, 'operator', '123456')
    assert ok and s['role'] == 'operator'
    ok, msg, _ = auth.login(s, 'operator', '246810')
    assert ok and s['user'] == 'R. Kumar'
    auth.clock.t += 599
    assert not auth.expire_idle(s)
    auth.clock.t += 2
    assert auth.expire_idle(s) and s['role'] == 'clinical' and s['user'] is None
    assert auth.login(s, 'technician', '987654')[0]
    auth.clock.t += 301
    assert auth.expire_idle(s) and s['role'] == 'clinical'


def test_lockout_after_wrong_pins(auth):
    s = auth.new_session('ipad-2')
    for _ in range(3):
        auth.login(s, 'operator', '1')
    assert auth.login(s, 'operator', '123456')[2] == 'locked'
    auth.clock.t += 61
    assert auth.login(s, 'operator', '123456')[0]


def test_badge_and_session_resume(auth):
    s = auth.new_session('ipad-3')
    assert auth.badge_login(s, 'B1')[0] and s['role'] == 'operator'
    assert auth.resume(s['token'], 'ipad-3') is s
    assert auth.resume(s['token'], 'other-device') is None
    assert auth.public(s)['allowed_ops'] == A.allowed_ops('operator')


# ---------------------------------------------------------------- audit chain
def test_audit_chain_append_verify_and_tamper(tmp_path):
    log = AuditLog(str(tmp_path))
    for i in range(5):
        log.append(device='d', role='clinical', op='stop', args={'i': i}, ok=True)
    assert log.verify() == {'ok': True, 'n': 5, 'bad_seq': None, 'reason': ''}
    log2 = AuditLog(str(tmp_path))            # reopen: the chain continues
    e = log2.append(device='d', role='operator', op='send_to', args={}, ok=True)
    assert e['seq'] == 6 and log2.verify()['ok']
    lines = (tmp_path / 'audit.jsonl').read_text().splitlines()
    rec = json.loads(lines[2])
    rec['role'] = 'technician'                # edit one entry
    lines[2] = json.dumps(rec)
    (tmp_path / 'audit.jsonl').write_text('\n'.join(lines) + '\n')
    r = AuditLog(str(tmp_path)).verify()
    assert not r['ok'] and r['bad_seq'] == 3
    del lines[2]                              # delete one entry
    (tmp_path / 'audit.jsonl').write_text('\n'.join(lines) + '\n')
    assert not AuditLog(str(tmp_path)).verify()['ok']


def test_audit_rotation_keeps_chain(tmp_path):
    log = AuditLog(str(tmp_path), rotate_bytes=300)
    for i in range(12):
        log.append(op='key', args={'key': 'w'}, ok=True)
    assert len(log.files()) > 1 and log.verify()['ok'] and log.verify()['n'] == 12
    assert [e['seq'] for e in log.tail(3)] == [10, 11, 12]


def test_audit_scrubs_secrets():
    from server.audit import scrub
    assert scrub({'op': 'login', 'id': 3, 'role': 'operator', 'pin': '123456'}) == {'role': 'operator',
                                                                                    'pin': '***'}


# ---------------------------------------------------------------- undo window
def test_undo_window_cancels_and_dispatches():
    events = []
    sent = []

    async def run():
        pc = PendingCommands(undo_s=0.2, on_event=events.append)

        async def go():
            sent.append('go')
            return True, 'sent'
        a = pc.add('send_to', 'Going to Theatre 1', go)
        b = pc.add('send_to', 'Going to Dock', go)
        assert pc.undo(a['id'])[0]
        await asyncio.sleep(0.35)
        assert not pc.undo(b['id'])[0]          # too late
        return a, b
    a, b = asyncio.run(run())
    assert sent == ['go']
    done = {e['id']: e for e in events if e['type'] == 'pending_done'}
    assert done[a['id']]['cancelled'] and done[b['id']]['ok'] and not done[b['id']]['cancelled']
    assert [e['type'] for e in events].count('pending') == 2


def test_default_undo_is_3s():
    async def run():
        pc = PendingCommands()

        async def go():
            return True, ''
        p = pc.add('instrument_request', 'x', go)
        pc.undo(p['id'])
        return p
    p = asyncio.run(run())
    assert p['undo_s'] == 3.0 and p['dispatch_at'] - p['created'] == pytest.approx(3.0)


# ---------------------------------------------------------------- alarms
def test_alarm_catalogue_has_what_do_who():
    for code, (prio, what, do, who, kind) in CATALOG.items():
        assert prio in ('high', 'medium', 'low') and what and do and who and kind in ('condition', 'event'), code


def test_high_alarm_latches_until_acknowledged():
    clk = Clock()
    said = []
    am = AlarmManager(clock=clk, say=said.append)
    a = am.raise_('estop_pressed')
    assert said and said[0].startswith('Robot alarm')
    am.clear('estop_pressed')
    assert 'estop_pressed' in am.active and not am.active['estop_pressed']['condition_active']
    ok, _ = am.acknowledge(a['id'], 'Nurse Tan')
    assert ok and 'estop_pressed' not in am.active


def test_high_acknowledged_stays_while_condition_true():
    am = AlarmManager(clock=Clock())
    a = am.raise_('estop_pressed')
    am.acknowledge(a['id'], 'x')
    assert am.active['estop_pressed']['acknowledged']
    am.clear('estop_pressed')
    assert 'estop_pressed' not in am.active


def test_medium_not_latched_and_ack_silences():
    clk = Clock()
    am = AlarmManager(clock=clk, silence_s=120)
    a = am.raise_('localisation_uncertain')
    am.acknowledge(a['id'], 'x')
    assert am.active['localisation_uncertain']['acknowledged']
    clk.t += 60
    am.raise_('localisation_uncertain')                     # still true, still silenced
    assert am.active['localisation_uncertain']['acknowledged']
    clk.t += 61
    am.raise_('localisation_uncertain')                     # silence over: sounds again
    assert am.active['localisation_uncertain']['acknowledged'] is None
    am.clear('localisation_uncertain')
    assert 'localisation_uncertain' not in am.active
    assert am.stats['localisation_uncertain']['auto_cleared'] == 1


def test_medium_event_alarm_cleared_by_ack():
    am = AlarmManager(clock=Clock())
    a = am.raise_event('manual_control_lost')
    assert am.acknowledge(a['id'], 'x')[0] and 'manual_control_lost' not in am.active


def test_clinical_cannot_disable_only_technician_suppresses_low():
    am = AlarmManager(clock=Clock())
    assert not am.suppress('fall')[0] and not am.suppress('link_lost')[0]
    assert am.suppress('battery_low')[0]
    am.raise_('battery_low')
    assert am.view()['counts']['low'] == 0 and am.view()['suppressed'] == ['battery_low']
    assert 'suppress' not in A.allowed_ops('clinical') and not A.allowed('clinical', 'alarm_suppress')[0]


def test_tech_only_alarm_hidden_from_clinical():
    am = AlarmManager(clock=Clock())
    am.raise_('placeholder_policy')
    assert am.view('clinical')['active'] == [] and len(am.view('technician')['active']) == 1
    assert 'tech_code' not in (am.view('operator')['active'] or [{}])[0] if am.view('operator')['active'] else True


def test_budget_ack_without_action():
    clk = Clock()
    am = AlarmManager(clock=clk, action_window_s=60)
    a = am.raise_('localisation_uncertain')
    am.acknowledge(a['id'], 'x')
    b = am.raise_('nav_blocked')
    am.acknowledge(b['id'], 'x')
    clk.t += 10
    am.note_command()                                        # a command follows both acks
    c = am.raise_('camera_stale')
    am.acknowledge(c['id'], 'x')                             # nothing follows this one
    clk.t += 61
    am.tick_stats()
    st = am.budget()
    assert st['camera_stale']['ack_without_action'] == 1
    assert st['nav_blocked']['ack_without_action'] == 0 and st['localisation_uncertain']['acknowledged'] == 1


def test_light_follows_priority_then_mode():
    am = AlarmManager(clock=Clock())
    assert am.light('HOLD') == {'colour': 'red', 'pattern': 'steady'}
    assert am.light('NAV')['colour'] == 'blue' and am.light('LOCO')['colour'] == 'magenta'
    a = am.raise_('localisation_uncertain')
    assert am.light('NAV') == {'colour': 'amber', 'pattern': 'pulse_0.6hz'}
    am.raise_('fall')
    assert am.light('DAMP') == {'colour': 'red', 'pattern': 'flash_2hz'}
    am.acknowledge(a['id'], 'x')


def test_evaluate_snapshot_rules():
    am = AlarmManager(clock=Clock())
    am.evaluate({'mode': 'NAV', 'controller': {'placeholder': True}, 'battery_soc': 12, 'estop_pressed': True,
                 'link_lost': False, 'amcl_std': 0.8, 'clients': 1})
    assert {'battery_low_task', 'estop_pressed', 'placeholder_policy', 'localisation_uncertain'} <= set(am.active)
    am.evaluate({'mode': 'STAND', 'controller': {}, 'battery_soc': 90, 'estop_pressed': False, 'clients': 1})
    assert 'battery_low_task' not in am.active and 'estop_pressed' in am.active      # High latched


# ---------------------------------------------------------------- incidents
def test_incident_bundle_has_last_5_min_no_images(tmp_path):
    clk = Clock()
    ring = RingBuffer(seconds=300, clock=clk)
    ring.add('mode', {'name': 'NAV'})
    clk.t += 400
    ring.add('mode', {'name': 'HOLD'})
    ring.add('command', {'op': 'stop', 'role': 'clinical'})
    st = IncidentStore(str(tmp_path), clock=clk)
    iid, path, meta = st.create(ring, {'by': {'role': 'clinical'}, 'chips': ['stuck']})
    assert iid.startswith('INC-') and iid.endswith('-01') and meta['n_events'] == 2
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        tl = z.read('timeline.jsonl').decode()
    assert set(names) == {'incident.json', 'timeline.jsonl', 'README.txt'}
    assert 'NAV' not in tl and 'HOLD' in tl                  # older than 5 min dropped
    assert st.next_id().endswith('-02') and st.get(iid)['incident']['chips'] == ['stuck']
    assert st.path('../../etc/passwd') is None


# ---------------------------------------------------------------- catalogue / checks
def test_places_have_display_metadata_and_roles():
    places = cat.load_places()
    ids = {p['id'] for p in places}
    assert {'theatre_door', 'dock', 'theatre_instrument_table'} <= ids
    clin = {p['id']: p['allowed'] for p in cat.places_for(places, 'clinical')}
    assert clin['theatre_door'] and clin['dock'] and not clin['theatre_instrument_table']
    dock = next(p for p in places if p['id'] == 'dock')
    assert dock['location'] == 'corridor_west' and dock['kind'] == 'dock'


def test_instrument_rack_state_from_ground_truth():
    catl = cat.load_instruments()
    iid = 'scalpel_handle'
    home = catl[iid]['home']
    objs = {iid: {'pose': home + [1, 0, 0, 0]}, 'adson_forceps': {'pose': [0, 0, 0, 1, 0, 0, 0],
                                                                 'held_by': 'surgeon'}}
    st = {i['id']: i for i in cat.instrument_state(catl, objs)}
    assert st[iid]['rack_count'] == 1 and st[iid]['available']
    assert st['adson_forceps']['held_by'] == 'surgeon' and st['adson_forceps']['rack_count'] == 0
    text, speak = cat.readback_instrument(catl['needle_driver'] if 'needle_driver' in catl else catl[iid])
    assert '→ surgeon, handle first' in text


def test_checks_lock_motion_without_estop():
    r = run_checks({'manager_age': 0.5, 'estop': {'alive': False, 'reason': 'not seen'}, 'controller':
                    {'loop_hz': 500, 'policy': 'p', 'placeholder': True}, 'scan_age': 0.1})
    st = {i['id']: i['status'] for i in r['items']}
    assert st['estop'] == 'fail' and r['motion_locked'] and not r['ready'] and st['policy'] == 'warn'
    r = run_checks({'manager_age': 0.5, 'estop': {'alive': True, 'pressed': False}, 'estop_test_t': 999,
                    'controller': {'loop_hz': 500}, 'scan_age': 0.1, 'battery_soc': 95, 'localised': True},
                   now=1000)
    assert not r['motion_locked'] and r['ready']


def test_audit_two_writers_share_one_chain(tmp_path):
    a, b = AuditLog(str(tmp_path)), AuditLog(str(tmp_path))      # two server processes, same file
    for i in range(6):
        (a if i % 2 else b).append(op='stop', args={'i': i}, ok=True)
    r = AuditLog(str(tmp_path)).verify()
    assert r['ok'] and r['n'] == 6


def test_audit_tail_with_multibyte_text(tmp_path):
    log = AuditLog(str(tmp_path))
    for i in range(3000):                       # > 64 KiB so the tail read starts mid-file
        log.append(op='send_to', message=f'Going to Theatre 1 · Needle driver → surgeon {i}', ok=True)
    assert AuditLog(str(tmp_path)).append(op='x', ok=True)['seq'] == 3001
    assert log.verify()['ok']
