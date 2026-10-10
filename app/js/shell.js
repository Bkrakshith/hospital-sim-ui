// Global chrome present on every screen (04 §4): safety rail, status bar, mode ribbon, alarm / connection
// banners, across-room view, readback card, stop-reason prompt.
import { store, api, device, sourceLabel, whoText } from './client.js';
import { derive, batteryText, linkQuality, estopStatus, topAlarm, unackedAlarms } from './status.js';
import { h, ic, button, holdToConfirm, toast, fmt, clear, anySheetOpen, slideToConfirm } from './ui.js';
import { icon } from './icons.js';
import { sound, speech } from './platform.js';
import { openSignIn, openAlarmList, openProblem, openLease, openHelp, openSettings, openSoundCheck } from './sheets.js';

const S = store.state;
export const shell = { lastStop: 0, myPending: new Set(), stopPressedAt: 0 };

// ================================================================== safety rail
export function renderSafety() {
  const el = document.getElementById('safety');
  clear(el);
  const stop = h('button', { id: 'stop-btn', class: 'stop', type: 'button', 'aria-label': 'Stop the robot. It holds still where it is.' },
    h('span', { class: 'stop-ic', html: icon('stop', 44) }),
    h('span', { class: 'stop-word' }, 'STOP'),
    h('span', { class: 'stop-sub', id: 'stop-sub' }, 'Holds still'));
  // pointerdown, one tap, no confirmation (S-3). Keyboard: Enter/Space via click (no pointer) only.
  stop.addEventListener('pointerdown', (e) => { e.preventDefault(); pressStop('pointer'); });
  stop.addEventListener('click', (e) => { if (e.detail === 0) pressStop('keyboard'); });

  const estop = h('div', { class: 'rail-item rail-estop', id: 'rail-estop', role: 'status', 'aria-label': 'Hardware e-stop remote' });
  const lease = h('button', { class: 'rail-item rail-lease', id: 'rail-lease', type: 'button', onClick: () => openLease() });
  const alarms = h('button', { class: 'rail-item rail-alarms', id: 'rail-alarms', type: 'button', onClick: () => openAlarmList() });
  const power = holdToConfirm([
    h('span', { class: 'hold-word' }, 'Power off'),
    h('span', { class: 'hold-sub' }, 'Hold · robot sinks to the floor'),
  ], () => doPowerOff(), { cls: 'power-off', aria: 'Power off. Press and hold for 1.5 seconds. The robot will sink to the floor.', id: 'power-btn' });
  const powerHint = h('div', { class: 'power-hint', id: 'power-hint', 'aria-hidden': 'true' }, h('strong', {}, 'Keep holding to power off.'), ' The motors switch off and the robot sinks to the floor. Use Stop to make it hold still instead.');
  power.addEventListener('pointerdown', () => powerHint.classList.add('show'));
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => power.addEventListener(ev, () => powerHint.classList.remove('show')));

  el.append(
    h('div', { class: 'stop-zone' }, stop),
    h('div', { class: 'rail-group' }, estop, lease, alarms),
    h('div', { class: 'rail-spacer' }),
    h('div', { class: 'power-zone' }, power, powerHint),
  );
  updateSafety();
}

export async function pressStop(how) {
  const b = document.getElementById('stop-btn');
  shell.stopPressedAt = Date.now();
  if (b) { b.classList.add('fired'); setTimeout(() => b.classList.remove('fired'), 600); }
  // cancel any readback of this iPad that has not been dispatched yet
  for (const id of shell.myPending) api.undo(id);
  if (!S.connected) {
    toast('Stop cannot reach the robot: no connection. Use the hardware e-stop.', { level: 'warn', icon: 'linkOff' });
    return;
  }
  const r = await api.stop();
  if (r.ok) {
    showStopReason();
  } else toast(`Stop: ${r.message}`, { level: 'warn' });
}

async function doPowerOff() {
  const r = await api.powerOff();
  toast(r.ok ? 'Powering off. The robot sinks to the floor.' : `Power off failed: ${r.message}`, { level: r.ok ? 'warn' : 'warn', icon: 'power' });
}

export function updateSafety() {
  const e = S.connected ? estopStatus() : { level: 'unknown', text: 'Unknown: no link to the robot', short: 'unknown' };
  const es = document.getElementById('rail-estop');
  if (es) {
    es.dataset.level = e.level;
    es.innerHTML = `${icon(e.level === 'ok' ? 'checkCircle' : e.level === 'unknown' ? 'info' : 'triangle', 22)}<span class="rail-k">E-stop remote</span><span class="rail-v">${e.short}</span>`;
    es.title = e.text;
    es.setAttribute('aria-label', `Hardware e-stop remote: ${e.text}`);
  }
  const l = document.getElementById('rail-lease');
  if (l) {
    const holder = S.lease.holder;
    const v = !S.connected ? 'Unknown' : S.lease.you ? 'This iPad' : holder ? (holder.device_name || 'Other iPad') : 'Nobody';
    l.dataset.you = S.lease.you ? '1' : '0';
    l.dataset.held = holder ? '1' : '0';
    l.innerHTML = `${icon(S.lease.you ? 'hand' : holder ? 'people' : 'unlock', 22)}<span class="rail-k">Control</span><span class="rail-v">${v}</span>`;
    l.setAttribute('aria-label', `Manual control: ${v}. Tap for details.`);
  }
  const a = document.getElementById('rail-alarms');
  if (a) {
    const c = S.alarms.counts || {};
    const n = (c.high || 0) + (c.medium || 0) + (c.low || 0);
    const top = c.high ? 'high' : c.medium ? 'medium' : c.low ? 'low' : 'none';
    a.dataset.level = top;
    a.innerHTML = `${icon(top === 'high' ? 'octagon' : top === 'medium' ? 'triangle' : top === 'low' ? 'info' : 'bell', 22)}<span class="rail-k">Alarms</span><span class="rail-v">${n ? n : 'None'}</span>`;
    a.setAttribute('aria-label', `Alarms: ${n || 'none'}. Tap to see the list.`);
  }
  const sub = document.getElementById('stop-sub');
  if (sub) sub.textContent = !S.connected ? 'No link' : (S.mode && S.mode.name === 'DAMP') ? 'Powered down' : 'Holds still';
  const sb = document.getElementById('stop-btn');
  if (sb) sb.classList.toggle('offline', !S.connected);
}

// ================================================================== status bar
const ROLE_WORD = { clinical: 'Clinical', operator: 'Operator', technician: 'Technician' };
export function renderStatusbar() {
  const el = document.getElementById('statusbar');
  clear(el);
  const role = S.session.role || 'clinical';
  const place = S.places.find((p) => p.id === device.place);
  const roleChip = h('button', { class: `chip chip-role role-${role}`, id: 'role-chip', type: 'button', onClick: () => openSignIn(), 'aria-label': role === 'clinical' ? 'Clinical mode. Tap to sign in as operator or technician.' : `${ROLE_WORD[role]} ${S.session.user || ''}. Tap to sign out or switch.` },
    ic(role === 'clinical' ? 'user' : role === 'operator' ? 'joystick' : 'wrench', 20),
    h('span', {}, ROLE_WORD[role] + (S.session.user && role !== 'clinical' ? ` · ${S.session.user}` : '')),
    role === 'clinical' ? h('span', { class: 'chip-hint' }, 'Sign in') : h('span', { class: 'chip-hint' }, 'Done'));
  el.append(
    h('div', { class: 'sb-left' },
      h('button', { class: 'sb-place', type: 'button', onClick: () => openSettings(), 'aria-label': `This iPad: ${device.name} at ${place ? place.name : 'unknown place'}. Tap for settings.` },
        h('span', { class: 'sb-room' }, place ? place.name : 'Surgical wing'), h('span', { class: 'sb-dev' }, device.name)),
      roleChip,
      h('span', { class: 'chip chip-rec', id: 'sb-rec', hidden: true }, h('span', { class: 'rec-dot' }), 'REC'),
      h('span', { class: 'chip chip-sim', id: 'sb-sim', hidden: true }, ic('sim', 18), h('span', { id: 'sb-sim-t' }, 'Simulation')),
    ),
    h('div', { class: 'sb-right' },
      h('span', { class: 'sb-item', id: 'sb-batt' }),
      h('span', { class: 'sb-item', id: 'sb-link' }),
      h('button', { class: 'sb-btn', id: 'sb-sound', type: 'button', onClick: () => openSoundCheck() }),
      h('button', { class: 'sb-btn', id: 'sb-theme', type: 'button', onClick: () => toggleTheme() }),
      h('button', { class: 'sb-btn', id: 'sb-help', type: 'button', 'aria-label': 'Help', onClick: () => openHelp() }, ic('help', 24)),
      h('span', { class: 'sb-clock', id: 'sb-clock' }),
    ),
  );
  updateStatusbar();
}

export function updateStatusbar() {
  const b = batteryText();
  const bt = document.getElementById('sb-batt');
  if (bt) {
    bt.dataset.level = b.level;
    const pct = b.soc === null ? 0 : Math.max(0, Math.min(100, b.soc));
    bt.innerHTML = `<span class="batt" aria-hidden="true"><span class="batt-fill" style="width:${pct}%"></span></span><span class="sb-v">${b.text}</span>`;
    bt.setAttribute('aria-label', b.soc === null ? 'Robot battery not reported' : `Robot battery ${Math.round(b.soc)} percent, about ${b.text} left`);
    bt.setAttribute('role', 'img');
  }
  const q = linkQuality();
  const lk = document.getElementById('sb-link');
  if (lk) {
    lk.dataset.q = q;
    lk.innerHTML = `<span class="bars" aria-hidden="true">${[1, 2, 3, 4].map((i) => `<i class="${i <= q ? 'on' : ''}" style="height:${4 + i * 4}px"></i>`).join('')}</span><span class="sb-v">${q ? 'Link' : 'No link'}</span>`;
    lk.setAttribute('role', 'img');
    lk.setAttribute('aria-label', q ? `Link to robot: ${q} of 4 bars` : 'No link to the robot');
  }
  const snd = document.getElementById('sb-sound');
  if (snd) {
    snd.innerHTML = icon(sound.muted ? 'speakerOff' : 'speaker', 24) + (sound.verified ? '' : '<span class="sb-dot" title="Sound not checked"></span>');
    snd.setAttribute('aria-label', sound.verified ? 'Sound checked. Tap to test again.' : 'Sound not checked yet. Tap for a sound check.');
  }
  const th = document.getElementById('sb-theme');
  if (th) {
    const dim = document.documentElement.dataset.theme === 'dim';
    th.innerHTML = icon(dim ? 'sun' : 'moon', 24);
    th.setAttribute('aria-label', dim ? 'Switch to Light theme' : 'Switch to Theatre dim theme');
  }
  const rec = document.getElementById('sb-rec');
  if (rec) rec.hidden = !(S.mission && S.mission.recording);
  const sim = document.getElementById('sb-sim');
  if (sim) {
    const isSim = !!(S.hello && (S.hello.mock || S.hello.use_sim_time));
    sim.hidden = !isSim;
    const t = document.getElementById('sb-sim-t');
    if (t) t.textContent = S.hello && S.hello.mock ? 'Mock robot' : 'Simulation';
  }
  const ck = document.getElementById('sb-clock');
  if (ck) ck.textContent = fmt.time(new Date());
}

export function toggleTheme() {
  const root = document.documentElement;
  const next = root.dataset.theme === 'dim' ? 'light' : 'dim';
  root.classList.add('theme-fade');
  root.dataset.theme = next;
  root.style.background = next === 'dim' ? '#07090C' : '#F4F6F8';
  const m = document.getElementById('meta-theme'); if (m) m.content = next === 'dim' ? '#07090C' : '#F4F6F8';
  try { localStorage.setItem('g1.theme', JSON.stringify(next)); } catch { /* ignore */ }
  setTimeout(() => root.classList.remove('theme-fade'), 350);
  store.emit('theme', next);
  updateStatusbar();
}

// ================================================================== mode ribbon
let lastFam = null;
export function updateRibbon() {
  const el = document.getElementById('ribbon');
  const d = derive();
  const app = document.getElementById('app');
  app.dataset.fam = d.fam;
  app.dataset.link = S.connected ? 'up' : 'down';
  if (d.alarm && d.alarm.priority === 'high' && !d.alarm.acknowledged) app.dataset.alarm = 'high'; else delete app.dataset.alarm;
  const sweep = lastFam !== null && lastFam !== d.fam;
  lastFam = d.fam;
  const famWord = !S.connected ? 'No link · last known' : { robot: 'Robot driving', person: 'Person driving', standby: 'Standing by', off: 'Powered down', stopped: 'Stopped', unknown: 'No status' }[d.fam];
  const changed = S.connected ? d.changed : null;
  el.innerHTML = '';
  el.className = `ribbon fam-${S.connected ? d.fam : 'unknown'}${sweep ? ' sweep' : ''}`;
  el.append(
    h('div', { class: 'rb-icon', html: icon(d.fam === 'person' ? (d.rawMode === 'LOCO' ? 'handWalk' : 'handArm') : d.icon, 30) }),
    h('div', { class: 'rb-main' },
      h('div', { class: 'rb-mode' }, famWord !== d.mode ? [h('span', { class: 'rb-fam' }, famWord), h('span', { class: 'rb-sep', 'aria-hidden': 'true' }, '·')] : null, h('span', { class: 'rb-text' }, d.mode),
        d.progress && d.progress.dist !== undefined && d.progress.dist !== null ? h('span', { class: 'rb-meta' }, ` · ${fmt.dist(d.progress.dist)} · ${fmt.eta(d.progress.eta)}`) : null),
      changed ? h('div', { class: `rb-changed${changed.fresh ? ' fresh' : ''}` }, changed.at ? `${changed.fresh ? 'Now: ' : ''}${changed.text} · ${fmt.time(new Date(changed.at))}` : changed.text) : null),
    h('div', { class: 'rb-ctrl' }, h('span', { class: 'rb-k' }, 'Controlled by'), h('span', { class: 'rb-v' }, S.connected ? d.controller : 'Unknown')),
  );
  if (d.fam === 'stopped' && d.hold) {
    const by = String(d.hold.source || '') === `ui:${device.id}` ? 'you (this iPad)' : whoText(d.hold.by) || (S.mode && sourceLabel(S.mode.source));
    el.querySelector('.rb-text').textContent = `Stopped${by ? ' by ' + by : ''}${d.hold.since ? ' · ' + fmt.time(d.hold.since) : ''}`;
  }
  if (sweep) setTimeout(() => el.classList.remove('sweep'), 400);
  if (changed && changed.fresh) setTimeout(updateRibbon, 5100 - (Date.now() - changed.at));
}

// ================================================================== banners (connection + alarm + sign-out warning)
export function updateBanners() {
  const el = document.getElementById('banners');
  clear(el);
  if (!S.connected && S.everConnected !== undefined) {
    const secs = S.lostAt ? Math.round((Date.now() - S.lostAt) / 1000) : null;
    const m = S.mode ? S.mode.name : null;
    const manual = m === 'LOCO' || m === 'MANIP';
    el.append(h('div', { class: 'banner banner-link', role: 'alert' },
      h('span', { class: 'bn-icon', html: icon('linkOff', 32) }),
      h('div', { class: 'bn-text' },
        h('div', { class: 'bn-what' }, S.everConnected ? `No connection to the robot${secs !== null ? ` for ${secs} s` : ''}` : 'Connecting to the robot…'),
        h('div', { class: 'bn-do' }, S.everConnected
          ? (manual ? 'Manual control stops: the robot holds still within 1 s. ' : 'The robot holds still if someone was driving it by hand; a task it was already doing continues. ')
            + 'Stop on this iPad cannot reach it now. Use the hardware e-stop if you need to stop it.'
          : 'Stop works once connected. Keep the hardware e-stop within reach.')),
      h('span', { class: 'bn-spin', 'aria-hidden': 'true' })));
  }
  if (S.connected && S.protocolChecked && !S.v2) {
    el.append(h('div', { class: 'banner banner-link', role: 'alert' }, h('span', { class: 'bn-icon', html: icon('triangle', 32) }),
      h('div', { class: 'bn-text' }, h('div', { class: 'bn-what' }, 'This robot server is too old for the iPad app'),
        h('div', { class: 'bn-do' }, 'It speaks protocol 1: no roles, no Stop hold, no readback. Use the engineering console at /console/ and ask a technician to update the server. Keep the hardware e-stop within reach.'))));
  }
  const a = topAlarm();
  if (a && S.connected) {
    const cls = `banner banner-alarm pri-${a.priority}${a.acknowledged ? ' acked' : ''}`;
    const others = unackedAlarms().length - (a.acknowledged ? 0 : 1);
    const ack = !a.acknowledged ? button('Acknowledge', { kind: 'onfill', size: 'clinical', icon: 'check', onClick: async () => { const r = await api.ackAlarm(a.id); if (!r.ok) toast(r.message, { level: 'warn' }); } }) : null;
    el.append(h('div', { class: cls, role: a.priority === 'low' ? 'status' : 'alert' },
      h('span', { class: 'bn-icon', html: icon(a.priority === 'high' ? 'octagon' : a.priority === 'medium' ? 'triangle' : 'info', 32) }),
      h('div', { class: 'bn-text' },
        h('div', { class: 'bn-what' }, a.what, a.acknowledged ? h('span', { class: 'bn-ack' }, ` · acknowledged by ${whoText(a.acknowledged.by) || 'someone'}`) : null),
        a.priority !== 'low' || !a.acknowledged ? h('div', { class: 'bn-do' }, a.do, a.who ? h('span', { class: 'bn-who' }, ` Who: ${String(a.who).replace(/\.$/, '')}.`) : null) : null),
      h('div', { class: 'bn-actions' },
        ack,
        a.priority !== 'low' ? button('Send to technician', { kind: 'onfill-ghost', size: 'clinical', icon: 'send', onClick: () => openProblem({ alarm: a }) }) : null,
        others > 0 ? button(`All alarms (${others + 1})`, { kind: 'onfill-ghost', size: 'clinical', onClick: () => openAlarmList() }) : null)));
  }
  if (shell.idleWarn) {
    el.append(h('div', { class: 'banner banner-info', role: 'status' },
      h('span', { class: 'bn-icon', html: icon('clock', 28) }),
      h('div', { class: 'bn-text' }, h('div', { class: 'bn-what' }, `Signing out in ${shell.idleWarn} s`), h('div', { class: 'bn-do' }, 'Touch the screen to stay signed in. The iPad goes back to Clinical mode.'))));
  }
}

// ================================================================== readback card (HF-6, F2 step 3, F3 step 3)
export function showReadback(p) {
  const main = document.getElementById('float-host');
  const old = document.getElementById('readback');
  if (old) old.remove();
  const undoS = p.undo_s || 3;
  const card = h('div', { class: 'readback', id: 'readback', role: 'alertdialog', 'aria-label': p.text },
    h('div', { class: 'rbk-kicker' }, ic(p.kind === 'instrument_request' ? 'handover' : 'robotArrow', 26), p.kind === 'instrument_request' ? 'Request' : 'Sending'),
    h('div', { class: 'rbk-text' }, p.text),
    h('div', { class: 'rbk-sub', id: 'rbk-sub' }, 'The robot says this out loud. Undo if it is wrong.'),
    h('div', { class: 'rbk-actions' },
      h('button', { class: 'btn btn-undo btn-clinical', id: 'rbk-undo', type: 'button', 'aria-label': 'Undo' },
        h('span', { class: 'undo-ring', html: `<svg viewBox="0 0 44 44" width="44" height="44" aria-hidden="true"><circle cx="22" cy="22" r="18" class="ur-bg"/><circle cx="22" cy="22" r="18" class="ur-fg" style="animation-duration:${undoS}s"/></svg>` }),
        h('span', { class: 'btn-label' }, 'Undo'), h('span', { class: 'undo-s', id: 'undo-s' }, `${undoS}`))));
  main.append(card);
  main.classList.add('scrim');
  requestAnimationFrame(() => card.classList.add('in'));
  const t0 = Date.now();
  const iv = setInterval(() => {
    const left = Math.max(0, undoS - Math.floor((Date.now() - t0) / 1000));
    const u = document.getElementById('undo-s'); if (u) u.textContent = String(left);
  }, 200);
  card.querySelector('#rbk-undo').addEventListener('click', async () => {
    const r = await api.undo(p.id);
    if (r.ok) { finish('Cancelled. Nothing was sent.', 'ok'); }
    else toast(r.message, { level: 'warn' });
  });
  function finish(text, level) {
    clearInterval(iv);
    card.classList.add('done', level === 'fail' ? 'failed' : 'ok');
    const sub = card.querySelector('#rbk-sub'); if (sub) sub.textContent = text;
    const ub = card.querySelector('#rbk-undo'); if (ub) ub.remove();
    setTimeout(() => { card.classList.remove('in'); main.classList.remove('scrim'); setTimeout(() => card.remove(), 250); }, level === 'fail' ? 4500 : 1400);
  }
  card.finish = finish;
  if (device.speak) speech.say(p.speak || p.text);
  return card;
}

// ================================================================== stop reason (F5 step 3, non-blocking)
export function showStopReason() {
  const old = document.getElementById('stop-reason');
  if (old) old.remove();
  const chip = (id, label) => h('button', { class: 'chip-btn', type: 'button', onClick: async () => {
    await api.stopReason(id);
    card.remove();
    if (id === 'behaving_oddly') openProblem({ chips: ['behaving_oddly'] });
    else toast('Thank you. Noted in the log.', { level: 'ok' });
  } }, label);
  const card = h('div', { class: 'stop-reason', id: 'stop-reason', role: 'region', 'aria-label': 'Why did you stop the robot? Optional.' },
    h('div', { class: 'sr-head' }, h('span', { class: 'sr-title' }, 'Stopped. Why? (optional)'), button('', { icon: 'x', kind: 'ghost', size: 'operator', aria: 'Dismiss', onClick: () => card.remove() })),
    h('div', { class: 'sr-chips' }, chip('person_in_way', 'Person in the way'), chip('wrong_task', 'Wrong task'), chip('behaving_oddly', 'Robot behaving oddly'), chip('other', 'Other')));
  document.getElementById('float-host').append(card);
  requestAnimationFrame(() => card.classList.add('in'));
  setTimeout(() => { if (card.isConnected) { card.classList.remove('in'); setTimeout(() => card.remove(), 250); } }, 20000);
}

// ================================================================== across-room view (HF-21)
export const across = {
  shown: false,
  show() {
    if (this.shown) return;
    this.shown = true;
    const el = document.getElementById('across');
    el.hidden = false;
    this.render();
    requestAnimationFrame(() => el.classList.add('in'));
    document.getElementById('app').dataset.across = '1';
  },
  hide() {
    if (!this.shown) return;
    this.shown = false;
    const el = document.getElementById('across');
    el.classList.remove('in');
    delete document.getElementById('app').dataset.across;
    setTimeout(() => { if (!this.shown) el.hidden = true; }, 250);
  },
  render() {
    if (!this.shown) return;
    const el = document.getElementById('across');
    const d = derive();
    const p = d.progress;
    const alarm = d.alarm && !d.alarm.acknowledged ? d.alarm : null;
    el.className = `across in lvl-${d.status.level} fam-${d.fam}`;
    el.innerHTML = '';
    const arc = p && p.frac !== null && p.frac !== undefined ? `<svg class="ac-arc" viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="52" class="ac-arc-bg"/><circle cx="60" cy="60" r="52" class="ac-arc-fg" style="stroke-dashoffset:${(326.7 * (1 - p.frac)).toFixed(1)}"/></svg>` : '';
    el.append(
      h('div', { class: 'ac-top' }, h('span', { class: 'ac-fam' }, ic(d.fam === 'person' ? 'hand' : d.icon, 34), d.mode), h('span', { class: 'ac-clock' }, fmt.time(new Date()))),
      h('div', { class: 'ac-body' },
        h('div', { class: `ac-status st-${d.status.level}` }, h('span', { class: 'ac-st-ic', html: icon(d.status.icon, 84) }), h('span', {}, d.status.word)),
        h('div', { class: 'ac-activity' }, alarm ? alarm.what : d.activity),
        h('div', { class: 'ac-next' }, alarm ? d.next : d.next),
        p ? h('div', { class: 'ac-progress', html: `${arc}<span class="ac-eta">${fmt.eta(p.eta)}</span>` }) : null),
      h('div', { class: 'ac-foot' }, 'Tap anywhere to wake. The first tap does nothing else.'),
    );
  },
};

// ================================================================== pending (readback) wiring
const cards = new Map();
// Send a request that gets a server-side readback (send_to / instrument_request). The `pending` broadcast can
// arrive before the op's result, so we expect one of this kind for a short while.
export async function dispatchRequest(kind, fn) {
  shell.expect = { kind, until: Date.now() + 4000 };
  const r = await fn();
  shell.expect = null;
  const p = r && r.data && r.data.pending;
  if (r.ok && p && !cards.has(p.id) && !p.local) { shell.myPending.add(p.id); cards.set(p.id, showReadback(p)); }
  if (r.ok && p) shell.myPending.add(p.id);
  if (!r.ok) toast(plainRefusal(r), { level: 'warn' });
  return r;
}

// server refusal codes in plain words (the raw message is kept for technicians in the audit log)
const REFUSALS = {
  no_mission: 'Scrub assist is not running on the robot. An operator starts it, or hand the instrument over by hand.',
  not_on_rack: null, forbidden: 'That needs an operator or technician sign-in.',
};
export function plainRefusal(r) {
  const code = r && r.data && r.data.code;
  return (code && REFUSALS[code]) || (r && r.message) || 'The robot did not accept that';
}

export function wirePending() {
  store.on('pending', (p) => {
    // show the big card on the device that asked; others get a quiet toast
    const mine = shell.myPending.has(p.id) || p.local || (shell.expect && shell.expect.kind === p.kind && Date.now() < shell.expect.until);
    if (mine) { shell.myPending.add(p.id); shell.expect = null; cards.set(p.id, showReadback(p)); }
    else toast(p.text, { icon: p.kind === 'instrument_request' ? 'handover' : 'robotArrow' });
  });
  store.on('pending_done', (d) => {
    const c = cards.get(d.id);
    shell.myPending.delete(d.id);
    cards.delete(d.id);
    if (!c) return;
    if (d.cancelled) c.finish('Cancelled. Nothing was sent.', 'ok');
    else if (d.ok) { c.finish('Sent to the robot.', 'ok'); sound.done(); }
    else c.finish(`Not sent: ${d.message || 'the robot refused'}`, 'fail');
  });
}

