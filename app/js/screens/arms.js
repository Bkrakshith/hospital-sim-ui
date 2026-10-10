// Operator → Arms (F4b): robot view large (live head camera), own-hand picture-in-picture (annotated
// operator camera, mirrored like a mirror), tracking rings, latency pill, proximity strip, pre-flight checks,
// goal button "Use arms" (runs LOCO → STAND → MANIP as needed), Hold arms, Finish, calibration for a SEATED
// operator. Cameras are live only; REC shows only when the mission records.
import { store, api } from '../client.js';
import { h, ic, button, slideToConfirm, sheet, toast, fmt, clear } from '../ui.js';
import { icon } from '../icons.js';
import { pathList, runPath } from '../goals.js';
import { openLease } from '../sheets.js';

const S = store.state;

export function tracking() {
  const t = (S.status && S.status.tracking) || null;
  if (!t) return null;
  const hv = t.hands_visible || [false, false];
  const conf = t.confidence || {};
  return {
    left: { visible: !!hv[0], conf: conf.left ? conf.left.hand ?? conf.left.arm : null },
    right: { visible: !!hv[1], conf: conf.right ? conf.right.hand ?? conf.right.arm : null },
    latency: t.latency_ms ?? null,
    calibrated: !!t.calibrated,
    framing: t.framing || 'off',
    fps: t.fps,
    message: t.message,
  };
}

export function mount(el) {
  const view = h('div', { class: 'arms-view' });
  const side = h('aside', { class: 'arms-side' });
  el.append(h('div', { class: 'arms' }, view, side));

  // robot view + overlays
  const robotImg = h('img', { class: 'mjpeg robot-view', alt: 'Live robot head camera', src: '/stream/head_camera.mjpg' });
  robotImg.addEventListener('error', () => { robotImg.hidden = true; noRobot.hidden = false; });
  // an MJPEG stream can stay open without frames (mock robot, sim camera off): show the empty state instead of black
  const camCheck = setInterval(() => { const none = !robotImg.naturalWidth; robotImg.hidden = none; noRobot.hidden = !none; }, 1500);
  const noRobot = h('div', { class: 'cam-empty', hidden: true }, ic('camera', 40), h('div', {}, 'No robot camera picture'), h('div', { class: 'muted' }, 'The head camera is not streaming.'));
  const prox = h('div', { class: 'prox', role: 'status', 'aria-label': 'People and objects near the robot' });
  const pip = h('div', { class: 'pip' }, h('img', { class: 'mjpeg mirror', alt: 'Your hands, mirrored', src: '/stream/camera.mjpg' }), h('span', { class: 'cam-label' }, 'You (mirrored)'), h('div', { class: 'rings' }));
  const pills = h('div', { class: 'cam-pills' });
  view.append(robotImg, noRobot, h('span', { class: 'cam-label cam-label-robot' }, 'Robot view · live only'), prox, pills, pip);

  let manipSince = null;
  let fatigueShown = false;
  const renderOverlay = () => {
    const tr = tracking();
    // proximity strip from the lidar (state.proximity / `proximity` messages): [left, front, right] in m, null = clear
    const px = S.proximity || (S.status && S.status.proximity);
    clear(prox);
    if (px && Array.isArray(px.sectors) && !(px.age > 2)) {
      for (const [i, lbl] of ['Left', 'Front', 'Right'].entries()) {
        const d = px.sectors[i];
        const lvl = d === null || d === undefined ? 'ok' : d < 0.5 ? 'high' : d < 1.0 ? 'med' : 'ok';
        const words = d === null || d === undefined ? 'clear' : d < 0.5 ? `${fmt.num(d, 1)} m · very close` : d < 1.0 ? `${fmt.num(d, 1)} m · close` : `${fmt.num(d, 1)} m`;
        prox.append(h('span', { class: `px px-${lvl}`, 'aria-label': `${lbl}: ${words}` }, h('b', {}, lbl), ` ${words}`));
      }
    } else prox.append(h('span', { class: 'px px-unk' }, ic('info', 18), px ? 'Proximity data is stale: watch the room' : 'Proximity sensing not available: watch the room'));
    clear(pills);
    const rec = S.mission && S.mission.recording;
    if (rec) pills.append(h('span', { class: 'pill pill-rec' }, h('span', { class: 'rec-dot' }), 'REC'));
    if (tr) {
      const lat = tr.latency;
      const lvl = lat === null ? 'unk' : lat > 500 ? 'high' : lat > 250 ? 'med' : 'ok';
      pills.append(h('span', { class: `pill pill-${lvl}` }, ic('signal', 18), lat === null ? 'Latency –' : `${Math.round(lat)} ms`, lvl === 'med' ? ' · slow link, moves slower' : lvl === 'high' ? ' · too slow for arms' : ''));
    } else pills.append(h('span', { class: 'pill pill-unk' }, 'No tracking data'));
    const rings = pip.querySelector('.rings');
    clear(rings);
    for (const side of ['left', 'right']) {
      const s = tr && tr[side];
      rings.append(h('span', { class: `ring ${s && s.visible ? 'ok' : 'lost'}` }, h('span', { html: icon(s && s.visible ? 'checkCircle' : 'x', 18) }), side === 'left' ? 'L' : 'R', s && s.conf !== null && s.conf !== undefined ? ` ${Math.round(s.conf * 100)}%` : ''));
    }
    // tracking lost in MANIP -> banner over the view
    const lost = S.mode && S.mode.name === 'MANIP' && tr && (!tr.left.visible || !tr.right.visible);
    view.classList.toggle('tracking-lost', !!lost);
    let lb = view.querySelector('.lost-banner');
    if (lost && !lb) view.append(h('div', { class: 'lost-banner', role: 'alert' }, ic('hand', 26), 'Hands not visible. Arms holding still.'));
    if (!lost && lb) lb.remove();
    // fatigue (HF-11)
    if (S.mode && S.mode.name === 'MANIP') { manipSince = manipSince || Date.now(); if (!fatigueShown && Date.now() - manipSince > 15 * 60 * 1000) { fatigueShown = true; toast('15 minutes of arm control. Consider a short break.', { icon: 'clock' }); } }
    else manipSince = null;
  };

  const checks = () => {
    const tr = tracking();
    return [
      ['Both hands tracked', tr && tr.left.visible && tr.right.visible],
      ['Link fast enough (< 250 ms)', tr && tr.latency !== null && tr.latency < 250],
      ['Calibrated', tr && tr.calibrated],
      ['Area around the robot clear', null],
    ];
  };

  let lastKey = '', busy = false, matched = false;
  const renderSide = () => {
    const m = S.mode && S.mode.name;
    const tr = tracking();
    const ck = checks();
    const st = S.status || {};
    const held = !!st.arms_hold;
    const handsOk = !!st.hand_override_allowed;
    if (!held) matched = false;
    const key = JSON.stringify([m, S.lease.you, !!S.lease.holder, busy, ck.map((c) => c[1]), tr && tr.framing, held, handsOk, matched]);
    if (key === lastKey) return;
    lastKey = key;
    clear(side);
    side.append(h('header', { class: 'screen-head' }, h('h1', {}, 'Manual arms')));
    const tooSlow = tr && tr.latency !== null && tr.latency > 500;
    if (m === 'MANIP') {
      const n = ck.filter((c) => c[1]).length;
      side.append(h('div', { class: 'row gap preflight-mini' }, ic(n >= 3 ? 'checkCircle' : 'triangle', 22), h('span', {}, `Checks: ${n} of ${ck.length - 1} OK`),
        button('Calibrate…', { size: 'operator', kind: 'ghost', icon: 'seat', onClick: () => calibrate() })));
    } else side.append(h('section', { class: 'card preflight' }, h('h2', { class: 'sec-t' }, 'Before you start'),
      h('ul', { class: 'check-list compact' }, ck.map(([label, okv]) => h('li', { class: `ck ck-${okv === null ? 'unknown' : okv ? 'ok' : 'fail'}` }, h('span', { class: 'ck-ic', html: icon(okv === null ? 'eye' : okv ? 'checkCircle' : 'x', 22) }), h('span', { class: 'ck-name' }, label, okv === null ? h('span', { class: 'muted' }, ' · look') : null)))),
      button('Calibrate…', { size: 'operator', icon: 'seat', onClick: () => calibrate() })));
    if (!S.lease.you) {
      side.append(h('section', { class: 'card' }, h('p', {}, S.lease.holder ? `${S.lease.holder.user || S.lease.holder.device_name} has control.` : 'Take control to move the arms.'),
        S.lease.holder ? button('Ask to take over…', { size: 'operator', onClick: openLease }) : slideToConfirm('Slide to take control', async () => { const r = await api.leaseAcquire('manual arms'); toast(r.ok ? 'You have control' : r.message, { level: r.ok ? 'ok' : 'warn' }); }, { kind: 'person' })));
    } else if (m !== 'MANIP') {
      side.append(h('section', { class: 'card' }, h('h2', { class: 'sec-t' }, 'Use arms'), h('p', { class: 'muted' }, 'What will happen:'), pathList('MANIP'),
        tooSlow ? h('p', { class: 'note note-warn' }, ic('signal', 22), 'Link too slow for arm control (over 500 ms).') : null,
        slideToConfirm(busy ? 'Working…' : 'Slide to use arms', async () => {
          busy = true; renderSide();
          const r = await runPath('MANIP', (i, s, st) => { if (st === 'running') toast(s.label, { icon: 'handArm' }); });
          busy = false; lastKey = ''; renderSide();
          if (!r.ok) toast(r.message, { level: 'warn' });
        }, { kind: 'person', disabled: busy || tooSlow, id: 'use-arms', sub: 'Your arms move the robot arms' })));
    } else if (!held) {
      side.append(h('section', { class: 'card' }, h('h2', { class: 'sec-t' }, 'Arms are live'),
        button('Hold arms', { kind: 'secondary', size: 'operator', icon: 'pause', cls: 'btn-block', id: 'hold-arms', onClick: async () => {
          const r = await api.manipHold(true); toast(r.ok ? 'Arms held. They stay where they are.' : plainNotNow(r), { level: r.ok ? 'ok' : 'warn' });
        } }),
        h('p', { class: 'muted small-note' }, 'Freezes the arms where they are and stays in manual arms, so you can rest or use the hand buttons.'),
        slideToConfirm('Finish: arms back to rest', async () => { const r = await runPath('STAND'); toast(r.ok ? 'Arms at rest. Standing by.' : r.message, { level: r.ok ? 'ok' : 'warn' }); }, { kind: 'standby', sub: 'Over about 1 s · is the area clear?' })));
    } else {
      // held: releasing makes the arms move toward the operator's current pose (<= 1.5 rad/s), so match first
      side.append(h('section', { class: 'card arms-held' }, h('h2', { class: 'sec-t' }, ic('pause', 22), 'Arms held'),
        h('ol', { class: 'release-steps' },
          h('li', { class: matched ? 'done' : 'now' }, h('b', {}, 'Match the robot. '), 'Put your arms and hands where the robot\'s are (see the robot view).',
            !matched ? button('My arms match the robot', { size: 'operator', icon: 'check', id: 'pose-matched', onClick: () => { matched = true; renderSide(); } }) : null),
          h('li', { class: matched ? 'now' : 'todo' }, h('b', {}, 'Release. '), 'The robot arms then follow yours again, moving toward your pose at up to 1.5 rad/s.',
            slideToConfirm('Slide to let the arms follow you', async () => {
              const r = await api.manipHold(false); toast(r.ok ? 'Arms follow you again' : plainNotNow(r), { level: r.ok ? 'ok' : 'warn' });
            }, { kind: 'person', id: 'release-arms', disabled: !matched, sub: 'Match first' })))));
    }
    if (S.lease.you && (held || m === 'HOLD' || handsOk)) {
      const handBtn = (side_, close, label, ico) => button(label, { size: 'operator', icon: ico, disabled: !handsOk, onClick: async () => {
        const r = await api.hand(side_, close); if (!r.ok) toast(plainNotNow(r), { level: 'warn' });
      } });
      side.append(h('section', { class: 'card hands-card' }, h('h2', { class: 'sec-t' }, 'Hands'),
        h('div', { class: 'row gap hand-btns' }, h('span', { class: 'hb-k' }, 'Left'), handBtn('left', 0, 'Open', 'gripOpen'), handBtn('left', 1, 'Close', 'grip')),
        h('div', { class: 'row gap hand-btns' }, h('span', { class: 'hb-k' }, 'Right'), handBtn('right', 0, 'Open', 'gripOpen'), handBtn('right', 1, 'Close', 'grip')),
        h('p', { class: 'muted small-note' }, handsOk ? 'All fingers and the thumb open or close together.' : 'Hands can be opened or closed only while the arms are held or the robot is stopped.')));
    }
    side.append(h('section', { class: 'card cam-tools' }, h('h2', { class: 'sec-t' }, 'Your camera'),
      h('div', { class: 'row gap wrap' },
        button('Re-centre', { size: 'operator', icon: 'crosshair', onClick: () => api.key('h') }),
        button(tr && tr.framing !== 'off' ? 'Auto-framing on' : 'Auto-framing off', { size: 'operator', icon: 'target', onClick: () => api.key('f') }))));
  };

  renderSide(); renderOverlay();
  const offs = [store.on('state', () => { renderOverlay(); renderSide(); }), store.on('proximity', renderOverlay), store.on('mode', renderSide), store.on('lease', renderSide)];
  return () => { clearInterval(camCheck); offs.forEach((o) => o()); view.querySelectorAll('img.mjpeg').forEach((i) => { i.src = ''; }); };
}

function plainNotNow(r) {
  if (r && r.data && r.data.code === 'not_now') return 'Not now: hands can only be moved while the arms are held or the robot is stopped.';
  if (r && r.data && r.data.code === 'need_lease') return 'Take control first.';
  return (r && r.message) || 'The robot did not accept that';
}

// Calibration for a SEATED operator: upper arms relaxed, elbows ~90°, forearms forward, palms facing, thumbs up.
export function calibrate() {
  const figure = `<svg viewBox="0 0 240 200" class="calib-fig" role="img" aria-label="Seated pose: upper arms relaxed at the sides, elbows bent at about 90 degrees, forearms forward, palms facing each other, thumbs up">
    <g fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="120" cy="34" r="18"/>
      <path d="M120 52v58"/>
      <path d="M96 64h48"/>
      <path d="M96 64l-8 40"/><path d="M144 64l8 40"/>
      <path d="M88 104l-26 14" class="fa"/><path d="M152 104l26 14" class="fa"/>
      <path d="M62 118l-2-12" /><path d="M178 118l2-12"/>
      <path d="M100 110h40l6 40M100 110l-6 40"/>
      <path d="M70 150h100"/><path d="M80 150v36M160 150v36"/>
    </g>
    <g fill="currentColor" font-size="12" font-family="-apple-system,system-ui,sans-serif">
      <text x="12" y="92">elbow ~90°</text><text x="176" y="100">thumbs up</text>
    </g>
  </svg>`;
  const status = h('div', { class: 'calib-status', 'aria-live': 'polite' });
  const draw = () => {
    const tr = tracking();
    status.innerHTML = '';
    status.append(h('span', { class: `pill pill-${tr && tr.calibrated ? 'ok' : 'unk'}` }, ic(tr && tr.calibrated ? 'checkCircle' : 'info', 18), tr && tr.calibrated ? 'Calibrated' : 'Not calibrated'),
      h('span', { class: `pill pill-${tr && tr.left.visible && tr.right.visible ? 'ok' : 'med'}` }, tr && tr.left.visible && tr.right.visible ? 'Both hands seen' : 'Hands not both seen'));
  };
  draw();
  const off = store.on('state', draw);
  let counting = false;
  const go = h('button', { class: 'btn btn-primary btn-operator', type: 'button', onClick: () => {
    if (counting) return;
    counting = true;
    let n = 3;
    go.querySelector('.btn-label').textContent = `Hold still… ${n}`;
    const iv = setInterval(() => {
      n--;
      if (n > 0) { go.querySelector('.btn-label').textContent = `Hold still… ${n}`; return; }
      clearInterval(iv);
      api.key('c');
      go.querySelector('.btn-label').textContent = 'Calibrated. Relax';
      setTimeout(() => { counting = false; go.querySelector('.btn-label').textContent = 'Calibrate again'; }, 2500);
    }, 1000);
  } }, ic('seat', 24), h('span', { class: 'btn-label' }, 'Start 3-second calibration'));
  const body = h('div', { class: 'calib' },
    h('div', { class: 'calib-art', html: figure }),
    h('div', { class: 'calib-steps' },
      h('ol', { class: 'plain-steps' },
        h('li', {}, 'Sit upright, facing the camera, both hands in view.'),
        h('li', {}, 'Let your upper arms hang relaxed at your sides.'),
        h('li', {}, 'Bend your elbows to about 90°, forearms pointing forward.'),
        h('li', {}, 'Turn your palms to face each other, thumbs up.'),
        h('li', {}, 'Hold still while the countdown runs.')),
      status,
      h('div', { class: 'row gap wrap' }, go,
        button('Clear calibration', { size: 'operator', kind: 'ghost', onClick: () => { api.key('u'); toast('Calibration cleared'); } }))));
  sheet(body, { title: 'Calibrate your arms (seated)', wide: true, onClose: off });
}
