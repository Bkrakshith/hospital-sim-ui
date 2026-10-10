"""Scripted flows F1-F5 for the G1 iPad app (Playwright, WebKit, iPad Pro 11).

    source env.sh; ROS_DOMAIN_ID=74 python hospital-sim-ui/server --mock --no-tls --port 8174 --localhost-role clinical &
    PLAYWRIGHT_BROWSERS_PATH=... python hospital-sim-ui/app/tests/flows.py [--url http://127.0.0.1:8174] [--out DIR] [--only F2,F5]

Drives the UI with real pointer gestures (tap, slide, hold). Setup steps that are not part of the flow under
test (loading the map, setting the initial pose) go through the app's own `api` via the ?test=1 hook.
Prints PASS/FAIL per check and exits non-zero on any failure or console error.
"""
import argparse
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ap = argparse.ArgumentParser()
ap.add_argument('--url', default='http://127.0.0.1:8174')
ap.add_argument('--out', default=os.path.join(HERE, '..', 'docs', 'screenshots'))
ap.add_argument('--only', default='')
ap.add_argument('--browser', default='webkit')
ap.add_argument('--tech-pin', default='987654')
ap.add_argument('--op-pin', default='123456')
ap.add_argument('--sim', action='store_true', help='running against the MuJoCo sim + mission (F3 end to end)')
args = ap.parse_args()
os.makedirs(args.out, exist_ok=True)
ONLY = set(x for x in args.only.split(',') if x)

results = []
console = []


def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{detail}]' if detail else ''), flush=True)
    return cond


def run(pg, js, arg=None):
    return pg.evaluate(js, arg)


def state(pg, expr):
    return pg.evaluate(f'() => {{ const S = window.__g1.store.state; return {expr}; }}')


def wait_for(pg, expr, timeout=15.0, poll=0.2):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            if state(pg, expr):
                return True
        except Exception:
            pass
        time.sleep(poll)
    return False


def api(pg, call):
    return pg.evaluate(f'async () => {{ const c = await import("./js/client.js"); return await c.api.{call}; }}')


def tap(pg, selector, **kw):
    el = pg.locator(selector).first
    el.wait_for(state='visible', timeout=kw.get('timeout', 5000))
    el.scroll_into_view_if_needed()
    box = el.bounding_box()
    x, y = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
    pg.mouse.move(x, y)
    pg.mouse.down()
    time.sleep(kw.get('hold', 0.06))
    pg.mouse.up()
    time.sleep(0.25)


def slide(pg, selector):
    tr = pg.locator(selector).first
    tr.wait_for(state='visible', timeout=5000)
    tr.scroll_into_view_if_needed()
    time.sleep(0.2)
    box = tr.bounding_box()
    th = tr.locator('.slide-thumb').bounding_box()
    x0, y = th['x'] + th['width'] / 2, th['y'] + th['height'] / 2
    pg.mouse.move(x0, y)
    pg.mouse.down()
    for i in range(1, 13):
        pg.mouse.move(x0 + (box['width'] - th['width']) * i / 12, y)
        time.sleep(0.02)
    pg.mouse.up()
    time.sleep(0.4)


def hold(pg, selector, secs):
    el = pg.locator(selector).first
    el.scroll_into_view_if_needed()
    box = el.bounding_box()
    pg.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
    pg.mouse.down()
    time.sleep(secs)
    pg.mouse.up()
    time.sleep(0.3)


def shot(pg, name):
    pg.evaluate('() => document.querySelectorAll(".toast").forEach(t => t.remove())')
    pg.screenshot(path=os.path.join(args.out, name + '.png'))


def go(pg, screen):
    pg.evaluate(f"location.hash = '#/{screen}'")
    time.sleep(0.8)


def sign_in(pg, role, pin, user):
    tap(pg, '#role-chip')
    tap(pg, f'.role-card:has-text("{role.capitalize()}")')
    pg.fill('#signin-name', user)
    for d in pin:
        tap(pg, f'.keys .key[aria-label="{d}"]', hold=0.03)
    ok = wait_for(pg, f'S.session.role === "{role}"', 6)
    time.sleep(0.6)
    return ok


def sign_out(pg):
    if state(pg, 'S.session.role') == 'clinical':
        return True
    tap(pg, '#role-chip')
    tap(pg, 'button:has-text("Done: back to Clinical")')
    return wait_for(pg, 'S.session.role === "clinical"', 6)


def mode(pg):
    return state(pg, 'S.mode && S.mode.name')


def ensure_standing(pg):
    """Setup helper: robot standing, no hold, lease free, stale alarms acknowledged."""
    for a in state(pg, 'S.alarms.active.filter(a => !a.acknowledged).map(a => a.id)') or []:
        api(pg, f'ackAlarm({json.dumps(a)})')
    m = mode(pg)
    if m == 'HOLD':
        api(pg, "resume('stand')")
    elif m == 'DAMP':
        role = state(pg, 'S.session.role')
        if role != 'technician':
            api(pg, f"login('technician', '{args.tech_pin}', 'T. Lee')")
            wait_for(pg, 'S.session.role === "technician"', 5)
        pg.evaluate('async () => { const g = await import("./js/goals.js"); return await g.standUp(); }')
        if role == 'clinical':
            api(pg, 'logout()')
        elif role == 'operator':
            api(pg, f"login('operator', '{args.op_pin}', 'R. Kumar')")
    wait_for(pg, 'S.mode && S.mode.name === "STAND"', 8)


def main():
    with sync_playwright() as p:
        bt = getattr(p, args.browser)
        b = bt.launch()
        dev = dict(p.devices['iPad Pro 11 landscape'])
        ctx = b.new_context(**dev)
        pg = ctx.new_page()
        pg.on('console', lambda m: console.append(f'{m.type}: {m.text}') if m.type == 'error' else None)
        pg.on('pageerror', lambda e: console.append(f'pageerror: {e}'))
        pg.goto(args.url + '/?test=1#/home')
        check('connects and speaks v2', wait_for(pg, 'S.connected && S.v2', 10))
        wait_for(pg, 'S.mode', 5)

        # ---------------------------------------------------------------- F1 start of day
        if not ONLY or 'F1' in ONLY:
            print('--- F1 start-of-day', flush=True)
            check('F1 technician signs in', sign_in(pg, 'technician', args.tech_pin, 'T. Lee'))
            if mode(pg) != 'DAMP':
                api(pg, "leaseAcquire('test')"); api(pg, 'powerOff()'); api(pg, 'leaseRelease()')
                wait_for(pg, 'S.mode.name === "DAMP"', 6)
                for a in state(pg, 'S.alarms.active.map(a => a.id)') or []:
                    api(pg, f'ackAlarm({json.dumps(a)})')
            go(pg, 'checks')
            pg.locator('.check-list').first.wait_for(timeout=8000)
            time.sleep(0.5)
            shot(pg, 'f1_checks_technician_light')
            check('F1 automatic checks listed', pg.locator('.check-list .ck').count() >= 5, f"{pg.locator('.check-list .ck').count()} items")
            if pg.locator('text=Slide to stand up').count():
                slide(pg, '.checks-auto .slide')
                check('F1 stand-up slide: DAMP -> STAND', wait_for(pg, 'S.mode.name === "STAND"', 8), mode(pg))
            else:
                ensure_standing(pg)
            check('F1 back to clinical', sign_out(pg))
            go(pg, 'checks')
            t0 = time.time()
            tap(pg, '.nurse-check button:has-text("Yes")')
            tap(pg, '.nurse-check button:has-text("Yes")')
            shot(pg, 'f1_nurse_press_stop_light')
            tap(pg, '#stop-btn', hold=0.05)   # the nurse presses Stop (pointerdown)
            check('F1 Stop -> HOLD', wait_for(pg, 'S.mode.name === "HOLD"', 5), mode(pg))
            pg.locator('text=Stopped by you. That is right.').wait_for(timeout=4000)
            shot(pg, 'f1_nurse_stopped_right_light')
            if pg.locator('#stop-reason').count():
                tap(pg, '#stop-reason button[aria-label="Dismiss"]')
            slide(pg, '.nurse-check .slide')
            check('F1 resume slide -> STAND', wait_for(pg, 'S.mode.name === "STAND"', 8), mode(pg))
            pg.locator('.q-done').wait_for(timeout=5000)
            took = time.time() - t0
            check('F1 nurse part recorded', pg.locator('.q-done').count() == 1, f'{took:.0f} s scripted')
            shot(pg, 'f1_ready_for_today_light')

        # ---------------------------------------------------------------- navigation setup (map + AMCL)
        nav_ok = False
        if not ONLY or ONLY & {'F2', 'F5'}:
            print('--- setup: load map + localise (technician)', flush=True)
            sign_in(pg, 'technician', args.tech_pin, 'T. Lee')
            ensure_standing(pg)
            st = state(pg, 'S.status && S.status.stacks && S.status.stacks.nav && S.status.stacks.nav.state')
            if st not in ('running', 'external'):
                r = api(pg, "mapLoad('hospital_gt')")
                print('map_load', r.get('message'))
            ok = wait_for(pg, 'S.status.stacks.nav.state === "running" || S.status.stacks.nav.state === "external"', 60, 1)
            time.sleep(4)
            api(pg, 'initialPose(8.93, -12.45, 0)')
            nav_ok = wait_for(pg, 'S.pose && S.pose.frame === "map" && S.status.nav && S.status.nav.server_ready', 60, 1)
            check('setup: Nav2 + AMCL on hospital_gt, pose in map frame', ok and nav_ok, str(state(pg, 'S.status.stacks.nav.state')))
            sign_out(pg)
            go(pg, 'home')
            time.sleep(1.5)
            shot(pg, 'home_standing_light')

        # ---------------------------------------------------------------- F2 send to
        if (not ONLY or 'F2' in ONLY) and nav_ok:
            print('--- F2 send to Theatre 1', flush=True)
            t0 = time.time()
            tap(pg, '#tile-send')
            tap(pg, '.place-tile[data-place="theatre_door"]')
            pg.locator('#readback').wait_for(timeout=4000)
            shot(pg, 'f2_readback_undo_light')
            check('F2 readback card shows the place', 'Theatre 1' in pg.locator('.rbk-text').inner_text())
            tap(pg, '#rbk-undo')
            check('F2 undo cancels (no NAV)', wait_for(pg, '!S.pending.size', 4) and mode(pg) == 'STAND', mode(pg))
            time.sleep(1.5)
            t1 = time.time()
            tap(pg, '#tile-send')
            tap(pg, '.place-tile[data-place="theatre_door"]')
            sent = wait_for(pg, 'S.mode.name === "NAV"', 10)
            check('F2 send-to dispatched after 3 s: mode NAV', sent, f'{time.time() - t1:.1f} s incl. 3 s undo window')
            check('F2 ribbon is the robot-driving family', pg.locator('#ribbon.fam-robot').count() == 1)
            time.sleep(3)
            shot(pg, 'f2_going_to_theatre_light')
            hero = pg.locator('.hero-activity').inner_text()
            check('F2 hero says where it is going', 'Theatre 1' in hero or 'Going' in hero, hero)
            # across-room view after idle; first tap only wakes
            run(pg, '() => window.__g1.idle(25)')
            time.sleep(1.6)
            check('F2 across-room view after 20 s idle', pg.locator('#across.in').count() == 1)
            shot(pg, 'f2_across_room_light')
            h0 = run(pg, '() => location.hash')
            tap(pg, '.ac-body')
            check('F2 first tap only wakes', pg.locator('#across.in').count() == 0 and run(pg, '() => location.hash') == h0)
            # ---------------------------------------------------------------- F5 stop / resume / power off
            if not ONLY or 'F5' in ONLY:
                print('--- F5 stop during a trip', flush=True)
                tap(pg, '#stop-btn', hold=0.05)
                check('F5 Stop (one tap) -> HOLD', wait_for(pg, 'S.mode.name === "HOLD"', 3), mode(pg))
                time.sleep(1)
                check('F5 ribbon red "Stopped by"', pg.locator('#ribbon.fam-stopped').count() == 1 and 'Stopped' in pg.locator('#ribbon').inner_text(), pg.locator('#ribbon').inner_text().replace('\n', ' | '))
                shot(pg, 'f5_stopped_reason_light')
                if pg.locator('#stop-reason').count():
                    tap(pg, '#stop-reason button:has-text("Person in the way")')
                check('F5 resume offers to continue the trip', pg.locator('#resume-task').count() == 1, state(pg, 'JSON.stringify(S.hold && S.hold.resume_task)'))
                shot(pg, 'f5_recovery_light')
                slide(pg, '#resume-task')
                check('F5 slide to continue -> NAV', wait_for(pg, 'S.mode.name === "NAV"', 10), mode(pg))
                time.sleep(2)
                tap(pg, '#stop-btn', hold=0.05)
                wait_for(pg, 'S.mode.name === "HOLD"', 3)
                tap(pg, '.hero-recover button:has-text("Cancel task")')
                check('F5 cancel task keeps it standing', wait_for(pg, 'S.mode.name === "STAND" || S.mode.name === "HOLD"', 6), mode(pg))
                ensure_standing(pg)
                # power off: a short press does nothing, 1.5 s hold powers off
                hold(pg, '#power-btn', 0.6)
                time.sleep(0.5)
                check('F5 short press on Power off does nothing', mode(pg) != 'DAMP', mode(pg))
                pg.mouse.move(*[v for v in (lambda b: (b['x'] + b['width'] / 2, b['y'] + b['height'] / 2))(pg.locator('#power-btn').bounding_box())])
                pg.mouse.down(); time.sleep(0.9)
                shot(pg, 'f5_power_off_holding_light')
                time.sleep(0.9); pg.mouse.up()
                check('F5 hold 1.5 s -> DAMP', wait_for(pg, 'S.mode.name === "DAMP"', 5), mode(pg))
                check('F5 latched High alarm raised', wait_for(pg, 'S.alarms.active.some(a => a.priority === "high")', 5))
                time.sleep(0.6)
                shot(pg, 'f5_power_off_alarm_light')
                if pg.locator('.banner-alarm button:has-text("Acknowledge")').count():
                    tap(pg, '.banner-alarm button:has-text("Acknowledge")')
                check('F5 alarm acknowledged', wait_for(pg, 'S.alarms.active.filter(a => a.priority === "high").every(a => a.acknowledged)', 5))

        # ---------------------------------------------------------------- F3 request instrument
        if not ONLY or 'F3' in ONLY:
            print('--- F3 request instrument', flush=True)
            ensure_standing(pg)
            time.sleep(2.0)   # let the session change from the setup helper settle (screen remount)
            go(pg, 'instruments')
            shot(pg, 'f3_instruments_light')
            tap(pg, '.seg-b:has-text("Surgeon")')
            tap(pg, '.inst-tile[data-inst="needle_driver"]')
            time.sleep(0.8)
            if args.sim:
                pg.locator('#readback').wait_for(timeout=4000)
                txt = pg.locator('.rbk-text').inner_text()
                check('F3 readback "Needle driver → surgeon, handle first"', 'Needle driver' in txt and 'surgeon' in txt, txt)
                shot(pg, 'f3_readback_light')
                check('F3 request dispatched: mission running', wait_for(pg, 'S.mission && S.mission.state === "running"', 12))
                ok = wait_for(pg, 'S.mission && S.mission.history && S.mission.history.some(h => h.instrument === "needle_driver" && h.success)', 240, 2)
                check('F3 instrument handed (mission history)', ok)
                check('F3 handed count updated', state(pg, 'S.handed.length') >= 1, str(state(pg, 'S.handed')))
                go(pg, 'instruments'); shot(pg, 'f3_handed_light')
            else:
                seen = []
                for _ in range(20):
                    seen += pg.locator('.toast').all_inner_texts()
                    if any('Scrub assist is not running' in m for m in seen):
                        break
                    time.sleep(0.2)
                check('F3 on the mock: plain refusal (no mission)', any('Scrub assist is not running' in m for m in seen), ' | '.join(sorted(set(seen))))
                shot(pg, 'f3_mock_refusal_light')

        # ---------------------------------------------------------------- F4 manual walking + arms
        if not ONLY or 'F4' in ONLY:
            print('--- F4 manual walking + arms (operator)', flush=True)
            ensure_standing(pg)
            check('F4 operator signs in', sign_in(pg, 'operator', args.op_pin, 'R. Kumar'))
            check('F4 lease free (stale leases expire in 30 s)', wait_for(pg, '!S.lease.holder || S.lease.you', 40, 1))
            go(pg, 'drive')
            shot(pg, 'f4a_take_control_light')
            slide(pg, '#take-control')
            check('F4a lease acquired', wait_for(pg, 'S.lease.you', 5))
            slide(pg, '#start-loco')
            check('F4a goal button runs STAND -> LOCO', wait_for(pg, 'S.mode.name === "LOCO"', 8), mode(pg))
            check('F4a ribbon person-driving (stripes)', pg.locator('#ribbon.fam-person').count() == 1)
            p0 = state(pg, '[S.pose.x, S.pose.y]')
            joy = pg.locator('.joy').bounding_box()
            cx, cy = joy['x'] + joy['width'] / 2, joy['y'] + joy['height'] / 2
            pg.mouse.move(cx, cy); pg.mouse.down()
            for i in range(8):
                pg.mouse.move(cx, cy - 8 * (i + 1)); time.sleep(0.05)
            time.sleep(0.4)
            shot(pg, 'f4a_manual_walking_light')
            time.sleep(1.6)
            pg.mouse.up()
            time.sleep(0.8)
            p1 = state(pg, '[S.pose.x, S.pose.y]')
            moved = ((p1[0] - p0[0]) ** 2 + (p1[1] - p0[1]) ** 2) ** 0.5
            check('F4a hold-to-move moves the robot', moved > 0.05, f'{moved:.2f} m')
            time.sleep(1.0)
            p2 = state(pg, '[S.pose.x, S.pose.y]')
            check('F4a release = stop', ((p2[0] - p1[0]) ** 2 + (p2[1] - p1[1]) ** 2) ** 0.5 < 0.08, f'{((p2[0] - p1[0]) ** 2 + (p2[1] - p1[1]) ** 2) ** 0.5:.3f} m after release')
            go(pg, 'arms')
            time.sleep(1)
            shot(pg, 'f4b_arms_preflight_light')
            slide(pg, '#use-arms')
            check('F4b "Use arms" runs LOCO -> STAND -> MANIP', wait_for(pg, 'S.mode.name === "MANIP"', 10), mode(pg))
            time.sleep(1)
            shot(pg, 'f4b_arms_live_light')
            tap(pg, '#hold-arms')
            check('F4b Hold arms: stays in MANIP, arms held', wait_for(pg, 'S.mode.name === "MANIP" && S.status.arms_hold', 5), f"{mode(pg)} hold={state(pg, 'S.status.arms_hold')}")
            wait_for(pg, 'S.status.hand_override_allowed', 3)
            time.sleep(0.6)
            r = api(pg, "hand('left', 1)")
            check('F4b gripper override accepted while held', r.get('ok'), r.get('message', ''))
            check('F4b release needs the pose match first', pg.locator('#release-arms[aria-disabled="true"]').count() == 1)
            shot(pg, 'f4b_arms_held_match_pose_light')
            tap(pg, '#pose-matched')
            slide(pg, '#release-arms')
            check('F4b release -> arms follow again (still MANIP)', wait_for(pg, '!S.status.arms_hold && S.mode.name === "MANIP"', 5), f"{mode(pg)} hold={state(pg, 'S.status.arms_hold')}")
            r = api(pg, "hand('left', 0)")
            check('F4b gripper refused while arms are live (not_now)', not r.get('ok') and (r.get('data') or {}).get('code') == 'not_now', str(r.get('data')))
            tap(pg, 'button:has-text("Calibrate…")')
            time.sleep(0.6)
            shot(pg, 'f4b_calibration_seated_light')
            tap(pg, '.sheet-close')
            slide(pg, '.arms-side .slide-standby')
            check('F4b finish -> STAND', wait_for(pg, 'S.mode.name === "STAND"', 8), mode(pg))
            api(pg, 'leaseRelease()')
            sign_out(pg)

        errs = [c for c in console if 'favicon' not in c]
        check('zero console errors', not errs, ' | '.join(errs[:5]))
        b.close()
    bad = [r for r in results if not r[1]]
    print(f'\n{len(results) - len(bad)}/{len(results)} checks passed')
    sys.exit(1 if bad else 0)


main()
