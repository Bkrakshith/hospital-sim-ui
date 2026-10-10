// App shell: router, top bar (connection, mode badge, battery, e-stop), theme, toasts.
import { robot } from './robot.js';
import { h, toast, fmt } from './ui.js';
import { estop, keyboard } from './teleop.js';
import * as dashboard from './pages/dashboard.js';
import * as mapping from './pages/mapping.js';
import * as navigation from './pages/navigation.js';
import * as teleop from './pages/teleop.js';
import * as mission from './pages/mission.js';
import * as logs from './pages/logs.js';

const PAGES = { dashboard, mapping, navigation, teleop, mission, logs };
const TITLES = { dashboard: 'Dashboard', mapping: 'Mapping', navigation: 'Navigation', teleop: 'Teleoperation', mission: 'Mission', logs: 'Logs' };
let current = null;
let cleanup = null;

function route() {
  const name = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('?')[0];
  const page = PAGES[name] ? name : 'dashboard';
  if (page === current) return;
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } }
  keyboard.disable();
  current = page;
  document.querySelectorAll('.sidebar a').forEach((a) => a.classList.toggle('active', a.dataset.page === page));
  document.getElementById('page-title').textContent = TITLES[page];
  const main = document.getElementById('main');
  main.innerHTML = '';
  main.scrollTop = 0;
  cleanup = PAGES[page].mount(main) || null;
}

// ------------------------------------------------------------------ top bar
function updateMode() {
  const b = document.getElementById('mode-badge');
  const m = robot.state.mode;
  if (!m) { b.dataset.mode = 'none'; b.textContent = 'NO MODE'; b.title = 'No /g1/mode received (is the mode manager running?)'; return; }
  b.dataset.mode = m.name;
  b.textContent = m.name;
  b.title = `${m.name} — source: ${m.source || '-'}${m.detail ? ' — ' + m.detail : ''}`;
}

function updateStatus(st) {
  const batt = document.getElementById('batt-pill');
  const bt = st.battery;
  batt.querySelector('.txt').textContent = bt && bt.soc !== null && bt.soc !== undefined ? `${Math.round(bt.soc)}%` : '--';
  batt.classList.toggle('warn', !!(bt && bt.soc !== null && bt.soc < 20));
  const nav = st.nav || {};
  const np = document.getElementById('nav-pill');
  const active = ['active', 'sending', 'paused', 'canceling'].includes(nav.state);
  np.hidden = !active;
  if (active) {
    const fb = nav.feedback || {};
    np.textContent = nav.state === 'paused' ? 'Navigation paused'
      : `Navigating${fb.distance_remaining !== undefined ? ` · ${fmt.num(fb.distance_remaining, 1)} m left` : ''}`;
  }
  const foot = document.getElementById('sidebar-foot');
  const slam = st.stacks.slam.state, navs = st.stacks.nav.state;
  foot.innerHTML = '';
  foot.append(
    h('div', {}, h('span', {}, 'SLAM'), h('span', {}, slam)),
    h('div', {}, h('span', {}, 'Nav2'), h('span', {}, navs)),
    h('div', {}, h('span', {}, 'Map'), h('span', {}, st.active_map || (slam === 'running' || slam === 'external' ? 'live SLAM' : '-'))),
  );
}

function setConn(ok) {
  const p = document.getElementById('conn-pill');
  p.classList.toggle('ok', ok);
  p.classList.toggle('err', !ok);
  p.querySelector('.txt').textContent = ok ? 'online' : 'offline';
  document.getElementById('conn-banner').hidden = ok;
}

function initTheme() {
  const btn = document.getElementById('theme-toggle');
  btn.addEventListener('click', () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('g1.theme', root.dataset.theme); } catch (e) { /* private mode */ }
    robot.emit('theme');
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => robot.emit('theme'));
}

function init() {
  initTheme();
  document.getElementById('nav-toggle').addEventListener('click', () => document.getElementById('app').classList.toggle('nav-collapsed'));
  document.getElementById('estop').addEventListener('click', estop);
  // "x" is the e-stop on every page (unless typing in a field)
  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if ((e.key === 'x' || e.key === 'X') && !keyboard.enabled && !e.repeat && !e.ctrlKey && !e.metaKey) estop();
  });
  robot.on('connection', (ok) => {
    setConn(ok);
    if (!ok) keyboard.releaseAll();
  });
  robot.on('hello', (m) => {
    document.getElementById('mock-pill').hidden = !m.mock;
  });
  robot.on('mode', ({ mode, prev }) => {
    updateMode();
    if (prev && prev.mode !== mode.mode) {
      const lvl = mode.name === 'DAMP' ? 'warn' : 'info';
      toast(`Mode: ${prev.name} → ${mode.name}`, `${mode.source || ''}${mode.detail ? ' · ' + mode.detail : ''}`, lvl, 3000);
    }
  });
  robot.on('state', updateStatus);
  robot.on('toast', (t) => toast(t.msg, '', t.level || 'info'));
  window.addEventListener('hashchange', route);
  setConn(false);
  document.getElementById('conn-banner').hidden = true;
  updateMode();
  route();
  robot.connect();
}

init();
