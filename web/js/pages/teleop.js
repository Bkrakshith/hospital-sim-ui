// Teleoperation: the exclusive mode flow, contract key bindings, keyboard / joystick locomotion,
// camera upper-body teleop preview with hand-tracking indicators.
import { robot, MODE_DESC } from '../robot.js';
import { h, icon, fmt, syncCamera } from '../ui.js';
import { keyboard, joystick, pressModeKey, pressCameraKey, MODE_KEYS, MOVE_KEYS, CAMERA_KEYS, LEGAL } from '../teleop.js';

// the operator's exclusive flow; STAND appears in three phases
const FLOW = [
  { id: 'damp', mode: 'DAMP', title: 'DAMP', desc: 'motors damped' },
  { key: 'r', label: 'ready' },
  { id: 'stand', mode: 'STAND', title: 'STAND', desc: 'balancing' },
  { key: 'l', label: 'walk' },
  { id: 'loco', mode: 'LOCO', title: 'LOCO', desc: 'W A S D · Q E' },
  { key: 'p', label: 'pause' },
  { id: 'paused', mode: 'STAND', title: 'STAND', desc: 'locomotion paused' },
  { key: 'm', label: 'camera' },
  { id: 'manip', mode: 'MANIP', title: 'MANIP', desc: 'camera arm + hand teleop' },
  { key: 'n', label: 'stop' },
  { id: 'done', mode: 'STAND', title: 'STAND', desc: 'arms back to default' },
];

export function mount(root) {
  const stepper = h('div', { class: 'stepper' });
  const modeDetail = h('div', { class: 'muted small' });
  const modeKeys = h('div', { class: 'mode-keys' });
  const kbBtn = h('button', { class: 'kb-status' });
  const keyEls = {};
  const mk = (k, label, cls = '') => {
    const el = h('button', { class: `key ${cls}`, title: `${MOVE_KEYS[k] || label} (key ${k})` },
      k === 'space' ? 'SPACE' : k.toUpperCase(), h('small', {}, label));
    if (k === 'space') el.onclick = () => robot.send('key', { key: 'space' });
    else {
      el.addEventListener('pointerdown', (e) => { el.setPointerCapture(e.pointerId); if (robot.modeName() === 'LOCO') keyboard.startMove(k); });
      const up = () => keyboard.stopMove(k);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    }
    keyEls[k] = el;
    return el;
  };
  const movePad = h('div', { class: 'keys-grid' },
    mk('q', 'turn L'), mk('w', 'fwd'), mk('e', 'turn R'),
    mk('a', 'left'), mk('s', 'back'), mk('d', 'right'),
    mk('space', 'zero velocity', 'wide'));
  const velKv = h('dl', { class: 'kv' });
  const joy = joystick();

  const camImg = h('img', { alt: 'camera teleop (annotated)' });
  const camOverlay = h('div', { class: 'overlay' });
  const camBox = h('div', { class: 'camera-box nocam' }, camImg,
    h('div', { class: 'ph' }, 'Waiting for /g1/teleop/camera/annotated/compressed …'), camOverlay);
  const indicators = h('div', { class: 'row' });
  const manipNote = h('div');
  const trackKv = h('dl', { class: 'kv' });
  const confTbl = h('table', { class: 'topics' });
  const mgrKv = h('dl', { class: 'kv' });
  const calibState = h('span', { class: 'tag' }, 'calibration: n/a');
  const camKeyBtn = (k, cls = '') => h('button', { class: `btn ${cls}`, dataset: { key: k }, title: `${CAMERA_KEYS[k].sub} (key ${k})`,
    onclick: () => pressCameraKey(k) }, h('kbd', {}, k), CAMERA_KEYS[k].label);
  const camControls = h('div', { class: 'stack' },
    h('div', { class: 'row between' },
      h('button', { class: 'btn primary', dataset: { key: 'c' }, style: { fontSize: '15px', padding: '10px 18px' }, title: 'key c',
        onclick: () => pressCameraKey('c') }, h('kbd', {}, 'c'), 'Calibrate'),
      calibState),
    h('div', { class: 'hint' }, 'Calibrate (seated): sit so your head, shoulders, elbows and both hands are in view. Hold the neutral pose: upper arms relaxed along your body, elbows bent ~90°, forearms pointing forward, palms facing each other, thumbs up, fingers open. Hold still and press Calibrate. Recalibrate if the operator or chair position changes.'),
    h('div', { class: 'row' }, camKeyBtn('f'), camKeyBtn('h'), camKeyBtn('u', 'ghost')));

  root.append(h('div', { class: 'page' },
    h('section', { class: 'card' },
      h('div', { class: 'card-h' }, h('h2', {}, 'Mode flow'), h('span', { class: 'sub' }, 'Only one of LOCO / MANIP / NAV at a time. The mode manager decides; rejected requests show up as warnings.')),
      stepper, modeDetail),
    h('div', { class: 'teleop-grid' },
      h('div', { class: 'stack', style: { gap: '14px' } },
        h('section', { class: 'card' },
          h('div', { class: 'card-h' }, h('h2', {}, 'Commands'), kbBtn),
          modeKeys),
        h('section', { class: 'card' },
          h('div', { class: 'card-h' }, h('h2', {}, 'Mode manager'), h('span', { class: 'sub' }, '/g1/teleop/manager_status')),
          mgrKv),
        h('section', { class: 'card' },
          h('div', { class: 'card-h' }, h('h2', {}, 'Locomotion'), h('span', { class: 'sub' }, 'active in LOCO only')),
          h('div', { class: 'row', style: { alignItems: 'flex-start', gap: '22px' } },
            h('div', { class: 'stack' }, movePad, h('div', { class: 'hint', style: { maxWidth: '190px' } },
              'Hold a key to walk; releasing all keys sends "space" (zero). /g1/teleop/key')),
            h('div', { class: 'stack', style: { flex: 1, minWidth: '240px' } }, joy.el, h('div', { class: 'divider' }), velKv)))),
      h('section', { class: 'card' },
        h('div', { class: 'card-h' }, h('h2', {}, 'Camera teleop'), h('span', { class: 'sub' }, 'OBSBOT · hand / arm tracking')),
        h('div', { class: 'stack' },
          h('div', { class: 'callout warn' }, 'Turn off the OBSBOT\'s built-in AI tracking on the camera (it can\'t be disabled from Linux).'),
          camBox, indicators, camControls, h('div', { class: 'divider' }),
          h('div', { class: 'row', style: { alignItems: 'flex-start', gap: '18px' } },
            h('div', { style: { flex: '1 1 200px', minWidth: 0 } }, h('h3', { style: { marginBottom: '6px' } }, 'Tracking'), trackKv),
            h('div', { style: { flex: '1 1 220px', minWidth: 0 } }, h('h3', { style: { marginBottom: '6px' } }, 'Confidence'), confTbl)),
          manipNote))),
  ));

  // keyboard capture
  let kbOn = true;
  const renderKb = () => {
    kbBtn.className = `kb-status ${kbOn ? 'on' : ''}`;
    kbBtn.innerHTML = '';
    kbBtn.append(icon('keyboard'), kbOn ? 'Keyboard capture ON' : 'Keyboard capture off');
  };
  kbBtn.onclick = () => { kbOn = !kbOn; kbOn ? keyboard.enable() : keyboard.disable(); renderKb(); };
  keyboard.onChange = (held) => { for (const k of Object.keys(MOVE_KEYS)) keyEls[k].classList.toggle('pressed', held.has(k)); };
  keyboard.onFlash = (k) => {
    const el = keyEls[k] || root.querySelector(`[data-key="${k}"]`);
    if (!el) return;
    el.classList.add('pressed');
    setTimeout(() => el.classList.remove('pressed'), 180);
  };
  keyboard.enable();
  keyboard.cameraKeys = true;
  renderKb();

  function flowPhase(mode) {
    if (mode === 'STAND') {
      // where STAND came from places it in the flow (robot.js remembers the previous mode)
      if (robot.state.standFrom === 'LOCO') return 'paused';
      if (robot.state.standFrom === 'MANIP') return 'done';
      return 'stand';
    }
    return { DAMP: 'damp', LOCO: 'loco', MANIP: 'manip' }[mode] || null;
  }

  function renderFlow() {
    const m = robot.state.mode;
    const cur = m ? m.name : null;
    const phase = cur ? flowPhase(cur) : null;
    stepper.innerHTML = '';
    for (const s of FLOW) {
      if (s.key) {
        const spec = MODE_KEYS[s.key];
        const ok = cur && (spec.from ? spec.from.includes(cur) : (LEGAL[cur] || []).includes(spec.target));
        stepper.append(h('div', { class: 'step-arrow' }, h('span', {}, s.label), h('kbd', { style: ok ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {} }, s.key), h('span', {}, '→')));
      } else {
        const reachable = cur && cur !== s.mode && (LEGAL[cur] || []).includes(s.mode);
        stepper.append(h('div', { class: `step ${phase === s.id ? 'current' : ''} ${reachable && !(phase === s.id) ? 'reachable' : ''}`, dataset: { mode: s.mode } },
          h('div', { class: 'name' }, s.title), h('div', { class: 'desc' }, s.desc)));
      }
    }
    const navStep = h('div', { class: `step ${cur === 'NAV' ? 'current' : ''}`, dataset: { mode: 'NAV' }, style: { maxWidth: '150px' } },
      h('div', { class: 'name' }, 'NAV'), h('div', { class: 'desc' }, 'from STAND with g · p returns'));
    stepper.append(h('div', { class: 'step-arrow' }, h('span', {}, 'or'), h('kbd', {}, 'g')), navStep);
    modeDetail.textContent = m ? `Current: ${m.name} — ${MODE_DESC[m.name] || ''} (source: ${m.source || '?'}${m.detail ? ', ' + m.detail : ''}). LOCO → MANIP directly is rejected: pause (p) first.`
      : 'No /g1/mode yet — start g1_teleop_manager (or the mock robot).';
  }

  function renderModeKeys() {
    const cur = robot.modeName();
    modeKeys.innerHTML = '';
    for (const k of ['r', 'l', 'p', 'm', 'n', 'g', 'x']) {
      const s = MODE_KEYS[k];
      const ok = k === 'x' || (cur && (s.from ? s.from.includes(cur) : (LEGAL[cur] || []).includes(s.target)));
      // l/m/g stay clickable in a "wrong" mode so the operator sees the manager's rejection
      const soft = !ok && !s.from && k !== 'x' && cur;
      modeKeys.append(h('button', { class: 'mode-key', dataset: { key: k }, disabled: !ok && !soft,
        style: k === 'x' ? { borderColor: '#d62c2c' } : soft ? { opacity: 0.6 } : {},
        title: soft ? `${cur} → ${s.target} is not a legal transition; the manager will reject it` : s.sub,
        onclick: () => pressModeKey(k) },
        h('kbd', { style: k === 'x' ? { background: '#d62c2c', color: '#fff' } : {} }, k),
        h('div', {}, h('div', { class: 'lbl' }, s.label), h('div', { class: 'sub' }, s.sub))));
    }
    const loco = cur === 'LOCO';
    for (const k of Object.keys(MOVE_KEYS)) keyEls[k].disabled = !loco;
  }

  function renderState(st) {
    const tr = st.tracking;
    const cam = st.camera || {};
    const live = syncCamera(camImg, camBox, st);
    camOverlay.innerHTML = '';
    if (live) camOverlay.append(h('span', { class: 'hud' }, `${fmt.num(cam.fps, 0)} fps`));
    if (tr && tr.framing) camOverlay.append(h('span', { class: 'hud' }, `framing: ${tr.framing}`));
    indicators.innerHTML = '';
    const hv = (tr && tr.hands_visible) || [null, null];
    const ind = (label, v) => h('div', { class: `indicator ${v === true ? 'on' : v === false ? 'off' : ''}` }, h('span', { class: 'led' }), label,
      h('span', { class: 'muted small' }, v === true ? 'visible' : v === false ? 'lost' : 'n/a'));
    indicators.append(ind('Left hand', hv[0]), ind('Right hand', hv[1]),
      h('div', { class: `indicator ${tr && tr.framing === 'tracking' ? 'on' : tr && tr.framing === 'searching' ? 'off' : ''}` }, h('span', { class: 'led' }), 'Auto-framing',
        h('span', { class: 'muted small' }, (tr && tr.framing) || 'n/a')));
    if (tr && tr.fps !== undefined) indicators.append(h('span', { class: 'tag' }, `tracking ${fmt.num(tr.fps, 0)} fps`));
    manipNote.innerHTML = '';
    const cur = robot.modeName();
    if (cur === 'MANIP' && tr && tr.hands_visible && tr.hands_visible.includes(false)) {
      manipNote.append(h('div', { class: 'callout warn' }, 'A tracked hand is out of view: its arm / hand targets are not updated until it is visible again.'));
    } else if (cur !== 'MANIP') {
      manipNote.append(h('div', { class: 'hint' }, 'Upper-body commands reach the robot only in MANIP (key m from STAND). Legs hold stance, cmd_vel is forced to zero.'));
    }
    // extra tracking keys from the webcam teleop node (beyond the contract)
    calibState.className = `tag ${tr && tr.calibrated ? 'ok' : tr ? 'warn' : ''}`;
    calibState.textContent = tr ? (tr.calibrated ? 'calibrated' : 'NOT calibrated') : 'calibration: n/a';
    trackKv.innerHTML = '';
    const ptz = tr && tr.ptz;
    for (const [k, v] of [
      ['Tracking rate', tr && tr.fps !== undefined ? `${fmt.num(tr.fps, 1)} fps` : '—'],
      ['Latency', tr && tr.latency_ms !== undefined ? `${fmt.num(tr.latency_ms, 0)} ms` : '—'],
      ['Framing', tr ? `${tr.framing || '—'}${tr.framing_detail ? ' · ' + tr.framing_detail : ''}` : '—'],
      ['PTZ yaw (R+)', ptz ? `${fmt.num(ptz.yaw_right_deg, 0)}°` : '—'],
      ['PTZ pitch (up+)', ptz ? `${fmt.num(ptz.pitch_up_deg, 0)}°` : '—'],
      ['Zoom', ptz ? fmt.num(ptz.zoom, 0) : '—'],
    ]) trackKv.append(h('dt', {}, k), h('dd', {}, v));
    confTbl.innerHTML = '';
    const conf = tr && tr.confidence;
    confTbl.append(h('tr', {}, h('td', { class: 'muted' }, ''), h('td', { class: 'muted' }, 'arm'), h('td', { class: 'muted' }, 'hand')));
    for (const side of ['left', 'right']) {
      const c = conf && conf[side];
      const cell = (v, stt) => h('td', {}, c ? `${fmt.num(v, 2)}${stt ? ' · ' + stt : ''}` : '—');
      confTbl.append(h('tr', {}, h('td', {}, side), cell(c && c.arm, c && c.arm_state), cell(c && c.hand, c && c.hand_state)));
    }
    if (tr && tr.message) confTbl.append(h('tr', {}, h('td', { colspan: 3, class: 'muted small', style: { textAlign: 'left' } }, tr.message)));
    const mg = st.manager;
    mgrKv.innerHTML = '';
    for (const [k, v] of [
      ['Output /g1/cmd_vel', mg && mg.cmd_vel ? mg.cmd_vel.map((x) => fmt.num(x, 2)).join('  ') : '—'],
      ['Last key', mg && mg.last_key ? h('kbd', {}, mg.last_key) : '—'],
      ['Last message', mg && mg.last_message ? mg.last_message : h('span', { class: 'muted' }, mg ? 'none' : 'no manager status')],
    ]) mgrKv.append(h('dt', {}, k), h('dd', { style: { whiteSpace: 'normal' } }, v));
    const p = robot.state.pose;
    velKv.innerHTML = '';
    for (const [k, v] of [['Measured vx', p && p.vx !== undefined ? `${fmt.num(p.vx)} m/s` : '—'], ['Measured vy', p && p.vy !== undefined ? `${fmt.num(p.vy)} m/s` : '—'],
      ['Measured wz', p && p.wz !== undefined ? `${fmt.num(p.wz)} rad/s` : '—']]) velKv.append(h('dt', {}, k), h('dd', {}, v));
  }

  function onMode() {
    renderFlow();
    renderModeKeys();
  }

  const unsubs = [robot.on('mode', onMode), robot.on('state', renderState)];
  renderFlow();
  renderModeKeys();
  if (robot.state.status) renderState(robot.state.status);
  return () => {
    unsubs.forEach((u) => u());
    keyboard.onChange = null; keyboard.onFlash = null; keyboard.cameraKeys = false;
    keyboard.disable();
    joy.destroy();
    camImg.removeAttribute('src');
  };
}
