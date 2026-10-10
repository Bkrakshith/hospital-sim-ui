// App entry: router, navigation per role, idle handling (across-room view, role fallback), alarm sounds,
// Wake Lock, clean-screen lock. Screens live in js/screens/*.js and export {mount(el, ctx) -> cleanup}.
import { store, connect, api, device, isV2, addEvent, placeName } from './client.js';
import { h, ic, toast, clear, anySheetOpen, closeAllSheets, fmt } from './ui.js';
import { icon } from './icons.js';
import { sound, wake, speech } from './platform.js';
import { derive } from './status.js';
import {
  shell, renderSafety, updateSafety, renderStatusbar, updateStatusbar, updateRibbon, updateBanners, across, wirePending,
} from './shell.js';
import * as home from './screens/home.js';
import * as places from './screens/places.js';
import * as instruments from './screens/instruments.js';
import * as checks from './screens/checks.js';
import * as status from './screens/status.js';
import * as map from './screens/map.js';
import * as drive from './screens/drive.js';
import * as arms from './screens/arms.js';
import * as missions from './screens/missions.js';
import * as system from './screens/system.js';
import * as teach from './screens/teach.js';

const S = store.state;
const RANK = { clinical: 0, operator: 1, technician: 2 };
const SCREENS = {
  home: { title: 'Home', icon: 'home', mod: home, min: 'clinical' },
  places: { title: 'Send to', icon: 'pin', mod: places, min: 'clinical' },
  instruments: { title: 'Instruments', icon: 'handover', mod: instruments, min: 'clinical' },
  checks: { title: 'Checks', icon: 'checks', mod: checks, min: 'clinical' },
  status: { title: 'Status', icon: 'status', mod: status, min: 'clinical' },
  map: { title: 'Map', icon: 'map', mod: map, min: 'operator' },
  drive: { title: 'Walk', icon: 'joystick', mod: drive, min: 'operator', noAcross: true },
  arms: { title: 'Arms', icon: 'handArm', mod: arms, min: 'operator', noAcross: true },
  missions: { title: 'Missions', icon: 'steps', mod: missions, min: 'operator' },
  system: { title: 'System', icon: 'wrench', mod: system, min: 'technician' },
  teach: { title: 'Teach', icon: 'sparkles', mod: teach, min: 'operator', badge: 'Soon' },
};
const NAV = {
  clinical: ['home', 'places', 'instruments', 'checks', 'status'],
  operator: ['home', 'map', 'drive', 'arms', 'missions', 'teach'],
  technician: ['home', 'map', 'drive', 'arms', 'missions', 'system', 'teach'],
};
const IDLE_ACROSS_S = 20;
const ROLE_IDLE_S = { operator: 600, technician: 300 };

let current = null, cleanup = null;
let lastTouch = Date.now();
let swallowUntil = 0;

export function go(name) { location.hash = `#/${name}`; }
const role = () => S.session.role || 'clinical';
const allowed = (name) => SCREENS[name] && RANK[role()] >= RANK[SCREENS[name].min];

// ------------------------------------------------------------------ nav
function renderNav() {
  const el = document.getElementById('navrail');
  clear(el);
  const items = NAV[role()] || NAV.clinical;
  el.append(h('div', { class: 'brand', 'aria-hidden': 'true' }, h('span', { class: 'brand-mark', html: icon('robot', 30) })));
  const list = h('div', { class: 'nav-items', role: 'list' });
  for (const n of items) {
    const s = SCREENS[n];
    list.append(h('a', { class: 'nav-item', href: `#/${n}`, role: 'listitem', dataset: { screen: n }, 'aria-label': s.title + (s.badge ? ' (coming soon)' : '') },
      h('span', { class: 'nav-ic', html: icon(s.icon, 28) }), h('span', { class: 'nav-t' }, s.title), s.badge ? h('span', { class: 'nav-badge' }, s.badge) : null));
  }
  el.append(list);
  markNav();
}
function markNav() {
  document.querySelectorAll('.nav-item').forEach((a) => {
    const on = a.dataset.screen === current;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}

// ------------------------------------------------------------------ router
function route() {
  const name = (location.hash.replace(/^#\/?/, '') || 'home').split('?')[0].split('/')[0];
  if (!allowed(name)) {
    if (SCREENS[name] && name !== 'home') toast(`${SCREENS[name].title} needs ${SCREENS[name].min} sign-in`, { level: 'info', icon: 'lock' });
    if (location.hash !== '#/home') { history.replaceState(null, '', '#/home'); }
    mount('home');
    return;
  }
  mount(name);
}
function mount(name) {
  if (name === current && cleanup !== null) { markNav(); return; }
  const sr = document.getElementById('stop-reason'); if (sr) sr.remove();   // the optional 'why' panel does not follow you
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } }
  current = name;
  const app = document.getElementById('app');
  app.dataset.screen = name;
  const main = document.getElementById('main');
  clear(main);
  main.scrollTop = 0;
  const wrap = h('div', { class: `screen screen-${name}` });
  main.append(wrap);
  requestAnimationFrame(() => wrap.classList.add('in'));
  try { cleanup = SCREENS[name].mod.mount(wrap, { go }) || (() => {}); } catch (e) { console.error(e); cleanup = () => {}; wrap.append(h('div', { class: 'empty' }, 'This screen failed to load. ', String(e.message || e))); }
  markNav();
  document.title = `${SCREENS[name].title} · G1 Theatre`;
}

// ------------------------------------------------------------------ idle: across-room view + role fallback
function onUserActivity(e) {
  lastTouch = Date.now();
  if (shell.idleWarn) { shell.idleWarn = 0; updateBanners(); }
  if (e && e.type === 'pointerdown') sound.unlock();
}
function initIdle() {
  ['pointerdown', 'keydown', 'wheel'].forEach((ev) => window.addEventListener(ev, onUserActivity, { capture: true, passive: true }));
  const ac = document.getElementById('across');
  // the first tap only wakes the screen (HF-21): swallow this pointer sequence
  ac.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); swallowUntil = Date.now() + 500; across.hide(); });
  window.addEventListener('click', (e) => { if (Date.now() < swallowUntil && !e.target.closest('#safety')) { e.preventDefault(); e.stopPropagation(); } }, { capture: true });
  setInterval(() => {
    const idle = (Date.now() - lastTouch) / 1000;
    const scr = SCREENS[current] || {};
    const blocked = anySheetOpen() || scr.noAcross || document.getElementById('readback') || !document.getElementById('clean-lock').hidden;
    if (!across.shown && idle > IDLE_ACROSS_S && !blocked) across.show();
    else if (across.shown) across.render();
    // role fallback to Clinical (the v2 server also enforces this and pushes `session`)
    const lim = ROLE_IDLE_S[role()];
    if (lim && !(S.lease.you && ['LOCO', 'MANIP'].includes(S.mode && S.mode.name))) {
      const left = Math.round(lim - idle);
      if (left <= 60 && left > 0) { shell.idleWarn = left; updateBanners(); }
      if (left <= 0) {
        shell.idleWarn = 0;
        (async () => { if (S.lease.you) await api.leaseRelease(); await api.logout(); })();
        toast('Signed out after inactivity. Back to Clinical mode.', { level: 'info', icon: 'lock' });
        lastTouch = Date.now();
      }
    }
  }, 1000);
}

// ------------------------------------------------------------------ alarm sounds + wake lock
const soundState = new Map(); // id -> last played
function alarmSounds() {
  const now = Date.now();
  // iPad tones play on the controlling iPad, or on every iPad when nobody holds control (04 §7, A-3)
  const mayPlay = S.lease.you || !S.lease.holder;
  for (const a of S.alarms.active) {
    if (a.acknowledged) continue;
    const last = soundState.get(a.id) || 0;
    const every = a.priority === 'high' ? 10000 : a.priority === 'medium' ? 30000 : Infinity;
    if (!last || now - last > every) {
      soundState.set(a.id, now);
      if (!sound.unlocked) continue;
      if (a.priority === 'high') sound.high();
      else if (mayPlay && a.priority === 'medium') sound.medium();
      else if (mayPlay && !last && a.priority === 'low') sound.low();
    }
  }
}
function updateWake() {
  const m = S.mode && S.mode.name;
  const want = ['LOCO', 'MANIP', 'NAV', 'AUTO'].includes(m) || S.alarms.active.some((a) => !a.acknowledged) || S.lease.you;
  wake.set(want);
}

// ------------------------------------------------------------------ arrival chime
let prevNav = null;
function trackArrivals() {
  const nav = S.status && S.status.nav;
  const st = nav ? nav.state : null;
  if (prevNav && ['active', 'sending'].includes(prevNav) && st === 'succeeded') {
    sound.arrived();
  }
  prevNav = st;
}

// ------------------------------------------------------------------ clean-screen lock (I-2, F7 step 5)
export function startCleanMode(seconds = 30) {
  const el = document.getElementById('clean-lock');
  let left = seconds;
  const t0 = Date.now();
  clear(el);
  const count = h('div', { class: 'cl-count', 'aria-live': 'polite' }, String(left));
  const stopHold = h('button', { class: 'cl-stop', type: 'button', 'aria-label': 'Stop: press and hold for 2 seconds while the screen is locked for cleaning' },
    h('span', { html: icon('stop', 40) }), h('span', { class: 'cl-stop-w' }, 'STOP'), h('span', { class: 'cl-stop-s' }, 'Hold 2 s'));
  let ht = 0;
  stopHold.addEventListener('pointerdown', (e) => { e.preventDefault(); stopHold.classList.add('holding'); ht = setTimeout(() => { stopHold.classList.remove('holding'); api.stop(); toast('Stop sent'); }, 2000); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => stopHold.addEventListener(ev, () => { clearTimeout(ht); stopHold.classList.remove('holding'); }));
  el.append(h('div', { class: 'cl-inner' },
    h('div', { class: 'cl-ic', html: icon('clean', 64) }),
    h('div', { class: 'cl-t' }, 'Screen locked for cleaning'),
    h('div', { class: 'cl-s' }, 'Wipe the screen now. Touches are ignored until the countdown ends.'),
    count,
    h('div', { class: 'cl-s small' }, '70 % isopropyl or approved wipes. No bleach or peroxide.')), stopHold);
  el.hidden = false;
  el.addEventListener('pointerdown', swallow, true);
  function swallow(e) { if (!e.target.closest('.cl-stop')) { e.preventDefault(); e.stopPropagation(); } }
  const iv = setInterval(() => {
    left = Math.max(0, seconds - Math.floor((Date.now() - t0) / 1000));
    count.textContent = String(left);
    if (left <= 0) {
      clearInterval(iv);
      el.hidden = true;
      el.removeEventListener('pointerdown', swallow, true);
      api.checksRecord('clean_ipad', { ipad_screen: true });
      toast('Cleaning logged', { level: 'ok' });
      lastTouch = Date.now();
    }
  }, 250);
}
window.G1 = { startCleanMode };

// ------------------------------------------------------------------ boot
function wire() {
  let stThrottle = 0;
  store.on('state', () => {
    updateSafety(); updateRibbon(); trackArrivals(); updateWake();
    const now = Date.now();
    if (now - stThrottle > 1000) { stThrottle = now; updateStatusbar(); }
  });
  store.on('mode', ({ mode, prev }) => {
    updateRibbon(); updateSafety(); updateWake(); if (across.shown) across.render();
    // HF-20: a mode change this iPad did not ask for gets an audible cue if motion starts
    if (prev && prev.name !== mode.name && ['NAV', 'AUTO', 'LOCO', 'MANIP'].includes(mode.name) && !String(mode.source || '').includes(device.id) && sound.unlocked) sound.low();
  });
  store.on('alarms', () => { updateBanners(); updateSafety(); updateRibbon(); alarmSounds(); updateWake(); if (across.shown) across.render(); });
  store.on('lease', () => { updateSafety(); updateRibbon(); updateWake(); });
  store.on('session', ({ session, prev }) => {
    renderNav(); renderStatusbar();
    if (prev && prev.role !== session.role) {
      document.getElementById('app').dataset.role = session.role;
      if (!allowed(current)) go('home'); else { const c = current; current = null; mount(c); }
    }
  });
  store.on('connection', (okc) => { updateBanners(); updateSafety(); updateRibbon(); updateStatusbar(); if (okc) toast('Connected to the robot', { level: 'ok', icon: 'link' }); });
  store.on('hello', () => { updateStatusbar(); updateRibbon(); });
  store.on('protocol', () => updateBanners());
  store.on('sound', () => updateStatusbar());
  store.on('toast', (t) => toast(t.msg, { level: t.level === 'error' ? 'warn' : t.level === 'success' ? 'ok' : t.level || 'info' }));
  store.on('event', (e) => { if (e.kind === 'arrived') sound.arrived(); });
  setInterval(() => { updateStatusbar(); if (!S.connected) updateBanners(); alarmSounds(); }, 1000);
  window.addEventListener('hashchange', route);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && anySheetOpen()) closeAllSheets(); });
  // unlock audio on the first touch anywhere (iOS needs a gesture)
  window.addEventListener('pointerdown', () => sound.unlock(), { once: true, capture: true });
}

function boot() {
  document.getElementById('app').dataset.role = role();
  speech.enabled = device.speak;
  renderNav();
  renderStatusbar();
  renderSafety();
  updateRibbon();
  updateBanners();
  wirePending();
  wire();
  initIdle();
  route();
  connect();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* app works without it */ });
  }
  // test hook (Playwright): inject protocol messages to reach states the mock cannot produce
  if (/[?&]test=1/.test(location.search)) window.__g1 = { offline: (v) => import('./client.js').then((c) => c.setTestOffline(v)), store, inject: (m) => import('./client.js').then((c) => c.handle(m)), go, across, startCleanMode, idle: (s) => { lastTouch = Date.now() - s * 1000; } };
}

boot();
