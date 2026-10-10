"""Start-of-day check (docs/ui/04 F1; README decision 15). `run_checks(snapshot)` turns the server's view of the robot
into a list of items {id, name, status ok|warn|fail|unknown, value, fix}. Any `fail` keeps motion locked in the app;
the hardware e-stop items also lock motion in the manager (docs/interfaces.md 3.4)."""
import json
import os
import time


def _item(i, name, status, value='', fix=''):
    return {'id': i, 'name': name, 'status': status, 'value': value, 'fix': fix}


def run_checks(s, now=None):
    now = time.time() if now is None else now
    items = []
    age = s.get('manager_age')
    items.append(_item('robot_link', 'Robot link', 'ok' if age is not None and age < 2.5 else 'fail',
                       'no answer' if age is None else f'{age:.1f} s since last status',
                       'Robot not answering: check it is switched on and on the robot Wi-Fi.'))
    e = s.get('estop') or {}
    if e.get('dev_override'):
        items.append(_item('estop', 'Hardware e-stop', 'warn', 'DEV OVERRIDE: e-stop not required',
                           'Development only. Never run with patients like this.'))
    elif e.get('alive') and not e.get('pressed'):
        items.append(_item('estop', 'Hardware e-stop', 'ok', 'connected, released'))
    else:
        items.append(_item('estop', 'Hardware e-stop', 'fail', e.get('reason') or 'not seen',
                           'Switch the wireless e-stop on; release it if pressed. Motion stays locked until then.'))
    t = s.get('estop_test_t')
    items.append(_item('estop_test', 'E-stop press test', 'ok' if t and now - t < 600 else 'warn',
                       f"pressed and released {time.strftime('%H:%M', time.localtime(t))}" if t else 'not done',
                       'Press the e-stop, then release it: the app must see both.'))
    soc = s.get('battery_soc')
    if soc is None:
        items.append(_item('battery', 'Battery', 'unknown', 'no battery data (simulation)', ''))
    else:
        items.append(_item('battery', 'Battery', 'ok' if soc >= 80 else 'warn' if soc >= 30 else 'fail',
                           f'{soc:.0f} %', 'Charge the robot before the list starts.'))
    c = s.get('controller') or {}
    hz = c.get('loop_hz')
    if not c:
        items.append(_item('controller', 'Balance controller', 'fail', 'no status', 'Start the robot software.'))
    else:
        items.append(_item('controller', 'Balance controller', 'ok' if (hz or 0) > 400 else 'warn',
                           f"{hz} Hz · {c.get('policy', '?')}", 'Controller loop slow: call technician.'))
        items.append(_item('policy', 'Approved walking policy', 'warn' if c.get('placeholder') else 'ok',
                           'development placeholder policy' if c.get('placeholder') else c.get('policy', ''),
                           'Load the approved (trained) policy before clinical use.'))
    tmax = s.get('temp_max')
    items.append(_item('temps', 'Joint temperatures', 'unknown' if tmax is None else 'ok' if tmax < 60 else 'fail',
                       'not reported (simulation)' if tmax is None else f'max {tmax} °C',
                       'Let the robot cool down; call technician.'))
    sa = s.get('scan_age')
    items.append(_item('lidar', 'Lidar', 'ok' if sa is not None and sa < 1.0 else 'fail',
                       'no data' if sa is None else f'{sa:.1f} s', 'Lidar not streaming: call technician.'))
    ca = s.get('camera_age')
    items.append(_item('camera', 'Operator camera', 'ok' if ca is not None and ca < 2 else 'unknown',
                       'no stream' if ca is None else f'{ca:.1f} s', 'Only needed for manual arms.'))
    loc = s.get('localised')
    std = s.get('amcl_std')
    items.append(_item('localisation', 'Map and localisation', 'ok' if loc else 'warn',
                       (f"map {s.get('active_map') or '?'}" + (f', ±{std:.2f} m' if std is not None else ''))
                       if loc else 'not localised',
                       'Operator: load the map and set the robot position.'))
    items.append(_item('time', 'Clock', 'ok', time.strftime('%Y-%m-%d %H:%M', time.localtime(now))))
    items.append(_item('versions', 'Software versions', 'ok', s.get('versions_text', '')))
    locked = any(i['status'] == 'fail' for i in items if i['id'] in ('robot_link', 'estop'))
    ready = not any(i['status'] == 'fail' for i in items)
    return {'items': items, 'motion_locked': locked, 'ready': ready, 't': round(now, 1)}


class CheckRecords:
    def __init__(self, directory):
        os.makedirs(directory, exist_ok=True)
        self.path = os.path.join(directory, 'checks.jsonl')

    def record(self, rec):
        with open(self.path, 'a') as f:
            f.write(json.dumps(rec, default=str) + '\n')

    def today(self, now=None):
        now = time.time() if now is None else now
        day = time.strftime('%Y-%m-%d', time.localtime(now))
        out = []
        try:
            with open(self.path) as f:
                for ln in f:
                    r = json.loads(ln)
                    if time.strftime('%Y-%m-%d', time.localtime(r['t'])) == day:
                        out.append(r)
        except (OSError, ValueError):
            pass
        return out
