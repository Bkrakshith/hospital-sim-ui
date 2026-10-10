// Goal buttons, not transition buttons (HF-16, HF-19). The user asks for an outcome ("Use arms"); the app
// shows the legal FSM path (always via STAND, docs/interfaces.md 3.2) and runs it step by step, waiting for the
// manager to confirm each mode before sending the next. The robot never starts a motion the app did not show.
import { store, api } from './client.js';
import { h, ic } from './ui.js';

const S = store.state;
const LEAVE = {
  LOCO: 'Stop walking',
  MANIP: 'Put the arms back to rest (about 1 s)',
  NAV: 'Pause the trip',
  AUTO: 'Pause the task',
  HOLD: 'Clear the stop and stand normally',
};
const ENTER = { LOCO: 'Manual walking', MANIP: 'Manual arms', NAV: 'Drive itself to the goal', STAND: 'Stand still', AUTO: 'Run the task' };

// returns {steps:[{mode, label}], blocked: reason|null}
export function pathTo(target) {
  const m = S.mode ? S.mode.name : null;
  if (!S.connected) return { steps: [], blocked: 'No connection to the robot' };
  if (!m) return { steps: [], blocked: 'The robot has not reported its mode' };
  if (m === target) return { steps: [], blocked: null };
  if (m === 'DAMP') return { steps: [], blocked: 'The robot is powered down. A technician stands it up first (start-of-day check).' };
  const steps = [];
  if (m === 'HOLD' || S.hold) steps.push({ mode: 'STAND', label: LEAVE.HOLD, resume: true });
  else if (m !== 'STAND') steps.push({ mode: 'STAND', label: LEAVE[m] || 'Stand still' });
  if (target !== 'STAND') steps.push({ mode: target, label: ENTER[target] || target });
  return { steps, blocked: null };
}

export function pathList(target) {
  const { steps, blocked } = pathTo(target);
  if (blocked) return h('p', { class: 'note note-warn' }, ic('info', 22), blocked);
  if (!steps.length) return null;
  return h('ol', { class: 'path-list', 'aria-label': 'What will happen' }, steps.map((s, i) => h('li', {}, h('span', { class: 'pl-n' }, String(i + 1)), s.label)));
}

function waitMode(name, ms = 4000) {
  return new Promise((resolve) => {
    if (S.mode && S.mode.name === name) { resolve(true); return; }
    const off = store.on('mode', ({ mode }) => { if (mode.name === name) { off(); clearTimeout(t); resolve(true); } });
    const t = setTimeout(() => { off(); resolve(S.mode && S.mode.name === name); }, ms);
  });
}

// run the path; onStep(i, step, state) for UI updates. Returns {ok, message}.
export async function runPath(target, onStep = () => {}) {
  const { steps, blocked } = pathTo(target);
  if (blocked) return { ok: false, message: blocked };
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    onStep(i, s, 'running');
    const r = s.resume ? await api.resume('stand') : await api.setMode(s.mode);
    if (!r.ok) { onStep(i, s, 'failed'); return { ok: false, message: r.message }; }
    const reached = await waitMode(s.mode, s.mode === 'STAND' ? 5000 : 4000);
    if (!reached) { onStep(i, s, 'failed'); return { ok: false, message: `The robot did not reach "${s.label}"` }; }
    onStep(i, s, 'done');
  }
  return { ok: true, message: 'done' };
}

// Technician stand-up (F1 step 3): DAMP -> STAND. Takes the lease for the step if it is free, then hands it back.
import { toast } from './ui.js';
export async function standUp() {
  const took = !S.lease.you && !S.lease.holder;
  if (took) await api.leaseAcquire('stand-up test');
  const r = await api.setMode('STAND');
  toast(r.ok ? 'Standing up. The robot says "Ready".' : r.message, { level: r.ok ? 'ok' : 'warn' });
  if (took) await api.leaseRelease();
  return r;
}
