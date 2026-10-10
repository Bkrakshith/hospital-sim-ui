// Technician → System: diagnostics (controller, joints/temps, battery, topics, stacks, sim, interlocks),
// mapping (SLAM start/save, maps), logs, audit log, incident bundles, calibration, about + link to /console.
import { store, api, isV2, modeLabel, sourceLabel, device, APP_VERSION } from '../client.js';
import { h, ic, button, holdToConfirm, toast, fmt, clear, sheet } from '../ui.js';
import { icon } from '../icons.js';
import { MapView } from '../mapview.js';
import { calibrate, tracking } from './arms.js';

const S = store.state;
const JOINTS = ['L hip pitch', 'L hip roll', 'L hip yaw', 'L knee', 'L ankle pitch', 'L ankle roll', 'R hip pitch', 'R hip roll', 'R hip yaw', 'R knee', 'R ankle pitch', 'R ankle roll',
  'Waist yaw', 'Waist roll', 'Waist pitch', 'L shoulder pitch', 'L shoulder roll', 'L shoulder yaw', 'L elbow', 'L wrist roll', 'L wrist pitch', 'L wrist yaw',
  'R shoulder pitch', 'R shoulder roll', 'R shoulder yaw', 'R elbow', 'R wrist roll', 'R wrist pitch', 'R wrist yaw'];
const TABS = [['diag', 'Diagnostics', 'gauge'], ['mapping', 'Mapping', 'layers'], ['logs', 'Logs', 'logs'], ['audit', 'Audit', 'shield'], ['incidents', 'Incidents', 'bug'], ['calib', 'Calibration', 'seat'], ['about', 'About', 'info']];
let tab = 'diag';

export function mount(el) {
  const tabs = h('div', { class: 'seg seg-tabs', role: 'tablist', 'aria-label': 'System' });
  const body = h('div', { class: 'sys-body' });
  el.append(h('header', { class: 'screen-head' }, h('div', {}, h('h1', {}, 'System'), h('p', { class: 'muted' }, 'Technician tools. Raw names and values.')),
    h('a', { class: 'btn btn-ghost btn-tech', href: '/console/', target: '_blank', rel: 'noopener' }, ic('external', 20), h('span', { class: 'btn-label' }, 'Engineering console'))), tabs, body);
  let cleanup = null;
  const drawTabs = () => {
    clear(tabs);
    for (const [id, label, ico] of TABS) tabs.append(h('button', { class: `seg-b${tab === id ? ' on' : ''}`, type: 'button', role: 'tab', 'aria-selected': tab === id ? 'true' : 'false', onClick: () => { tab = id; drawTabs(); show(); } }, ic(ico, 20), label));
  };
  const show = () => {
    if (cleanup) cleanup();
    clear(body);
    cleanup = ({ diag, mapping, logs, audit, incidents, calib, about })[tab](body) || null;
  };
  drawTabs(); show();
  return () => { if (cleanup) cleanup(); };
}

const kv = (k, v, cls = '') => [h('dt', {}, k), h('dd', { class: cls }, v === undefined || v === null || v === '' ? '–' : String(v))];

// ------------------------------------------------------------------ diagnostics
function diag(el) {
  const grid = h('div', { class: 'diag-grid' });
  el.append(grid);
  const render = () => {
    const st = S.status || {};
    const c = st.controller || {};
    const mg = st.manager || {};
    const temps = st.temps;
    const b = st.battery;
    clear(grid);
    const card = (title, ico, ...kids) => h('section', { class: 'card dcard' }, h('h2', { class: 'st-h' }, ic(ico, 22), title), ...kids);
    grid.append(
      card('Mode manager', 'status', h('dl', { class: 'kv mono' }, ...kv('mode', S.mode ? `${S.mode.name} (${S.mode.mode})` : null), ...kv('source', S.mode && S.mode.source), ...kv('label', modeLabel(S.mode && S.mode.name)), ...kv('detail', S.mode && S.mode.detail),
        ...kv('last key', mg.last_key), ...kv('cmd_vel', mg.cmd_vel ? (Array.isArray(mg.cmd_vel) ? mg.cmd_vel.map((x) => fmt.num(x, 2)).join(' ') : JSON.stringify(mg.cmd_vel)) : null), ...kv('message', mg.last_message),
        ...kv('hold', S.hold ? `${S.hold.source || ''} ${S.hold.held_from ? 'from ' + S.hold.held_from : ''}` : 'no'))),
      card('Controller', 'gauge', h('dl', { class: 'kv mono' }, ...kv('policy', c.policy || c.policy_name), ...kv('placeholder', c.placeholder !== undefined ? String(c.placeholder) : null, c.placeholder ? 'warn' : ''),
        ...kv('fall', c.fall !== undefined ? String(c.fall) : c.fall_detected !== undefined ? String(c.fall_detected) : null, c.fall || c.fall_detected ? 'bad' : ''), ...kv('loop Hz', c.loop_hz !== undefined ? fmt.num(c.loop_hz, 1) : c.hz !== undefined ? fmt.num(c.hz, 1) : null),
        ...Object.entries(c).filter(([k]) => !['policy', 'policy_name', 'placeholder', 'fall', 'fall_detected', 'loop_hz', 'hz'].includes(k)).slice(0, 6).flatMap(([k, v]) => kv(k, typeof v === 'object' ? JSON.stringify(v) : v)))),
      card('Interlocks', 'lock', S.motion ? h('dl', { class: 'kv mono' }, ...kv('locked', String(S.motion.locked), S.motion.locked ? 'warn' : ''), ...kv('reasons', (S.motion.reasons || []).join('; ')),
        ...kv('e-stop ok', S.motion.estop ? String(S.motion.estop.ok) : null), ...kv('e-stop pressed', S.motion.estop ? String(S.motion.estop.pressed) : null), ...kv('e-stop age s', S.motion.estop ? fmt.num(S.motion.estop.age, 2) : null),
        ...kv('dev override', S.motion.estop ? String(!!S.motion.estop.dev_override) : null, S.motion.estop && S.motion.estop.dev_override ? 'warn' : ''), ...kv('zone', S.motion.zone ? `${S.motion.zone.name} ${S.motion.zone.cap} m/s` : 'none'), ...kv('lease', S.lease.holder ? `${S.lease.holder.device_name} ${S.lease.holder.user || ''}` : 'free'))
        : h('p', { class: 'muted' }, 'No interlock data yet.')),
      card('Battery', 'battery', b ? h('dl', { class: 'kv mono' }, ...kv('soc %', fmt.num(b.soc, 0)), ...kv('voltage V', fmt.num(b.voltage, 2)), ...kv('current A', fmt.num(b.current, 2)), ...kv('source', b.source)) : h('p', { class: 'muted' }, 'Not published (/battery_state or /lf/bmsstate).')),
      card('Stacks', 'layers', h('dl', { class: 'kv mono' }, ...Object.entries(st.stacks || {}).flatMap(([k, v]) => kv(k, `${v.state}${v.pid ? ' pid ' + v.pid : ''}${v.exit_code !== undefined && v.exit_code !== null ? ' exit ' + v.exit_code : ''}`, v.state === 'failed' ? 'bad' : '')),
        ...kv('active map', st.active_map), ...kv('nav', st.nav ? `${st.nav.state}${st.nav.server_ready ? '' : ' (server not ready)'}` : null), ...kv('amcl σ m', st.amcl ? fmt.num(st.amcl.std_xy, 2) : null))),
      card('Simulation', 'sim', st.sim ? h('dl', { class: 'kv mono' }, ...Object.entries(st.sim).slice(0, 8).flatMap(([k, v]) => kv(k, typeof v === 'number' ? fmt.num(v, 2) : typeof v === 'object' ? JSON.stringify(v) : v))) : h('p', { class: 'muted' }, S.hello && S.hello.mock ? 'Mock robot (no /sim/status).' : 'No /sim/status (real robot or sim not running).')),
      card('Topics', 'signal', h('table', { class: 'tbl mono' }, h('thead', {}, h('tr', {}, h('th', {}, 'topic'), h('th', {}, 'age s'), h('th', {}, ''))),
        h('tbody', {}, Object.entries(st.topics || {}).sort().map(([t, age]) => { const lvl = age === null || age === undefined ? 'unk' : age < 1.5 ? 'ok' : age < 5 ? 'warn' : 'bad'; return h('tr', { class: `lvl-${lvl}` }, h('td', {}, t), h('td', { class: 'num' }, age === null || age === undefined ? 'never' : fmt.num(age, 1)), h('td', {}, h('span', { class: `dot dot-${lvl}`, 'aria-label': lvl }), ({ ok: 'ok', warn: 'slow', bad: 'stale', unk: 'none' })[lvl])); })))),
      card('Joints', 'arm', temps && temps.joints ? h('div', {}, h('p', { class: 'mono' }, `hottest: ${temps.hottest} ${fmt.num(temps.max, 0)} °C`),
        h('table', { class: 'tbl mono joints' }, h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'joint'), h('th', {}, '°C'))), h('tbody', {}, temps.joints.map((t, i) => h('tr', { class: t > 70 ? 'lvl-bad' : t > 55 ? 'lvl-warn' : '' }, h('td', { class: 'num' }, i), h('td', {}, JOINTS[i] || i), h('td', { class: 'num' }, fmt.num(t, 0)))))))
        : h('p', { class: 'muted' }, 'No motor temperatures (/lowstate absent or all zero; the MuJoCo sim does not model them).')),
      card('Devices', 'people', h('dl', { class: 'kv mono' }, ...Object.entries(S.devices || {}).flatMap(([id, d]) => kv(d.name || id, `${d.role || ''} ${d.user || ''} ${d.connected ? 'online' : 'offline'}`)), ...kv('this iPad', `${device.name} ${device.id}`))),
    );
    grid.append(h('div', { class: 'row gap' }, button('Copy for incident', { size: 'tech', icon: 'logs', onClick: async () => {
      const txt = JSON.stringify({ t: new Date().toISOString(), mode: S.mode, hold: S.hold, lease: S.lease, motion: S.motion, controller: st.controller, manager: st.manager, stacks: st.stacks, nav: st.nav, topics: st.topics, pose: S.pose, alarms: S.alarms.active }, null, 1);
      try { await navigator.clipboard.writeText(txt); toast('Copied', { level: 'ok' }); } catch { toast('Copy is not available here', { level: 'warn' }); }
    } })));
  };
  render();
  let last = 0;
  const off = store.on('state', () => { if (Date.now() - last > 1000) { last = Date.now(); render(); } });
  return off;
}

// ------------------------------------------------------------------ mapping
function mapping(el) {
  const box = h('div', { class: 'map-box map-box-tech' });
  const side = h('aside', { class: 'map-side' });
  el.append(h('div', { class: 'map-layout' }, h('div', { class: 'map-wrap' }, box), side));
  const mv = new MapView(box, { trail: true });
  const name = h('input', { class: 'input', id: 'map-name', value: `wing_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`, 'aria-label': 'Map name' });
  const list = h('div', { class: 'maps-list' });
  const loadMaps = async () => {
    const r = await api.mapsList();
    clear(list);
    const maps = r.ok && r.data ? r.data.maps || [] : [];
    if (!maps.length) list.append(h('p', { class: 'muted' }, r.ok ? 'No saved maps.' : r.message));
    for (const m of maps) {
      list.append(h('div', { class: 'map-row' }, h('div', {}, h('div', { class: 'mr-n' }, m.name, m.ground_truth ? h('span', { class: 'pill pill-unk' }, 'ground truth') : null), h('div', { class: 'muted mono' }, `${m.width}×${m.height} · ${m.resolution} m`)),
        h('div', { class: 'row gap' }, button('Load', { size: 'tech', onClick: async () => { const x = await api.mapLoad(m.name); toast(x.ok ? `Loading ${m.name}` : x.message, { level: x.ok ? 'ok' : 'warn' }); } }),
          holdToConfirm([h('span', { class: 'hold-word' }, 'Delete')], async () => { const x = await api.mapDelete(m.name); toast(x.ok ? 'Deleted' : x.message, { level: x.ok ? 'ok' : 'warn' }); loadMaps(); }, { cls: 'hold-inline', aria: `Delete map ${m.name}: press and hold` }))));
    }
  };
  const render = () => {
    const st = S.status || {};
    const slam = st.stacks && st.stacks.slam ? st.stacks.slam.state : 'unknown';
    const nav = st.stacks && st.stacks.nav ? st.stacks.nav.state : 'unknown';
    clear(side);
    side.append(
      h('section', { class: 'card' }, h('h2', { class: 'sec-t' }, 'SLAM mapping'), h('p', { class: 'mono' }, `slam: ${slam} · nav: ${nav}`),
        h('div', { class: 'row gap wrap' },
          ['running', 'starting', 'external'].includes(slam) ? button('Stop SLAM', { size: 'tech', icon: 'x', onClick: async () => { const r = await api.stackStop('slam'); toast(r.ok ? 'Stopping SLAM' : r.message); } })
            : button('Start SLAM', { size: 'tech', kind: 'primary', icon: 'play', onClick: async () => { const r = await api.stackStart('slam'); toast(r.ok ? 'Starting SLAM' : r.message); } }),
          ['running', 'starting', 'external'].includes(nav) ? button('Stop navigation', { size: 'tech', onClick: () => api.stackStop('nav') }) : null),
        h('p', { class: 'muted small-note' }, 'Drive the robot around (Walk) while SLAM runs. Do not edit the live map during navigation.'),
        h('label', { class: 'field' }, h('span', { class: 'field-k' }, 'Save as'), name),
        button('Save map', { size: 'tech', icon: 'check', onClick: async () => { const r = await api.mapSave(name.value.trim()); toast(r.ok ? 'Map saved' : r.message, { level: r.ok ? 'ok' : 'warn' }); loadMaps(); } })),
      h('section', { class: 'card' }, h('h2', { class: 'sec-t' }, 'Saved maps'), list));
  };
  render(); loadMaps();
  let k = '';
  const off = store.on('state', () => { const st = S.status || {}; const nk = JSON.stringify(st.stacks); if (nk !== k) { k = nk; render(); } });
  return () => { off(); mv.destroy(); };
}

// ------------------------------------------------------------------ logs
function logs(el) {
  let level = 'info', q = '';
  const bar = h('div', { class: 'row gap wrap log-bar' });
  const out = h('div', { class: 'log-out mono', role: 'log', 'aria-live': 'off' });
  el.append(bar, out);
  const LV = { debug: 0, info: 1, warn: 2, error: 3 };
  const drawBar = () => {
    clear(bar);
    bar.append(h('div', { class: 'seg' }, ...['debug', 'info', 'warn', 'error'].map((l) => h('button', { class: `seg-b${level === l ? ' on' : ''}`, type: 'button', onClick: () => { level = l; drawBar(); render(); } }, l))),
      h('input', { class: 'input', type: 'search', placeholder: 'Search', value: q, 'aria-label': 'Search logs', onInput: (e) => { q = e.target.value.toLowerCase(); render(); } }));
  };
  const render = () => {
    const list = S.logs.filter((l) => (LV[l.level] ?? 1) >= LV[level] && (!q || `${l.src} ${l.msg}`.toLowerCase().includes(q))).slice(-400);
    clear(out);
    for (const l of list) out.append(h('div', { class: `log-l lv-${l.level}` }, h('span', { class: 'log-t' }, fmt.timeS(l.t)), h('span', { class: 'log-lv' }, l.level), h('span', { class: 'log-src' }, l.src), h('span', { class: 'log-m' }, l.msg)));
    if (!list.length) out.append(h('p', { class: 'muted' }, 'No log lines match.'));
    out.scrollTop = out.scrollHeight;
  };
  drawBar(); render();
  let t = 0;
  const off = store.on('log', () => { clearTimeout(t); t = setTimeout(render, 300); });
  return () => { off(); clearTimeout(t); };
}

// ------------------------------------------------------------------ audit
function audit(el) {
  const out = h('div', { class: 'audit' });
  el.append(h('div', { class: 'row gap' }, button('Refresh', { size: 'tech', icon: 'refresh', onClick: () => load() }), button('Verify chain', { size: 'tech', icon: 'shield', onClick: async () => { const r = await api.auditVerify(); toast(r.ok ? `Audit log intact${r.data && r.data.count ? ` (${r.data.count} entries)` : ''}` : r.message, { level: r.ok ? 'ok' : 'warn' }); } })), out);
  const load = async () => {
    const r = await api.auditList(200);
    clear(out);
    if (!r.ok) { out.append(h('p', { class: 'note note-warn' }, ic('lock', 22), r.message)); return; }
    const rows = (r.data && (r.data.entries || r.data.items)) || [];
    if (!rows.length) { out.append(h('p', { class: 'muted' }, 'No entries.')); return; }
    out.append(h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl mono' }, h('thead', {}, h('tr', {}, ['time', 'user', 'role', 'device', 'op', 'args', 'result'].map((x) => h('th', {}, x)))),
      h('tbody', {}, rows.map((e) => h('tr', { class: e.ok === false ? 'lvl-warn' : '' }, h('td', {}, fmt.timeS(e.t)), h('td', {}, e.user || '–'), h('td', {}, e.role || '–'), h('td', {}, e.device_name || e.device || '–'), h('td', {}, e.op), h('td', { class: 'wrap' }, e.args ? JSON.stringify(e.args).slice(0, 80) : ''), h('td', {}, e.ok === false ? `refused: ${e.message || ''}` : 'ok')))))));
  };
  load();
  return null;
}

// ------------------------------------------------------------------ incidents
function incidents(el) {
  const out = h('div', { class: 'incidents' });
  el.append(out);
  const load = async () => {
    const r = await api.incidentsList();
    clear(out);
    if (!r.ok) { out.append(h('p', { class: 'note note-warn' }, ic('lock', 22), r.message)); return; }
    const list = (r.data && r.data.incidents) || [];
    if (!list.length) { out.append(h('div', { class: 'empty' }, ic('checkCircle', 40), h('div', { class: 'empty-t' }, 'No incidents'), h('div', { class: 'empty-s' }, 'Problems sent from any iPad appear here with their data bundle.'))); return; }
    for (const i of list.slice().reverse()) {
      out.append(h('button', { class: 'inc-row', type: 'button', onClick: () => open(i.id) }, ic('bug', 24), h('span', { class: 'inc-id mono' }, i.id), h('span', {}, (i.chips || []).join(', ') || 'no tags'), h('span', { class: 'muted' }, `${i.t ? fmt.time(i.t) : ''} · ${i.by || ''} · ${i.device || i.device_name || ''}`), ic('chevron', 20)));
    }
  };
  const open = async (id) => {
    const r = await api.incidentGet(id);
    const d = r.data || {};
    const body = h('div', { class: 'inc-detail' },
      h('dl', { class: 'kv mono' }, ...kv('id', id), ...kv('time', d.t ? fmt.timeS(d.t) : null), ...kv('by', d.by), ...kv('device', d.device || d.device_name), ...kv('tags', (d.chips || []).join(', ')), ...kv('note', d.note), ...kv('mode', d.mode ? `${d.mode.name} (${d.mode.source})` : null)),
      d.timeline ? h('ul', { class: 'tl-list' }, d.timeline.slice(-20).map((e) => h('li', {}, h('span', { class: 'tl-t' }, fmt.timeS(e.t)), h('span', {}, e.text)))) : null,
      button('Download bundle (.zip)', { size: 'tech', icon: 'logs', onClick: async () => {
        // one-time link, valid 60 s: no session token in the URL
        const r = await api.incidentLink(id);
        if (!r.ok || !r.data || !r.data.url) { toast(r.message || 'Could not make a download link', { level: 'warn' }); return; }
        const a = h('a', { href: r.data.url, download: `${id}.zip` }); document.body.append(a); a.click(); a.remove();
        toast(`Downloading ${id} (link valid ${r.data.expires_in || 60} s, once)`, { level: 'ok' });
      } }));
    sheet(body, { title: `Incident ${id}`, wide: true });
  };
  load();
  return null;
}

// ------------------------------------------------------------------ calibration
function calib(el) {
  const out = h('div', { class: 'card' });
  el.append(out);
  const render = () => {
    const tr = tracking();
    clear(out);
    out.append(h('h2', { class: 'sec-t' }, 'Operator camera (teleop)'),
      h('dl', { class: 'kv mono' }, ...kv('calibrated', tr ? String(tr.calibrated) : null), ...kv('framing', tr && tr.framing), ...kv('fps', tr && fmt.num(tr.fps, 1)), ...kv('latency ms', tr && tr.latency), ...kv('hands', tr ? `${tr.left.visible ? 'L' : '-'} ${tr.right.visible ? 'R' : '-'}` : null), ...kv('message', tr && tr.message)),
      h('div', { class: 'row gap wrap' }, button('Calibrate (seated)…', { size: 'tech', kind: 'primary', icon: 'seat', onClick: calibrate }), button('Re-centre (h)', { size: 'tech', onClick: () => api.key('h') }), button('Auto-framing (f)', { size: 'tech', onClick: () => api.key('f') }),
        holdToConfirm([h('span', { class: 'hold-word' }, 'Clear calibration (u)')], () => { api.key('u'); toast('Calibration cleared'); }, { cls: 'hold-inline', aria: 'Clear calibration: press and hold' })),
      h('p', { class: 'muted small-note' }, 'Robot joint calibration and zone speed limits are not editable here (two-person rule, not built yet).'));
  };
  render();
  let last = 0;
  return store.on('state', () => { if (Date.now() - last > 1000) { last = Date.now(); render(); } });
}

// ------------------------------------------------------------------ about
function about(el) {
  const h0 = S.hello || {};
  el.append(h('section', { class: 'card' }, h('h2', { class: 'sec-t' }, 'Versions'),
    h('dl', { class: 'kv mono' }, ...kv('app', `g1-ipad ${APP_VERSION}`), ...kv('protocol', `${h0.protocol || '?'}`), ...kv('server mock', String(!!h0.mock)), ...kv('sim time', String(!!h0.use_sim_time)),
      ...kv('nav2', String(h0.nav2)), ...kv('g1_interfaces', String(h0.g1_interfaces)), ...kv('versions', h0.versions ? JSON.stringify(h0.versions) : null), ...kv('device', `${device.name} · ${device.id}`), ...kv('user agent', navigator.userAgent))),
    h('section', { class: 'card' }, h('h2', { class: 'sec-t' }, 'Third-party code (SOUP)'), h('p', {}, 'None. The app is plain HTML, CSS and JavaScript with no libraries, no web fonts and no CDN. Icons are drawn for this app.')),
    h('section', { class: 'card' }, h('h2', { class: 'sec-t' }, 'Limits'), h('ul', { class: 'plain-list' },
      h('li', {}, 'The iPad is not an emergency stop. A hardware latching e-stop must be within reach.'),
      h('li', {}, 'No patient data is shown, stored or sent by this app.'),
      h('li', {}, 'Cameras are live only. Nothing is recorded by the app.'))));
  return null;
}
