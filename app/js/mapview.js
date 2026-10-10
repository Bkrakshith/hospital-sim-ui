// Canvas map widget (Operator / Technician): occupancy grid, laser scan, robot, Nav2 path, goals, waypoints,
// named places. Adapted from the console (hospital-sim-ui/web/js/mapview.js): app store + tokens, place pins, zoom API for
// the +/- / Fit buttons (no pinch needed, 05 §5). World frame: x right, y up (ROS).
import { store as robot } from './client.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function parseColor(c) {
  const d = document.createElement('canvas').getContext('2d');
  d.fillStyle = c;
  const v = d.fillStyle; // normalised: #rrggbb or rgba()
  if (v.startsWith('#')) return [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16)];
  const m = v.match(/\d+(\.\d+)?/g);
  return m ? m.slice(0, 3).map(Number) : [128, 128, 128];
}

export class MapView {
  constructor(container, opts = {}) {
    this.opts = { interactive: true, trail: true, minScale: 4, maxScale: 400, ...opts };
    this.el = container;
    this.canvas = document.createElement('canvas');
    container.append(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.view = { cx: 0, cy: 0, scale: 25 };
    this.fitted = false;
    this.follow = false;
    this.tool = 'pan';
    this.goal = null;
    this.waypoints = [];
    this.wpIndex = -1;
    this.trail = [];
    this.drag = null;
    this.preview = null;
    this.onPose = null;   // (tool, {x, y, yaw}) => void
    this.onViewChange = null;
    this._mapCanvas = null;
    this._mapKey = null;
    this._dirty = true;
    this._unsubs = [
      robot.on('map', () => { this._mapKey = null; if (!this.fitted) this.fit(); this.invalidate(); }),
      robot.on('pose', (p) => this._onPose(p)),
      robot.on('scan', () => this.invalidate()),
      robot.on('path', () => this.invalidate()),
      robot.on('theme', () => { this._mapKey = null; this._colors = null; this.invalidate(); }),
      robot.on('places', () => this.invalidate()),
    ];
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(container);
    if (this.opts.interactive) this._bind();
    else this.canvas.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    this._resize();
    if (robot.state.map) this.fit();
    const loop = () => {
      if (this._destroyed) return;
      if (this._dirty) { this._dirty = false; this._draw(); }
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  destroy() {
    this._destroyed = true;
    cancelAnimationFrame(this._raf);
    this._unsubs.forEach((u) => u());
    this._ro.disconnect();
    this.canvas.remove();
  }

  invalidate() { this._dirty = true; }
  setTool(t) { this.tool = t; this.canvas.style.cursor = t === 'pan' ? 'grab' : 'crosshair'; this.invalidate(); }
  setGoal(g) { this.goal = g; this.invalidate(); }
  setWaypoints(w, idx = -1) { this.waypoints = w || []; this.wpIndex = idx; this.invalidate(); }
  clearTrail() { this.trail = []; this.invalidate(); }

  _onPose(p) {
    if (this.opts.trail) {
      const last = this.trail[this.trail.length - 1];
      if (!last || Math.hypot(last[0] - p.x, last[1] - p.y) > 0.1) {
        this.trail.push([p.x, p.y]);
        if (this.trail.length > 1500) this.trail.shift();
      }
    }
    if (this.follow) { this.view.cx = p.x; this.view.cy = p.y; }
    if (!this.fitted && !robot.state.map) { this.view.cx = p.x; this.view.cy = p.y; }
    this.invalidate();
  }

  _resize() {
    const r = this.el.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = Math.max(10, r.width); this.h = Math.max(10, r.height);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.invalidate();
  }

  fit() {
    const m = robot.state.map;
    if (!m) {
      const p = robot.state.pose;
      if (p) { this.view.cx = p.x; this.view.cy = p.y; }
      return;
    }
    // fit the known (non-unknown) part of the map
    const b = this._knownBounds(m);
    const wm = (b.x1 - b.x0) * m.resolution, hm = (b.y1 - b.y0) * m.resolution;
    this.view.cx = m.origin[0] + (b.x0 + b.x1) / 2 * m.resolution;
    this.view.cy = m.origin[1] + (b.y0 + b.y1) / 2 * m.resolution;
    // do not zoom in further than ~40 px/m on a small (fresh SLAM) map
    this.view.scale = Math.max(this.opts.minScale, Math.min(40,
      0.92 * Math.min(this.w / Math.max(wm, 2), this.h / Math.max(hm, 2))));
    this.fitted = true;
    this.invalidate();
  }

  _knownBounds(m) {
    if (m._bounds) return m._bounds;
    const d = m.raw.data, W = m.width, H = m.height;
    let x0 = W, x1 = 0, y0 = H, y1 = 0;
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        if (d[(r * W + c) * 4] !== 255) {
          if (c < x0) x0 = c; if (c > x1) x1 = c;
          const yy = H - 1 - r;   // row 0 of the image is the top (max y)
          if (yy < y0) y0 = yy; if (yy > y1) y1 = yy;
        }
      }
    }
    if (x1 < x0) { x0 = 0; x1 = W; y0 = 0; y1 = H; }
    m._bounds = { x0, x1: x1 + 1, y0, y1: y1 + 1 };
    return m._bounds;
  }

  w2s(x, y) { return [this.w / 2 + (x - this.view.cx) * this.view.scale, this.h / 2 - (y - this.view.cy) * this.view.scale]; }
  s2w(sx, sy) { return [this.view.cx + (sx - this.w / 2) / this.view.scale, this.view.cy - (sy - this.h / 2) / this.view.scale]; }

  // ------------------------------------------------------------------ input
  _bind() {
    const c = this.canvas;
    c.style.cursor = 'grab';
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    c.addEventListener('dblclick', () => this.fit());
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      const [x, y] = this._evWorld(e);
      const pan = this.tool === 'pan' || e.button === 1 || e.button === 2;
      this.drag = { pan, sx: e.clientX, sy: e.clientY, cx: this.view.cx, cy: this.view.cy, wx: x, wy: y };
      if (pan) { this.follow = false; c.style.cursor = 'grabbing'; }
      else this.preview = { x, y, yaw: 0, tool: this.tool };
      this.invalidate();
    });
    c.addEventListener('pointermove', (e) => {
      const [x, y] = this._evWorld(e);
      this.hover = { x, y };
      if (this.onHover) this.onHover(x, y);
      if (!this.drag) return;
      if (this.drag.pan) {
        this.view.cx = this.drag.cx - (e.clientX - this.drag.sx) / this.view.scale;
        this.view.cy = this.drag.cy + (e.clientY - this.drag.sy) / this.view.scale;
        if (this.onViewChange) this.onViewChange();
      } else {
        const dx = x - this.drag.wx, dy = y - this.drag.wy;
        if (Math.hypot(dx, dy) * this.view.scale > 6) this.preview.yaw = Math.atan2(dy, dx);
      }
      this.invalidate();
    });
    const end = (e) => {
      if (!this.drag) return;
      const d = this.drag;
      this.drag = null;
      c.style.cursor = this.tool === 'pan' ? 'grab' : 'crosshair';
      if (!d.pan && this.preview && e.type === 'pointerup') {
        const p = { x: this.preview.x, y: this.preview.y, yaw: this.preview.yaw };
        const tool = this.tool;
        this.preview = null;
        if (this.onPose) this.onPose(tool, p);
      }
      this.preview = null;
      this.invalidate();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  }

  _evWorld(e) {
    const r = this.canvas.getBoundingClientRect();
    return this.s2w(e.clientX - r.left, e.clientY - r.top);
  }

  _wheel(e) {
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const [wx, wy] = this.s2w(sx, sy);
    const f = Math.exp(-e.deltaY * 0.0015);
    this.view.scale = Math.max(this.opts.minScale, Math.min(this.opts.maxScale, this.view.scale * f));
    // keep the point under the cursor fixed
    this.view.cx = wx - (sx - this.w / 2) / this.view.scale;
    this.view.cy = wy + (sy - this.h / 2) / this.view.scale;
    this.invalidate();
  }

  // ------------------------------------------------------------------ drawing
  _themeColors() {
    if (!this._colors) {
      this._colors = {
        free: parseColor(css('--map-free')), occ: parseColor(css('--map-occ')), unk: parseColor(css('--map-unknown')),
        bg: css('--map-bg'), scan: css('--alarm-low'), path: css('--robot-driving'), robot: css('--robot-driving'),
        grid: css('--map-grid'), text: css('--text'), panel: css('--surface'), warn: css('--alarm-med-fill'), ok: css('--ok'),
        accent: css('--person-driving'), muted: css('--text-2'), place: css('--text-2'),
      };
    }
    return this._colors;
  }

  _mapBitmap(m) {
    const key = `${m.version}`;
    if (this._mapKey === key && this._mapCanvas) return this._mapCanvas;
    const C = this._themeColors();
    const src = m.raw.data;
    const out = new ImageData(m.width, m.height);
    const d = out.data;
    for (let i = 0; i < src.length; i += 4) {
      const v = src[i];
      let col, a = 255;
      if (v === 255) { col = C.unk; a = 0; }
      else if (v >= 65) col = C.occ;
      else if (v <= 25) col = C.free;
      else { // grey-ish in between
        const t = v / 100;
        col = [0, 1, 2].map((k) => C.free[k] + (C.occ[k] - C.free[k]) * t);
      }
      d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2]; d[i + 3] = a;
    }
    const c = document.createElement('canvas');
    c.width = m.width; c.height = m.height;
    c.getContext('2d').putImageData(out, 0, 0);
    this._mapCanvas = c;
    this._mapKey = key;
    return c;
  }

  _draw() {
    const ctx = this.ctx, C = this._themeColors(), s = this.view.scale;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, this.w, this.h);
    const m = robot.state.map;
    // unknown area under the map extent
    if (m) {
      const [ox, oy] = [m.origin[0], m.origin[1]];
      const [sx0, sy0] = this.w2s(ox, oy + m.height * m.resolution);
      ctx.fillStyle = `rgb(${C.unk.join(',')})`;
      ctx.fillRect(sx0, sy0, m.width * m.resolution * s, m.height * m.resolution * s);
    }
    this._drawGrid();
    if (m) {
      const bmp = this._mapBitmap(m);
      const [sx0, sy0] = this.w2s(m.origin[0], m.origin[1] + m.height * m.resolution);
      ctx.save();
      ctx.imageSmoothingEnabled = s * m.resolution < 1; // smooth only when a cell is smaller than a pixel
      if (m.origin[2]) { // rotated map origin (rare)
        const [px, py] = this.w2s(m.origin[0], m.origin[1]);
        ctx.translate(px, py); ctx.rotate(-m.origin[2]); ctx.translate(-px, -py);
      }
      ctx.drawImage(bmp, sx0, sy0, m.width * m.resolution * s, m.height * m.resolution * s);
      ctx.restore();
    }
    this._drawTrail(C);
    this._drawPath(C);
    this._drawScan(C);
    if (this.opts.places !== false) this._drawPlaces(C);
    this._drawWaypoints(C);
    if (this.goal) this._drawPoseMarker(this.goal, C.ok, 'goal');
    if (this.opts.amcl !== false) this._drawAmcl(C);
    this._drawRobot(C);
    if (this.preview) {
      const col = this.preview.tool === 'initial' ? C.warn : this.preview.tool === 'waypoint' ? C.accent : C.ok;
      this._drawPoseMarker(this.preview, col, this.preview.tool);
    }
    this._drawScaleBar(C);
  }

  zoom(f) { this.view.scale = Math.max(this.opts.minScale, Math.min(this.opts.maxScale, this.view.scale * f)); this.invalidate(); }
  centreOnRobot() { const p = robot.state.pose; if (p) { this.view.cx = p.x; this.view.cy = p.y; this.invalidate(); } }

  _drawPlaces(C) {
    const ctx = this.ctx;
    ctx.font = '600 13px -apple-system, system-ui, sans-serif';
    const drawn = [];
    for (const p of robot.state.places || []) {
      const [sx, sy] = this.w2s(p.x, p.y);
      if (drawn.some(([x, y]) => Math.hypot(x - sx, y - sy) < 24)) continue;
      drawn.push([sx, sy]);
      if (sx < -40 || sy < -40 || sx > this.w + 40 || sy > this.h + 40) continue;
      ctx.fillStyle = C.panel; ctx.strokeStyle = C.place; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sx, sy, 6, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
      if (this.view.scale > 14) { ctx.fillStyle = C.text; ctx.globalAlpha = 0.8; ctx.fillText(p.name + (p.sub && p.name.startsWith('Theatre') ? ' · ' + p.sub.split(' · ')[0].split(' (')[0].toLowerCase() : ''), sx + 10, sy + 4); ctx.globalAlpha = 1; }
    }
  }

  _drawGrid() {
    const s = this.view.scale;
    if (s < 12) return;
    const ctx = this.ctx;
    const [x0, y1] = this.s2w(0, 0), [x1, y0] = this.s2w(this.w, this.h);
    ctx.strokeStyle = this._themeColors().grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = Math.floor(x0); x <= x1; x++) { const [sx] = this.w2s(x, 0); ctx.moveTo(sx + .5, 0); ctx.lineTo(sx + .5, this.h); }
    for (let y = Math.floor(y0); y <= y1; y++) { const [, sy] = this.w2s(0, y); ctx.moveTo(0, sy + .5); ctx.lineTo(this.w, sy + .5); }
    ctx.stroke();
  }

  _drawTrail(C) {
    if (this.trail.length < 2) return;
    const ctx = this.ctx;
    ctx.strokeStyle = C.robot; ctx.globalAlpha = 0.35; ctx.lineWidth = 2; ctx.setLineDash([4, 4]);
    ctx.beginPath();
    this.trail.forEach(([x, y], i) => { const [sx, sy] = this.w2s(x, y); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
    ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;
  }

  _drawPath(C) {
    const p = robot.state.path;
    if (!p || !p.pts || p.pts.length < 2) return;
    const ctx = this.ctx;
    ctx.strokeStyle = C.path; ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.globalAlpha = 0.9;
    ctx.beginPath();
    p.pts.forEach(([x, y], i) => { const [sx, sy] = this.w2s(x, y); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
    ctx.stroke(); ctx.globalAlpha = 1;
  }

  _drawScan(C) {
    const sc = robot.state.scan;
    if (!sc || !sc.pts || this.opts.showScan === false) return;
    const ctx = this.ctx;
    ctx.fillStyle = C.scan;
    const r = Math.max(1.3, Math.min(3, this.view.scale * 0.03));
    const pts = sc.pts;
    for (let i = 0; i < pts.length; i += 2) {
      const [sx, sy] = this.w2s(pts[i], pts[i + 1]);
      ctx.fillRect(sx - r / 2, sy - r / 2, r, r);
    }
  }

  _drawAmcl(C) {
    const st = robot.state.status;
    const a = st && st.amcl;
    if (!a || !a.std_xy) return;
    const [sx, sy] = this.w2s(a.x, a.y);
    const r = Math.max(4, a.std_xy * 2 * this.view.scale);
    const ctx = this.ctx;
    ctx.strokeStyle = C.warn; ctx.globalAlpha = 0.5; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, 2 * Math.PI); ctx.stroke(); ctx.globalAlpha = 1;
  }

  _drawRobot(C) {
    const p = robot.state.pose;
    if (!p) return;
    const ctx = this.ctx;
    const [sx, sy] = this.w2s(p.x, p.y);
    const R = Math.max(7, 0.3 * this.view.scale);
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(-p.yaw);
    ctx.fillStyle = C.robot; ctx.globalAlpha = 0.18;
    ctx.beginPath(); ctx.arc(0, 0, R, 0, 2 * Math.PI); ctx.fill();
    ctx.globalAlpha = 1; ctx.strokeStyle = C.robot; ctx.lineWidth = 2; ctx.stroke();
    const A = Math.max(9, R * 0.95);
    ctx.fillStyle = C.robot;
    ctx.beginPath(); ctx.moveTo(A, 0); ctx.lineTo(-A * 0.55, A * 0.6); ctx.lineTo(-A * 0.25, 0); ctx.lineTo(-A * 0.55, -A * 0.6); ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = C.panel; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.restore();
  }

  _drawPoseMarker(p, color, kind) {
    const ctx = this.ctx;
    const [sx, sy] = this.w2s(p.x, p.y);
    ctx.save();
    ctx.translate(sx, sy);
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(0, 0, 7, 0, 2 * Math.PI); ctx.globalAlpha = 0.25; ctx.fill(); ctx.globalAlpha = 1; ctx.stroke();
    ctx.rotate(-(p.yaw || 0));
    ctx.beginPath(); ctx.moveTo(7, 0); ctx.lineTo(30, 0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(34, 0); ctx.lineTo(24, -6); ctx.lineTo(24, 6); ctx.closePath(); ctx.fill();
    ctx.restore();
    if (kind === 'initial' || kind === 'goal') {
      ctx.font = '600 14px -apple-system, system-ui, sans-serif';
      ctx.fillStyle = color;
      ctx.fillText(kind === 'initial' ? 'robot is here' : 'go here', sx + 10, sy - 12);
    }
  }

  _drawWaypoints(C) {
    const w = this.waypoints;
    if (!w.length) return;
    const ctx = this.ctx;
    ctx.strokeStyle = C.accent; ctx.lineWidth = 1.5; ctx.setLineDash([6, 5]); ctx.globalAlpha = 0.7;
    ctx.beginPath();
    w.forEach((p, i) => { const [sx, sy] = this.w2s(p.x, p.y); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
    ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    w.forEach((p, i) => {
      const [sx, sy] = this.w2s(p.x, p.y);
      const col = i < this.wpIndex ? C.ok : i === this.wpIndex ? C.warn : C.accent;
      ctx.save(); ctx.translate(sx, sy); ctx.rotate(-(p.yaw || 0));
      ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(20, 0); ctx.lineTo(11, -5); ctx.lineTo(11, 5); ctx.closePath(); ctx.fill();
      ctx.restore();
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(sx, sy, 10, 0, 2 * Math.PI); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = '700 11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), sx, sy + 0.5);
      ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
    });
  }

  _drawScaleBar(C) {
    const ctx = this.ctx;
    const target = 110 / this.view.scale;
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50];
    const m = steps.find((v) => v >= target) || 50;
    const px = m * this.view.scale;
    const x = this.w - px - 16, y = this.h - 16;
    ctx.strokeStyle = C.text; ctx.lineWidth = 2; ctx.globalAlpha = 0.75;
    ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x, y); ctx.lineTo(x + px, y); ctx.lineTo(x + px, y - 5); ctx.stroke();
    ctx.fillStyle = C.text; ctx.font = '600 11px system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(`${m} m`, x + px / 2, y - 7);
    ctx.textAlign = 'start'; ctx.globalAlpha = 1;
  }
}
