// Small DOM helpers, toasts, prompts, formatting.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function icon(name) {
  const paths = {
    play: '<path d="M7 5v14l11-7z"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    save: '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v6h8V3M8 21v-7h8v7"/>',
    target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
    pin: '<path d="M12 22s7-7.5 7-12.5A7 7 0 0 0 5 9.5C5 14.5 12 22 12 22z"/><circle cx="12" cy="9.5" r="2.5"/>',
    pose: '<circle cx="12" cy="12" r="3"/><path d="M12 12l7-7M15 5h4v4"/>',
    hand: '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11.5v-8a1.5 1.5 0 0 1 3 0V12M14 11.5V5a1.5 1.5 0 0 1 3 0v8.5M17 10a1.5 1.5 0 0 1 3 0v4a8 8 0 0 1-8 8h-1a7 7 0 0 1-5.6-2.8L3 16a1.5 1.5 0 0 1 2.3-2L8 16"/>',
    fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    follow: '<circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
    route: '<circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="5" r="2.5"/><path d="M8.5 19H15a3.5 3.5 0 0 0 0-7H9a3.5 3.5 0 0 1 0-7h6.5"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
    camera: '<path d="M3 8h4l2-3h6l2 3h4v11H3z"/><circle cx="12" cy="13" r="3.5"/>',
    keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
    home: '<path d="M3 11l9-7 9 7v9h-6v-6H9v6H3z"/>',
  };
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.innerHTML = paths[name] || '';
  return s;
}

export function toast(title, msg = '', level = 'info', ms = 4500) {
  const box = document.getElementById('toasts');
  const t = h('div', { class: `toast ${level}`, role: 'status' },
    h('div', {}, h('div', { class: 't-title' }, title), msg ? h('div', { class: 't-msg' }, msg) : null));
  box.prepend(t);
  while (box.children.length > 5) box.lastChild.remove();
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, ms);
  setTimeout(() => t.remove(), ms + 350);
  return t;
}

// run a robot.request and toast failures (and optionally successes)
export async function act(promise, { success = null, fail = 'Command failed' } = {}) {
  try {
    const r = await promise;
    if (!r.ok) toast(fail, r.message, 'warn', 6000);
    else if (success) toast(success, r.message || '', 'success');
    return r;
  } catch (e) {
    toast(fail, e.message, 'error', 6000);
    return { ok: false, message: e.message };
  }
}

export function prompt(title, { placeholder = '', value = '', okText = 'OK', hint = '' } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', placeholder, value });
    const close = (v) => { back.remove(); resolve(v); };
    const back = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) close(null); } },
      h('div', { class: 'modal', role: 'dialog' },
        h('h2', {}, title),
        hint ? h('div', { class: 'hint' }, hint) : null,
        input,
        h('div', { class: 'row end' },
          h('button', { class: 'btn ghost', onclick: () => close(null) }, 'Cancel'),
          h('button', { class: 'btn primary', onclick: () => close(input.value.trim() || null) }, okText))));
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') close(input.value.trim() || null);
      if (e.key === 'Escape') close(null);
    });
    document.body.append(back);
    input.focus();
    input.select();
  });
}

export function confirmBox(title, text, okText = 'Confirm', danger = false) {
  return new Promise((resolve) => {
    const close = (v) => { back.remove(); resolve(v); };
    const back = h('div', { class: 'modal-back' },
      h('div', { class: 'modal', role: 'dialog' },
        h('h2', {}, title), h('div', { class: 'muted' }, text),
        h('div', { class: 'row end' },
          h('button', { class: 'btn ghost', onclick: () => close(false) }, 'Cancel'),
          h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => close(true) }, okText))));
    document.body.append(back);
  });
}

export const fmt = {
  num: (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? '--' : Number(v).toFixed(d)),
  deg: (rad) => (rad === null || rad === undefined ? '--' : `${(rad * 180 / Math.PI).toFixed(0)}°`),
  age: (s) => (s === null || s === undefined ? '--' : s < 1 ? `${Math.round(s * 1000)} ms` : s < 60 ? `${s.toFixed(1)} s` : `${Math.round(s / 60)} min`),
  time: (t) => new Date(t * 1000).toLocaleTimeString([], { hour12: false }),
  since: (t) => {
    const s = Date.now() / 1000 - t;
    if (s < 60) return `${Math.round(s)} s`;
    if (s < 3600) return `${Math.round(s / 60)} min`;
    return `${(s / 3600).toFixed(1)} h`;
  },
};

// stack state -> tag class
export function stackTag(st) {
  const cls = { running: 'ok', starting: 'info', stopping: 'warn', failed: 'err', external: 'ok' }[st] || '';
  return h('span', { class: `tag ${cls}` }, st || 'stopped');
}

// Attach the MJPEG stream only while frames are arriving (an <img> on a silent multipart stream would
// hold the page's load event and a server connection forever).
export function syncCamera(img, box, st) {
  const cam = st && st.camera;
  const live = !!(cam && cam.age !== null && cam.age !== undefined && cam.age < 3);
  if (live && !img.getAttribute('src')) img.src = `/stream/camera.mjpg?t=${Date.now()}`;
  if (!live && img.getAttribute('src')) img.removeAttribute('src');
  box.classList.toggle('nocam', !live);
  return live;
}
