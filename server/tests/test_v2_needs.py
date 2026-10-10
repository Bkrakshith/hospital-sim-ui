"""App follow-up needs (hospital-sim-ui/app/NEEDS_FROM_BACKEND.md 1-9): handed timestamps, proximity sectors, ground-truth map
pose, resume/task sentences, handover-failure alarm, one-time incident links, manip_hold / hand allow-list."""
import asyncio
import math
import os
import sys
import types

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from server import auth as A  # noqa: E402

rclpy = pytest.importorskip('rclpy')
from server.app import Dashboard  # noqa: E402
from server.bridge import RosBridge  # noqa: E402


class FakeMission:
    def __init__(self):
        self.status = None
        self.objects = {}
        self.pelvis = None
        self.pelvis_t = 0.0

    def request_available(self):
        return True

    def command(self, c):
        self.last = c


class FakeBridge:
    def __init__(self):
        self.latest = {'mode': {'mode': 1, 'name': 'STAND', 'source': 'keyboard', 'detail': 'ready'},
                       'manager': {}, 'lease': {}, 'controller': {}, 'battery': None, 'temps': None,
                       'amcl_pose': None, 'sim': None, 'scan': None}
        self.mission = FakeMission()
        self.nav = {'state': 'idle', 'goal': None, 'feedback': {}}
        self.pose = {'frame': 'map', 'x': 25.9, 'y': -15.6, 'yaw': 0.0}
        self.said, self.seen, self.estop = [], {}, {'test_t': None, 'last': None, 'pressed': False}

    def robot_pose(self):
        return self.pose

    def proximity(self):
        return None

    def topic_health(self):
        return {}

    def say(self, t):
        self.said.append(t)

    def publish_light(self, d):
        pass


@pytest.fixture
def dash(tmp_path):
    opts = types.SimpleNamespace(ui_dir=os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
                                 auth_config=A.DEFAULT_CONFIG, undo_s=3.0, data_dir=str(tmp_path),
                                 app_dir=str(tmp_path), localhost_role='technician', use_sim_time=False, mock=False)
    d = Dashboard(opts)
    d.bridge = FakeBridge()
    return d


def test_new_ops_in_allow_list():
    assert not A.allowed('clinical', 'manip_hold')[0] and A.allowed('operator', 'manip_hold')[0]
    assert not A.allowed('clinical', 'hand')[0] and A.allowed('operator', 'hand')[0]
    assert not A.allowed('operator', 'incident_link')[0] and A.allowed('technician', 'incident_link')[0]
    assert A.is_motion('hand', {}) and A.is_motion('manip_hold', {'on': False})


def test_proximity_sectors_from_scan():
    scan = types.SimpleNamespace(ranges=[np.inf] * 360, angle_min=-math.pi, angle_increment=math.radians(1),
                                 range_min=0.1, range_max=30.0, header=types.SimpleNamespace(frame_id='laser_link'))
    r = list(scan.ranges)
    r[180] = 1.2       # 0 deg: front
    r[180 + 60] = 0.4  # +60 deg: left
    r[180 - 90] = 2.5  # -90 deg: right
    r[0] = 0.3         # 180 deg: behind -> ignored
    scan.ranges = r
    fake = types.SimpleNamespace(latest={'scan': scan}, seen={'/scan': 0})
    p = RosBridge.proximity(fake)
    assert p['sectors'] == [0.4, 1.2, 2.5] and p['named'] == {'left': 0.4, 'front': 1.2, 'right': 2.5}
    scan.ranges = [np.inf] * 360
    assert RosBridge.proximity(fake)['sectors'] == [None, None, None]


def test_gt_map_pose_fallback():
    T = np.eye(4)
    T[:3, 3] = [25.58, -20.0, 0.78]
    T[:2, :2] = [[0, 1], [-1, 0]]       # yaw -90 deg
    import time
    fake = types.SimpleNamespace(mission=types.SimpleNamespace(pelvis=T, pelvis_t=time.time()))
    x, y, yaw = RosBridge.gt_map_pose(fake)
    assert (x, y) == pytest.approx((25.58, -20.0)) and yaw == pytest.approx(-math.pi / 2)
    fake.mission.pelvis_t -= 5
    assert RosBridge.gt_map_pose(fake) is None


def test_handover_failure_raises_medium_alarm_and_success_clears(dash):
    b = dash.bridge
    b.mission.status = {'state': 'running', 'counts': {'ok': 0, 'failed': 0}, 'history': []}
    dash.track_mission_history()
    b.mission.status = {'state': 'running', 'counts': {'ok': 0, 'failed': 1}, 'history': [
        {'instrument': 'angled_tweezers', 'success': False, 'duration': 30.0,
         'message': 'Handover: surgeon did not take the instrument'}]}
    dash.track_mission_history()
    a = dash.alarms.active.get('handover_failed')
    assert a and a['priority'] == 'medium' and 'Angled tweezers' in a['what'] and a['do'] and a['who']
    assert any(e['kind'] == 'task_failed' for e in dash.timeline)
    b.mission.status = {'state': 'running', 'counts': {'ok': 1, 'failed': 1}, 'history': [
        b.mission.status['history'][0], {'instrument': 'scalpel_handle', 'success': True, 'duration': 40.0,
                                         'message': 'handed over', 't': 1234.5}]}
    dash.track_mission_history()
    assert 'handover_failed' not in dash.alarms.active


def test_pick_failure_is_grasp_failed(dash):
    b = dash.bridge
    b.mission.status = {'counts': {'ok': 0, 'failed': 0}, 'history': []}
    dash.track_mission_history()
    b.mission.status = {'counts': {'ok': 0, 'failed': 1}, 'history': [
        {'instrument': 'scissors', 'success': False, 'duration': 9.0, 'message': 'Pick: grasp failed'}]}
    dash.track_mission_history()
    assert 'grasp_failed' in dash.alarms.active and 'handover_failed' not in dash.alarms.active


def test_handover_card_has_timestamps(dash):
    b = dash.bridge
    b.mission.status = {'counts': {'ok': 1, 'failed': 0}, 'history': [
        {'instrument': 'scalpel_handle', 'success': True, 'duration': 40.0, 'message': 'handed over',
         't': 1790700000.0}]}
    c = {'session': dash.auth.new_session('ipad-x')}
    ok, _, d = asyncio.run(dash.op_handover_card({'since': 1790600000.0}, c))
    h = d['instruments_handed'][0]
    assert ok and h['t'] == 1790700000.0 and h['instrument'] == 'scalpel_handle' and h['name'] == 'Scalpel'


def test_task_sentence_and_resume_text(dash):
    b = dash.bridge
    assert dash.task_state()['text'] == 'Standing by at Theatre 1'           # pose at theatre_door
    b.latest['mode'] = {'mode': 5, 'name': 'AUTO', 'source': 'mission'}
    b.pose = {'frame': 'map', 'x': 25.93, 'y': -11.65, 'yaw': 0}
    b.mission.status = {'state': 'running', 'kind': 'goto:theatre_door'}
    t = dash.task_state()
    assert t['text'].startswith('Going to Theatre 1 · 4 m') and t['place'] == 'theatre_door'
    b.mission.status = {'state': 'running', 'kind': 'scrub_nurse', 'step': 'Pick', 'instrument': 'needle_driver'}
    assert dash.task_state()['text'] == 'Picking up the needle driver'
    # stopped during the goto: resume text names the destination
    b.latest['mode'] = {'mode': 6, 'name': 'HOLD', 'source': 'ui:ipad-1'}
    b.latest['manager'] = {'hold': {'from': 'AUTO'}}
    b.mission.status = {'state': 'paused', 'kind': 'goto:theatre_door', 'paused_by_hold': True}
    h = dash.hold_state()
    assert h['resume_task']['text'] == 'Continue to Theatre 1 (4 m)'
    # stopped during a send_to that fell back to a Nav2 goal
    b.latest['manager'] = {'hold': {'from': 'NAV'}}
    b.nav = {'state': 'paused', 'goal': {'x': 1, 'y': 2}, 'feedback': {'distance_remaining': 12.2}}
    dash.nav_place = 'Sterile store'
    assert dash.hold_state()['resume_task']['text'] == 'Continue to Sterile store (12 m)'
    assert dash.task_state()['text'].startswith('Stopped by')


def test_incident_link_is_one_time_and_expires(dash, tmp_path):
    c = {'session': dash.auth.new_session('ipad-t', role='technician')}
    ok, _, d = asyncio.run(dash.op_incident_create({'chips': ['stuck']}, c))
    iid = d['id']
    ok, _, link = asyncio.run(dash.op_incident_link({'incident_id': iid}, c))
    tok = link['url'].split('dl=')[1]
    assert ok and 'token' not in link['url'] and link['expires_in'] == 60
    assert dash.take_download_token(tok, iid) and not dash.take_download_token(tok, iid)   # one time
    ok, _, link = asyncio.run(dash.op_incident_link({'incident_id': iid}, c))
    tok = link['url'].split('dl=')[1]
    dash.dl_tokens[tok] = (iid, 0.0)                                                       # expired
    assert not dash.take_download_token(tok, iid)
    assert not asyncio.run(dash.op_incident_link({'incident_id': 'INC-0000-99'}, c))[0]
