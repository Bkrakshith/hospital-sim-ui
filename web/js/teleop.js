// Teleoperation input: contract key bindings (docs/interfaces.md 3.3), browser keyboard capture,
// virtual joystick. The mode manager is the authority: mode keys go through the SetMode service
// (so its accept/reject answer can be shown), movement keys are only sent in LOCO.
import { robot } from './robot.js';
import { h, toast } from './ui.js';

export const MOVE_KEYS = {
  w: 'forward', s: 'backward', a: 'strafe left', d: 'strafe right', q: 'turn left', e: 'turn right',
};
// mode keys: target mode, and the modes the key means something in (null = let the manager decide)
export const MODE_KEYS = {
  r: { target: 'STAND', from: ['DAMP'], label: 'Ready', sub: 'DAMP → STAND' },
  l: { target: 'LOCO', from: null, label: 'Start locomotion', sub: 'STAND → LOCO' },
  p: { target: 'STAND', from: ['LOCO', 'NAV', 'AUTO'], label: 'Pause', sub: 'LOCO / NAV / AUTO → STAND' },
  m: { target: 'MANIP', from: null, label: 'Start camera teleop', sub: 'STAND → MANIP' },
  n: { target: 'STAND', from: ['MANIP'], label: 'Stop camera teleop', sub: 'MANIP → STAND' },
  g: { target: 'NAV', from: null, label: 'Hand over to Nav2', sub: 'STAND → NAV' },
  x: { target: 'DAMP', from: null, label: 'E-stop', sub: 'any → DAMP' },
};
// keys handled by the camera teleop node (g1-webcam-teleop/xr_teleoperate webcam), forwarded on /g1/teleop/key
export const CAMERA_KEYS = {
  c: { label: 'Calibrate', sub: 'hold a neutral pose, then press' },
  f: { label: 'Auto-framing', sub: 'toggle OBSBOT hand-following' },
  h: { label: 'Re-centre camera', sub: 'gimbal home' },
  u: { label: 'Clear calibration', sub: 'forget the neutral pose' },
};
export function pressCameraKey(k) {
  robot.send('key', { key: k });
  toast(`${CAMERA_KEYS[k].label}`, `key "${k}" sent to the camera teleop node`, 'info', 2500);
}
export const LEGAL = {
  DAMP: ['STAND'], STAND: ['LOCO', 'MANIP', 'NAV', 'AUTO', 'DAMP'], LOCO: ['STAND', 'DAMP'],
  MANIP: ['STAND', 'DAMP'], NAV: ['STAND', 'DAMP'], AUTO: ['STAND', 'DAMP'],
};

let lastHint = 0;
function hint(title, msg) {
  const now = Date.now();
  if (now - lastHint < 1500) return;
  lastHint = now;
  toast(title, msg, 'info', 3000);
}

export function setModeServiceUp() {
  const st = robot.state.status;
  return !!(st && st.services && st.services.set_mode);
}

// press a contract mode key (from keyboard or on-screen button)
export async function pressModeKey(k) {
  const spec = MODE_KEYS[k];
  if (!spec) return;
  if (k === 'x') { await estop(); return; }
  const cur = robot.modeName();
  if (spec.from && cur && !spec.from.includes(cur)) {
    hint(`"${k}" does nothing in ${cur}`, `${spec.label} applies to ${spec.from.join(' / ')}.` +
      (cur === 'MANIP' && k === 'p' ? ' Use n to stop camera teleop.' : ''));
    return;
  }
  if (!setModeServiceUp()) {
    // no SetMode service (manager not up?): fall back to the key topic
    robot.send('key', { key: k });
    hint('Key sent on /g1/teleop/key', 'SetMode service not available, no confirmation possible.');
    return;
  }
  try {
    const r = await robot.request('set_mode', { mode: spec.target });
    if (!r.ok) toast(`${cur || '?'} → ${spec.target} rejected`, r.message || 'rejected by the mode manager', 'warn', 6000);
  } catch (e) {
    toast('SetMode failed', e.message, 'error');
  }
}

export async function estop() {
  try {
    const r = await robot.request('estop');
    toast('E-STOP', r.message || 'DAMP requested', 'error', 5000);
  } catch (e) {
    toast('E-STOP could not be sent', e.message, 'error', 8000);
  }
}

// --------------------------------------------------------------------------- keyboard capture
export class KeyboardTeleop {
  constructor() {
    this.enabled = false;
    this.cameraKeys = false;    // c/f/h/u only on the Teleoperation page
    this.held = new Map();      // key -> interval id
    this.onChange = null;       // (heldKeysSet) => void
    this._down = (e) => this._onDown(e);
    this._up = (e) => this._onUp(e);
    this._blur = () => this.releaseAll();
  }

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    window.addEventListener('keydown', this._down);
    window.addEventListener('keyup', this._up);
    window.addEventListener('blur', this._blur);
    document.addEventListener('visibilitychange', this._blur);
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    this.releaseAll();
    window.removeEventListener('keydown', this._down);
    window.removeEventListener('keyup', this._up);
    window.removeEventListener('blur', this._blur);
    document.removeEventListener('visibilitychange', this._blur);
  }

  _typing(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }

  _key(e) {
    if (e.code === 'Space') return 'space';
    return (e.key || '').toLowerCase();
  }

  _onDown(e) {
    if (this._typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = this._key(e);
    if (k in MOVE_KEYS || k === 'space' || k in MODE_KEYS || k in CAMERA_KEYS) e.preventDefault();
    if (e.repeat) return;
    if (k in MOVE_KEYS) {
      if (robot.modeName() !== 'LOCO') {
        hint('Movement keys act only in LOCO', `Mode is ${robot.modeName() || 'unknown'}: press l (from STAND) to start locomotion.`);
        return;
      }
      this.startMove(k);
    } else if (k === 'space') {
      robot.send('key', { key: 'space' });
      this._flash('space');
    } else if (k in MODE_KEYS) {
      this._flash(k);
      pressModeKey(k);
    } else if (k in CAMERA_KEYS && this.cameraKeys) {
      this._flash(k);
      pressCameraKey(k);
    }
  }

  _onUp(e) {
    const k = this._key(e);
    if (k in MOVE_KEYS) this.stopMove(k);
  }

  // hold-to-move: re-send the key every key_repeat_ms (the manager times out after 0.5 s)
  startMove(k) {
    if (this.held.has(k)) return;
    const every = (robot.state.hello && robot.state.hello.key_repeat_ms) || 150;
    robot.send('key', { key: k });
    const id = setInterval(() => {
      if (robot.modeName() !== 'LOCO') { this.stopMove(k); return; }
      robot.send('key', { key: k });
    }, every);
    this.held.set(k, id);
    if (this.onChange) this.onChange(new Set(this.held.keys()));
  }

  stopMove(k) {
    const id = this.held.get(k);
    if (id === undefined) return;
    clearInterval(id);
    this.held.delete(k);
    if (this.held.size === 0) robot.send('key', { key: 'space' }); // stop as soon as all keys are released
    if (this.onChange) this.onChange(new Set(this.held.keys()));
  }

  releaseAll() { [...this.held.keys()].forEach((k) => this.stopMove(k)); }

  _flash(k) {
    if (this.onFlash) this.onFlash(k);
  }
}

export const keyboard = new KeyboardTeleop();

// --------------------------------------------------------------------------- joystick
// Up/down = vx, left/right = wz (or vy in strafe mode). Sends /g1/cmd_vel_teleop at 10 Hz
// while held, zero on release. Only active in LOCO.
export function joystick({ onVel } = {}) {
  let strafe = false;
  let scale = 0.5;
  let vec = [0, 0];
  let timer = null;
  const knob = h('div', { class: 'knob' });
  const pad = h('div', { class: 'joystick', title: 'Drag to drive (LOCO only)' }, knob);
  const readout = h('div', { class: 'vel-readout mono' }, 'vx 0.00  vy 0.00  wz 0.00');
  const lim = () => (robot.state.hello && robot.state.hello.limits) || { vx: [-0.5, 0.8], vy: [-0.4, 0.4], wz: [-1, 1] };

  const cmd = () => {
    const L = lim();
    const [jx, jy] = vec;
    const vx = jy >= 0 ? jy * L.vx[1] * scale : -jy * L.vx[0] * scale;
    const side = -jx;
    const vy = strafe ? side * L.vy[1] * scale : 0;
    const wz = strafe ? 0 : side * L.wz[1] * scale;
    return { vx, vy, wz };
  };
  const send = () => {
    const c = cmd();
    robot.send('cmd_vel', c);
    readout.textContent = `vx ${c.vx.toFixed(2)}  vy ${c.vy.toFixed(2)}  wz ${c.wz.toFixed(2)}`;
    if (onVel) onVel(c);
  };
  const setKnob = () => {
    knob.style.transform = `translate(${vec[0] * 47}px, ${-vec[1] * 47}px)`;
  };
  const move = (e) => {
    const r = pad.getBoundingClientRect();
    let x = (e.clientX - r.left - r.width / 2) / (r.width / 2 - 28);
    let y = -(e.clientY - r.top - r.height / 2) / (r.height / 2 - 28);
    const n = Math.hypot(x, y);
    if (n > 1) { x /= n; y /= n; }
    vec = [x, y];
    setKnob();
  };
  const release = () => {
    if (timer) { clearInterval(timer); timer = null; }
    pad.classList.remove('active');
    vec = [0, 0];
    setKnob();
    for (let i = 0; i < 3; i++) setTimeout(send, i * 60);
  };
  pad.addEventListener('pointerdown', (e) => {
    if (robot.modeName() !== 'LOCO') {
      hint('Joystick acts only in LOCO', 'Press "Start locomotion" (l) from STAND first.');
      return;
    }
    pad.setPointerCapture(e.pointerId);
    pad.classList.add('active');
    move(e);
    send();
    timer = setInterval(() => {
      if (robot.modeName() !== 'LOCO') { release(); return; }
      send();
    }, 100);
  });
  pad.addEventListener('pointermove', (e) => { if (timer) move(e); });
  pad.addEventListener('pointerup', release);
  pad.addEventListener('pointercancel', release);

  const speed = h('input', { type: 'range', min: 10, max: 100, value: 50, step: 5 });
  const speedLbl = h('span', { class: 'mono small' }, '50%');
  speed.addEventListener('input', () => { scale = speed.value / 100; speedLbl.textContent = `${speed.value}%`; });
  const strafeBox = h('input', { type: 'checkbox' });
  strafeBox.addEventListener('change', () => { strafe = strafeBox.checked; });

  const el = h('div', { class: 'joy-wrap' }, pad,
    h('div', { class: 'stack', style: { flex: '1 1 180px', minWidth: '180px' } },
      h('label', { class: 'inline' }, 'Speed', speed, speedLbl),
      h('label', { class: 'inline' }, strafeBox, 'Left/right strafes (vy) instead of turning'),
      readout,
      h('div', { class: 'hint' }, 'Publishes /g1/cmd_vel_teleop at 10 Hz while held; limits from the contract.')));
  const update = () => pad.classList.toggle('disabled', robot.modeName() !== 'LOCO');
  const un = robot.on('mode', update);
  update();
  return { el, destroy: () => { release(); un(); } };
}
