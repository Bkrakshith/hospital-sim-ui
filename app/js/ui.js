// DOM helpers and the signature interaction controls (05 §5, §9):
//   button()          acts on pointerup inside the target (click), with a pressed state
//   slideToConfirm()  64-pt track, thumb must travel >= 70 %; states the consequence
//   holdToConfirm()   1.5 s press with a filling ring; releasing early cancels
//   sheet()           inset modal that never covers the safety rail
import { icon } from './icons.js';

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  append(el, kids);
  return el;
}

function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

export function ic(name, size = 24) {
  const s = document.createElement('span');
  s.className = 'icw';
  s.innerHTML = icon(name, size);
  return s;
}

// Standard button. `size`: 'clinical' (64) | 'operator' (56) | 'tech' (44).
export function button(label, { icon: iname, kind = 'secondary', size = 'clinical', onClick, disabled, title, aria, cls = '', id } = {}) {
  const b = h('button', {
    class: `btn btn-${kind} btn-${size} ${cls}`.trim(), type: 'button', id,
    'aria-label': aria || (typeof label === 'string' ? label : undefined), title, disabled: !!disabled,
  }, iname ? ic(iname, size === 'tech' ? 20 : 24) : null, label ? h('span', { class: 'btn-label' }, label) : null);
  if (onClick) b.addEventListener('click', (e) => { if (!b.disabled) onClick(e); });
  return b;
}

// ------------------------------------------------------------------ slide to confirm
export function slideToConfirm(text, onConfirm, { kind = 'standby', id, disabled = false, sub } = {}) {
  const track = h('div', {
    class: `slide slide-${kind}`, role: 'slider', tabindex: disabled ? -1 : 0, id,
    'aria-label': `${text}. Slide right to confirm, or press Enter`, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': 0,
    'aria-disabled': disabled ? 'true' : 'false',
  });
  const fill = h('div', { class: 'slide-fill' });
  const label = h('div', { class: 'slide-text' }, h('span', { class: 'slide-main' }, text), sub ? h('span', { class: 'slide-sub' }, sub) : null);
  const thumb = h('div', { class: 'slide-thumb' }, ic('chevron', 28));
  track.append(fill, label, thumb);
  let drag = null;
  const max = () => track.clientWidth - thumb.offsetWidth - 8;
  const set = (x) => {
    const m = max();
    const v = Math.max(0, Math.min(m, x));
    thumb.style.transform = `translateX(${v}px)`;
    fill.style.width = `${v + thumb.offsetWidth / 2 + 4}px`;
    track.setAttribute('aria-valuenow', Math.round((v / Math.max(1, m)) * 100));
    return m ? v / m : 0;
  };
  const reset = () => { track.classList.add('snap'); set(0); setTimeout(() => track.classList.remove('snap'), 220); };
  const fire = () => {
    track.classList.add('done');
    set(max());
    setTimeout(() => { track.classList.remove('done'); reset(); }, 700);
    onConfirm();
  };
  thumb.addEventListener('pointerdown', (e) => {
    if (track.getAttribute('aria-disabled') === 'true') return;
    e.preventDefault();
    thumb.setPointerCapture(e.pointerId);
    drag = { x0: e.clientX };
    track.classList.add('dragging');
  });
  thumb.addEventListener('pointermove', (e) => { if (drag) set(e.clientX - drag.x0); });
  const end = (e) => {
    if (!drag) return;
    const f = set(e.clientX - drag.x0);
    drag = null;
    track.classList.remove('dragging');
    if (e.type === 'pointerup' && f >= 0.7) fire(); else reset();
  };
  thumb.addEventListener('pointerup', end);
  thumb.addEventListener('pointercancel', end);
  track.addEventListener('keydown', (e) => {
    if (track.getAttribute('aria-disabled') === 'true') return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fire(); }
  });
  track.setDisabled = (d) => { track.setAttribute('aria-disabled', d ? 'true' : 'false'); track.tabIndex = d ? -1 : 0; };
  track.setText = (t, s) => { label.querySelector('.slide-main').textContent = t; const ss = label.querySelector('.slide-sub'); if (ss && s !== undefined) ss.textContent = s; track.setAttribute('aria-label', `${t}. Slide right to confirm, or press Enter`); };
  return track;
}

// ------------------------------------------------------------------ hold to confirm
export function holdToConfirm(labelNodes, onConfirm, { ms = 1500, cls = '', aria, id } = {}) {
  const R = 20, C = 2 * Math.PI * R;
  const b = h('button', { class: `hold ${cls}`, type: 'button', 'aria-label': aria, id });
  const ring = h('span', { class: 'hold-ring', html: `<svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true"><circle cx="24" cy="24" r="${R}" class="hold-bg"/><circle cx="24" cy="24" r="${R}" class="hold-fg" stroke-dasharray="${C}" stroke-dashoffset="${C}"/></svg>` });
  b.append(ring, ...[].concat(labelNodes));
  const fg = ring.querySelector('.hold-fg');
  let t0 = 0, raf = 0, fired = false;
  const tick = () => {
    const f = Math.min(1, (performance.now() - t0) / ms);
    fg.style.strokeDashoffset = String(C * (1 - f));
    if (f >= 1) { fired = true; b.classList.remove('holding'); b.classList.add('fired'); setTimeout(() => { b.classList.remove('fired'); fg.style.strokeDashoffset = String(C); }, 900); onConfirm(); return; }
    raf = requestAnimationFrame(tick);
  };
  const start = (e) => { if (e) e.preventDefault(); fired = false; t0 = performance.now(); b.classList.add('holding'); cancelAnimationFrame(raf); raf = requestAnimationFrame(tick); if (e && e.pointerId !== undefined) b.setPointerCapture(e.pointerId); };
  const stop = () => { cancelAnimationFrame(raf); b.classList.remove('holding'); if (!fired) fg.style.strokeDashoffset = String(C); };
  b.addEventListener('pointerdown', start);
  b.addEventListener('pointerup', stop);
  b.addEventListener('pointercancel', stop);
  b.addEventListener('pointerleave', stop);
  // keyboard / switch access: hold Space or Enter
  b.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) start(e); });
  b.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') stop(); });
  b.addEventListener('click', (e) => e.preventDefault());
  return b;
}

// ------------------------------------------------------------------ sheet (modal inset in the content area)
let sheetStack = [];
export function sheet(content, { title, onClose, wide = false, dismissable = true, cls = '' } = {}) {
  const host = document.getElementById('sheet-host');
  const closeBtn = dismissable ? button('Close', { icon: 'x', kind: 'ghost', size: 'operator', cls: 'sheet-close', onClick: () => close() }) : null;
  const panel = h('div', { class: `sheet ${wide ? 'sheet-wide' : ''} ${cls}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog' },
    title || closeBtn ? h('div', { class: 'sheet-head' }, title ? h('h2', { class: 'sheet-title' }, title) : h('span'), closeBtn) : null,
    h('div', { class: 'sheet-body' }, content));
  const scrim = h('div', { class: 'sheet-scrim', onClick: () => { if (dismissable) close(); } });
  const wrap = h('div', { class: 'sheet-wrap' }, scrim, panel);
  host.append(wrap);
  host.hidden = false;
  requestAnimationFrame(() => wrap.classList.add('in'));
  const rec = { wrap, close };
  sheetStack.push(rec);
  function close() {
    if (!wrap.isConnected) return;
    wrap.classList.remove('in');
    sheetStack = sheetStack.filter((s) => s !== rec);
    setTimeout(() => { wrap.remove(); if (!host.children.length) host.hidden = true; }, 180);
    if (onClose) onClose();
  }
  const f = panel.querySelector('button, [tabindex="0"]');
  if (f) setTimeout(() => f.focus({ preventScroll: true }), 50);
  return rec;
}
export function anySheetOpen() { return sheetStack.length > 0; }
export function closeAllSheets() { [...sheetStack].forEach((s) => s.close()); }

// ------------------------------------------------------------------ toast (Info: 3 s max, never over the rail)
export function toast(msg, { level = 'info', icon: iname, ms = 3000 } = {}) {
  const host = document.getElementById('toast-host');
  const t = h('div', { class: `toast toast-${level}`, role: 'status' }, ic(iname || (level === 'ok' ? 'checkCircle' : level === 'warn' ? 'triangle' : 'info'), 22), h('span', {}, msg));
  host.append(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 250); }, Math.min(ms, 3000));
}

// ------------------------------------------------------------------ formatting
export const fmt = {
  time(t) { const d = t instanceof Date ? t : new Date(t * 1000); return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }); },
  timeS(t) { const d = t instanceof Date ? t : new Date(t * 1000); return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); },
  eta(s) {
    if (s === null || s === undefined || !isFinite(s)) return '';
    if (s < 45) return `~${Math.max(5, Math.round(s / 5) * 5)} s`;
    if (s < 90) return '~1 min';
    return `~${Math.round(s / 60)} min`;
  },
  dist(m) { if (m === null || m === undefined || !isFinite(m)) return ''; return m < 10 ? `${m.toFixed(1)} m` : `${Math.round(m)} m`; },
  num(v, d = 1) { return v === null || v === undefined || !isFinite(v) ? '–' : Number(v).toFixed(d); },
  ago(sec) { if (sec === null || sec === undefined) return 'never'; if (sec < 1.5) return 'just now'; if (sec < 90) return `${Math.round(sec)} s ago`; return `${Math.round(sec / 60)} min ago`; },
};

// unit in a lighter weight ("~40 s")
export function numUnit(text) {
  const m = String(text).match(/^(~?[\d.,]+)\s*(.*)$/);
  if (!m) return document.createTextNode(text);
  return h('span', { class: 'nu' }, m[1], m[2] ? h('span', { class: 'unit' }, ' ' + m[2]) : null);
}

export function clear(el) { while (el.firstChild) el.firstChild.remove(); return el; }
