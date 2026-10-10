"""End to end on the MuJoCo sim: request an instrument from the iPad app, Stop during the pick (arms must
freeze), resume the task, and see the instrument handed and counted. Drives the real UI (WebKit, iPad Pro 11).

    source env.sh; export ROS_DOMAIN_ID=74
    ros2 launch g1_bringup mission.launch.py fixed_base:=true &
    python hospital-sim-ui/server --no-tls --http-host 127.0.0.1 --port 8174 --localhost-role clinical --data-dir <dir> &
    PLAYWRIGHT_BROWSERS_PATH=... python hospital-sim-ui/app/tests/sim_e2e.py [--instrument needle_driver]
"""
import argparse
import os
import sys
import threading
import time

import numpy as np
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import JointState

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from playwright.sync_api import sync_playwright  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument('--url', default='http://127.0.0.1:8174')
ap.add_argument('--instrument', default='needle_driver')
ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'docs', 'screenshots'))
args = ap.parse_args()

ARM = ['waist_yaw_joint', 'waist_roll_joint', 'waist_pitch_joint'] + [
    f'{s}_{j}_joint' for s in ('left', 'right') for j in (
        'shoulder_pitch', 'shoulder_roll', 'shoulder_yaw', 'elbow', 'wrist_roll', 'wrist_pitch', 'wrist_yaw')]


class JointWatch(Node):
    def __init__(self):
        super().__init__('app_sim_e2e_watch')
        self.q = None
        self.create_subscription(JointState, '/joint_states', self.cb, 20)

    def cb(self, m):
        d = dict(zip(m.name, m.position))
        if all(n in d for n in ARM):
            self.q = np.array([d[n] for n in ARM])


results = []


def check(name, cond, detail=''):
    results.append((name, bool(cond)))
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{detail}]' if detail else ''), flush=True)


def main():
    rclpy.init()
    jw = JointWatch()
    threading.Thread(target=rclpy.spin, args=(jw,), daemon=True).start()
    errs = []
    with sync_playwright() as p:
        b = p.webkit.launch()
        ctx = b.new_context(**p.devices['iPad Pro 11 landscape'])
        ctx.add_init_script("try { localStorage.setItem('g1.speak', 'false'); } catch (e) {}")
        pg = ctx.new_page()
        pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
        pg.on('pageerror', lambda e: errs.append(str(e)))
        st = lambda e: pg.evaluate(f'() => {{ const S = window.__g1.store.state; return {e}; }}')  # noqa: E731
        api = lambda c: pg.evaluate(f'async () => {{ const c = await import("./js/client.js"); return await c.api.{c}; }}')  # noqa: E731

        def wait(e, t):
            t0 = time.time()
            while time.time() - t0 < t:
                try:
                    if st(e):
                        return True
                except Exception:
                    pass
                time.sleep(0.25)
            return False

        def shot(n):
            pg.evaluate('() => document.querySelectorAll(".toast").forEach(t => t.remove())')
            pg.screenshot(path=os.path.join(args.out, n + '.png'))

        pg.goto(args.url + '/?test=1#/home')
        check('connected, v2, mission status seen', wait('S.connected && S.v2 && S.mission', 20))
        # technician stand-up if needed
        if st('S.mode.name') == 'DAMP':
            api("login('technician', '987654', 'T. Lee')"); wait('S.session.role === "technician"', 5)
            pg.evaluate('async () => { const g = await import("./js/goals.js"); return await g.standUp(); }')
            api('logout()'); wait('S.session.role === "clinical"', 5)
        check('fixed-base pose from sim ground truth, in the map frame', wait('S.pose && S.pose.frame === "map" && S.pose.source === "sim_ground_truth"', 10), str(st('S.pose && [S.pose.frame, S.pose.source]')))
        time.sleep(1)
        where = pg.locator('.hero-where').inner_text()
        check('floor plan shows the robot, labelled "(simulation position)"', '(simulation position)' in where and pg.locator('.fp-robot').evaluate('e => e.style.display !== "none"'), where.replace('\n', ' | '))
        check('robot ready (standing, or scrub assist waiting for a request)', wait('S.mode.name === "STAND" || (S.mode.name === "AUTO" && S.mission.step === "WaitForRequest")', 15), st('S.mode.name'))
        # ---- request the instrument through the UI
        pg.evaluate("location.hash = '#/instruments'"); time.sleep(1.2)
        shot('sim_instruments_light')
        pg.locator(f'.inst-tile[data-inst="{args.instrument}"]').click()
        pg.locator('#readback').wait_for(timeout=5000)
        txt = pg.locator('.rbk-text').inner_text()
        check('readback card', 'surgeon' in txt and 'handle first' in txt, txt)
        shot('sim_readback_light')
        check('mission runs (AUTO) after the 3 s undo window', wait('S.mode.name === "AUTO" && S.mission.state === "running"', 25), st('S.mode.name'))
        pg.evaluate("location.hash = '#/home'")
        # ---- Stop while the arm is moving (pick)
        ok = wait('S.mission && ["Pick"].includes(S.mission.step)', 180)
        check('mission reached the pick', ok, st('S.mission.step'))
        time.sleep(1.0)
        shot('sim_home_bringing_light')
        hero = pg.locator('.hero-activity').inner_text(); task = st('S.status.task && S.status.task.text')
        check('hero uses the server task sentence', bool(task) and hero == task.split(' · ')[0], f'hero "{hero}" · task "{task}"')
        q0 = jw.q.copy() if jw.q is not None else None
        pg.locator('#stop-btn').dispatch_event('pointerdown')
        t_stop = time.time()
        check('Stop -> HOLD', wait('S.mode.name === "HOLD"', 3), st('S.mode.name'))
        print(f'  stop latency (UI tap -> HOLD seen): {time.time() - t_stop:.2f} s')
        time.sleep(0.5)
        qa = jw.q.copy() if jw.q is not None else None
        time.sleep(3.0)
        qb = jw.q.copy() if jw.q is not None else None
        if qa is not None and qb is not None:
            drift = float(np.max(np.abs(qb - qa)))
            moved_before = float(np.max(np.abs(qa - q0))) if q0 is not None else float('nan')
            check('arms frozen in HOLD (max drift over 3 s < 0.02 rad)', drift < 0.02, f'drift {drift:.4f} rad; moved {moved_before:.3f} rad before the freeze settled')
        else:
            check('joint states received', False)
        check('mission paused by the hold', wait('S.mission.state === "paused" || S.status.mission_paused_by_hold', 5), st('S.mission.state'))
        if pg.locator('#stop-reason').count():
            pg.locator('#stop-reason button:has-text("Person in the way")').click()
        time.sleep(0.5)
        shot('sim_stopped_during_pick_light')
        check('hero offers to continue the task', pg.locator('#resume-task').count() == 1, pg.locator('#resume-task').inner_text().replace('\n', ' | ') if pg.locator('#resume-task').count() else '')
        # resume via the slide
        tr = pg.locator('#resume-task'); box = tr.bounding_box(); th = tr.locator('.slide-thumb').bounding_box()
        x0, y = th['x'] + th['width'] / 2, th['y'] + th['height'] / 2
        pg.mouse.move(x0, y); pg.mouse.down()
        for i in range(1, 13):
            pg.mouse.move(x0 + (box['width'] - th['width']) * i / 12, y); time.sleep(0.02)
        pg.mouse.up()
        check('slide to continue -> AUTO, mission running', wait('S.mode.name === "AUTO" && S.mission.state === "running"', 10), st('S.mode.name'))
        # across-room view during the task
        time.sleep(4)
        pg.evaluate('() => window.__g1.idle(25)'); time.sleep(1.8)
        shot('sim_across_room_bringing_light')
        pg.mouse.click(500, 400); time.sleep(0.5)
        ok = wait(f'S.mission.history && S.mission.history.some(h => h.instrument === "{args.instrument}" && (h.success || h.success === false))', 300)
        failed = st(f'S.mission.history.some(h => h.instrument === "{args.instrument}" && h.success === false)')
        if failed and wait('S.alarms.active.some(a => a.code === "handover_failed" || a.code === "grasp_failed")', 8):   # raised ~1 s after the history entry
            pg.mouse.click(500, 300); time.sleep(0.5); pg.evaluate("location.hash = '#/home'"); time.sleep(1); shot('sim_alarm_request_failed_light')
            check('failed request shows a Medium alarm with what/do/who', pg.locator('.banner-alarm.pri-medium .bn-who').count() == 1, pg.locator('.banner-alarm').inner_text().replace('\n', ' | '))
        ok = st(f'S.mission.history.some(h => h.instrument === "{args.instrument}" && h.success)')
        check('instrument handed (mission history success)', ok, str(st('(S.mission.history || []).slice(-2)')))
        check('handed count on the iPad, with times', st('S.handed.length') >= 1 and st('S.handed.every(x => x.t)'), str(st('S.handed')))
        rt = st('S.hold && S.hold.resume_task && S.hold.resume_task.text')
        time.sleep(2)
        pg.mouse.click(500, 300); time.sleep(0.5)
        pg.evaluate("location.hash = '#/instruments'"); time.sleep(1.2); shot('sim_handed_count_light')
        api("login('operator', '123456', 'R. Kumar')"); wait('S.session.role === "operator"', 5)
        pg.mouse.click(500, 300); time.sleep(0.5)
        pg.evaluate("location.hash = '#/missions'"); time.sleep(1.5); shot('sim_missions_tree_light')
        api('logout()')
        check('zero console errors', not errs, ' | '.join(errs[:3]))
        b.close()
    jw.destroy_node(); rclpy.shutdown()
    bad = [r for r in results if not r[1]]
    print(f'\n{len(results) - len(bad)}/{len(results)} checks passed')
    sys.exit(1 if bad else 0)


main()
