// WebSocket client + state store + op adapter for the G1 theatre app.
// Protocol: hospital-sim-ui/PROTOCOL.md (v1 base + "v2" section). Derived from the console's hospital-sim-ui/web/js/robot.js.
//
// Everything the screens need lives in `store.state`; screens subscribe with store.on(event, fn).
// All robot commands go through `api` (protocol v2 ops, hospital-sim-ui/PROTOCOL.md). A v1-only server is refused with a clear
// message (`S.protocolChecked && !S.v2`); the engineering console at /console/ still speaks v1.
//
// Robot state is never cached (no localStorage, no service-worker cache). Only device settings
// (device id/name/room, theme, handedness, sound) are kept in localStorage.

import { PLACES, INSTRUMENTS, DOCK_ID, placeById } from './data.js';

const listeners = new Map();
const HEARTBEAT_MS = 180;          // v2: every client sends heartbeat at >= 5 Hz
const APP_VERSION = '0.1.0';

function ls(key, dflt) { try { const v = localStorage.getItem(key); return v === null ? dflt : JSON.parse(v); } catch { return dflt; } }
function lsSet(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode */ } }

export const device = {
  get id() {
    let id = ls('g1.device_id', null);
    if (!id) { id = 'ipad-' + Math.random().toString(16).slice(2, 8); lsSet('g1.device_id', id); }
    return id;
  },
  get name() { return ls('g1.device_name', 'iPad OR-1'); },
  set name(v) { lsSet('g1.device_name', v); },
  get place() { return ls('g1.device_place', 'theatre_door'); },     // where this iPad is mounted ("Come here")
  set place(v) { lsSet('g1.device_place', v); },
  get room() { const p = placeById(this.place); return p ? p.room : 'theatre1'; },
  get speak() { return ls('g1.speak', true); },
  set speak(v) { lsSet('g1.speak', !!v); },
  get mirror() { return ls('g1.mirror', false); },
  set mirror(v) { lsSet('g1.mirror', !!v); },
  get token() { try { return sessionStorage.getItem('g1.token'); } catch { return null; } },
  set token(v) { try { if (v) sessionStorage.setItem('g1.token', v); else sessionStorage.removeItem('g1.token'); } catch { /* ignore */ } },
};

export const store = {
  state: {
    connected: false,
    everConnected: false,
    lostAt: null,             // Date.now() when the link dropped
    lastMsgAt: 0,
    hello: null,
    v2: false,
    session: { role: 'clinical', user: null, local: true },
    mode: null,               // {mode, name, source, detail, stamp}
    modeChange: null,         // {from, to, source, at}
    status: null,             // latest 'state'
    pose: null, scan: null, map: null, path: null,
    logs: [],
    mission: null,
    alarms: { active: [], counts: { high: 0, medium: 0, low: 0 }, suppressed: [] },
    lease: { holder: null, you: false },
    hold: null,
    motion: null,
    pending: new Map(),       // id -> pending readback
    timeline: [],             // {t, kind, text, by}
    places: PLACES.map((p) => ({ ...p, allowed_roles: p.roles })),
    instruments: INSTRUMENTS.map((i) => ({ ...i, on_rack: null, available: null })),
    devices: {},
    handed: [],               // {name, t}   instruments handed today (for the count)
  },
  on(ev, fn) {
    if (!listeners.has(ev)) listeners.set(ev, new Set());
    listeners.get(ev).add(fn);
    return () => listeners.get(ev).delete(fn);
  },
  emit(ev, data) {
    const set = listeners.get(ev);
    if (set) for (const fn of [...set]) { try { fn(data); } catch (e) { console.error(ev, e); } }
  },
};
const S = store.state;
export const isV2 = () => S.v2;

// ------------------------------------------------------------------ connection
let ws = null, backoff = 500, reqId = 1, hbTimer = 0, reconnectTimer = 0;
const pendingReq = new Map();

export function connect() {
  clearTimeout(reconnectTimer);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = (window.G1_WS_URL) || `${proto}://${location.host}/ws`;
  try { ws = new WebSocket(url); } catch (e) { scheduleReconnect(); return; }
  ws.onopen = async () => {
    backoff = 500;
    S.connected = true; S.everConnected = true; S.lostAt = null; S.lastMsgAt = Date.now();
    store.emit('connection', true);
    clearInterval(hbTimer);
    hbTimer = setInterval(() => { if (S.v2) send('heartbeat'); }, HEARTBEAT_MS);
    // v2 hello (a v1 server answers "unknown op": the app then shows "server too old")
    try {
      const r = await request('hello', { protocol: 2, device_id: device.id, device_name: device.name, room: device.room, app: 'g1-ipad', version: APP_VERSION, token: device.token || undefined }, { timeout: 4000 });
      if (r.ok) { S.v2 = true; if (r.data && r.data.session) setSession(r.data.session); refreshCatalogues(); }
      else { S.v2 = false; }
      S.protocolChecked = true;
    } catch { S.v2 = false; S.protocolChecked = true; }
    store.emit('protocol', S.v2);
  };
  ws.onclose = () => {
    const was = S.connected;
    S.connected = false;
    clearInterval(hbTimer);
    if (was) { S.lostAt = Date.now(); store.emit('connection', false); }
    for (const [, p] of pendingReq) p.reject(new Error('connection closed'));
    pendingReq.clear();
    scheduleReconnect();
  };
  ws.onerror = () => {};
  ws.onmessage = (ev) => {
    S.lastMsgAt = Date.now();
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    handle(msg);
  };
}
let testOffline = false;
export function setTestOffline(v) { testOffline = v; if (v && ws) ws.close(); else if (!v) connect(); }   // test hook only
function scheduleReconnect() {
  if (testOffline) return;
  backoff = Math.min(backoff * 1.6, 4000);
  reconnectTimer = setTimeout(connect, backoff);
}

export function request(op, args = {}, { timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) { reject(new Error('Not connected to the robot')); return; }
    const id = reqId++;
    pendingReq.set(id, { resolve, reject });
    ws.send(JSON.stringify({ ...args, op, id }));   // the request id always wins over an arg named id
    setTimeout(() => { if (pendingReq.has(id)) { pendingReq.delete(id); reject(new Error(`${op} timed out`)); } }, timeout);
  });
}
export function send(op, args = {}) {
  if (ws && ws.readyState === 1) { ws.send(JSON.stringify({ op, ...args })); return true; }
  return false;
}

// ------------------------------------------------------------------ incoming
export function handle(msg) {
  switch (msg.type) {
    case 'hello':
      S.hello = msg;
      if (Array.isArray(msg.timeline)) S.timeline = msg.timeline.slice(-100);
      if (Array.isArray(msg.places)) setPlaces(msg.places);
      store.emit('hello', msg);
      break;
    case 'session': setSession(msg); break;
    case 'mode': setMode(msg); break;
    case 'state':
      S.status = msg;
      if (msg.mode) setMode(msg.mode);
      if ('hold' in msg) S.hold = msg.hold;
      if (msg.lease) setLease(msg.lease);
      if ('motion' in msg) S.motion = msg.motion;
      if (msg.devices) S.devices = msg.devices;
      if (msg.proximity) S.proximity = msg.proximity;
      store.emit('state', msg);
      break;
    case 'pose': S.pose = msg; store.emit('pose', msg); break;
    case 'proximity': S.proximity = msg; store.emit('proximity', msg); break;
    case 'scan': S.scan = msg; store.emit('scan', msg); break;
    case 'path': S.path = msg; store.emit('path', msg); break;
    case 'map': decodeMap(msg); break;
    case 'log':
      S.logs.push(msg); if (S.logs.length > 3000) S.logs.splice(0, S.logs.length - 3000);
      store.emit('log', msg); break;
    case 'logs': S.logs = (msg.entries || []).concat(); store.emit('logs', S.logs); break;
    case 'toast': store.emit('toast', msg); break;
    case 'mission': setMission(msg); break;
    case 'alarms':
      S.alarms = { active: msg.active || [], counts: msg.counts || countAlarms(msg.active || []), suppressed: msg.suppressed || [] };
      store.emit('alarms', S.alarms); break;
    case 'lease': setLease(msg); break;
    case 'event': addEvent(msg); break;
    case 'pending':
      S.pending.set(msg.id, { ...msg, received: Date.now() });
      store.emit('pending', msg); break;
    case 'pending_done': {
      const p = S.pending.get(msg.id);
      S.pending.delete(msg.id);
      store.emit('pending_done', { ...msg, pending: p }); break;
    }
    case 'instruments': setInstruments(msg.instruments); break;
    case 'result': {
      const p = pendingReq.get(msg.id);
      if (p) { pendingReq.delete(msg.id); p.resolve(msg); }
      break;
    }
    default: break;
  }
}

function setSession(sess) {
  const prev = S.session;
  S.session = { ...sess, local: false };
  if (sess.token) device.token = sess.token;
  if (sess.role === 'clinical') device.token = null;
  if ('lease_holder' in sess) S.lease.you = !!sess.lease_holder;
  store.emit('session', { session: S.session, prev });
}

function setMode(m) {
  const prev = S.mode;
  if (prev && prev.name === m.name && prev.source === m.source && prev.stamp === m.stamp) return;
  if (prev && prev.name === m.name && !m.stamp) { S.mode = { ...prev, ...m }; return; }
  S.mode = m;
  if (prev && prev.name !== m.name) {
    S.modeChange = { from: prev.name, to: m.name, source: m.source, detail: m.detail, at: Date.now() };
  }
  store.emit('mode', { mode: m, prev });
}

function setLease(l) {
  let holder = l.holder !== undefined ? l.holder : S.lease.holder;
  if (!holder) holder = null;
  const you = l.you !== undefined ? !!l.you : S.lease.you;
  const changed = JSON.stringify(holder) !== JSON.stringify(S.lease.holder) || you !== S.lease.you;
  S.lease = { holder, you };
  if (changed) store.emit('lease', S.lease);
}

function setMission(msg) {
  const prev = S.mission;
  S.mission = msg;
  // handed-instrument count: history entries with success (F3 step 5, HF-3)
  if (msg.history && prev && prev.history && msg.history.length > prev.history.length) {
    for (const h of msg.history.slice(prev.history.length)) {
      if (h.success) {
        const name = instrumentName(h.instrument);
        S.handed.push({ name, t: h.t || Date.now() / 1000, duration: h.duration });
      }
    }
  }
  store.emit('mission', msg);
}

function setPlaces(list) {
  const byId = new Map(PLACES.map((p) => [p.id, p]));
  S.places = list.map((p) => {
    const b = byId.get(p.id) || {};
    const sm = /Theatre (\d+)/.exec(p.name || '');
    return { ...b, ...p, sub: p.sub || b.sub || '', stripe: p.stripe || (sm ? Number(sm[1]) : null), dock: p.kind === 'dock' || b.dock, roles: p.allowed_roles || b.roles };
  });
  store.emit('places', S.places);
}
function setInstruments(list) {
  const byId = new Map(INSTRUMENTS.map((i) => [i.id, i]));
  S.instruments = list.map((i) => ({ ...(byId.get(i.id) || { kind: 'forceps', group: 'Other' }), ...i, name: (byId.get(i.id) || {}).name || i.name }));
  store.emit('instruments', S.instruments);
}
async function refreshCatalogues() {
  try { const r = await request('places_list'); if (r.ok && r.data && r.data.places) setPlaces(r.data.places); } catch { /* keep built-in */ }
  try {   // handed-instrument count for today, including hands before this page loaded (HF-3)
    const r = await request('handover_card');
    const list = r.ok && r.data && r.data.instruments_handed;
    if (Array.isArray(list)) { S.handed = list.map((x) => ({ name: x.name || instrumentName(x.instrument || x.id), t: x.t })); store.emit('mission', S.mission); }
  } catch { /* keep local */ }
  try { const r = await request('instruments_list'); if (r.ok && r.data && r.data.instruments) setInstruments(r.data.instruments); } catch { /* keep built-in */ }
}

export function addEvent(ev) {
  S.timeline.push(ev);
  if (S.timeline.length > 200) S.timeline.splice(0, S.timeline.length - 200);
  store.emit('event', ev);
}

function countAlarms(list) {
  const c = { high: 0, medium: 0, low: 0 };
  for (const a of list) if (c[a.priority] !== undefined) c[a.priority]++;
  return c;
}

function decodeMap(msg) {
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = msg.width; c.height = msg.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    S.map = { ...msg, png: undefined, raw: ctx.getImageData(0, 0, msg.width, msg.height) };
    store.emit('map', S.map);
  };
  img.src = 'data:image/png;base64,' + msg.png;
}

// ------------------------------------------------------------------ names
export function instrumentName(id) {
  const i = S.instruments.find((x) => x.id === id) || INSTRUMENTS.find((x) => x.id === id);
  return i ? i.name : String(id || 'instrument').replace(/_/g, ' ');
}
export function placeName(id) {
  const p = S.places.find((x) => x.id === id) || placeById(id);
  return p ? p.name : String(id || '').replace(/_/g, ' ');
}
export function modeLabel(name) {
  const info = S.hello && S.hello.mode_info && S.hello.mode_info[name];
  if (info && info.label) return info.label;
  return ({ DAMP: 'Powered down', STAND: 'Standing by', HOLD: 'Stopped', LOCO: 'Manual walking', MANIP: 'Manual arms', NAV: 'Driving', AUTO: 'Working (task)' })[name] || name || 'Unknown';
}
// a person/device reference from the server (string, or {user, device_name, source}) in words
export function whoText(x) {
  if (!x) return null;
  if (typeof x === 'string') return x.startsWith('ui:') || !x.includes(' ') ? sourceLabel(x) : x;
  if (x.user && x.device_name) return `${x.user} (${x.device_name})`;
  return x.user || x.device_name || (x.source ? sourceLabel(x.source) : null);
}
// who changed the mode, in words (HF-18)
export function sourceLabel(src) {
  if (src && typeof src === 'object') src = src.source || src.user || src.device_name || '';
  if (!src) return 'unknown';
  const s = String(src);
  if (s.startsWith('ui:')) {
    const id = s.slice(3);
    if (id === device.id) return S.session.user ? `${S.session.user} (this iPad)` : 'this iPad';
    const d = S.devices[id];
    return d ? `${d.user ? d.user + ' · ' : ''}${d.name || id}` : `iPad ${id}`;
  }
  return ({
    ui: 'an iPad or the console', ui_stop: 'Stop on an iPad', keyboard: 'the keyboard at the robot PC', mission: 'the scrub-assist task',
    watchdog: 'the safety watchdog (control link lost)', estop_hw: 'the hardware e-stop', lease: 'a control takeover',
    safety: 'the safety system', nav: 'navigation', startup: 'start-up', init: 'start-up', voice: 'voice',
  })[s] || s;
}

// ------------------------------------------------------------------ api (protocol v2 ops)
function ok(message, data) { return { ok: true, message, data }; }
function fail(message, data) { return { ok: false, message, data }; }
async function call(op, args, opts) {
  try { return await request(op, args, opts); } catch (e) { return fail(e.message || String(e)); }
}

export const api = {
  // Stop = HOLD. Sent at once (the Stop button calls this on pointerdown).
  stop(reason = null) {
    if (!S.connected) return Promise.resolve(fail('Not connected to the robot. Use the hardware e-stop.'));
    return call('stop', { reason });
  },
  stopReason(reason, note = '') { return call('stop_reason', { reason, note }); },
  resume(to) { return call('resume', { to }); },
  powerOff() { return call('power_off', {}); },
  sendTo(placeId) { return call('send_to', { place: placeId }); },
  comeHere() { return this.sendTo(device.place); },
  dock() {
    const d = S.places.find((p) => p.kind === 'dock' || p.dock);
    return call('send_to', { place: d ? d.id : 'dock' });
  },
  requestInstrument(id, requester = 'surgeon') { return call('instrument_request', { instrument: id, requester }); },
  undo(pendingId) { return call('undo', { pending_id: pendingId }); },
  cancelTask() { return call('cancel_task', {}); },
  missionCommand(command) { return call('mission_command', { command }); },
  ackAlarm(id) { return call('alarm_ack', { alarm_id: id }); },
  suppressAlarm(code) { return call('alarm_suppress', { code }); },

  // session
  login(role, pin, user) { return call('login', { role, pin, user }); },
  badgeLogin(badge) { return call('badge_login', { badge }); },
  logout() { return call('logout', {}); },

  // lease
  leaseAcquire(reason) { return call('lease_acquire', { reason }); },
  leaseRelease() { return call('lease_release', {}); },
  leaseSteal(reason) { return call('lease_steal', { reason }); },

  // motion (operator; needs the lease)
  setMode(mode) { return call('set_mode', { mode }); },
  key(k) { return send('key', { key: k }); },
  cmdVel(vx, vy, wz) { return send('cmd_vel', { vx, vy, wz }); },
  navGoal(x, y, yaw) { return call('nav_goal', { x, y, yaw }); },
  navWaypoints(poses, start = 0) { return call('nav_waypoints', { poses, start }); },
  navPause() { return call('nav_pause'); },
  navResume() { return call('nav_resume'); },
  navCancel() { return call('nav_cancel'); },
  initialPose(x, y, yaw) { return call('initial_pose', { x, y, yaw }); },

  // data
  checksRun() { return call('checks_run', {}); },
  checksRecord(part, answers) { return call('checks_record', { part, answers }); },
  checksStatus() { return call('checks_status', {}); },
  handoverCard() { return call('handover_card', {}); },
  incidentCreate(chips, note) { return call('incident_create', { chips, note }); },
  incidentsList() { return call('incidents_list', {}); },
  incidentGet(id) { return call('incident_get', { incident_id: id }); },
  incidentLink(id) { return call('incident_link', { incident_id: id }); },   // one-time download URL, 60 s
  auditList(limit = 200, before_seq = null) { return call('audit_list', { limit, before_seq }); },
  auditVerify() { return call('audit_verify', {}); },
  alarmStats() { return call('alarm_stats', {}); },
  zonesList() { return call('zones_list', {}); },
  mapsList() { return call('maps_list', {}); },
  mapLoad(name) { return call('map_load', { name }); },
  mapSave(name) { return call('map_save', { name }); },
  mapDelete(name) { return call('map_delete', { name }); },
  routesList(map) { return call('routes_list', { map }); },
  routeSave(map, name, poses) { return call('route_save', { map, name, poses }); },
  stackStart(stack, args = {}) { return call('stack_start', { stack, ...args }, { timeout: 20000 }); },
  stackStop(stack) { return call('stack_stop', { stack }, { timeout: 20000 }); },
  getMap() { return call('get_map', {}); },
  manipHold(on) { return call('manip_hold', { on: !!on }); },     // arms held inside MANIP (lease holder)
  hand(side, close) { return call('hand', { side, close }); },    // gripper override: only in HOLD or with arms held
};

export function sessionRole() { return S.session.role || 'clinical'; }
export { APP_VERSION };
