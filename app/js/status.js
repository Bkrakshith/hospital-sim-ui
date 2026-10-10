// One place that turns robot state into plain language (05 §4 status semantics, HF-15..HF-18).
// Used by the hero card, the mode ribbon, the across-room view and the timeline so they never disagree.
import { store, modeLabel, sourceLabel, whoText, placeName, instrumentName, device } from './client.js';
import { roomAt, STEP_WORDS, REQUEST_STEPS } from './data.js';
import { fmt } from './ui.js';

const S = store.state;
const TERMINAL_MISSION = ['idle', 'succeeded', 'failed', 'aborted', null, undefined];
let navStart = null; // {key, dist0}

export const FAMILY = {
  DAMP: 'off', STAND: 'standby', HOLD: 'stopped', LOCO: 'person', MANIP: 'person', NAV: 'robot', AUTO: 'robot',
};
const FAMILY_ICON = { robot: 'robotArrow', person: 'hand', standby: 'pauseCircle', off: 'power', stopped: 'stop', unknown: 'linkOff' };

export function where() {
  const p = S.pose;
  if (!p || p.frame !== 'map') return null;
  const r = roomAt(p.x, p.y);
  const name = r ? r.name : 'Between rooms';
  return p.source === 'sim_ground_truth' ? `${name} (simulation position)` : name;
}

function nearestPlace(x, y, tol = 0.8) {
  let best = null, bd = tol;
  for (const p of S.places) { const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = p; } }
  return best;
}

function navInfo() {
  const nav = S.status && S.status.nav;
  if (!nav || !['active', 'sending', 'paused'].includes(nav.state)) { navStart = null; return null; }
  let dest = null;
  if (nav.goal) { const pl = nearestPlace(nav.goal.x, nav.goal.y); dest = pl ? pl.name : 'a point on the map'; }
  if (nav.kind === 'waypoints') dest = `waypoint ${Math.min((nav.index || 0) + 1, (nav.waypoints || []).length || 1)} of ${(nav.waypoints || []).length || '?'}`;
  if (nav.place) dest = placeName(nav.place);
  const fb = nav.feedback || {};
  const key = JSON.stringify(nav.goal || nav.index);
  const dist = fb.distance_remaining;
  if (!navStart || navStart.key !== key) navStart = { key, dist0: dist };
  if (dist !== undefined && navStart.dist0 !== undefined && dist > navStart.dist0) navStart.dist0 = dist;
  const frac = dist !== undefined && navStart.dist0 ? Math.max(0, Math.min(1, 1 - dist / navStart.dist0)) : null;
  const eta = fb.eta !== undefined && fb.eta !== null && fb.eta > 0 ? fb.eta : (dist !== undefined ? dist / 0.3 : null);
  return { dest, dist, eta, frac, paused: nav.state === 'paused', recoveries: fb.recoveries || 0, state: nav.state };
}

function missionInfo() {
  const m = S.mission;
  if (!m || TERMINAL_MISSION.includes(m.state)) return null;
  const step = m.step || '';
  const stepWord = STEP_WORDS[step] || (step ? step.replace(/([a-z])([A-Z])/g, '$1 $2') : 'Working');
  let goto = null;
  if (m.kind && String(m.kind).startsWith('goto:')) goto = placeName(String(m.kind).slice(5));
  const idx = REQUEST_STEPS.findIndex((s) => s.nodes.includes(step));
  return { state: m.state, step, stepWord, instrument: m.instrument, goto, reqIdx: idx, queue: m.queue || [] };
}

export function unackedAlarms() {
  return S.alarms.active.filter((a) => !a.acknowledged);
}
export function topAlarm() {
  const order = { high: 0, medium: 1, low: 2 };
  const list = S.alarms.active.filter((a) => !a.acknowledged || (a.priority === 'high' && a.condition_active));
  return list.sort((a, b) => order[a.priority] - order[b.priority] || (b.since || 0) - (a.since || 0))[0] || null;
}

export function controllerText() {
  const holder = S.lease.holder;
  const m = S.mode ? S.mode.name : null;
  if (S.lease.you) return S.session.user ? `${S.session.user} (this iPad)` : 'This iPad';
  if (holder) return `${holder.user ? holder.user + ' · ' : ''}${holder.device_name || 'another iPad'}`;
  if (m === 'NAV' || m === 'AUTO') return 'The robot';
  if (m === 'LOCO' || m === 'MANIP') return 'A person (keyboard)';
  return 'Nobody';
}

// Main derivation
export function derive() {
  const connected = S.connected;
  const m = S.mode ? S.mode.name : null;
  const hold = S.hold || (m === 'HOLD' ? { since: null, by: null } : null);
  const fam = !m ? 'unknown' : hold ? 'stopped' : (FAMILY[m] || 'standby');
  const nav = navInfo();
  const mis = missionInfo();
  const alarm = topAlarm();
  const here = where();
  const user = S.lease.holder && S.lease.holder.user;

  let mode = modeLabel(m);
  let activity = '', next = '', progress = null, icon = FAMILY_ICON[fam];
  if (fam === 'unknown') { mode = 'No robot status'; activity = connected ? 'Waiting for the robot to report its mode' : 'No connection to the robot'; next = connected ? 'Is the mode manager running?' : 'Reconnecting…'; }
  else if (fam === 'stopped') {
    mode = 'Stopped';
    const mine = hold && String(hold.source || '') === `ui:${device.id}`;
    const by = mine ? 'you (this iPad)' : hold && hold.by ? whoText(hold.by) : (S.mode && S.mode.source ? sourceLabel(S.mode.source) : null);
    activity = by ? `Stopped by ${by}` : 'Stopped. Holding still';
    const task = hold && hold.resume_task;
    next = hold && hold.resume_blocked ? hold.resume_blocked : task ? 'Holding still. Slide to continue, or cancel the task' : 'Holding still until someone slides to resume';
  } else if (fam === 'off') {
    activity = 'Motors are off';
    next = 'A technician stands it up on the gantry';
  } else if (fam === 'person') {
    const who = S.lease.you ? (S.session.user || 'you') : (user || 'someone');
    mode = m === 'LOCO' ? `Manual walking · ${who}` : `Manual arms · ${who}`;
    activity = m === 'LOCO' ? `${S.lease.you ? 'You are' : who + ' is'} walking the robot` : `${S.lease.you ? 'You are' : who + ' is'} moving the arms`;
    next = 'Moves only while the operator holds the control';
  } else if (fam === 'robot') {
    if (mis) {
      if (mis.goto) { mode = `Going to ${mis.goto}`; activity = `Going to ${mis.goto}`; next = 'Then stands by there'; }
      else if (mis.instrument) {
        const n = instrumentName(mis.instrument);
        mode = `Scrub assist · ${mis.stepWord}`;
        activity = `Bringing ${n.toLowerCase()}`;
        const nx = mis.reqIdx >= 0 && mis.reqIdx < REQUEST_STEPS.length - 1 ? REQUEST_STEPS[mis.reqIdx + 1].label : null;
        const THEN = { 'Pick up': 'pick it up from the rack', Carry: 'carry it to the surgeon', Offer: 'offer it handle first', Handed: 'let go when the surgeon holds it', Back: 'back to the instrument table' };
        next = mis.step === 'Handover' ? 'Waiting for the surgeon to take it' : nx ? (THEN[nx] || nx.toLowerCase()) : 'back to the instrument table';
        icon = 'robotHand';
      } else if (mis.step === 'WaitForRequest') {
        mode = 'Scrub assist · ready'; activity = 'Ready for an instrument request'; next = 'Tap Request instrument'; icon = 'robotHand';
      } else { mode = `Scrub assist · ${mis.stepWord}`; activity = mis.stepWord; next = 'Then ready for a request'; icon = 'robotHand'; }
      if (mis.state === 'paused') next = 'Task paused';
    } else if (nav) {
      mode = `Going to ${nav.dest || 'a goal'}`;
      activity = `Going to ${nav.dest || 'a goal'}`;
      next = nav.paused ? 'Paused on the way' : `Arrives in ${fmt.eta(nav.eta) || 'a moment'} · then stands by`;
    } else {
      activity = m === 'AUTO' ? 'Working on a task' : 'Driving itself';
      next = 'Then stands by';
    }
    if (nav) progress = { frac: nav.frac, eta: nav.eta, dist: nav.dist, recoveries: nav.recoveries };
  } else {
    // standing by
    const at = S.pose && S.pose.frame === 'map' ? nearestPlace(S.pose.x, S.pose.y, 1.2) : null;
    activity = at ? `Standing by at ${at.name}${at.sub && at.name !== 'Dock' ? ' · ' + at.sub.split(' · ')[0].toLowerCase() : ''}` : here ? `Standing by in ${here === 'Between rooms' ? 'the wing' : here}` : 'Standing by';
    next = S.mission && S.mission.state === 'idle' ? 'Waiting for your request' : 'Waiting for your request';
  }

  // status word (one of four; the mode is shown separately in the ribbon)
  let status;
  if (!connected) status = { level: 'unknown', word: 'No link', icon: 'linkOff' };
  else if (alarm && alarm.priority === 'high' && !alarm.acknowledged) status = { level: 'alarm', word: 'Alarm', icon: 'octagon' };
  else if (fam === 'stopped') status = { level: 'stopped', word: 'Stopped', icon: 'stop' };
  else if ((alarm && alarm.priority === 'medium' && !alarm.acknowledged) || fam === 'off' || fam === 'unknown' || (S.motion && S.motion.locked) || (nav && nav.recoveries > 2))
    status = { level: 'needs', word: 'Needs you', icon: 'triangle' };
  else status = { level: 'ok', word: 'OK', icon: 'checkCircle' };
  // server task sentence (v2.1 state.task) wins for what the robot is doing; distance/ETA stay in the progress bar
  const task = S.status && S.status.task;
  if (task && task.text && connected && ['robot', 'person', 'standby'].includes(fam) && !(alarm && alarm.priority === 'high' && !alarm.acknowledged)) {
    activity = String(task.text).split(' · ')[0];
    if (fam === 'robot') mode = activity;
  }
  if (!connected && fam !== 'unknown') {
    activity = `Last known: ${activity.charAt(0).toLowerCase()}${activity.slice(1)}`;
    next = 'Not live. Look at the robot itself';
    progress = null;
  }
  if (alarm && status.level === 'alarm') { activity = alarm.what; next = `${alarm.do}${alarm.who ? ` Who: ${String(alarm.who).replace(/\.$/, '')}.` : ''}`; }

  const mc = S.modeChange;
  const changed = mc ? { text: `${modeLabel(mc.to)} · changed by ${sourceLabel(mc.source)}`, by: sourceLabel(mc.source), at: mc.at, fresh: Date.now() - mc.at < 5000 } :
    S.mode && S.mode.source ? { text: `changed by ${sourceLabel(S.mode.source)}`, by: sourceLabel(S.mode.source), at: null, fresh: false } : null;

  return { fam, mode, icon, activity, next, progress, status, alarm, changed, here, controller: controllerText(), rawMode: m, nav, mission: mis, hold };
}

export function batteryText() {
  const b = S.status && S.status.battery;
  if (!b || b.soc === null || b.soc === undefined) return { text: '–', level: 'unknown', soc: null };
  // G1: ~2 h of walking on a full pack (Unitree spec); standing uses less. Rough, stated as approximate.
  const hours = (b.soc / 100) * 2.2;
  const text = hours >= 1 ? `~${hours.toFixed(hours >= 2 ? 0 : 1)} h` : `~${Math.max(5, Math.round(hours * 60 / 5) * 5)} min`;
  return { text, level: b.soc < 15 ? 'high' : b.soc < 30 ? 'low' : 'ok', soc: b.soc };
}

export function linkQuality() {
  if (!S.connected) return 0;
  const age = (Date.now() - S.lastMsgAt) / 1000;
  if (age > 2) return 1;
  if (age > 1) return 2;
  return 4;
}

export function estopStatus() {
  const mo = S.motion;
  if (!mo || !mo.estop) return { level: 'unknown', text: 'Not reported', short: 'not reported' };
  const e = mo.estop;
  if (e.dev_override) return { level: 'warn', text: 'Development override: not required', short: 'dev override' };
  if (e.pressed) return { level: 'alarm', text: 'Pressed. Release when safe', short: 'pressed' };
  if (e.ok) return { level: 'ok', text: `Remote seen ${fmt.ago(e.age)}`, short: 'seen' };
  return { level: 'alarm', text: 'Remote not seen. Motion locked', short: 'not seen' };
}

export { device };
