// Operator → Walk (F4a): take control (lease), goal button "Start manual walking" runs the legal path,
// hold-to-move joystick + buttons (released = zero at once, S-5), speed cap with zone cap shown,
// optional hardware keyboard (w a s d q e, space), Done → stand → offer to resume the paused trip.
import { store, api } from '../client.js';
import { h, ic, button, slideToConfirm, toast, fmt, clear } from '../ui.js';
import { MapView } from '../mapview.js';
import { pathList, runPath } from '../goals.js';
import { openLease } from '../sheets.js';

const S = store.state;
const CAPS = [['slow', 'Slow', 0.2], ['normal', 'Normal', 0.3], ['fast', 'Fast', 0.5]];
let capId = 'normal';

export function mount(el) {
  const left = h('div', { class: 'drive-left' });
  const right = h('div', { class: 'drive-right' });
  el.append(h('div', { class: 'drive' }, left, right));
  const mapBox = h('div', { class: 'drive-map' });
  const camBox = h('div', { class: 'drive-cam', hidden: true });
  right.append(h('div', { class: 'card drive-view' }, h('div', { class: 'card-h' }, h('h2', {}, 'Where it is'),
    button('Robot camera', { size: 'operator', icon: 'camera', kind: 'ghost', onClick: () => toggleCam() })), mapBox, camBox));
  const mv = new MapView(mapBox, { interactive: false, trail: true });
  mv.follow = true;
  mv.view.scale = 40;
  let camOn = false;
  const toggleCam = () => {
    camOn = !camOn;
    camBox.hidden = !camOn;
    clear(camBox);
    if (camOn) camBox.append(h('img', { class: 'mjpeg', src: '/stream/head_camera.mjpg', alt: 'Live robot head camera' }), h('span', { class: 'cam-label' }, 'Robot view · live only'));
  };

  // ---- motion state
  let v = { vx: 0, vy: 0, wz: 0 };
  let sending = 0;
  let strafe = false;
  const cap = () => {
    const sel = CAPS.find((c) => c[0] === capId)[2];
    const z = S.motion && S.motion.zone && S.motion.zone.cap;
    const m = S.motion && S.motion.manual_cap;
    return Math.min(sel, z || Infinity, m || Infinity);
  };
  const active = () => S.lease.you && S.mode && S.mode.name === 'LOCO';
  const startSending = () => {
    if (sending) return;
    sending = setInterval(() => { if (!active()) { stopMotion(); return; } api.cmdVel(v.vx, v.vy, v.wz); }, 100);
  };
  const stopMotion = () => {
    v = { vx: 0, vy: 0, wz: 0 };
    clearInterval(sending); sending = 0;
    api.cmdVel(0, 0, 0); setTimeout(() => api.cmdVel(0, 0, 0), 60);
    if (knob) knob.style.transform = 'translate(0px, 0px)';
    joyEl && joyEl.classList.remove('held');
  };

  // ---- joystick (220 pt, thumb 88, spring return)
  let joyEl = null, knob = null;
  const joystick = () => {
    joyEl = h('div', { class: 'joy', role: 'application', 'aria-label': 'Joystick: hold and move to walk; let go to stop' });
    knob = h('div', { class: 'joy-knob' }, ic('walk', 34));
    joyEl.append(h('span', { class: 'joy-f' }, 'Forward'), knob);
    let id = null;
    const R = 110 - 44;
    const move = (e) => {
      const r = joyEl.getBoundingClientRect();
      let dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
      const d = Math.hypot(dx, dy);
      if (d > R) { dx *= R / d; dy *= R / d; }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      const fx = dx / R, fy = -dy / R;
      const dead = (x) => (Math.abs(x) < 0.12 ? 0 : x);
      v.vx = dead(fy) * cap();
      if (strafe) { v.vy = -dead(fx) * Math.min(0.4, cap()); v.wz = 0; } else { v.wz = -dead(fx) * Math.min(1.0, cap() * 2.5); v.vy = 0; }
    };
    joyEl.addEventListener('pointerdown', (e) => {
      if (!active()) { toast('Start manual walking first', { icon: 'info' }); return; }
      e.preventDefault(); id = e.pointerId; joyEl.setPointerCapture(id); joyEl.classList.add('held'); move(e); startSending();
    });
    joyEl.addEventListener('pointermove', (e) => { if (e.pointerId === id) move(e); });
    const end = (e) => { if (e.pointerId === id) { id = null; stopMotion(); } };
    joyEl.addEventListener('pointerup', end);
    joyEl.addEventListener('pointercancel', end);
    return joyEl;
  };
  const holdBtn = (label, ico, set) => {
    const b = h('button', { class: 'btn btn-secondary btn-operator hold-move', type: 'button', 'aria-label': `${label}: hold to move` }, ic(ico, 24), h('span', { class: 'btn-label' }, label));
    b.addEventListener('pointerdown', (e) => { if (!active()) { toast('Start manual walking first', { icon: 'info' }); return; } e.preventDefault(); b.setPointerCapture(e.pointerId); set(); b.classList.add('held'); startSending(); });
    const end = () => { b.classList.remove('held'); stopMotion(); };
    b.addEventListener('pointerup', end); b.addEventListener('pointercancel', end);
    return b;
  };

  // ---- keyboard
  let kbOn = false;
  const keys = new Set();
  const kbApply = () => {
    const c = cap();
    v.vx = (keys.has('w') ? c : 0) - (keys.has('s') ? c : 0);
    v.vy = (keys.has('a') ? Math.min(0.4, c) : 0) - (keys.has('d') ? Math.min(0.4, c) : 0);
    v.wz = (keys.has('q') ? Math.min(1, c * 2.5) : 0) - (keys.has('e') ? Math.min(1, c * 2.5) : 0);
    if (keys.size) startSending(); else stopMotion();
  };
  const onKey = (e) => {
    if (!kbOn || e.target.closest('input,textarea,select')) return;
    const k = e.key.toLowerCase();
    if (k === ' ') { e.preventDefault(); keys.clear(); stopMotion(); return; }
    if (!'wasdqe'.includes(k) || k.length !== 1) return;
    e.preventDefault();
    if (e.type === 'keydown') { if (!active()) return; keys.add(k); } else keys.delete(k);
    kbApply();
  };
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
  const onBlur = () => { keys.clear(); stopMotion(); };
  window.addEventListener('blur', onBlur);

  // ---- left panel by state
  let lastKey = '';
  let busy = false;
  const render = () => {
    const m = S.mode && S.mode.name;
    const key = JSON.stringify([m, S.lease.you, !!S.lease.holder, S.connected, busy, capId, kbOn, strafe, S.motion && S.motion.zone, S.status && S.status.nav && S.status.nav.state === 'paused', !!S.hold]);
    if (key === lastKey) return;
    lastKey = key;
    if (sending) stopMotion();   // never keep sending a velocity from a control that is being replaced
    clear(left);
    left.append(h('header', { class: 'screen-head' }, h('div', {}, h('h1', {}, 'Manual walking'), h('p', { class: 'muted' }, 'Hold to move. Let go and it stops.'))));
    if (!S.lease.you) {
      left.append(h('section', { class: 'card step-card' }, h('h2', {}, '1 · Take control'),
        h('p', {}, S.lease.holder ? `${S.lease.holder.user || S.lease.holder.device_name} has control now.` : 'Only one device can drive the robot at a time. Others can still press Stop.'),
        S.lease.holder ? button('Ask to take over…', { kind: 'secondary', size: 'operator', icon: 'people', onClick: () => openLease() })
          : slideToConfirm('Slide to take control', async () => { const r = await api.leaseAcquire('manual walking'); toast(r.ok ? 'You have control' : r.message, { level: r.ok ? 'ok' : 'warn' }); render(); }, { kind: 'person', id: 'take-control', sub: 'Logged with your name' })));
      return;
    }
    if (m !== 'LOCO') {
      const fromTask = m === 'NAV' || m === 'AUTO';
      left.append(h('section', { class: 'card step-card' }, h('h2', {}, '2 · Start manual walking'),
        fromTask ? h('p', { class: 'note note-warn' }, ic('info', 22), 'The robot will stop its task and stand still first. The task is remembered.') : null,
        h('p', { class: 'muted' }, 'What will happen:'), pathList('LOCO'),
        slideToConfirm(busy ? 'Working…' : 'Slide to start manual walking', async () => {
          busy = true; render();
          const r = await runPath('LOCO', (i, s, stt) => { if (stt === 'running') toast(s.label, { icon: 'hand' }); });
          busy = false; lastKey = ''; render();
          if (!r.ok) toast(r.message, { level: 'warn' });
        }, { kind: 'person', id: 'start-loco', disabled: busy || !S.connected, sub: `Speed cap ${fmt.num(cap(), 1)} m/s` }),
        button('Hand back control', { kind: 'ghost', size: 'operator', icon: 'unlock', onClick: async () => { await api.leaseRelease(); render(); } })));
      return;
    }
    // LOCO + lease: controls
    const zone = S.motion && S.motion.zone;
    left.append(
      h('div', { class: 'drive-controls' },
        joystick(),
        h('div', { class: 'drive-btns' },
          h('div', { class: 'db-row' }, holdBtn('Turn left', 'back', () => { v = { vx: 0, vy: 0, wz: Math.min(1, cap() * 2.5) }; }), holdBtn('Forward', 'walk', () => { v = { vx: cap(), vy: 0, wz: 0 }; }), holdBtn('Turn right', 'chevron', () => { v = { vx: 0, vy: 0, wz: -Math.min(1, cap() * 2.5) }; })),
          h('div', { class: 'db-row' }, holdBtn('Step left', 'back', () => { v = { vx: 0, vy: Math.min(0.4, cap()), wz: 0 }; }), holdBtn('Back', 'undo', () => { v = { vx: -Math.min(0.3, cap()), vy: 0, wz: 0 }; }), holdBtn('Step right', 'chevron', () => { v = { vx: 0, vy: -Math.min(0.4, cap()), wz: 0 }; })))),
      h('section', { class: 'card drive-opts' },
        h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Speed cap' }, h('span', { class: 'seg-k' }, 'Speed'),
          ...CAPS.map(([id, label, val]) => {
            const lockedFast = id === 'fast' && S.session.role !== 'technician';
            return h('button', { class: `seg-b${capId === id ? ' on' : ''}`, type: 'button', role: 'radio', 'aria-checked': capId === id ? 'true' : 'false', disabled: lockedFast, title: lockedFast ? 'Technician only' : undefined, onClick: () => { capId = id; render(); } }, `${label} ${val}`, h('span', { class: 'unit' }, ' m/s'), lockedFast ? ic('lock', 16) : null);
          })),
        h('p', { class: 'muted' }, zone ? `Zone: ${zone.name} · capped at ${zone.cap} m/s` : 'No speed zone here', ` · now ${fmt.num(cap(), 1)} m/s max`),
        h('div', { class: 'row gap wrap' },
          h('button', { class: `toggle-btn${strafe ? ' on' : ''}`, type: 'button', 'aria-pressed': strafe ? 'true' : 'false', onClick: () => { strafe = !strafe; render(); } }, 'Joystick sideways = step'),
          h('button', { class: `toggle-btn${kbOn ? ' on' : ''}`, type: 'button', 'aria-pressed': kbOn ? 'true' : 'false', onClick: () => { kbOn = !kbOn; render(); } }, ic('terminal', 18), 'Keyboard W A S D Q E')),
        h('p', { class: 'muted small-note' }, 'If this iPad loses the link for 1 second, the robot holds still.')),
      h('div', { class: 'row gap wrap' },
        button('Done walking', { kind: 'primary', size: 'operator', icon: 'check', onClick: done })),
    );
  };
  const done = async () => {
    stopMotion();
    const pausedTrip = S.status && S.status.nav && S.status.nav.state === 'paused';
    const r = await runPath('STAND');
    if (!r.ok) { toast(r.message, { level: 'warn' }); return; }
    lastKey = '';
    render();
    if (pausedTrip) {
      left.append(h('section', { class: 'card step-card' }, h('h2', {}, 'Resume the paused trip?'),
        slideToConfirm('Slide to resume the trip', async () => { const x = await api.navResume(); toast(x.ok ? 'Continuing the trip' : x.message, { level: x.ok ? 'ok' : 'warn' }); }, { kind: 'robot' }),
        button('Leave it standing', { kind: 'ghost', size: 'operator', onClick: () => { api.navCancel(); render(); } })));
    }
  };
  render();
  const offs = [store.on('mode', render), store.on('lease', render), store.on('state', render), store.on('connection', (okc) => { if (!okc) stopMotion(); render(); })];
  return () => { stopMotion(); offs.forEach((o) => o()); mv.destroy(); window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKey); window.removeEventListener('blur', onBlur); };
}
