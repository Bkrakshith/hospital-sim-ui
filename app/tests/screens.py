"""Screenshots of every screen, Light + Theatre dim, iPad Pro 11 landscape (+ portrait for the main screens).

    python hospital-sim-ui/app/tests/screens.py [--url http://127.0.0.1:8174] [--out hospital-sim-ui/app/docs/screenshots]

Runs against the real v2 server + mock robot. States the mock cannot produce are INJECTED through the
?test=1 hook and the file name says so (`*_injected_*`): a running scrub-assist mission, Medium/Low alarms,
lost link. Everything else is live. Also writes a11y.json (touch targets, labels) for the accessibility pass.
"""
import argparse
import json
import os
import time

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ap = argparse.ArgumentParser()
ap.add_argument('--url', default='http://127.0.0.1:8174')
ap.add_argument('--out', default=os.path.join(HERE, '..', 'docs', 'screenshots'))
ap.add_argument('--browser', default='webkit')
ap.add_argument('--themes', default='light,dim')
args = ap.parse_args()
os.makedirs(args.out, exist_ok=True)
console = []

TREE = [
    ('scrub_nurse', 'RUNNING', 0), ('EnsureAuto', 'SUCCESS', 1), ('ReachStation', 'SUCCESS', 1), ('ToReady', 'SUCCESS', 1),
    ('FineAlign', 'SUCCESS', 1), ('Serve', 'RUNNING', 1), ('ServeOrRecover', 'RUNNING', 2), ('ServeOne', 'RUNNING', 3),
    ('WaitForRequest', 'SUCCESS', 4), ('LocateInstrument', 'SUCCESS', 4), ('Pick', 'RUNNING', 4), ('ToSurgeon', 'IDLE', 4),
    ('CarryToSurgeon', 'IDLE', 5), ('Handover', 'IDLE', 4), ('Retract', 'IDLE', 4), ('ReturnToReady', 'IDLE', 4), ('BackToTable', 'IDLE', 4),
]
MISSION = {'type': 'mission', 'state': 'running', 'step': 'Pick', 'instrument': 'needle_driver', 'kind': 'scrub_nurse', 'queue': ['scissors'],
           'tree': [{'name': n, 'status': s, 'depth': d, 'type': '', 'message': ''} for n, s, d in TREE],
           'history': [{'instrument': 'scissors', 'success': True, 'duration': 52.3, 'message': ''}, {'instrument': 'angled_tweezers', 'success': True, 'duration': 47.9, 'message': ''}],
           'counts': {'ok': 2, 'failed': 0}, 'recording': False, 'message': 'picking needle_driver',
           'instruments': ['scalpel_handle', 'scissors', 'angled_tweezers', 'veress_needle', 'trocar', 'adson_forceps', 'needle_driver']}


def st(pg, expr):
    return pg.evaluate(f'() => {{ const S = window.__g1.store.state; return {expr}; }}')


def api(pg, call):
    return pg.evaluate(f'async () => {{ const c = await import("./js/client.js"); return await c.api.{call}; }}')


def inject(pg, msg, wait=0.4):
    pg.evaluate('(m) => window.__g1.inject(m)', msg)
    time.sleep(wait)


def wait(pg, expr, t=10):
    t0 = time.time()
    while time.time() - t0 < t:
        try:
            if st(pg, expr):
                return True
        except Exception:
            pass
        time.sleep(0.2)
    return False


def go(pg, s, settle=1.0):
    pg.evaluate(f"location.hash = '#/{s}'")
    time.sleep(settle)


def shot(pg, name):
    pg.evaluate('() => document.querySelectorAll(".toast").forEach(t => t.remove())')
    pg.screenshot(path=os.path.join(args.out, name + '.png'))
    print('shot', name, flush=True)


def close_sheets(pg):
    pg.keyboard.press('Escape')
    time.sleep(0.3)


def login(pg, role):
    pin = {'operator': '123456', 'technician': '987654'}[role]
    api(pg, f"login('{role}', '{pin}', '{'R. Kumar' if role == 'operator' else 'T. Lee'}')")
    wait(pg, f'S.session.role === "{role}"')
    time.sleep(0.5)


def logout(pg):
    if st(pg, 'S.lease.you'):
        api(pg, 'leaseRelease()')
    api(pg, 'logout()')
    wait(pg, 'S.session.role === "clinical"')


def standing(pg):
    for a in st(pg, 'S.alarms.active.filter(a => !a.acknowledged).map(a => a.id)') or []:
        api(pg, f'ackAlarm({json.dumps(a)})')
    m = st(pg, 'S.mode && S.mode.name')
    if m == 'HOLD':
        api(pg, "resume('stand')")
    elif m in ('LOCO', 'MANIP', 'NAV', 'AUTO'):
        api(pg, 'cancelTask()')
        if st(pg, 'S.mode.name') in ('LOCO', 'MANIP'):
            login(pg, 'technician'); api(pg, "leaseAcquire('shots')"); api(pg, "setMode('STAND')"); api(pg, 'leaseRelease()'); logout(pg)
    elif m == 'DAMP':
        login(pg, 'technician')
        pg.evaluate('async () => { const g = await import("./js/goals.js"); return await g.standUp(); }')
        logout(pg)
    wait(pg, 'S.mode.name === "STAND"')
    time.sleep(0.5)


def a11y_audit(pg):
    """Touch targets and accessible names of every visible control on the current screen."""
    return pg.evaluate('''() => {
      const out = [];
      const role = document.getElementById('app').dataset.role;
      for (const el of document.querySelectorAll('button, a[href], [role="slider"], [role="switch"], input, select')) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        const name = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('title') || '').trim().replace(/\\s+/g, ' ');
        out.push({ tag: el.tagName, cls: el.className && String(el.className).slice(0, 40), name: name.slice(0, 60), w: Math.round(r.width), h: Math.round(r.height), role,
                   zone: el.closest('#safety') ? 'safety' : el.closest('#navrail') ? 'nav' : el.closest('#statusbar') ? 'bar' : el.closest('.sheet') ? 'sheet' : 'main' });
      }
      return out;
    }''')


def run_theme(p, theme, portrait=False):
    dev = dict(p.devices['iPad Pro 11' if portrait else 'iPad Pro 11 landscape'])
    b = getattr(p, args.browser).launch()
    ctx = b.new_context(**dev)
    ctx.add_init_script(f"try {{ localStorage.setItem('g1.theme', JSON.stringify('{theme}')); localStorage.setItem('g1.speak', 'false'); }} catch (e) {{}}")
    pg = ctx.new_page()
    pg.on('console', lambda m: console.append(f'{theme} {m.type}: {m.text}') if m.type == 'error' else None)
    pg.on('pageerror', lambda e: console.append(f'{theme} pageerror: {e}'))
    pg.goto(args.url + '/?test=1#/home')
    wait(pg, 'S.connected && S.v2 && S.mode', 12)
    o = 'portrait' if portrait else 'landscape'
    T = f'{theme}'
    audit = {}

    def snap(name, key=None):
        shot(pg, f'{name}_{o}_{T}' if portrait else f'{name}_{T}')
        if key and theme == 'light' and not portrait:
            audit[key] = a11y_audit(pg)

    standing(pg)
    go(pg, 'home', 2)
    snap('clinical_home_standby', 'home')
    if portrait:
        # the main screens only
        go(pg, 'places'); snap('clinical_places')
        inject(pg, MISSION); go(pg, 'home', 1.5); snap('clinical_home_injected_mission')
        login(pg, 'operator'); go(pg, 'drive', 1.5); snap('operator_walk'); go(pg, 'map', 2); snap('operator_map'); logout(pg)
        pg.evaluate('() => window.__g1.idle(25)'); time.sleep(1.8); snap('across_room')
        b.close()
        return audit
    # ---- clinical
    go(pg, 'places'); snap('clinical_places', 'places')
    go(pg, 'instruments'); snap('clinical_instruments', 'instruments')
    go(pg, 'checks', 2); snap('clinical_checks_start_of_day', 'checks')
    pg.locator('.seg-b:has-text("Handover card")').click(); time.sleep(1); snap('clinical_checks_handover')
    pg.locator('.seg-b:has-text("End of shift")').click(); time.sleep(0.6); snap('clinical_checks_end_of_shift')
    go(pg, 'status', 1.5); snap('clinical_status', 'status')
    # sheets
    go(pg, 'home')
    pg.locator('#role-chip').click(); time.sleep(0.5); snap('sheet_sign_in', 'signin')
    pg.locator('.role-card:has-text("Operator")').click(); time.sleep(0.5); snap('sheet_pin_pad', 'pinpad'); close_sheets(pg)
    pg.locator('#sb-help').click(); time.sleep(0.5); snap('sheet_help'); close_sheets(pg)
    pg.locator('.sb-place').click(); time.sleep(0.5); snap('sheet_settings'); close_sheets(pg)
    pg.locator('#sb-sound').click(); time.sleep(0.5); snap('sheet_sound_check'); close_sheets(pg)
    pg.locator('#rail-lease').click(); time.sleep(0.5); snap('sheet_control_lease'); close_sheets(pg)
    pg.locator('.home-extras button:has-text("Send problem")').click(); time.sleep(0.5)
    pg.locator('.chip-btn:has-text("Stuck")').click(); time.sleep(0.2); snap('sheet_send_problem', 'problem'); close_sheets(pg)
    # ---- live states: send-to readback, trip, stop, across-room
    navok = st(pg, 'S.status && S.status.nav && S.status.nav.server_ready && S.pose && S.pose.frame === "map"')
    if navok:
        go(pg, 'places'); pg.locator('.place-tile[aria-disabled="false"][data-place="sterile_store"], .place-tile[aria-disabled="false"][data-place="corridor_west"]').first.click()
        pg.locator('#readback').wait_for(timeout=4000); time.sleep(0.3); snap('clinical_readback_undo', 'readback')
        wait(pg, 'S.mode.name === "NAV"', 8); go(pg, 'home', 3); snap('clinical_home_going')
        pg.evaluate('() => window.__g1.idle(25)'); time.sleep(1.8); snap('across_room_going', 'across')
        pg.mouse.click(600, 400); time.sleep(0.5)
        pg.locator('#stop-btn').dispatch_event('pointerdown'); wait(pg, 'S.mode.name === "HOLD"', 4); time.sleep(1.2)
        snap('clinical_home_stopped', 'stopped')
        pg.evaluate('() => window.__g1.idle(25)'); time.sleep(1.8); snap('across_room_stopped')
        pg.mouse.click(600, 400); time.sleep(0.3)
        api(pg, 'cancelTask()'); standing(pg)
    # ---- alarms: High is live (power off); Medium / Low injected
    login(pg, 'technician'); api(pg, 'powerOff()'); logout(pg)
    wait(pg, 'S.alarms.active.some(a => a.priority === "high")', 5); go(pg, 'home', 1.2)
    pg.wait_for_timeout(260)
    snap('alarm_high_power_off', 'alarm')
    pg.locator('#rail-alarms').click(); time.sleep(0.5); snap('sheet_alarm_list'); close_sheets(pg)
    standing(pg)
    inject(pg, {'type': 'alarms', 'active': [{'id': 901, 'code': 'handover_failed', 'priority': 'medium', 'what': 'Handover failed: Angled tweezers (Handover: surgeon did not take the instrument).', 'do': 'Hand the instrument to the surgeon manually.', 'who': 'Scrub nurse.', 'since': time.time(), 'latched': False, 'condition_active': True, 'acknowledged': None}], 'counts': {'high': 0, 'medium': 1, 'low': 0}, 'suppressed': []})
    go(pg, 'home', 1)
    MED = {'type': 'alarms', 'active': [{'id': 901, 'code': 'handover_failed', 'priority': 'medium', 'what': 'Handover failed: Angled tweezers (Handover: surgeon did not take the instrument).', 'do': 'Hand the instrument to the surgeon manually.', 'who': 'Scrub nurse.', 'since': time.time(), 'latched': False, 'condition_active': True, 'acknowledged': None}], 'counts': {'high': 0, 'medium': 1, 'low': 0}, 'suppressed': []}
    inject(pg, MED, 0.12); snap('alarm_medium_injected')
    inject(pg, {'type': 'alarms', 'active': [{'id': 902, 'code': 'battery_low', 'priority': 'low', 'what': 'Charge soon: about 40 min left.', 'do': 'Send it to the dock when it is free.', 'who': 'Anyone.', 'since': time.time(), 'latched': False, 'condition_active': True, 'acknowledged': None}], 'counts': {'high': 0, 'medium': 0, 'low': 1}, 'suppressed': []})
    LOW = {'type': 'alarms', 'active': [{'id': 902, 'code': 'battery_low', 'priority': 'low', 'what': 'Charge soon: about 40 min left.', 'do': 'Send it to the dock when it is free.', 'who': 'Anyone.', 'since': time.time(), 'latched': False, 'condition_active': True, 'acknowledged': None}], 'counts': {'high': 0, 'medium': 0, 'low': 1}, 'suppressed': []}
    inject(pg, LOW, 0.12); snap('alarm_low_injected')
    inject(pg, {'type': 'alarms', 'active': [], 'counts': {'high': 0, 'medium': 0, 'low': 0}, 'suppressed': []})
    # ---- mission (injected: the mock has no mission executive)
    inject(pg, MISSION)
    go(pg, 'home', 1.5); snap('clinical_home_injected_mission')
    go(pg, 'instruments', 1); snap('clinical_instruments_injected_mission')
    # ---- operator
    login(pg, 'operator')
    go(pg, 'home', 1); snap('operator_home')
    go(pg, 'map', 2.5); snap('operator_map', 'map')
    go(pg, 'missions', 1); snap('operator_missions_injected', 'missions')
    go(pg, 'drive', 1); snap('operator_walk_take_control', 'drive')
    api(pg, "leaseAcquire('shots')"); time.sleep(0.8); snap('operator_walk_start')
    pg.evaluate('async () => { const g = await import("./js/goals.js"); return await g.runPath("LOCO"); }'); time.sleep(1.5)
    snap('operator_walk_live')
    go(pg, 'arms', 2); snap('operator_arms_preflight', 'arms')
    pg.evaluate('async () => { const g = await import("./js/goals.js"); return await g.runPath("MANIP"); }'); time.sleep(2)
    snap('operator_arms_live')
    api(pg, 'manipHold(true)'); time.sleep(1.2); snap('operator_arms_held')
    api(pg, 'manipHold(false)'); time.sleep(0.8)
    pg.locator('button:has-text("Calibrate…")').click(); time.sleep(0.6); snap('operator_arms_calibration_seated'); close_sheets(pg)
    pg.evaluate('async () => { const g = await import("./js/goals.js"); return await g.runPath("STAND"); }'); time.sleep(1)
    api(pg, 'leaseRelease()')
    go(pg, 'teach', 1); snap('teach_preview_define', 'teach')
    pg.locator('.tf-step:has-text("Test in sim")').click(); time.sleep(0.4); snap('teach_preview_scorecard')
    pg.locator('.tf-step:has-text("Approve")').click(); time.sleep(0.4); snap('teach_preview_approval')
    logout(pg)
    # ---- technician
    login(pg, 'technician')
    go(pg, 'system', 1.5)
    for tab in ['Diagnostics', 'Mapping', 'Logs', 'Audit', 'Incidents', 'Calibration', 'About']:
        pg.locator(f'.seg-tabs .seg-b:has-text("{tab}")').click(); time.sleep(1.5 if tab in ('Mapping', 'Audit') else 0.8)
        snap(f'technician_{tab.lower()}', f'tech_{tab.lower()}')
    go(pg, 'status', 1); snap('technician_status_raw')
    logout(pg)
    # ---- clean screen + lost link
    go(pg, 'home', 1)
    pg.evaluate('() => window.__g1.startCleanMode(30)'); time.sleep(1.2); snap('clean_screen_lock')
    pg.evaluate("() => { const e = document.getElementById('clean-lock'); e.hidden = true; }")
    pg.evaluate('() => window.__g1.offline(true)'); time.sleep(3.5); snap('connection_lost_simulated')
    pg.evaluate('() => window.__g1.offline(false)'); time.sleep(3)
    b.close()
    return audit


with sync_playwright() as p:
    audits = {}
    for theme in args.themes.split(','):
        a = run_theme(p, theme)
        if a:
            audits = a
        run_theme(p, theme, portrait=True)
    with open(os.path.join(args.out, '..', 'a11y_targets.json'), 'w') as f:
        json.dump(audits, f, indent=1)
errs = [c for c in console if 'favicon' not in c]
print('console errors:', len(errs))
for e in errs[:20]:
    print(' ', e)
