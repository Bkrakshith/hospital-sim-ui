// Clean vector floor plan of the surgical wing (05 §9.3): rooms as shapes with names, the robot as a dot
// with a heading, the destination as a pin, the planned path as a line. Not the SLAM occupancy grid.
import { ROOMS, DOORS, WING_BOUNDS } from './data.js';
import { store } from './client.js';

const K = 12; // svg units per metre
const PAD = 1.2;
const B = { x0: WING_BOUNDS.x0 - PAD, y0: WING_BOUNDS.y0 - PAD, x1: WING_BOUNDS.x1 + PAD, y1: WING_BOUNDS.y1 + PAD };
const W = (B.x1 - B.x0) * K, H = (B.y1 - B.y0) * K;
const sx = (x) => (x - B.x0) * K;
const sy = (y) => (B.y1 - y) * K;

function roomsSvg({ highlight, labels = true, compact = false } = {}) {
  let s = '';
  for (const r of ROOMS) {
    const [x0, y0, x1, y1] = r.rect;
    const hl = highlight === r.id;
    s += `<rect class="fp-room${hl ? ' fp-hl' : ''}${r.id === 'corridor' || r.id === 'link' ? ' fp-corr' : ''}" x="${sx(x0) + 1.5}" y="${sy(y1) + 1.5}" width="${(x1 - x0) * K - 3}" height="${(y1 - y0) * K - 3}" rx="6"/>`;
  }
  for (const d of DOORS) {
    s += `<line class="fp-door" x1="${sx(d[0])}" y1="${sy(d[1])}" x2="${sx(d[2])}" y2="${sy(d[3])}"/>`;
  }
  if (labels) {
    for (const r of ROOMS) {
      if (compact && r.id === 'link') continue;
      const [x0, y0, x1, y1] = r.rect;
      const cx = sx((x0 + x1) / 2), cy = sy((y0 + y1) / 2);
      const hl = highlight === r.id;
      const name = r.short || r.name;
      if (r.id === 'link') continue;
      s += `<text class="fp-label${hl ? ' fp-label-hl' : ''}" x="${cx}" y="${cy + 5}" text-anchor="middle">${name}</text>`;
    }
  }
  return s;
}

// Static thumbnail for a place tile
export function placeThumb(place) {
  const pin = `<g class="fp-pin" transform="translate(${sx(place.x)} ${sy(place.y)})"><circle r="9" /><circle r="3.5" class="fp-pin-dot"/></g>`;
  return `<svg class="fp fp-thumb" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Floor plan with ${place.name} marked">${roomsSvg({ highlight: place.room, labels: false })}${pin}</svg>`;
}

// Live floor plan widget
export class FloorPlan {
  constructor(el, { labels = true, compact = false } = {}) {
    this.el = el;
    this.opts = { labels, compact };
    el.innerHTML = `<svg class="fp" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Floor plan of the surgical wing showing where the robot is">
      <g class="fp-rooms">${roomsSvg({ labels, compact })}</g>
      <polyline class="fp-path" points="" />
      <g class="fp-dest" style="display:none"><circle r="10"/><circle r="4" class="fp-pin-dot"/></g>
      <g class="fp-robot" style="display:none"><circle class="fp-robot-halo" r="16"/><circle class="fp-robot-body" r="8"/><path class="fp-robot-dir" d="M 9 0 L 17 0" /></g>
    </svg>`;
    this.svg = el.querySelector('svg');
    this.robot = el.querySelector('.fp-robot');
    this.dest = el.querySelector('.fp-dest');
    this.path = el.querySelector('.fp-path');
    this.rooms = el.querySelector('.fp-rooms');
    this._last = 0;
    this._unsubs = [store.on('pose', () => this.update()), store.on('path', () => this.update(true)), store.on('state', () => this.update(true))];
    this.update(true);
  }
  setHighlight(roomId) {
    if (roomId === this._hl) return;
    this._hl = roomId;
    this.rooms.innerHTML = roomsSvg({ highlight: roomId, ...this.opts });
  }
  update(force = false) {
    const now = performance.now();
    if (!force && now - this._last < 250) return;   // calm: at most 4 updates/s
    this._last = now;
    const S = store.state;
    const p = S.pose;
    if (p && p.frame === 'map') {
      this.robot.style.display = '';
      this.robot.setAttribute('transform', `translate(${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}) rotate(${(-p.yaw * 180 / Math.PI).toFixed(1)})`);
    } else this.robot.style.display = 'none';
    const nav = S.status && S.status.nav;
    const active = nav && ['active', 'sending', 'paused'].includes(nav.state);
    const g = active && nav.goal ? nav.goal : null;
    if (g) { this.dest.style.display = ''; this.dest.setAttribute('transform', `translate(${sx(g.x)} ${sy(g.y)})`); } else this.dest.style.display = 'none';
    const pts = active && S.path && S.path.pts ? S.path.pts : [];
    this.path.setAttribute('points', pts.filter((_, i) => i % 3 === 0 || i === pts.length - 1).map(([x, y]) => `${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join(' '));
  }
  destroy() { this._unsubs.forEach((u) => u()); this.el.innerHTML = ''; }
}
