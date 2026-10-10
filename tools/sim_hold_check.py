#!/usr/bin/env python3
"""End-to-end Stop/Resume/watchdog/lease/role check on the MuJoCo sim (docs/ui/README.md decisions 1, 2, 4, 5).

Needs a running stack on this ROS_DOMAIN_ID:
    ros2 launch g1_bringup mission.launch.py fixed_base:=true          # sim + controller + manager + mission
    python hospital-sim-ui/server --use-sim-time true                                # HTTPS 8443 + HTTP 127.0.0.1:8080
Then:
    python hospital-sim-ui/tools/sim_hold_check.py [--url wss://127.0.0.1:8443/ws] [--json out.json]

1. Clinical iPad requests an instrument (3 s readback/undo, then the mission starts: AUTO).
2. While the arm moves (pick), a Clinical iPad presses Stop -> HOLD. Measures arm + waist joint drift from
   /joint_states for 3 s (must be < 0.02 rad), checks hands keep their command and the mission is paused.
3. Resume the task -> AUTO, the mission continues (next steps / success).
4. Operator takes the lease, LOCO, stops its heartbeat -> HOLD by the watchdog in ~1 s.
5. A non-lease iPad's motion op is rejected; Clinical cannot run a Technician op.
"""
import argparse
import asyncio
import json
import os
import ssl
import sys
import threading
import time

import numpy as np
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import JointState

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from v2_check import Pad, wait_for  # noqa: E402

ARM = ['waist_yaw_joint', 'waist_roll_joint', 'waist_pitch_joint'] + [
    f'{s}_{j}_joint' for s in ('left', 'right') for j in (
        'shoulder_pitch', 'shoulder_roll', 'shoulder_yaw', 'elbow', 'wrist_roll', 'wrist_pitch', 'wrist_yaw')]


class JointWatch(Node):
    def __init__(self):
        super().__init__('sim_hold_check')
        self.lock = threading.Lock()
        self.buf = []            # (wall t, q[17])
        self.hand = {}
        self.create_subscription(JointState, '/joint_states', self.on_js, 50)
        self.pub_raw = self.create_publisher(JointState, '/g1/teleop/upper_body_target_raw', 10)
        self.stream = None       # callable t -> {joint: value} (camera-teleop stand-in)
        self.create_timer(0.02, self.tick_stream)
        for s in ('left', 'right'):
            self.create_subscription(JointState, f'/g1/hand/{s}/cmd', lambda m, s=s: self.on_hand(s, m), 10)

    def on_js(self, m):
        idx = {n: i for i, n in enumerate(m.name)}
        if not all(n in idx for n in ARM):
            return
        q = np.array([m.position[idx[n]] for n in ARM])
        with self.lock:
            self.buf.append((time.time(), q))
            self.buf = self.buf[-3000:]

    def tick_stream(self):
        if self.stream is None:
            return
        tgt = self.stream(time.time())
        m = JointState()
        m.name, m.position = list(tgt), [float(v) for v in tgt.values()]
        self.pub_raw.publish(m)

    def on_hand(self, side, m):
        self.hand[side] = (time.time(), list(m.position))

    def window(self, t0, t1):
        with self.lock:
            return [(t, q) for t, q in self.buf if t0 <= t <= t1]

    def speed(self, dt=0.2):
        with self.lock:
            b = self.buf[-40:]
        if len(b) < 2:
            return 0.0
        (ta, qa), (tb, qb) = b[0], b[-1]
        return float(np.max(np.abs(qb - qa)) / max(tb - ta, 1e-3))


async def main(a):
    rclpy.init()
    jw = JointWatch()
    from std_srvs.srv import Trigger
    cli = jw.create_client(Trigger, '/sim/reset_objects')
    th = threading.Thread(target=rclpy.spin, args=(jw,), daemon=True)
    th.start()
    if cli.wait_for_service(timeout_sec=5.0):       # instruments back in the rack (a previous run may have handed one)
        cli.call_async(Trigger.Request())
        time.sleep(1.5)
    results = []

    def check(name, ok, detail=''):
        results.append({'check': name, 'ok': bool(ok), 'detail': detail})
        print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail else ''))
        return ok

    sslctx = ssl.create_default_context()
    sslctx.check_hostname = False
    sslctx.verify_mode = ssl.CERT_NONE
    import aiohttp
    async with aiohttp.ClientSession() as s:
        N, O, X = Pad('nurse', a.url), Pad('operator', a.url), Pad('observer', a.url)
        for p in (N, O, X):
            await p.open(s, sslctx if a.url.startswith('wss') else None)
        mode = lambda: (N.mode or {}).get('name')  # noqa: E731
        mission = lambda: next((m for m in reversed(N.msgs) if m.get('type') == 'mission'), {})  # noqa: E731
        r = await O.call('login', role='operator', pin='123456', user='Sim Operator')
        check('operator login', r['ok'], r['message'])
        r = await X.call('login', role='operator', pin='123456')

        # ------------------------------------------------------------ roles
        r = await N.call('map_delete', name='hospital_gt')
        check('clinical cannot run a technician op (map_delete)', not r['ok'] and r['data']['code'] == 'forbidden',
              r['message'])

        # ------------------------------------------------------------ stand up
        if mode() == 'HOLD':
            await N.call('resume', to='stand')
        if mode() not in ('STAND',):
            if mode() != 'DAMP':
                await N.call('power_off')
                await asyncio.sleep(2)
            r = await O.call('set_mode', mode='STAND')
            check('DAMP -> STAND (operator)', r['ok'], r['message'])
        ok = await wait_for(lambda: mode() == 'STAND' and (N.mode or {}).get('detail') == 'ready', 20)
        check('robot standing', ok, N.mode)
        await asyncio.sleep(3.0)
        r = await N.call('checks_run')
        est = next((i for i in r['data']['items'] if i['id'] == 'estop'), {})
        check('start-of-day: sim e-stop heartbeat seen', est.get('status') == 'ok', est.get('value'))

        # ------------------------------------------------------------ instrument request with readback
        inst = a.instrument
        r = await N.call('instrument_request', instrument=inst, requester='surgeon')
        check(f'clinical instrument request ({inst}): readback + 3 s undo', r['ok'] and r['data']['pending'],
              r['message'])
        ok = await wait_for(lambda: mode() == 'AUTO', 15)
        check('mission started after the undo window (AUTO)', ok, mode())

        # ------------------------------------------------------------ stop during arm motion
        t_start = time.time()
        moving = await wait_for(lambda: mission().get('step') in ('Pick', 'pick') and jw.speed() > 0.15, 90, 0.05)
        if not moving:
            moving = await wait_for(lambda: jw.speed() > 0.15 and mode() == 'AUTO', 60, 0.05)
        v_before = jw.speed()
        step_before = mission().get('step')
        check('arm moving in AUTO before Stop', moving, f'{v_before:.2f} rad/s, step {step_before}, '
                                                        f'{time.time() - t_start:.1f} s after start')
        hand_before = {k: v[1] for k, v in jw.hand.items()}
        t_stop = time.time()
        r = await N.call('stop')
        ok = await wait_for(lambda: mode() == 'HOLD', 3, 0.02)
        t_hold = time.time()
        check('Stop (clinical, no lease) -> HOLD', r['ok'] and ok, f'{(t_hold - t_stop) * 1e3:.0f} ms')
        await asyncio.sleep(3.2)
        w = jw.window(t_hold, t_hold + 3.0)
        q0 = w[0][1]
        drift = float(max(np.max(np.abs(q - q0)) for _, q in w))
        w2 = jw.window(t_hold + 0.3, t_hold + 3.0)
        drift_settled = float(max(np.max(np.abs(q - w2[0][1])) for _, q in w2))
        worst = ARM[int(np.argmax(np.max(np.abs(np.array([q for _, q in w]) - q0), axis=0)))]
        check('arms frozen: joint drift over 3 s after HOLD < 0.02 rad', drift < 0.02,
              f'max drift {drift:.4f} rad ({worst}); after 0.3 s settle {drift_settled:.4f} rad; '
              f'{len(w)} samples; arm speed at stop {v_before:.2f} rad/s')
        results[-1]['drift'] = drift
        results[-1]['drift_settled'] = drift_settled
        new_hand = {k: v for k, v in jw.hand.items() if v[0] > t_hold + 0.1}
        check('hands keep their command (no hand cmd published in HOLD)', not new_hand,
              {k: v[1] for k, v in new_hand.items()} or hand_before)
        await asyncio.sleep(0.5)
        m = mission()
        check('mission paused (resumable) by HOLD', m.get('state') == 'paused' and m.get('paused_by_hold'),
              f"{m.get('state')} / {m.get('message')}")
        h = (N.state.get('hold') or {})
        check('state.hold offers "continue the task"', (h.get('resume_task') or {}).get('kind') == 'mission',
              h.get('resume_task'))
        r = await O.call('set_mode', mode='MANIP')
        check('HOLD -> MANIP refused (explicit resume only)', not r['ok'], r['message'])

        # ------------------------------------------------------------ resume the task
        r = await N.call('resume', to='task')
        check('resume task -> AUTO', r['ok'] and mode() == 'AUTO', r['message'])
        ok = await wait_for(lambda: mission().get('state') == 'running', 5)
        check('mission running again', ok, mission().get('message'))
        ok = await wait_for(lambda: (mission().get('step') != step_before and mission().get('state') == 'running')
                            or (mission().get('counts') or {}).get('ok', 0) > 0, 60)
        check('mission progresses after resume', ok, f"step {mission().get('step')}")
        if a.full:
            ok = await wait_for(lambda: (mission().get('counts') or {}).get('ok', 0) > 0
                                or (mission().get('counts') or {}).get('failed', 0) > 0, 120)
            c = mission().get('counts')
            check('instrument handed over after stop/resume', ok and c.get('ok', 0) > 0, c)

        # ------------------------------------------------------------ fixed-base sim: map pose, task, proximity
        pose = next((m for m in reversed(N.msgs) if m.get('type') == 'pose'), {})
        check('map-frame pose in the fixed-base sim (ground truth fallback)', pose.get('frame') == 'map' and
              pose.get('source') == 'sim_ground_truth', {k: pose.get(k) for k in ('frame', 'x', 'y', 'source')})
        check('state.task sentence', bool((N.state.get('task') or {}).get('text')), N.state.get('task'))
        px = N.state.get('proximity') or {}
        check('state.proximity from the sim /scan', len(px.get('sectors') or []) == 3, px.get('named'))

        # ------------------------------------------------------------ cancel, then watchdog
        await N.call('cancel_task')
        await wait_for(lambda: mode() == 'STAND', 10)
        await wait_for(lambda: (N.mode or {}).get('detail') == 'ready', 10)
        r = await O.call('lease_acquire', reason='manual test')
        check('operator takes the lease', r['ok'], r['message'])
        r = await X.call('cmd_vel', vx=0.2, vy=0, wz=0)
        check('non-lease iPad: motion op rejected', not r['ok'] and r['data']['code'] == 'lease', r['message'])
        r = await X.call('set_mode', mode='MANIP')
        check('non-lease iPad: MANIP rejected', not r['ok'], r['message'])
        r = await O.call('set_mode', mode='MANIP')
        check('lease holder: STAND -> MANIP', r['ok'], r['message'])
        await asyncio.sleep(1.5)
        check('MANIP holds with heartbeat', mode() == 'MANIP', mode())
        O.hb = False
        t0 = time.time()
        ok = await wait_for(lambda: mode() == 'HOLD', 5, 0.02)
        dt = time.time() - t0
        check('heartbeat stopped -> HOLD by watchdog (~1 s)', ok and (N.mode or {}).get('source') == 'watchdog'
              and dt < 2.0, f'{dt:.2f} s, source {(N.mode or {}).get("source")}')
        results[-1]['trip_s'] = dt
        O.hb = True
        await asyncio.sleep(0.5)
        r = await O.call('resume', to='stand')
        check('resume after watchdog -> STAND (arms blend >= 2 s)', r['ok'], r['message'])
        await wait_for(lambda: (N.mode or {}).get('detail') == 'ready', 10)

        # ------------------------------------------------------------ arms hold inside MANIP + gripper override
        r = await O.call('set_mode', mode='MANIP')
        check('MANIP again (lease holder)', r['ok'], r['message'])
        # camera-teleop stand-in on the free LEFT arm (the right hand works at the rack; sweeping it hits the rack)
        sp = 'left_shoulder_pitch_joint'
        jw.stream = lambda t: {sp: -0.3 + 0.25 * np.sin(1.5 * t), 'left_elbow_joint': 0.9}
        await asyncio.sleep(4.0)
        v = jw.speed()
        r = await O.call('manip_hold', on=True)
        t_h = time.time()
        check('manip_hold on while the operator arm moves', r['ok'] and mode() == 'MANIP', f'{r["message"]}, '
              f'{v:.2f} rad/s')
        await asyncio.sleep(3.2)
        w = jw.window(t_h, t_h + 3.0)
        q0 = w[0][1]
        dd = np.max(np.abs(np.array([q for _, q in w]) - q0), axis=0)
        drift = float(dd.max())
        w2 = jw.window(t_h + 0.3, t_h + 3.0)
        settled = float(max(np.max(np.abs(q - w2[0][1])) for _, q in w2))
        # an operator arm is faster than the mission's: allow the braking transient, require a still arm after it
        check('arms held in MANIP (teleop stream still running): drift < 0.03 rad, < 0.01 rad after 0.3 s',
              drift < 0.03 and settled < 0.01, f'{drift:.4f} rad ({ARM[int(dd.argmax())]}), settled {settled:.4f} '
                                               f'rad; arm speed before hold {v:.2f} rad/s')
        results[-1]['settled'] = settled
        results[-1]['drift'] = drift
        t_o = time.time()
        r = await O.call('hand', side='left', close=1.0)
        await asyncio.sleep(0.5)
        hc = jw.hand.get('left')
        check('gripper override closes the left hand (arms held)', r['ok'] and hc and hc[0] > t_o and
              min(hc[1]) > 0.99, r['message'])
        r = await O.call('hand', side='left', close=0.0)
        check('gripper override opens it again', r['ok'], r['message'])
        r = await O.call('manip_hold', on=False)
        t_r = time.time()
        await asyncio.sleep(3.0)
        qs = np.array([q[ARM.index(sp)] for _, q in jw.window(t_r, t_r + 3.0)])
        check('manip_hold off: the arm follows the operator again', r['ok'] and np.ptp(qs) > 0.1,
              f'shoulder pitch moved over {np.ptp(qs):.2f} rad in 3 s')
        jw.stream = None
        r = await O.call('set_mode', mode='STAND')
        check('MANIP -> STAND', r['ok'], r['message'])
        await O.call('lease_release')
        for p in (N, O, X):
            await p.close()
    jw.destroy_node()
    rclpy.shutdown()
    n_ok = sum(r['ok'] for r in results)
    print(f'\n{n_ok}/{len(results)} checks passed')
    if a.json:
        with open(a.json, 'w') as f:
            json.dump({'passed': n_ok, 'total': len(results), 'results': results}, f, indent=1, default=str)
    return 0 if n_ok == len(results) else 1


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--url', default='wss://127.0.0.1:8443/ws')
    ap.add_argument('--instrument', default='scalpel_handle')
    ap.add_argument('--full', action='store_true', help='also wait for the handover to finish')
    ap.add_argument('--json')
    sys.exit(asyncio.run(main(ap.parse_args())))
