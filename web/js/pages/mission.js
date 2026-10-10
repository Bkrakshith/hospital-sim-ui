// Mission (scrub nurse): instrument requests, start / pause / resume / abort, go-to locations, live behaviour tree,
// current step, head camera (on demand) with the target instrument highlighted, request history.
// Talks to g1_mission through the server: ops mission_command / mission_request, 'mission' status messages
// (= /g1/mission/status), /stream/head_camera.mjpg.
import { robot } from '../robot.js';
import { h, icon, act, fmt } from '../ui.js';
import { pressModeKey } from '../teleop.js';

const STATE_TAG = { idle: '', running: 'info', paused: 'warn', succeeded: 'ok', failed: 'err', aborted: 'warn' };
const NODE_CLS = { RUNNING: 'run', SUCCESS: 'ok', FAILURE: 'err', IDLE: 'idle', INVALID: 'idle' };
const LABEL = (n) => n.replace(/_/g, ' ');

export function mount(root) {
  const stateTag = h('span', { class: 'tag' }, 'no mission');
  const stepEl = h('div', { class: 'mission-step' }, '—');
  const msgEl = h('div', { class: 'muted small' });
  const kv = h('dl', { class: 'kv' });
  const modeHint = h('div', { class: 'callout', hidden: true });
  const btn = (label, ic, cls, onclick, title) => h('button', { class: `btn ${cls}`, onclick, title }, ic ? icon(ic) : null, label);
  const bStart = btn('Start', 'play', 'primary', () => cmd('start'), 'Start the scrub_nurse mission (requests AUTO)');
  const bPause = btn('Pause', 'pause', '', () => cmd('pause'), 'Hold the arms, cancel the Nav2 goal');
  const bResume = btn('Resume', 'play', '', () => cmd('resume'));
  const bAbort = btn('Abort', 'stop', 'danger', () => cmd('abort'), 'Stop the mission and return to STAND');
  const bReady = btn('Ready (r)', null, 'ghost', () => pressModeKey('r'), 'DAMP -> STAND');
  const bOverride = btn('Override (p)', null, 'ghost', () => pressModeKey('p'), 'Operator override: AUTO -> STAND (aborts the mission)');
  const locSel = h('select', { class: 'sel' });
  const bGo = btn('Go', 'pin', '', () => { if (locSel.value) cmd(`goto:${locSel.value}`); }, 'Walk to the location (Nav2), FineAlign if marked');
  const instGrid = h('div', { class: 'inst-grid' });
  const queueEl = h('div', { class: 'muted small' });
  const treeEl = h('div', { class: 'bt-tree' });
  const histBody = h('tbody');
  const countsEl = h('span', { class: 'sub' });
  const srcEl = h('div', { class: 'row' });

  const camImg = h('img', { alt: 'head camera' });
  const camHud = h('div', { class: 'overlay' });
  const camBox = h('div', { class: 'camera-box nocam head-cam' }, camImg,
    h('div', { class: 'ph' }, 'Head camera off. The sim renders /g1/head_camera only while someone watches.'), camHud);
  let camOn = false;
  const bCam = btn('Show head camera', 'camera', '', () => setCam(!camOn));

  root.append(h('div', { class: 'page mission-page' },
    h('div', { class: 'mission-grid' },
      h('div', { class: 'stack', style: { gap: '14px' } },
        h('section', { class: 'card' },
          h('div', { class: 'card-h' }, h('h2', {}, 'Scrub-nurse mission'), stateTag),
          stepEl, msgEl, modeHint,
          h('div', { class: 'row', style: { marginTop: '10px' } }, bStart, bPause, bResume, bAbort, bReady, bOverride),
          h('div', { class: 'divider' }),
          h('div', { class: 'row' }, h('span', { class: 'muted small' }, 'Go to'), locSel, bGo),
          h('div', { class: 'divider' }), kv, srcEl),
        h('section', { class: 'card' },
          h('div', { class: 'card-h' }, h('h2', {}, 'Request an instrument'),
            h('span', { class: 'sub' }, '/g1/mission/request_instrument')),
          instGrid, queueEl,
          h('div', { class: 'hint' }, 'A request starts the mission if it is idle (robot must be in STAND). The mission walks to the instrument table if needed, picks the instrument from the rack and hands it to the surgeon handle first.')),
        h('section', { class: 'card' },
          h('div', { class: 'card-h' }, h('h2', {}, 'History'), countsEl),
          h('table', { class: 'topics hist' },
            h('thead', {}, h('tr', {}, h('th', {}, 'instrument'), h('th', {}, 'result'), h('th', {}, 'time'), h('th', {}, 'note'))),
            histBody))),
      h('div', { class: 'stack', style: { gap: '14px' } },
        h('section', { class: 'card' },
          h('div', { class: 'card-h' }, h('h2', {}, 'Head camera'), bCam),
          camBox),
        h('section', { class: 'card' },
          h('div', { class: 'card-h' }, h('h2', {}, 'Behaviour tree'), h('span', { class: 'sub' }, 'py_trees · live')),
          treeEl)))));

  function setCam(on) {
    camOn = on;
    bCam.lastChild.textContent = on ? 'Hide head camera' : 'Show head camera';
    if (on) camImg.src = `/stream/head_camera.mjpg?t=${Date.now()}`;
    else { camImg.removeAttribute('src'); camBox.classList.add('nocam'); }
  }
  camImg.onload = () => camBox.classList.remove('nocam');

  async function cmd(c) {
    await act(robot.request('mission_command', { command: c }), { fail: `Mission: ${c}` });
  }
  async function request(name) {
    await act(robot.request('mission_request', { instrument: name }), { success: `Requested ${LABEL(name)}`, fail: 'Request rejected' });
  }

  let instKey = '', locKey = '';
  function render() {
    const m = robot.state.mission;
    const mode = robot.modeName();
    const st = robot.state.status;
    const link = st && st.mission_link;
    if (!m) {
      stateTag.className = 'tag err';
      stateTag.textContent = 'no mission node';
      stepEl.textContent = '—';
      msgEl.textContent = 'No /g1/mission/status. Start it: ros2 launch g1_bringup mission.launch.py';
      for (const b of [bStart, bPause, bResume, bAbort]) b.disabled = true;
      return;
    }
    const s = m.state;
    stateTag.className = `tag ${STATE_TAG[s] || ''}`;
    stateTag.textContent = s + (m.kind && s !== 'idle' ? ` · ${m.kind}` : '');
    stepEl.textContent = (s === 'running' || s === 'paused') ? (m.step || '…') : (s === 'idle' ? 'idle' : s);
    stepEl.dataset.state = s;
    msgEl.textContent = m.message || '';
    const active = s === 'running' || s === 'paused';
    bStart.disabled = active;
    bPause.disabled = s !== 'running';
    bResume.disabled = s !== 'paused';
    bAbort.disabled = !active;
    bReady.hidden = mode !== 'DAMP';
    bOverride.hidden = mode !== 'AUTO';
    if (mode === 'DAMP' || !mode) {
      modeHint.hidden = false;
      modeHint.className = 'callout warn';
      modeHint.textContent = 'Robot is in DAMP: press Ready (r) to stand before starting the mission.';
    } else if (!['STAND', 'AUTO'].includes(mode)) {
      modeHint.hidden = false;
      modeHint.className = 'callout warn';
      modeHint.textContent = `Robot is in ${mode}: return to STAND (p / n) before starting the mission.`;
    } else modeHint.hidden = true;

    // key-value
    kv.innerHTML = '';
    const fa = m.station_error;
    const add = (k, v) => kv.append(h('dt', {}, k), h('dd', {}, v));
    add('Mode', mode || '--');
    add('Instrument', m.instrument ? LABEL(m.instrument) : '--');
    add('Queue', m.queue && m.queue.length ? m.queue.map(LABEL).join(', ') : 'empty');
    add('Station error', fa ? `${fmt.num(fa[0] * 100, 1)} / ${fmt.num(fa[1] * 100, 1)} cm · ${fmt.num(fa[2], 1)}°` : '--');
    add('Recording', m.recording ? 'on (LeRobot)' : 'off');
    if (link) add('Status age', fmt.age(link.status_age));
    srcEl.innerHTML = '';
    const src = m.sources || {};
    for (const [k, v] of Object.entries(src)) {
      srcEl.append(h('span', { class: `tag ${v === 'ground_truth' ? 'warn' : 'ok'}`, title: v === 'ground_truth' ? 'simulator ground truth (step-1 cheat)' : '' },
        `${k}: ${v === 'ground_truth' ? 'GT (cheat)' : v}`));
    }

    // locations
    const lk = (m.locations || []).join(',');
    if (lk !== locKey) {
      locKey = lk;
      locSel.innerHTML = '';
      for (const l of m.locations || []) locSel.append(h('option', { value: l }, LABEL(l)));
    }
    bGo.disabled = active;

    // instruments
    const ik = (m.instruments || []).join(',');
    if (ik !== instKey) {
      instKey = ik;
      instGrid.innerHTML = '';
      for (const name of m.instruments || []) {
        const info = (m.instrument_info || {})[name] || {};
        instGrid.append(h('button', { class: 'inst-btn', dataset: { name }, title: info.desc || name, onclick: () => request(name) },
          h('span', { class: 'inst-ico' }, instIcon(name)),
          h('span', { class: 'inst-name' }, LABEL(name)),
          info.standin ? h('span', { class: 'inst-sub' }, 'stand-in') : null,
          h('span', { class: 'inst-q' })));
      }
    }
    const queue = m.queue || [];
    for (const b of instGrid.children) {
      const n = b.dataset.name;
      b.classList.toggle('target', active && m.instrument === n);
      const qi = queue.indexOf(n);
      b.querySelector('.inst-q').textContent = qi >= 0 ? `queued #${qi + 1}` : '';
      b.classList.toggle('queued', qi >= 0);
    }
    queueEl.textContent = queue.length ? `Queue: ${queue.map(LABEL).join(' → ')}` : '';

    // tree
    treeEl.innerHTML = '';
    for (const n of m.tree || []) {
      const cls = NODE_CLS[n.status] || 'idle';
      const tip = active && n.name === m.step;
      treeEl.append(h('div', { class: `bt-node ${cls}${tip ? ' tip' : ''}`, style: { paddingLeft: `${8 + n.depth * 16}px` }, title: n.type },
        h('span', { class: 'bt-dot' }),
        h('span', { class: `bt-name ${n.depth === 0 || /Sequence|Selector|Repeat/.test(n.type) ? 'comp' : ''}` }, n.name),
        n.message && !/Sequence|Selector|Repeat|Parallel/.test(n.type) && (cls === 'run' || cls === 'err' || tip)
          ? h('span', { class: 'bt-msg' }, n.message) : null));
    }
    if (!(m.tree || []).length) treeEl.append(h('div', { class: 'muted small' }, 'No tree yet: start the mission or request an instrument.'));

    // history
    histBody.innerHTML = '';
    for (const r of (m.history || []).slice().reverse()) {
      histBody.append(h('tr', {},
        h('td', {}, LABEL(r.instrument || '?')),
        h('td', {}, h('span', { class: `tag ${r.success ? 'ok' : 'err'}` }, r.success ? 'handed over' : 'failed')),
        h('td', {}, `${fmt.num(r.duration, 0)} s`),
        h('td', { class: 'muted small' }, r.success ? '' : (r.message || ''))));
    }
    const c = m.counts || { ok: 0, failed: 0 };
    countsEl.textContent = `${c.ok} ok · ${c.failed} failed`;

    // camera HUD
    camHud.innerHTML = '';
    const hc = link && link.head_camera;
    if (camOn && hc) camHud.append(h('span', { class: 'hud' }, `${fmt.num(hc.fps, 1)} fps`),
      h('span', { class: 'hud' }, m.instrument ? `target: ${LABEL(m.instrument)}` : 'no target'));
  }

  const offs = [robot.on('mission', render), robot.on('state', render), robot.on('mode', render)];
  render();
  return () => { offs.forEach((f) => f()); setCam(false); };
}

function instIcon(name) {
  const paths = {
    scalpel_handle: '<path d="M4 20l9-9M13 11l6-7 1 1-5 8z"/>',
    forceps: '<path d="M5 20l7-16M19 20L12 4M8 13h8"/>',
    adson_forceps: '<path d="M5 20l7-16M19 20L12 4M8 13h8"/>',
    angled_tweezers: '<path d="M6 20l6-14 3-2M18 20l-6-14"/>',
    veress_needle: '<path d="M12 21V9"/><rect x="9" y="3" width="6" height="6" rx="1"/>',
    trocar: '<path d="M12 21v-9"/><path d="M7 12h10l-2-6H9z"/>',
    needle_driver: '<circle cx="7" cy="18" r="2.5"/><circle cx="13" cy="19" r="2.5"/><path d="M8.5 16L18 4M12 16.5L18 4"/>',
    scissors: '<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M7.8 16.2L18 4M16.2 16.2L6 4"/>',
  };
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.innerHTML = paths[name] || '<path d="M6 18L18 6"/><circle cx="6" cy="18" r="2"/>';
  return s;
}

