// Operator → Map: live map with places, route and goal. Tools: Move map, Go to point (tap, drag for heading),
// Robot is here (relocalise), Add waypoint. +/- and Fit buttons (no pinch needed). Trip controls.
import { store, api, placeName } from '../client.js';
import { h, ic, button, slideToConfirm, toast, fmt, clear } from '../ui.js';
import { MapView } from '../mapview.js';
import { dispatchRequest } from '../shell.js';
import { pathList } from '../goals.js';
import { derive } from '../status.js';

const S = store.state;

export function mount(el) {
  const mapBox = h('div', { class: 'map-box', 'aria-label': 'Map. Use the tool buttons to set a goal or the robot position.' });
  const side = h('aside', { class: 'map-side' });
  const zoom = h('div', { class: 'map-zoom' },
    button('', { icon: 'plus', size: 'operator', aria: 'Zoom in', onClick: () => mv.zoom(1.4) }),
    button('', { icon: 'minus', size: 'operator', aria: 'Zoom out', onClick: () => mv.zoom(1 / 1.4) }),
    button('', { icon: 'fit', size: 'operator', aria: 'Fit the map', onClick: () => mv.fit() }),
    button('', { icon: 'crosshair', size: 'operator', aria: 'Centre on the robot', onClick: () => mv.centreOnRobot() }));
  const empty = h('div', { class: 'map-empty' });
  el.append(h('div', { class: 'map-layout' }, h('div', { class: 'map-wrap' }, mapBox, zoom, empty), side));
  const mv = new MapView(mapBox, { trail: true });
  let tool = 'pan';
  let pendingGoal = null;
  let waypoints = [];

  mv.onPose = (t, p) => {
    if (t === 'goal') { pendingGoal = p; mv.setGoal(p); renderSide(); }
    else if (t === 'initial') { confirmInitial(p); }
    else if (t === 'waypoint') { waypoints.push(p); mv.setWaypoints(waypoints); renderSide(); }
  };
  const setTool = (t) => { tool = t; mv.setTool(t); renderSide(); };

  const confirmInitial = async (p) => {
    const r = await api.initialPose(p.x, p.y, p.yaw);
    toast(r.ok ? 'Position set. Check the laser dots line up with the walls.' : r.message, { level: r.ok ? 'ok' : 'warn' });
    setTool('pan');
  };

  const renderSide = () => {
    clear(side);
    const d = derive();
    const nav = S.status && S.status.nav;
    const navActive = nav && ['active', 'sending', 'paused'].includes(nav.state);
    const toolBtn = (id, label, ico) => h('button', { class: `tool${tool === id ? ' on' : ''}`, type: 'button', 'aria-pressed': tool === id ? 'true' : 'false', onClick: () => setTool(tool === id ? 'pan' : id) }, ic(ico, 24), h('span', {}, label));
    side.append(h('div', { class: 'tools', role: 'toolbar', 'aria-label': 'Map tools' },
      toolBtn('pan', 'Move map', 'hand'), toolBtn('goal', 'Go to point', 'target'), toolBtn('initial', 'Robot is here', 'crosshair'), toolBtn('waypoint', 'Add stop', 'route')));
    const hint = { pan: 'Drag to move the map.', goal: 'Tap where the robot should go. Drag to set which way it faces.', initial: 'Tap where the robot really is, drag for its heading. Then check the laser dots match the walls.', waypoint: 'Tap to add stops to a route.' }[tool];
    side.append(h('p', { class: 'muted tool-hint' }, hint));

    if (pendingGoal) {
      side.append(h('div', { class: 'card goal-card' }, h('h3', {}, 'Go to this point'), h('p', { class: 'muted mono' }, `x ${fmt.num(pendingGoal.x, 1)} · y ${fmt.num(pendingGoal.y, 1)} · facing ${Math.round(pendingGoal.yaw * 180 / Math.PI)}°`),
        pathList('NAV'),
        h('div', { class: 'row gap' },
          button('Go', { kind: 'primary', size: 'operator', icon: 'robotArrow', onClick: async () => { const g = pendingGoal; pendingGoal = null; const r = await api.navGoal(g.x, g.y, g.yaw); toast(r.ok ? 'Going to the point' : r.message, { level: r.ok ? 'ok' : 'warn' }); if (!r.ok) mv.setGoal(null); setTool('pan'); } }),
          button('Clear', { size: 'operator', onClick: () => { pendingGoal = null; mv.setGoal(null); renderSide(); } }))));
    }
    if (navActive) {
      side.append(h('div', { class: 'card trip-card' }, h('h3', {}, nav.state === 'paused' ? 'Trip paused' : d.mode),
        d.progress ? h('p', {}, `${fmt.dist(d.progress.dist)} to go · ${fmt.eta(d.progress.eta)}${d.progress.recoveries ? ` · ${d.progress.recoveries} retries` : ''}`) : null,
        h('div', { class: 'row gap' },
          nav.state === 'paused' ? button('Resume', { kind: 'primary', size: 'operator', icon: 'play', onClick: () => api.navResume() }) : button('Pause', { size: 'operator', icon: 'pause', onClick: () => api.navPause() }),
          button('Cancel trip', { size: 'operator', icon: 'x', onClick: () => api.cancelTask() }))));
    }
    if (waypoints.length) {
      side.append(h('div', { class: 'card route-card' }, h('h3', {}, `Route · ${waypoints.length} stop${waypoints.length > 1 ? 's' : ''}`),
        h('ol', { class: 'wp-list' }, waypoints.map((w, i) => h('li', {}, `Stop ${i + 1} · ${fmt.num(w.x, 1)}, ${fmt.num(w.y, 1)}`))),
        h('div', { class: 'row gap wrap' },
          button('Run route', { kind: 'primary', size: 'operator', icon: 'play', onClick: async () => { const r = await api.navWaypoints(waypoints.map(({ x, y, yaw }) => ({ x, y, yaw }))); toast(r.ok ? 'Running the route' : r.message, { level: r.ok ? 'ok' : 'warn' }); } }),
          button('Clear', { size: 'operator', onClick: () => { waypoints = []; mv.setWaypoints([]); renderSide(); } }))));
    }
    side.append(h('h3', { class: 'sec-t' }, 'Send to a place'));
    const pl = h('div', { class: 'place-list' });
    for (const p of S.places) {
      pl.append(h('button', { class: 'place-row', type: 'button', onClick: () => dispatchRequest('send_to', () => api.sendTo(p.id)) }, ic(p.dock ? 'dock' : 'pin', 22), h('span', { class: 'pr-n' }, p.name), h('span', { class: 'pr-s' }, p.sub || '')));
    }
    side.append(pl);
    const st = S.status || {};
    const navStack = st.stacks && st.stacks.nav ? st.stacks.nav.state : null;
    side.append(h('p', { class: 'muted small-note' }, `Map: ${st.active_map || (S.map ? 'live' : 'none')} · navigation ${navStack || 'unknown'}`));
  };

  const renderEmpty = () => {
    clear(empty);
    empty.hidden = !!S.map;
    if (!S.map) empty.append(h('div', { class: 'empty' }, h('div', { class: 'empty-t' }, 'No map loaded'), h('div', { class: 'empty-s' }, 'A technician loads the wing map in System → Mapping. The robot and laser dots still show.')));
  };
  renderSide(); renderEmpty();
  let last = '';
  const onState = () => {
    const nav = S.status && S.status.nav;
    const k = JSON.stringify([nav && nav.state, nav && nav.feedback && Math.round((nav.feedback.distance_remaining || 0) * 2), S.status && S.status.active_map]);
    if (k !== last) { last = k; renderSide(); }
  };
  const offs = [store.on('state', onState), store.on('map', renderEmpty), store.on('places', renderSide), store.on('mode', renderSide)];
  return () => { offs.forEach((o) => o()); mv.destroy(); };
}
