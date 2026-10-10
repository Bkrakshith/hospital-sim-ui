// Navigation: choose a map, localise (initial pose), send goals / waypoint tasks to Nav2.
import { robot } from '../robot.js';
import { h, icon, act, prompt, confirmBox, fmt, stackTag, toast } from '../ui.js';
import { MapView } from '../mapview.js';
import { pressModeKey } from '../teleop.js';

export function mount(root) {
  const mapWrap = h('div', { class: 'map-wrap' });
  const empty = h('div', { class: 'map-empty' },
    h('div', {}, h('div', { style: { fontSize: '16px', fontWeight: 600, marginBottom: '6px' } }, 'No map loaded'),
      'Pick a saved map on the right and press "Localise", or navigate on the live SLAM map.'));
  mapWrap.append(empty);
  const tools = {
    pan: h('button', { class: 'tool-btn active', title: 'Pan / zoom' }, icon('hand'), 'Pan'),
    initial: h('button', { class: 'tool-btn', title: 'Click and drag: set the AMCL initial pose' }, icon('pose'), 'Initial pose'),
    goal: h('button', { class: 'tool-btn', title: 'Click and drag: navigate to this pose' }, icon('target'), 'Go to'),
    waypoint: h('button', { class: 'tool-btn', title: 'Click and drag: add a waypoint' }, icon('pin'), 'Add waypoint'),
  };
  const followBtn = h('button', { class: 'tool-btn', title: 'Keep the robot centred' }, icon('follow'), 'Follow');
  const fitBtn = h('button', { class: 'tool-btn', title: 'Fit map' }, icon('fit'), 'Fit');
  const hud = h('div', { class: 'map-hud' });
  const toolHint = h('span', { class: 'hud' }, 'Drag to pan, scroll to zoom');
  const mapCard = h('section', { class: 'card map-card' }, mapWrap,
    h('div', { class: 'map-toolbar' }, ...Object.values(tools)),
    h('div', { class: 'map-toolbar right' }, followBtn, fitBtn), hud);

  // --- side panel
  const navState = h('span');
  const mapsList = h('div', { class: 'list' });
  const locInfo = h('div', { class: 'hint' });
  const navBtnRow = h('div', { class: 'row' });
  const missionKv = h('dl', { class: 'kv' });
  const missionBtns = h('div', { class: 'row' });
  const modeHint = h('div');
  const wpList = h('div', { class: 'list' });
  const wpBtns = h('div', { class: 'row' });
  const routesList = h('div', { class: 'list' });

  const side = h('div', { class: 'side' },
    h('section', { class: 'card' },
      h('div', { class: 'card-h' }, h('h2', {}, 'Map & localisation'), navState),
      h('div', { class: 'stack' }, mapsList, navBtnRow, locInfo)),
    h('section', { class: 'card' },
      h('div', { class: 'card-h' }, h('h2', {}, 'Mission')),
      h('div', { class: 'stack' }, modeHint, missionKv, missionBtns)),
    h('section', { class: 'card' },
      h('div', { class: 'card-h' }, h('h2', {}, 'Waypoints'), h('span', { class: 'sub' }, 'Add waypoint tool')),
      h('div', { class: 'stack' }, wpList, wpBtns)),
    h('section', { class: 'card' },
      h('div', { class: 'card-h' }, h('h2', {}, 'Saved tasks'), h('span', { class: 'sub' }, 'routes for this map')),
      routesList),
  );
  root.append(h('div', { class: 'split' }, mapCard, side));

  const mv = new MapView(mapWrap);
  let selectedMap = null;
  let maps = [];
  let waypoints = [];
  let routes = {};

  const setTool = (t) => {
    mv.setTool(t);
    for (const [k, b] of Object.entries(tools)) b.classList.toggle('active', k === t);
    toolHint.textContent = { pan: 'Drag to pan, scroll to zoom', initial: 'Click where the robot is, drag towards where it faces',
      goal: 'Click the goal, drag to set the final heading', waypoint: 'Click to add a waypoint, drag for its heading' }[t];
  };
  for (const [k, b] of Object.entries(tools)) b.onclick = () => setTool(k);
  followBtn.onclick = () => { mv.follow = !mv.follow; followBtn.classList.toggle('active', mv.follow); };
  mv.onViewChange = () => followBtn.classList.toggle('active', mv.follow);
  fitBtn.onclick = () => { mv.follow = false; followBtn.classList.remove('active'); mv.fit(); };

  mv.onPose = async (tool, p) => {
    if (tool === 'initial') {
      await act(robot.request('initial_pose', p), { success: 'Initial pose sent' });
      setTool('pan');
    } else if (tool === 'goal') {
      mv.setGoal(p);
      await sendGoal(p);
    } else if (tool === 'waypoint') {
      waypoints.push({ ...p, label: '' });
      renderWaypoints();
    }
  };

  async function sendGoal(p) {
    const r = await act(robot.request('nav_goal', p, { timeout: 20000 }), { fail: 'Goal not sent' });
    if (r.ok) toast('Navigating', `to (${fmt.num(p.x, 1)}, ${fmt.num(p.y, 1)})`, 'success', 2500);
  }

  async function runWaypoints(list) {
    if (!list.length) return;
    mv.setGoal(null);
    await act(robot.request('nav_waypoints', { poses: list }, { timeout: 20000 }), { success: 'Waypoint task started', fail: 'Task not started' });
  }

  // ------------------------------------------------------------------ maps
  async function loadMaps() {
    try {
      const r = await robot.request('maps_list');
      maps = (r.data && r.data.maps) || [];
    } catch { maps = []; }
    const st = robot.state.status;
    if (!selectedMap) selectedMap = (st && st.active_map) || (maps[maps.length - 1] || {}).name || null;
    renderMaps();
    loadRoutes();
  }

  function renderMaps() {
    mapsList.innerHTML = '';
    const st = robot.state.status;
    const active = st && st.active_map;
    const theme = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    if (!maps.length) mapsList.append(h('div', { class: 'hint' }, 'No saved maps yet. Build one on the Mapping page.'));
    for (const m of maps.slice().reverse()) {
      const item = h('div', { class: `list-item ${m.name === selectedMap ? 'selected' : ''}`, style: { cursor: 'pointer' }, onclick: () => { selectedMap = m.name; renderMaps(); loadRoutes(); } },
        h('img', { class: 'thumb', src: `${m.preview}?theme=${theme}&v=${Math.round(m.mtime || 0)}`, alt: '' }),
        h('div', { class: 'grow' },
          h('div', { class: 'title' }, m.name),
          h('div', { class: 'small muted' }, m.error ? m.error : `${m.width}×${m.height} · ${m.resolution} m`,
            m.ground_truth ? h('span', { class: 'tag warn', style: { marginLeft: '6px' } }, 'ground truth') : null,
            m.name === active ? h('span', { class: 'tag ok', style: { marginLeft: '6px' } }, 'loaded') : null)),
        h('button', { class: 'btn sm ghost', title: 'Delete map', onclick: async (e) => {
          e.stopPropagation();
          if (await confirmBox('Delete map', `Delete ${m.name} (pgm, yaml, pose graph, tasks)?`, 'Delete', true)) {
            await act(robot.request('map_delete', { name: m.name }), { success: 'Map deleted' });
            if (selectedMap === m.name) selectedMap = null;
            loadMaps();
          }
        } }, icon('trash')));
      mapsList.append(item);
    }
  }

  function renderNavButtons(st) {
    navBtnRow.innerHTML = '';
    const nav = st.stacks.nav, slam = st.stacks.slam;
    const running = ['running', 'starting'].includes(nav.state);
    const slamOn = ['running', 'starting', 'external'].includes(slam.state);
    navBtnRow.append(
      h('button', { class: 'btn primary', disabled: !selectedMap || slamOn, title: slamOn ? 'Stop SLAM first' : 'Start map_server + AMCL + Nav2 on the selected map',
        onclick: async () => {
          await act(robot.request('map_load', { name: selectedMap }, { timeout: 30000 }), { success: 'Localisation starting', fail: 'Could not load map' });
          setTool('initial');
          toast('Set the initial pose', 'Click where the robot is on the map and drag towards where it faces.', 'info', 7000);
        } }, icon('upload'), 'Localise'),
      h('button', { class: 'btn', disabled: running || !slamOn, title: 'Run Nav2 on the live SLAM map (no AMCL)',
        onclick: () => act(robot.request('stack_start', { stack: 'nav' }), { success: 'Nav2 starting on SLAM map' }) }, 'Use SLAM map'),
      h('button', { class: 'btn danger', disabled: !['running', 'starting', 'failed'].includes(nav.state),
        onclick: () => act(robot.request('stack_stop', { stack: 'nav' }, { timeout: 30000 }), { success: 'Navigation stopped' }) }, icon('stop'), 'Stop'),
    );
    locInfo.textContent = nav.state === 'running' || nav.state === 'external'
      ? (nav.args && nav.args.localization === 'amcl' ? `AMCL on ${nav.args.map}. ${st.amcl ? `Localisation σ ≈ ${fmt.num(st.amcl.std_xy, 2)} m.` : 'Set the initial pose.'}` : 'Nav2 running on the live SLAM map.')
      : nav.state === 'starting' ? 'Starting map_server / AMCL / Nav2 …'
      : nav.state === 'failed' ? `Nav2 exited (code ${nav.exit_code}); see Logs.` : 'Navigation stack is stopped.';
  }

  // ------------------------------------------------------------------ mission
  function renderMission(st) {
    const nav = st.nav || {};
    const mode = robot.modeName();
    modeHint.innerHTML = '';
    if (mode && mode !== 'NAV' && mode !== 'STAND') {
      modeHint.append(h('div', { class: 'callout warn' }, `Mode is ${mode}. Navigation needs STAND first`,
        mode === 'LOCO' ? ' (press p to pause locomotion).' : mode === 'MANIP' ? ' (press n to stop camera teleop).' : ' (press r).'));
    } else if (mode === 'STAND') {
      modeHint.append(h('div', { class: 'callout' }, 'Sending a goal switches STAND → NAV (Nav2 then drives /g1/cmd_vel_nav).'));
    }
    const fb = nav.feedback || {};
    missionKv.innerHTML = '';
    const rows = [
      ['State', h('span', { class: `tag ${nav.state === 'active' ? 'info' : nav.state === 'succeeded' ? 'ok' : ['aborted', 'failed', 'rejected'].includes(nav.state) ? 'err' : nav.state === 'paused' ? 'warn' : ''}` }, nav.state || 'idle')],
      ['Nav2 server', nav.server_ready ? h('span', { class: 'tag ok' }, 'ready') : h('span', { class: 'tag' }, 'not running')],
    ];
    if (nav.kind === 'goal' && nav.goal) rows.push(['Goal', `${fmt.num(nav.goal.x, 1)}, ${fmt.num(nav.goal.y, 1)}`]);
    if (nav.kind === 'waypoints') rows.push(['Waypoint', `${Math.min(nav.index + 1, nav.waypoints.length)} / ${nav.waypoints.length}`]);
    if (fb.distance_remaining !== undefined && nav.state === 'active') {
      rows.push(['Remaining', `${fmt.num(fb.distance_remaining, 1)} m`], ['ETA', `${fmt.num(fb.eta, 0)} s`], ['Recoveries', fb.recoveries]);
    }
    if (nav.message) rows.push(['Note', nav.message]);
    for (const [k, v] of rows) missionKv.append(h('dt', {}, k), h('dd', {}, v));
    missionBtns.innerHTML = '';
    const active = ['active', 'sending'].includes(nav.state);
    missionBtns.append(
      h('button', { class: 'btn warn', disabled: !active, onclick: () => act(robot.request('nav_pause'), { success: 'Paused' }) }, icon('pause'), 'Pause'),
      h('button', { class: 'btn ok', disabled: nav.state !== 'paused', onclick: () => act(robot.request('nav_resume', {}, { timeout: 20000 }), { success: 'Resumed' }) }, icon('play'), 'Resume'),
      h('button', { class: 'btn danger', disabled: !(active || nav.state === 'paused'), onclick: () => { mv.setGoal(null); act(robot.request('nav_cancel'), { success: 'Canceled' }); } }, icon('x'), 'Cancel'),
      h('button', { class: 'btn', disabled: mode !== 'NAV', title: 'NAV → STAND (key p)', onclick: () => pressModeKey('p') }, h('kbd', {}, 'p'), 'Back to STAND'),
    );
    if (execActive()) mv.setWaypoints(nav.waypoints, nav.state === 'succeeded' ? nav.waypoints.length : nav.index);
    else mv.setWaypoints(waypoints);
  }

  // ------------------------------------------------------------------ waypoints + routes
  function renderWaypoints() {
    wpList.innerHTML = '';
    if (!waypoints.length) wpList.append(h('div', { class: 'hint' }, 'Use "Add waypoint" on the map to build a patrol / delivery route.'));
    waypoints.forEach((w, i) => {
      wpList.append(h('div', { class: 'list-item' },
        h('span', { class: 'wp-num' }, i + 1),
        h('div', { class: 'grow mono small' }, `${fmt.num(w.x)}, ${fmt.num(w.y)} · ${fmt.deg(w.yaw)}`),
        h('button', { class: 'btn sm ghost', title: 'Move up', disabled: i === 0, onclick: () => { [waypoints[i - 1], waypoints[i]] = [waypoints[i], waypoints[i - 1]]; renderWaypoints(); } }, '↑'),
        h('button', { class: 'btn sm ghost', title: 'Remove', onclick: () => { waypoints.splice(i, 1); renderWaypoints(); } }, icon('x'))));
    });
    wpBtns.innerHTML = '';
    wpBtns.append(
      h('button', { class: 'btn primary', disabled: !waypoints.length, onclick: () => runWaypoints(waypoints) }, icon('play'), 'Run'),
      h('button', { class: 'btn', disabled: !waypoints.length || !currentMapName(), title: currentMapName() ? '' : 'Select a saved map first',
        onclick: async () => {
          const name = await prompt('Save task', { placeholder: 'e.g. pacu_round', okText: 'Save', hint: `Saved with map ${currentMapName()}` });
          if (!name) return;
          const r = await act(robot.request('route_save', { map: currentMapName(), name, poses: waypoints }), { success: 'Task saved' });
          if (r.ok) { routes = r.data.routes; renderRoutes(); }
        } }, icon('save'), 'Save as task'),
      h('button', { class: 'btn ghost', disabled: !waypoints.length, onclick: () => { waypoints = []; renderWaypoints(); } }, 'Clear'),
    );
    if (!execActive()) mv.setWaypoints(waypoints);
  }

  function execActive() {
    const nav = (robot.state.status && robot.state.status.nav) || {};
    return nav.kind === 'waypoints' && ['active', 'sending', 'paused'].includes(nav.state);
  }

  function currentMapName() {
    const st = robot.state.status;
    return (st && st.active_map) || selectedMap;
  }

  async function loadRoutes() {
    const m = currentMapName();
    routes = {};
    if (m) {
      try { const r = await robot.request('routes_list', { map: m }); routes = (r.data && r.data.routes) || {}; } catch { /* ignore */ }
    }
    renderRoutes();
  }

  function renderRoutes() {
    routesList.innerHTML = '';
    const names = Object.keys(routes);
    if (!names.length) routesList.append(h('div', { class: 'hint' }, currentMapName() ? `No tasks for ${currentMapName()} yet.` : 'Select a map to see its tasks.'));
    for (const n of names) {
      const r = routes[n];
      routesList.append(h('div', { class: 'list-item' },
        icon('route'),
        h('div', { class: 'grow' }, h('div', { class: 'title' }, n), h('div', { class: 'small muted' }, `${r.length} waypoints`)),
        h('button', { class: 'btn sm', title: 'Show / edit', onclick: () => { waypoints = r.map((p) => ({ ...p })); renderWaypoints(); } }, 'Edit'),
        h('button', { class: 'btn sm primary', title: 'Run task', onclick: () => runWaypoints(r) }, icon('play')),
        h('button', { class: 'btn sm ghost', title: 'Delete task', onclick: async () => {
          const res = await act(robot.request('route_delete', { map: currentMapName(), name: n }), { success: 'Task deleted' });
          if (res.ok) { routes = res.data.routes; renderRoutes(); }
        } }, icon('trash'))));
    }
  }

  let lastActive = null;
  function renderState(st) {
    navState.innerHTML = '';
    navState.append(stackTag(st.stacks.nav.state));
    renderNavButtons(st);
    renderMission(st);
    if (st.active_map !== lastActive) { lastActive = st.active_map; if (st.active_map) { selectedMap = st.active_map; } renderMaps(); loadRoutes(); }
    hud.innerHTML = '';
    hud.append(toolHint);
    const p = robot.state.pose;
    if (p) hud.append(h('span', { class: 'hud mono' }, `${p.frame} ${fmt.num(p.x)}, ${fmt.num(p.y)}, ${fmt.deg(p.yaw)}`));
  }

  const unsubs = [
    robot.on('state', renderState),
    robot.on('mode', () => robot.state.status && renderMission(robot.state.status)),
    robot.on('map', () => { empty.hidden = true; }),
    robot.on('theme', renderMaps),
    robot.on('hello', loadMaps),
  ];
  empty.hidden = !!robot.state.map;
  setTool('pan');
  renderWaypoints();
  if (robot.state.connected) loadMaps();
  if (robot.state.status) renderState(robot.state.status);
  return () => { unsubs.forEach((u) => u()); mv.destroy(); };
}
