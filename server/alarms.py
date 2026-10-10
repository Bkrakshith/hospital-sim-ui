"""Server-side alarm manager (docs/ui/04 §7; 02 A-1..A-5; IEC 60601-1-8 by analogy).

Conditions are evaluated from a snapshot of robot state once a second (`evaluate`), or raised as events (`raise_event`,
e.g. the watchdog trip or power off). Rules:
  * High: latched. It stays listed until acknowledged, even after the condition clears ("Robot fell 10:42 —
    acknowledged by ..."). Once acknowledged it disappears when the condition is also gone.
  * Medium / Low: not latched: removed when the condition clears. Acknowledge silences for `silence_s` (2 min); if the
    condition is still true afterwards it sounds again.
  * Anyone can acknowledge; nobody in Clinical can disable. A technician may suppress a Low class for the session.
  * Every alarm text is what · do · who. `tech_code` is the code shown to technicians only.
Budget stats per code: raised, acknowledged, acknowledged without action (no command within 60 s after the ack),
auto-cleared.
"""
import itertools
import time

# code: (priority, what, do, who, kind)   kind: condition | event
CATALOG = {
    'fall': ('high', 'Robot has fallen.', 'Keep clear.', 'Call technician.', 'event'),
    'power_off': ('high', 'Robot powered down{by}.', 'It will not move until a technician stands it up.',
                  'Technician.', 'event'),
    'estop_pressed': ('high', 'Emergency stop pressed on remote.', 'Release it when safe, then Resume.',
                      'Person with the remote.', 'condition'),
    'estop_missing': ('medium', 'Hardware e-stop not connected.', 'Motion is locked. Switch the remote on.',
                      'Technician.', 'condition'),
    'link_lost': ('medium', 'Lost contact with robot.', 'It will stop. Check Wi-Fi / move closer.', 'Anyone.',
                  'condition'),
    'manual_control_lost': ('medium', 'Manual control lost.', 'Robot is holding still. Resume when ready.',
                            'Operator.', 'event'),
    'nav_blocked': ('medium', 'Robot is waiting: path blocked.', 'Clear the path or cancel the task.', 'Anyone.',
                    'condition'),
    'localisation_uncertain': ('medium', 'Robot is unsure where it is.', 'Relocalise on the map.', 'Operator.',
                               'condition'),
    'grasp_failed': ('medium', "Can't pick {what}.", 'Hand it to the scrub nurse manually.', 'Scrub nurse.', 'event'),
    # grasp_failed / handover_failed clear on acknowledge or when the next instrument request succeeds
    'handover_failed': ('medium', 'Handover failed: {what}.', 'Hand the instrument to the surgeon manually.',
                        'Scrub nurse.', 'event'),
    'battery_low_task': ('medium', 'Battery low.', 'Finishing this task, then docking.', 'Anyone.', 'condition'),
    'joint_hot': ('medium', '{what} hot.', 'Robot will stand still to cool.', 'Technician.', 'condition'),
    'placeholder_policy': ('low', 'Development policy running.', 'Not for clinical use.', 'Technician.',
                           'condition'),
    'battery_low': ('low', 'Charge soon.', 'Send the robot to the dock when free.', 'Anyone.', 'condition'),
    'camera_stale': ('low', 'Robot camera paused.', 'Check the camera if you need it.', 'Operator.', 'condition'),
    'no_controller_connected': ('low', 'No iPad connected while the robot is driving.', 'Open the app.',
                                'Anyone.', 'condition'),
}
TECH_ONLY = {'placeholder_policy'}
LIGHT = {'high': ('red', 'flash_2hz'), 'medium': ('amber', 'pulse_0.6hz'), 'low': ('cyan', 'steady')}
MODE_LIGHT = {'DAMP': ('off', 'steady'), 'STAND': ('white', 'steady'), 'HOLD': ('red', 'steady'),
              'LOCO': ('magenta', 'steady'), 'MANIP': ('magenta', 'steady'), 'NAV': ('blue', 'steady'),
              'AUTO': ('blue', 'steady')}
PRIO_RANK = {'high': 3, 'medium': 2, 'low': 1}


class AlarmManager:
    def __init__(self, clock=time.time, silence_s=120.0, action_window_s=60.0, on_change=None, say=None):
        self.clock = clock
        self.silence_s = silence_s
        self.action_window = action_window_s
        self.on_change = on_change or (lambda: None)
        self.say = say or (lambda text: None)
        self.active = {}               # code -> alarm dict
        self.suppressed = set()
        self.ids = itertools.count(1)
        self.stats = {c: {'raised': 0, 'acknowledged': 0, 'ack_without_action': 0, 'auto_cleared': 0}
                      for c in CATALOG}
        self.pending_acks = []         # (code, t_ack, actioned)
        self.history = []              # cleared alarms (for the handover card / incidents)

    # ------------------------------------------------------------------ raise / clear
    def _text(self, code, fmt):
        prio, what, do, who, _ = CATALOG[code]
        what = what.format(**{'by': '', 'what': 'instrument', **fmt})
        return prio, what, do, who

    def raise_(self, code, **fmt):
        if code not in CATALOG:
            raise KeyError(code)
        now = self.clock()
        a = self.active.get(code)
        prio, what, do, who = self._text(code, fmt)
        if a is not None:
            changed = not a['condition_active'] or a['what'] != what
            a.update(condition_active=True, what=what, text=f'{what} {do}')
            if a['acknowledged'] and prio != 'high' and now >= (a['silenced_until'] or 0):
                a['acknowledged'] = None        # re-sounds after the silence
                changed = True
            if changed:
                self.on_change()
            return a
        a = {'id': next(self.ids), 'code': code, 'priority': prio, 'what': what, 'do': do, 'who': who,
             'text': f'{what} {do}', 'since': round(now, 2), 'latched': prio == 'high', 'condition_active': True,
             'acknowledged': None, 'silenced_until': None, 'tech_code': code.upper(),
             'tech_only': code in TECH_ONLY, 'suppressed': code in self.suppressed}
        self.active[code] = a
        self.stats[code]['raised'] += 1
        if not a['suppressed']:
            if prio == 'high':
                self.say(f'Robot alarm: {what}')
            elif prio == 'medium':
                self.say(what)
        self.on_change()
        return a

    raise_event = raise_

    def clear(self, code):
        a = self.active.get(code)
        if a is None or not a['condition_active']:
            return
        a['condition_active'] = False
        if a['latched'] and not a['acknowledged']:
            self.on_change()                     # High stays until acknowledged
            return
        self._drop(code, auto=True)

    def _drop(self, code, auto):
        a = self.active.pop(code)
        if auto and not a['acknowledged']:
            self.stats[code]['auto_cleared'] += 1
        a['cleared'] = round(self.clock(), 2)
        self.history = (self.history + [a])[-200:]
        self.on_change()

    def set(self, code, cond, **fmt):
        if cond:
            self.raise_(code, **fmt)
        else:
            self.clear(code)

    # ------------------------------------------------------------------ operator actions
    def acknowledge(self, alarm_id, by, device=''):
        for code, a in list(self.active.items()):
            if a['id'] == alarm_id:
                now = self.clock()
                a['acknowledged'] = {'by': by, 'device': device, 't': round(now, 2)}
                a['silenced_until'] = round(now + self.silence_s, 2)
                self.stats[code]['acknowledged'] += 1
                self.pending_acks.append([code, now, False])
                event_kind = CATALOG[code][4] == 'event'
                if not a['condition_active'] or (event_kind and a['priority'] != 'high'):
                    self._drop(code, auto=False)
                else:
                    self.on_change()       # still true: High stays listed (acknowledged), Medium/Low silenced
                return True, f"acknowledged: {a['what']}"
        return False, 'no such alarm (already cleared?)'

    def note_command(self, t=None):
        """A command was sent: acknowledgements in the last action window count as actioned."""
        t = self.clock() if t is None else t
        for p in self.pending_acks:
            if t - p[1] <= self.action_window:
                p[2] = True

    def tick_stats(self):
        now = self.clock()
        keep = []
        for code, t_ack, actioned in self.pending_acks:
            if now - t_ack > self.action_window:
                if not actioned:
                    self.stats[code]['ack_without_action'] += 1
            else:
                keep.append([code, t_ack, actioned])
        self.pending_acks = keep

    def suppress(self, code):
        if code not in CATALOG or CATALOG[code][0] != 'low':
            return False, 'only Low alarm classes can be suppressed'
        self.suppressed.add(code)
        if code in self.active:
            self.active[code]['suppressed'] = True
        self.on_change()
        return True, f'{code} suppressed for this session'

    # ------------------------------------------------------------------ views
    def view(self, role='clinical'):
        items = [dict(a) for a in self.active.values() if not (a['tech_only'] and role != 'technician')]
        for a in items:
            if role != 'technician':
                a.pop('tech_code', None)
        items.sort(key=lambda a: (-PRIO_RANK[a['priority']], a['since']))
        counts = {p: sum(1 for a in items if a['priority'] == p and not a['suppressed']) for p in PRIO_RANK}
        return {'type': 'alarms', 'active': items, 'counts': counts, 'suppressed': sorted(self.suppressed)}

    def top(self):
        live = [a for a in self.active.values() if not a['suppressed'] and not a['tech_only']
                and not (a['acknowledged'] and a['priority'] != 'high')]
        if not live:
            return None
        return max(live, key=lambda a: PRIO_RANK[a['priority']])

    def light(self, mode_name):
        a = self.top()
        if a is not None and not (a['priority'] == 'high' and a['acknowledged']):
            c, p = LIGHT[a['priority']]
        else:
            c, p = MODE_LIGHT.get(mode_name or 'DAMP', ('off', 'steady'))
        return {'colour': c, 'pattern': p}

    def budget(self):
        return {code: dict(s) for code, s in self.stats.items() if s['raised']}

    # ------------------------------------------------------------------ condition evaluation
    def evaluate(self, s):
        """s: snapshot dict (see Dashboard.alarm_snapshot)."""
        ctrl = s.get('controller') or {}
        mode = s.get('mode')
        self.set('estop_pressed', bool(s.get('estop_pressed')))
        self.set('estop_missing', bool(s.get('estop_missing')))
        self.set('link_lost', bool(s.get('link_lost')) and mode in ('NAV', 'AUTO', 'LOCO', 'MANIP'))
        self.set('placeholder_policy', bool(ctrl.get('placeholder')))
        soc = s.get('battery_soc')
        busy = mode in ('NAV', 'AUTO')
        self.set('battery_low_task', soc is not None and soc < 15 and busy)
        self.set('battery_low', soc is not None and soc < 30 and not busy)
        tmax, hottest = s.get('temp_max'), s.get('temp_hottest')
        self.set('joint_hot', tmax is not None and tmax > s.get('temp_limit', 70),
                 what=(hottest or 'A joint').replace('_', ' ').capitalize())
        cam_age = s.get('camera_age')
        self.set('camera_stale', cam_age is not None and cam_age > 2.0 and mode != 'MANIP'
                 and s.get('camera_expected', False))
        std = s.get('amcl_std')
        self.set('localisation_uncertain', std is not None and std > 0.5 and busy)
        self.set('nav_blocked', bool(s.get('nav_blocked')))
        self.set('no_controller_connected', busy and s.get('clients', 1) == 0
                 and s.get('no_client_for', 0) > 10.0)
        if ctrl.get('fall_detected'):
            self.raise_('fall')
        if 'manual_control_lost' in self.active and mode != 'HOLD':
            self.clear('manual_control_lost')
        if 'power_off' in self.active and mode not in ('DAMP', None):
            self.clear('power_off')
        if 'fall' in self.active and not ctrl.get('fall_detected') and mode != 'DAMP':
            self.clear('fall')
        self.tick_stats()
