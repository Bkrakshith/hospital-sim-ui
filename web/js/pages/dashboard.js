// Dashboard: robot status at a glance.
import { robot, MODE_DESC } from '../robot.js';
import { h, fmt, stackTag } from '../ui.js';
import { MapView } from '../mapview.js';
import { syncCamera } from '../ui.js';
import { pressModeKey, MODE_KEYS, LEGAL } from '../teleop.js';

const KEY_TOPICS = [
  ['/g1/mode', 'Mode manager'], ['/g1/controller/status', 'Controller'], ['/odom', 'Odometry'],
  ['/scan', 'Laser scan'], ['/map', 'Map'], ['camera', 'Teleop camera'], ['/g1/teleop/tracking_status', 'Hand tracking'],
  ['/lowstate', 'Low state'], ['/battery_state', 'Battery'],
];

export function mount(root) {
  const modeBig = h('div', { class: 'mode-badge', style: { fontSize: '18px', padding: '8px 18px' } }, '—');
  const modeInfo = h('div', { class: 'muted small' });
  const modeBtns = h('div', { class: 'row' });
  const ctrlKv = h('dl', { class: 'kv' });
  const motionKv = h('dl', { class: 'kv' });
  const powerKv = h('dl', { class: 'kv' });
  const stacksBox = h('div', { class: 'stack' });
  const topicsTbl = h('table', { class: 'topics' });
  const logBox = h('div', { class: 'mini-log' });
  const mapWrap = h('div', { class: 'map-wrap' });
  const mapEmpty = h('div', { class: 'map-empty' }, 'No map yet — start SLAM on the Mapping page or load a map on Navigation.');
  mapWrap.append(mapEmpty);
  const camImg = h('img', { alt: 'teleop camera' });
  const camBox = h('div', { class: 'camera-box nocam' }, camImg,
    h('div', { class: 'ph' }, 'No camera frames (/g1/teleop/camera/annotated/compressed)'));

  const page = h('div', { class: 'page grid-dash' },
    h('section', { class: 'card span-4' },
      h('div', { class: 'card-h' }, h('h2', {}, 'Mode'), h('a', { href: '#/teleop', class: 'small' }, 'Teleoperation →')),
      h('div', { class: 'stack' }, modeBig, modeInfo, modeBtns)),
    h('section', { class: 'card span-4' },
      h('div', { class: 'card-h' }, h('h2', {}, 'Controller'), h('span', { class: 'sub' }, '/g1/controller/status')), ctrlKv),
    h('section', { class: 'card span-4' },
      h('div', { class: 'card-h' }, h('h2', {}, 'Motion & power')), motionKv, h('div', { class: 'divider' }), powerKv),
    h('section', { class: 'card span-8 map-card', style: { height: '430px' } },
      h('div', { class: 'card-h', style: { padding: '12px 14px 0' } }, h('h2', {}, 'Live map'),
        h('a', { href: '#/navigation', class: 'small' }, 'Navigation →')), mapWrap),
    h('section', { class: 'card span-4' },
      h('div', { class: 'card-h' }, h('h2', {}, 'Teleop camera'), h('span', { class: 'sub', id: 'd-camfps' }, '')), camBox,
      h('div', { class: 'divider', style: { margin: '12px 0' } }),
      h('div', { class: 'card-h' }, h('h2', {}, 'Stacks')), stacksBox),
    h('section', { class: 'card span-6' },
      h('div', { class: 'card-h' }, h('h2', {}, 'Data links'), h('span', { class: 'sub' }, 'time since last message')), topicsTbl),
    h('section', { class: 'card span-6' },
      h('div', { class: 'card-h' }, h('h2', {}, 'Recent events'), h('a', { href: '#/logs', class: 'small' }, 'All logs →')), logBox),
  );
  root.append(page);
  const mv = new MapView(mapWrap, { interactive: true });
  mv.follow = false;

  function renderMode() {
    const m = robot.state.mode;
    modeBig.dataset.mode = m ? m.name : 'none';
    modeBig.textContent = m ? m.name : 'NO MODE';
    modeInfo.textContent = m ? `${MODE_DESC[m.name] || ''} · requested by ${m.source || '?'}${m.detail ? ' · ' + m.detail : ''}`
      : 'No /g1/mode received yet — is g1_teleop_manager running?';
    modeBtns.innerHTML = '';
    const cur = m ? m.name : null;
    for (const k of ['r', 'l', 'p', 'm', 'n', 'g']) {
      const s = MODE_KEYS[k];
      const allowed = cur && (s.from ? s.from.includes(cur) : (LEGAL[cur] || []).includes(s.target));
      modeBtns.append(h('button', { class: 'btn sm', disabled: !allowed, title: `${s.sub} (key ${k})`, onclick: () => pressModeKey(k) },
        h('kbd', {}, k), s.label));
    }
  }

  function kv(dl, rows) {
    dl.innerHTML = '';
    for (const [k, v, cls] of rows) dl.append(h('dt', {}, k), h('dd', { class: cls || '' }, v));
  }

  function renderState(st) {
    const c = st.controller || {};
    const rows = [];
    if (!st.controller) rows.push(['Status', h('span', { class: 'tag warn' }, 'no data')]);
    else {
      rows.push(['Policy', c.policy || c.name || c.policy_name || '—']);
      if ('placeholder' in c) rows.push(['Placeholder policy', c.placeholder ? h('span', { class: 'tag warn' }, 'yes') : h('span', { class: 'tag ok' }, 'no')]);
      if ('fall_detected' in c || 'fall' in c) {
        const f = c.fall_detected ?? c.fall;
        rows.push(['Fall detected', f ? h('span', { class: 'tag err' }, 'FALL') : h('span', { class: 'tag ok' }, 'no')]);
      }
      if ('loop_hz' in c) rows.push(['Loop rate', `${fmt.num(c.loop_hz, 1)} Hz`]);
      for (const [k, v] of Object.entries(c)) {
        if (['policy', 'name', 'policy_name', 'placeholder', 'fall_detected', 'fall', 'loop_hz'].includes(k)) continue;
        if (typeof v === 'object') continue;
        rows.push([k.replace(/_/g, ' '), String(v)]);
      }
    }
    kv(ctrlKv, rows.slice(0, 9));
    const p = robot.state.pose;
    kv(motionKv, [
      ['Position', p ? `${fmt.num(p.x)}, ${fmt.num(p.y)} m (${p.frame})` : '—'],
      ['Heading', p ? fmt.deg(p.yaw) : '—'],
      ['Speed vx / vy', p && p.vx !== undefined ? `${fmt.num(p.vx)} / ${fmt.num(p.vy)} m/s` : '—'],
      ['Turn rate', p && p.wz !== undefined ? `${fmt.num(p.wz)} rad/s` : '—'],
    ]);
    const b = st.battery, t = st.temps;
    kv(powerKv, [
      ['Battery', b ? `${b.soc !== null && b.soc !== undefined ? Math.round(b.soc) + '%' : '--'}${b.voltage ? ' · ' + fmt.num(b.voltage, 1) + ' V' : ''}` : h('span', { class: 'muted' }, 'n/a')],
      ['Hottest joint', t ? `${t.max} °C (${t.hottest.replace(/_/g, ' ')})` : h('span', { class: 'muted' }, 'n/a (needs /lowstate)')],
    ]);
    // stacks
    stacksBox.innerHTML = '';
    const ss = st.stacks;
    const line = (name, label, extra) => h('div', { class: 'row between' },
      h('div', {}, h('strong', {}, label), extra ? h('span', { class: 'muted small' }, ' · ' + extra) : null), stackTag(ss[name].state));
    stacksBox.append(
      line('slam', 'SLAM (slam_toolbox)'),
      line('nav', 'Navigation (Nav2)', ss.nav.args && ss.nav.args.map ? `map ${ss.nav.args.map}` : ss.nav.args && ss.nav.args.localization === 'slam' ? 'on SLAM map' : ''),
    );
    if (ss.mock.state !== 'stopped') stacksBox.append(line('mock', 'Mock robot'));
    // topics
    topicsTbl.innerHTML = '';
    for (const [t, label] of KEY_TOPICS) {
      const age = st.topics[t];
      // /g1/mode and /map are latched (published on change): any message means the link is up
      const latched = t === '/g1/mode' || t === '/map';
      const cls = age === undefined ? '' : latched || age < 2 ? 'ok' : age < 10 ? 'warn' : 'err';
      topicsTbl.append(h('tr', {}, h('td', {}, h('span', { class: `status-dot ${cls}` }), label, ' ', h('span', { class: 'muted mono' }, t)),
        h('td', {}, age === undefined ? h('span', { class: 'muted' }, 'never') : latched ? `latched · ${fmt.age(age)}` : fmt.age(age))));
    }
    const fps = document.getElementById('d-camfps');
    if (fps) fps.textContent = st.camera && st.camera.fps ? `${fmt.num(st.camera.fps, 0)} fps` : 'no frames';
    syncCamera(camImg, camBox, st);
    renderMode();
  }

  function renderLogs() {
    logBox.innerHTML = '';
    const important = robot.state.logs.filter((l) => l.level !== 'debug').slice(-40).reverse();
    for (const l of important) {
      logBox.append(h('div', { class: l.level }, `${fmt.time(l.t)}  [${l.src}] ${l.msg}`));
    }
    if (!important.length) logBox.append(h('div', { class: 'muted' }, 'No events yet.'));
  }

  const unsubs = [
    robot.on('state', renderState),
    robot.on('mode', renderMode),
    robot.on('log', renderLogs), robot.on('logs', renderLogs),
    robot.on('map', () => { mapEmpty.hidden = true; }),
  ];
  mapEmpty.hidden = !!robot.state.map;
  renderMode();
  renderLogs();
  if (robot.state.status) renderState(robot.state.status);
  return () => { unsubs.forEach((u) => u()); mv.destroy(); camImg.removeAttribute('src'); };
}
