// Robot status (04 §6.2): plain-language sections. Technicians also see raw values (FSM name, source).
// Clinical camera view is a blurred, live-only thumbnail (P-1, 04 §5): nothing is stored.
import { store, modeLabel, sourceLabel, device, APP_VERSION } from '../client.js';
import { derive, batteryText, estopStatus, linkQuality } from '../status.js';
import { h, ic, button, fmt, clear } from '../ui.js';
import { icon } from '../icons.js';
import { openAlarmList, openProblem } from '../sheets.js';
import { evIcon } from './home.js';

const S = store.state;

export function mount(el) {
  const grid = h('div', { class: 'status-grid' });
  el.append(h('header', { class: 'screen-head' }, h('div', {}, h('h1', {}, 'Robot status'), h('p', { class: 'muted' }, 'What the robot is doing and whether it is healthy.')),
    h('div', { class: 'row gap' }, button('Alarms', { icon: 'bell', size: 'operator', onClick: openAlarmList }), button('Send problem to technician', { icon: 'send', size: 'operator', onClick: () => openProblem({}) }))), grid);
  const cam = h('img', { class: 'cam-thumb', alt: 'Blurred live view from the robot head camera', hidden: true });
  let camTimer = 0;
  const loadCam = () => {
    // only ask for a snapshot when the server has a head-camera frame (avoids a 404 per poll)
    const hc = S.status && S.status.mission_link && S.status.mission_link.head_camera;
    if (!hc || hc.age === null || hc.age === undefined || hc.age > 10) { cam.hidden = true; return; }
    const url = `/api/head_camera/snapshot.jpg?t=${Date.now()}`;
    const img = new Image();
    img.onload = () => { cam.src = url; cam.hidden = false; };
    img.onerror = () => { cam.hidden = true; };
    img.src = url;
  };
  const render = () => {
    const d = derive();
    const b = batteryText();
    const e = estopStatus();
    const st = S.status || {};
    const c = st.controller || {};
    const tech = S.session.role === 'technician';
    const temps = st.temps;
    const health = [];
    if (!S.connected) health.push(['No connection to the robot', 'fail']);
    if (c.fall || c.fall_detected) health.push(['Fall detected', 'fail']);
    if (temps && temps.max > 60) health.push([`${temps.hottest || 'A joint'} is warm (${Math.round(temps.max)} °C)`, 'warn']);
    if (e.level === 'alarm') health.push([`E-stop remote: ${e.text}`, 'fail']);
    for (const a of S.alarms.active.filter((x) => !x.acknowledged)) health.push([a.what, a.priority === 'high' ? 'fail' : 'warn']);
    clear(grid);
    const sec = (title, ico, ...kids) => h('section', { class: 'card st-card' }, h('h2', { class: 'st-h' }, ic(ico, 24), title), ...kids);
    grid.append(
      sec('Now', 'status', h('div', { class: `st-big lvl-${d.status.level}` }, h('span', { html: icon(d.status.icon, 34) }), d.status.word), h('p', { class: 'st-line' }, d.activity), h('p', { class: 'muted' }, d.next)),
      sec('Power', 'battery', h('div', { class: 'st-big' }, b.soc === null ? 'Not reported' : `${b.text} left`), b.soc !== null ? h('p', { class: 'muted' }, `${Math.round(b.soc)} % charge. Walking uses more than standing.`) : h('p', { class: 'muted' }, 'This robot does not report its battery yet.')),
      sec('Location', 'pin', h('div', { class: 'st-big' }, d.here || 'Unknown'), h('p', { class: 'muted' }, S.status && S.status.active_map ? `Map: ${S.status.active_map}` : 'Position from the robot')),
      sec('Health', health.length ? 'triangle' : 'checkCircle', health.length ? h('ul', { class: 'st-health' }, health.map(([t, l]) => h('li', { class: `lvl-${l}` }, ic(l === 'fail' ? 'octagon' : 'triangle', 22), t))) : h('div', { class: 'st-big lvl-ok' }, h('span', { html: icon('checkCircle', 30) }), 'All systems OK')),
      sec('Control', 'hand', h('div', { class: 'st-big' }, d.controller), h('p', { class: 'muted' }, `Mode: ${modeLabel(S.mode && S.mode.name)}${S.mode && S.mode.source ? ' · changed by ' + sourceLabel(S.mode.source) : ''}`), h('p', { class: 'muted' }, `Hardware e-stop remote: ${e.text}`)),
      sec('Today', 'clock', h('div', { class: 'st-kv' }, h('span', {}, 'Trips'), h('b', {}, String(S.timeline.filter((x) => x.kind === 'send_to' || x.kind === 'arrived').length))), h('div', { class: 'st-kv' }, h('span', {}, 'Instruments handed'), h('b', {}, String(S.handed.length))),
        h('ul', { class: 'tl-list' }, S.timeline.slice(-5).reverse().map((x) => h('li', {}, h('span', { class: 'tl-t' }, fmt.time(x.t)), ic(evIcon(x.kind), 18), h('span', {}, x.text))))),
      sec('Robot camera', 'camera', cam, h('p', { class: 'muted' }, cam.hidden ? 'No picture now. Live only, never recorded here.' : 'Blurred for privacy. Live only, never recorded here.')),
    );
    if (tech) {
      grid.append(sec('Technician', 'wrench', h('dl', { class: 'kv mono' },
        ...kv('FSM mode', S.mode ? `${S.mode.name} (${S.mode.mode})` : '–'), ...kv('source', S.mode ? S.mode.source || '–' : '–'), ...kv('detail', S.mode ? S.mode.detail || '–' : '–'),
        ...kv('policy', c.policy || c.policy_name || '–'), ...kv('placeholder', String(!!c.placeholder)), ...kv('loop Hz', c.loop_hz !== undefined ? fmt.num(c.loop_hz, 0) : c.hz !== undefined ? fmt.num(c.hz, 0) : '–'),
        ...kv('protocol', S.v2 ? 'v2' : 'not v2'), ...kv('app', APP_VERSION), ...kv('device', `${device.name} · ${device.id}`), ...kv('link', `${linkQuality()}/4`))));
    }
  };
  const kv = (k, v) => [h('dt', {}, k), h('dd', {}, v)];
  render(); loadCam();
  camTimer = setInterval(loadCam, 5000);
  let last = 0;
  const throttled = () => { if (Date.now() - last > 1000) { last = Date.now(); render(); } };
  const offs = [store.on('state', throttled), store.on('alarms', render), store.on('lease', render), store.on('session', render), store.on('event', render)];
  return () => { offs.forEach((o) => o()); clearInterval(camTimer); };
}
