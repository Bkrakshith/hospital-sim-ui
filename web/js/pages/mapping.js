// Mapping: start slam_toolbox, drive in LOCO (keyboard / joystick), watch the map grow, save it.
import { robot } from '../robot.js';
import { h, icon, act, prompt, fmt, stackTag, toast } from '../ui.js';
import { MapView } from '../mapview.js';
import { keyboard, joystick, pressModeKey, MODE_KEYS, LEGAL } from '../teleop.js';

export function mount(root) {
  const mapWrap = h('div', { class: 'map-wrap' });
  const empty = h('div', { class: 'map-empty' },
    h('div', {}, h('div', { style: { fontSize: '16px', fontWeight: 600, marginBottom: '6px' } }, 'No map yet'),
      'Start SLAM, then drive the robot in LOCO to build the map.'));
  mapWrap.append(empty);
  const followBtn = h('button', { class: 'tool-btn active', title: 'Keep the robot centred' }, icon('follow'), 'Follow');
  const fitBtn = h('button', { class: 'tool-btn', title: 'Fit map (double-click)' }, icon('fit'), 'Fit');
  const scanBtn = h('button', { class: 'tool-btn active', title: 'Show laser scan' }, 'Scan');
  const hud = h('div', { class: 'map-hud' });
  const mapCard = h('section', { class: 'card map-card' }, mapWrap,
    h('div', { class: 'map-toolbar' }, followBtn, fitBtn, scanBtn), hud);

  const slamState = h('span');
  const slamBtn = h('button', { class: 'btn primary block' });
  const slamInfo = h('div', { class: 'hint' });
  const saveBtn = h('button', { class: 'btn ok block' }, icon('save'), 'Save map');
  const mapInfo = h('dl', { class: 'kv' });
  const modeRow = h('div', { class: 'row' });
  const kbBtn = h('button', { class: 'kb-status', title: 'Capture the contract keys from this browser tab' });
  const joy = joystick();

  const side = h('div', { class: 'side' },
    h('section', { class: 'card' },
      h('div', { class: 'card-h' }, h('h2', {}, 'SLAM'), slamState),
      h('div', { class: 'stack' }, slamBtn, slamInfo)),
    h('section', { class: 'card' },
      h('div', { class: 'card-h' }, h('h2', {}, 'Drive'), h('span', { class: 'sub' }, 'LOCO mode')),
      h('div', { class: 'stack' }, modeRow, kbBtn,
        h('div', { class: 'hint' }, h('kbd', {}, 'W'), h('kbd', {}, 'S'), ' forward/back  ', h('kbd', {}, 'A'), h('kbd', {}, 'D'),
          ' strafe  ', h('kbd', {}, 'Q'), h('kbd', {}, 'E'), ' turn  ', h('kbd', {}, 'Space'), ' stop'),
        joy.el)),
    h('section', { class: 'card' },
      h('div', { class: 'card-h' }, h('h2', {}, 'Map'), h('span', { class: 'sub' }, '/map')),
      h('div', { class: 'stack' }, mapInfo, saveBtn,
        h('div', { class: 'hint' }, 'Saved to ros2_ws/src/hospital-sim-ros2/g1_navigation/maps/ as pgm + yaml (and the slam_toolbox pose graph when available).'))),
  );
  root.append(h('div', { class: 'split' }, mapCard, side));

  const mv = new MapView(mapWrap);
  mv.follow = true;
  followBtn.onclick = () => { mv.follow = !mv.follow; followBtn.classList.toggle('active', mv.follow); mv.invalidate(); };
  mv.onViewChange = () => { followBtn.classList.toggle('active', mv.follow); };
  fitBtn.onclick = () => { mv.follow = false; followBtn.classList.remove('active'); mv.fit(); };
  scanBtn.onclick = () => { mv.opts.showScan = mv.opts.showScan === false; scanBtn.classList.toggle('active', mv.opts.showScan !== false); mv.invalidate(); };

  let kbOn = true;
  const renderKb = () => {
    kbBtn.className = `kb-status ${kbOn ? 'on' : ''}`;
    kbBtn.innerHTML = '';
    kbBtn.append(icon('keyboard'), kbOn ? 'Keyboard control ON (this tab)' : 'Keyboard control off — click to enable');
  };
  kbBtn.onclick = () => { kbOn = !kbOn; kbOn ? keyboard.enable() : keyboard.disable(); renderKb(); };
  keyboard.enable();
  renderKb();

  slamBtn.onclick = async () => {
    const st = robot.state.status;
    const s = st ? st.stacks.slam.state : 'stopped';
    if (s === 'running' || s === 'starting') {
      slamBtn.disabled = true;
      await act(robot.request('stack_stop', { stack: 'slam' }, { timeout: 30000 }), { success: 'SLAM stopped' });
      slamBtn.disabled = false;
    } else if (s === 'external') {
      toast('SLAM was started outside the dashboard', 'Stop it from the terminal that launched it.', 'info');
    } else {
      slamBtn.disabled = true;
      mv.clearTrail();
      await act(robot.request('stack_start', { stack: 'slam' }), { success: 'SLAM starting' });
      slamBtn.disabled = false;
    }
  };

  saveBtn.onclick = async () => {
    const d = new Date();
    const def = `hospital_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    const name = await prompt('Save map', { value: def, okText: 'Save', hint: 'Letters, digits, _ . - only. Existing maps with the same name are overwritten.' });
    if (!name) return;
    await act(robot.request('map_save', { name }, { timeout: 20000 }), { success: 'Map saved', fail: 'Could not save map' });
  };

  function renderMode() {
    modeRow.innerHTML = '';
    const cur = robot.modeName();
    for (const k of ['r', 'l', 'p']) {
      const s = MODE_KEYS[k];
      const allowed = cur && (s.from ? s.from.includes(cur) : (LEGAL[cur] || []).includes(s.target));
      modeRow.append(h('button', { class: `btn sm ${k === 'l' ? 'ok' : ''}`, disabled: !allowed, title: `${s.sub} (key ${k})`, onclick: () => pressModeKey(k) },
        h('kbd', {}, k), s.label));
    }
  }

  function renderState(st) {
    const s = st.stacks.slam;
    slamState.innerHTML = '';
    slamState.append(stackTag(s.state));
    const running = ['running', 'starting', 'stopping'].includes(s.state);
    slamBtn.className = `btn block ${running ? 'danger' : 'primary'}`;
    slamBtn.innerHTML = '';
    slamBtn.append(icon(running ? 'stop' : 'play'), running ? 'Stop SLAM' : 'Start SLAM');
    slamBtn.disabled = s.state === 'stopping';
    const navAmcl = st.stacks.nav.state !== 'stopped' && st.stacks.nav.args && st.stacks.nav.args.localization === 'amcl';
    slamInfo.textContent = s.state === 'failed' ? `slam_toolbox exited (code ${s.exit_code}). See Logs.`
      : s.state === 'external' ? 'slam_toolbox is running (started outside the dashboard).'
      : running ? `online async slam_toolbox · since ${fmt.since(s.since)} · scans from /scan`
      : navAmcl ? 'Navigation with AMCL is running: stop it before mapping.' : 'Mapping uses slam_toolbox (online async) on /scan.';
    const m = robot.state.map;
    const scanAge = st.topics['/scan'];
    hud.innerHTML = '';
    hud.append(h('span', { class: 'hud' }, `scan ${scanAge === undefined ? 'none' : scanAge < 1 ? 'live' : fmt.age(scanAge) + ' old'}`));
    if (robot.state.pose) hud.append(h('span', { class: 'hud mono' }, `${robot.state.pose.frame} ${fmt.num(robot.state.pose.x)}, ${fmt.num(robot.state.pose.y)}`));
    saveBtn.disabled = !m;
    renderMode();
  }

  function renderMap(m) {
    empty.hidden = !!m;
    if (!m) { mapInfo.innerHTML = ''; return; }
    const area = (m.stats.free * m.resolution * m.resolution).toFixed(0);
    mapInfo.innerHTML = '';
    for (const [k, v] of [['Size', `${m.width} × ${m.height} cells`], ['Resolution', `${m.resolution.toFixed(3)} m`],
      ['Extent', `${(m.width * m.resolution).toFixed(1)} × ${(m.height * m.resolution).toFixed(1)} m`],
      ['Explored (free)', `${area} m²`], ['Updates', `#${m.version}`]]) {
      mapInfo.append(h('dt', {}, k), h('dd', {}, v));
    }
  }

  const unsubs = [robot.on('state', renderState), robot.on('mode', renderMode), robot.on('map', renderMap)];
  renderMap(robot.state.map);
  renderMode();
  if (robot.state.status) renderState(robot.state.status);
  return () => { unsubs.forEach((u) => u()); mv.destroy(); joy.destroy(); keyboard.disable(); };
}
