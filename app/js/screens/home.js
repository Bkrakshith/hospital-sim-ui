// Home (every role): hero status card (now · OK? · next, 44/34/22 pt) with a live floor plan, the four goal
// tiles, recovery after Stop (Resume slide / Cancel task / Send to technician), and the last events.
import { standUp } from '../goals.js';
import { store, api, device, isV2, placeName, sourceLabel } from '../client.js';
import { derive, batteryText } from '../status.js';
import { h, ic, button, slideToConfirm, toast, fmt, clear, numUnit } from '../ui.js';
import { icon } from '../icons.js';
import { FloorPlan } from '../floorplan.js';
import { dispatchRequest } from '../shell.js';
import { openProblem, sheetState } from '../sheets.js';

const S = store.state;

// Why a clinical goal tile is disabled right now (null = enabled). F2 failure branch, 04 §6.2.
export function motionBlock() {
  if (!S.connected) return 'No connection to the robot';
  const m = S.mode && S.mode.name;
  if (!m) return 'Waiting for the robot to report its mode';
  if (m === 'DAMP') return 'Robot is powered down. A technician stands it up first';
  if (S.hold || m === 'HOLD') return 'Robot is stopped. Resume or cancel first';
  if ((m === 'LOCO' || m === 'MANIP') && !S.lease.you) {
    const hd = S.lease.holder;
    return `${hd && hd.user ? hd.user : 'An operator'} is driving it by hand. Ask them, or take control`;
  }
  if (S.lease.holder && !S.lease.you) return `${S.lease.holder.user || S.lease.holder.device_name || 'Another iPad'} has control. Ask them to hand it back`;
  if (S.motion && S.motion.locked) return `Motion locked: ${(S.motion.reasons || ['start-up check not passed'])[0]}`;
  return null;
}

export function mount(el, { go }) {
  const hero = h('section', { class: 'card hero', 'aria-label': 'Robot status' });
  const tiles = h('section', { class: 'tiles', 'aria-label': 'Actions' });
  const tl = h('section', { class: 'timeline', 'aria-label': 'Recent events' });
  const extras = h('div', { class: 'home-extras' });
  el.append(h('div', { class: 'home' }, hero, h('div', { class: 'home-side' }, tiles, extras), tl));

  // ---- hero skeleton
  const stWord = h('div', { class: 'hero-status' });
  const activity = h('div', { class: 'hero-activity' });
  const next = h('div', { class: 'hero-next' });
  const prog = h('div', { class: 'hero-progress' });
  const recover = h('div', { class: 'hero-recover' });
  const note = h('div', { class: 'hero-note' });
  const plan = h('div', { class: 'hero-plan' });
  const where = h('div', { class: 'hero-where' });
  hero.append(h('div', { class: 'hero-text' }, stWord, activity, next, prog, recover, note), h('div', { class: 'hero-map' }, plan, where));
  const fp = new FloorPlan(plan, { labels: true, compact: true });

  let lastKey = '';
  const renderHero = () => {
    const d = derive();
    hero.dataset.level = d.status.level;
    hero.dataset.fam = d.fam;
    stWord.className = `hero-status st-${d.status.level}`;
    stWord.innerHTML = `${icon(d.status.icon, 44)}<span>${d.status.word}</span>`;
    activity.textContent = d.activity;
    next.textContent = d.next ? `Next: ${d.next.replace(/^Next: /, '')}` : '';
    if (d.status.level === 'alarm') next.textContent = d.next;
    // progress
    clear(prog);
    if (d.progress && d.progress.frac !== null && d.progress.frac !== undefined) {
      prog.append(h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(d.progress.frac * 100), 'aria-label': 'Trip progress' }, h('span', { style: { width: `${Math.round(d.progress.frac * 100)}%` } })),
        h('div', { class: 'bar-meta' }, h('span', {}, fmt.dist(d.progress.dist), ' to go'), h('span', { class: 'eta' }, numUnit(fmt.eta(d.progress.eta)))));
    } else if (d.mission && d.mission.instrument) {
      prog.append(stepper(d.mission.reqIdx));
    }
    const b = batteryText();
    where.innerHTML = '';
    where.append(h('span', {}, ic('pin', 20), d.here || 'Position unknown: no map loaded'), h('span', { class: `batt-t lvl-${b.level}` }, ic('battery', 20), b.soc === null ? 'Battery –' : `${b.text} left`));
    fp.setHighlight(null);
    // recovery / context actions: only rebuild when their inputs change (keep slides stable under the finger)
    const key = JSON.stringify([d.fam, d.hold && d.hold.resume_task, d.hold && d.hold.resume_blocked, d.nav && d.nav.state, d.mission && d.mission.state, S.session.role, S.connected, sheetState.lastIncident && sheetState.lastIncident.id]);
    if (key !== lastKey) { lastKey = key; renderRecover(d); }
  };

  const renderRecover = (d) => {
    clear(recover); clear(note);
    if (!S.connected) return;
    if (d.fam === 'stopped') {
      const task = d.hold && d.hold.resume_task;
      const blocked = d.hold && d.hold.resume_blocked;
      if (blocked) recover.append(h('p', { class: 'note note-warn' }, ic('triangle', 22), blocked));
      if (task) {
        recover.append(slideToConfirm(`Slide to ${task.text.charAt(0).toLowerCase()}${task.text.slice(1)}`, async () => {
          const r = await api.resume('task'); toast(r.ok ? (r.data && r.data.did) || 'Continuing' : r.message, { level: r.ok ? 'ok' : 'warn' });
        }, { kind: 'robot', id: 'resume-task', disabled: !!blocked, sub: 'The robot starts moving again' }));
      }
      recover.append(h('div', { class: 'row gap wrap' },
        task ? button('Cancel task', { icon: 'x', onClick: async () => { const r = await api.cancelTask(); toast(r.ok ? 'Task cancelled. The robot stays standing.' : r.message, { level: r.ok ? 'ok' : 'warn' }); } }) : null,
        !task ? slideToConfirm('Slide to stand normally', async () => {
          const r = await api.resume('stand'); toast(r.ok ? 'Standing by. Arms return to rest.' : r.message, { level: r.ok ? 'ok' : 'warn' });
        }, { kind: 'standby', id: 'resume-stand', disabled: !!blocked, sub: 'Arms move slowly back to rest' }) : null,
        button('Send problem to technician', { icon: 'send', kind: 'ghost', onClick: () => openProblem({}) })));
    } else if (d.fam === 'off') {
      if (S.session.role === 'technician') {
        recover.append(slideToConfirm('Slide to stand up', () => standUp(), { kind: 'standby', id: 'stand-up', sub: 'Robot on the gantry, area clear' }));
      } else recover.append(h('p', { class: 'muted' }, 'Clinical and operator users cannot stand the robot up from powered down. It needs the gantry and a technician.'));
    } else if (d.fam === 'robot' && (d.nav || d.mission)) {
      recover.append(h('div', { class: 'row gap wrap' },
        button('Cancel task', { icon: 'x', onClick: async () => { const r = await api.cancelTask(); toast(r.ok ? 'Task cancelled. The robot stays standing.' : r.message, { level: r.ok ? 'ok' : 'warn' }); } })));
    }
    const inc = sheetState.lastIncident;
    if (inc && Date.now() / 1000 - inc.t < 1800) note.append(h('p', { class: 'note note-info' }, ic('send', 22), `Technician notified ${fmt.time(inc.t)}${inc.id ? ' · ' + inc.id : ''}${d.fam === 'stopped' ? ' · robot holding' : ''}`));
    if (S.motion && S.motion.locked && d.fam !== 'off') note.append(h('p', { class: 'note note-warn' }, ic('lock', 22), `Moving is locked: ${(S.motion.reasons || []).join(', ') || 'start-up check needed'}.`));
  };

  // ---- tiles
  const tile = (id, iname, title, onTap) => {
    const sub = h('span', { class: 'tile-sub' });
    const b = h('button', { class: 'tile', id: `tile-${id}`, type: 'button', onClick: () => { if (!b.getAttribute('aria-disabled') || b.getAttribute('aria-disabled') === 'false') onTap(); else toast(b.dataset.why, { icon: 'info' }); } },
      h('span', { class: 'tile-ic', html: icon(iname, 40) }), h('span', { class: 'tile-t' }, title), sub);
    b.sub = sub;
    return b;
  };
  const tSend = tile('send', 'pin', 'Send to…', () => go('places'));
  const tInst = tile('instrument', 'handover', 'Request instrument', () => go('instruments'));
  const tCome = tile('come', 'comeHere', 'Come here', () => dispatchRequest('send_to', () => api.comeHere()));
  const tDock = tile('dock', 'dock', 'Go to dock', () => dispatchRequest('send_to', () => api.dock()));
  tiles.append(tSend, tInst, tCome, tDock);

  const renderTiles = () => {
    const why = motionBlock();
    const here = placeName(device.place);
    const mis = S.mission;
    const scrubActive = mis && mis.state && !['idle', 'succeeded', 'failed', 'aborted'].includes(mis.state);
    for (const [t, sub, open] of [
      [tSend, 'Pick a room', false],
      [tInst, scrubActive ? 'Scrub assist is running' : 'Starts scrub assist in Theatre 1', false],
      [tCome, `To ${here}`, false],
      [tDock, 'Corridor, west end', false],
    ]) {
      // Send to / Instruments open a picker (always allowed); the picker explains any block too
      const dis = !!why && (t === tCome || t === tDock);
      t.setAttribute('aria-disabled', dis ? 'true' : 'false');
      t.dataset.why = why || '';
      t.sub.textContent = dis ? why : sub;
      t.classList.toggle('blocked', dis);
    }
  };

  // ---- extras
  extras.append(
    button('Send problem to technician', { icon: 'send', kind: 'secondary', onClick: () => openProblem({}) }),
    button('Clean screen', { icon: 'clean', kind: 'secondary', onClick: () => window.G1.startCleanMode(30) }));

  // ---- timeline strip (last 3 events)
  const renderTimeline = () => {
    clear(tl);
    const evs = S.timeline.slice(-3).reverse();
    tl.append(h('h2', { class: 'tl-h' }, 'Latest'));
    if (!evs.length) { tl.append(h('div', { class: 'tl-empty' }, 'Nothing yet today. Events like arrivals and handed instruments appear here.')); return; }
    const ul = h('ul', { class: 'tl-strip' });
    for (const e of evs) ul.append(h('li', {}, h('span', { class: 'tl-t' }, fmt.time(e.t)), ic(evIcon(e.kind), 20), h('span', { class: 'tl-x' }, e.text), null));
    tl.append(ul);
  };

  const all = () => { renderHero(); renderTiles(); };
  all(); renderTimeline();
  const offs = [
    store.on('state', all), store.on('mode', all), store.on('alarms', all), store.on('lease', all), store.on('mission', all),
    store.on('connection', all), store.on('session', all), store.on('incident', () => { lastKey = ''; all(); }),
    store.on('event', renderTimeline), store.on('hello', renderTimeline),
  ];
  return () => { offs.forEach((o) => o()); fp.destroy(); };
}

export function evIcon(kind) {
  return ({ arrived: 'pin', handed: 'handover', request: 'handover', send_to: 'robotArrow', mode: 'status', stop: 'stop', alarm: 'triangle', alarm_ack: 'check', clean: 'clean', lease: 'hand', incident: 'send', check: 'checks', power_off: 'power' })[kind] || 'info';
}

// F3 step 4 request stepper
import { REQUEST_STEPS } from '../data.js';
export function stepper(idx) {
  const ol = h('ol', { class: 'req-steps', 'aria-label': 'Request progress' });
  REQUEST_STEPS.forEach((s, i) => {
    const st = idx < 0 ? 'todo' : i < idx ? 'done' : i === idx ? 'now' : 'todo';
    ol.append(h('li', { class: `rs-${st}`, 'aria-current': st === 'now' ? 'step' : undefined }, h('span', { class: 'rs-dot', html: st === 'done' ? icon('check', 16) : '' }), h('span', { class: 'rs-l' }, s.label)));
  });
  return ol;
}
