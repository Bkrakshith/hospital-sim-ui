// WebSocket client + state store for the G1 dashboard (protocol: hospital-sim-ui/PROTOCOL.md).
// Everything the pages need lives in `robot.state`; pages subscribe with robot.on(event, fn).

const listeners = new Map();

export const robot = {
  state: {
    connected: false,
    hello: null,
    mode: null,          // {mode, name, source, detail}
    status: null,        // latest 'state' message
    pose: null,          // {frame, x, y, yaw, vx, vy, wz}
    scan: null,          // {frame, pts: [x0,y0,...]}
    map: null,           // {frame, width, height, resolution, origin, version, image: ImageData-ready bitmap}
    path: null,          // {frame, pts: [[x,y],...]}
    logs: [],
    mission: null,       // latest /g1/mission/status (g1_mission)
  },
  ws: null,
  _id: 1,
  _pending: new Map(),

  on(ev, fn) {
    if (!listeners.has(ev)) listeners.set(ev, new Set());
    listeners.get(ev).add(fn);
    return () => listeners.get(ev).delete(fn);
  },
  emit(ev, data) {
    const set = listeners.get(ev);
    if (set) for (const fn of [...set]) { try { fn(data); } catch (e) { console.error(ev, e); } }
  },

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this._backoff = 500;
      this.state.connected = true;
      this.emit('connection', true);
      // protocol v2: >= 5 Hz heartbeat; the manager holds the robot (HOLD) if the device driving it by hand
      // goes silent for > 1 s (UI heartbeat watchdog, docs/interfaces.md 3.4)
      clearInterval(this._hb);
      this._hb = setInterval(() => {
        if (ws.readyState === 1) ws.send('{"op":"heartbeat"}');
      }, 150);
    };
    ws.onclose = () => {
      clearInterval(this._hb);
      const was = this.state.connected;
      this.state.connected = false;
      if (was) this.emit('connection', false);
      for (const [, p] of this._pending) p.reject(new Error('connection closed'));
      this._pending.clear();
      this._backoff = Math.min((this._backoff || 500) * 1.6, 5000);
      setTimeout(() => this.connect(), this._backoff);
    };
    ws.onerror = () => {};
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      this._handle(msg);
    };
  },

  _handle(msg) {
    const s = this.state;
    switch (msg.type) {
      case 'hello': s.hello = msg; this.emit('hello', msg); break;
      case 'mode': {
        const prev = s.mode;
        if (prev && prev.name !== msg.name && msg.name === 'STAND') s.standFrom = prev.name;
        s.mode = msg;
        this.emit('mode', { mode: msg, prev });
        break;
      }
      case 'state':
        s.status = msg;
        if (msg.mode && (!s.mode || s.mode.mode !== msg.mode.mode)) {
          const prev = s.mode;
          if (prev && msg.mode.name === 'STAND') s.standFrom = prev.name;
          s.mode = msg.mode; this.emit('mode', { mode: msg.mode, prev });
        }
        this.emit('state', msg);
        break;
      case 'pose': s.pose = msg; this.emit('pose', msg); break;
      case 'scan': s.scan = msg; this.emit('scan', msg); break;
      case 'path':
        s.path = msg; this.emit('path', msg); break;
      case 'map': this._decodeMap(msg); break;
      case 'log':
        s.logs.push(msg);
        if (s.logs.length > 3000) s.logs.splice(0, s.logs.length - 3000);
        this.emit('log', msg);
        break;
      case 'logs':
        s.logs = msg.entries.concat();
        this.emit('logs', s.logs);
        break;
      case 'toast': this.emit('toast', msg); break;
      case 'mission': {
        const prev = s.mission;
        s.mission = msg;
        this.emit('mission', msg);
        if (prev && prev.state !== msg.state && ['failed', 'aborted', 'succeeded'].includes(msg.state)) {
          this.emit('toast', { msg: `Mission ${msg.state}: ${msg.message || ''}`, level: msg.state === 'succeeded' ? 'success' : 'warn' });
        }
        break;
      }
      case 'result': {
        const p = this._pending.get(msg.id);
        if (p) { this._pending.delete(msg.id); p.resolve(msg); }
        break;
      }
      default: break;
    }
  },

  _decodeMap(msg) {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = msg.width; c.height = msg.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const raw = ctx.getImageData(0, 0, msg.width, msg.height);
      this.state.map = { ...msg, png: undefined, raw, stats: mapStats(raw) };
      this.emit('map', this.state.map);
    };
    img.src = 'data:image/png;base64,' + msg.png;
  },

  // send an op; resolves with the result message {ok, message, data}
  request(op, args = {}, { timeout = 15000 } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) { reject(new Error('not connected')); return; }
      const id = this._id++;
      this._pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ op, id, ...args }));
      setTimeout(() => {
        if (this._pending.has(id)) { this._pending.delete(id); reject(new Error(`${op} timed out`)); }
      }, timeout);
    });
  },
  // fire-and-forget (high-rate ops: key, cmd_vel)
  send(op, args = {}) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ op, ...args }));
  },

  modeName() { return this.state.mode ? this.state.mode.name : null; },
};

function mapStats(raw) {
  // grayscale PNG: 0..100 occupancy, 255 unknown (R channel)
  const d = raw.data;
  let free = 0, occ = 0;
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i];
    if (v === 255) continue;
    if (v >= 65) occ++; else if (v <= 25) free++;
  }
  return { free, occ };
}

export const MODE_DESC = {
  DAMP: 'Motors damped',
  STAND: 'Balancing, zero velocity',
  LOCO: 'Keyboard locomotion',
  MANIP: 'Camera upper-body teleop',
  NAV: 'Nav2 drives the robot',
  AUTO: 'Mission / skills drive the robot',
};
