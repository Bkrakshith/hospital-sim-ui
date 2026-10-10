// Checks (F1, F7, F8): start-of-day (automatic checks + the ~60 s nurse part, including pressing Stop),
// shift handover card, end of shift (dock, cleaning checklist, clean-screen lock).
import { standUp } from '../goals.js';
import { store, api, isV2, instrumentName, modeLabel, addEvent, device } from '../client.js';
import { h, ic, button, slideToConfirm, toast, fmt, clear } from '../ui.js';
import { icon } from '../icons.js';
import { shell, dispatchRequest } from '../shell.js';
import { derive, batteryText } from '../status.js';
import { sound } from '../platform.js';

const S = store.state;
let tab = 'start';

export function mount(el) {
  const tabs = h('div', { class: 'seg seg-lg', role: 'tablist', 'aria-label': 'Checks' });
  const body = h('div', { class: 'checks-body' });
  el.append(h('header', { class: 'screen-head' }, h('div', {}, h('h1', {}, 'Checks'), h('p', { class: 'muted' }, 'Start of day, shift handover and end of shift.')), tabs), body);
  let cleanup = null;
  const drawTabs = () => {
    clear(tabs);
    for (const [id, label, ico] of [['start', 'Start of day', 'checks'], ['handover', 'Handover card', 'people'], ['end', 'End of shift', 'dock']]) {
      tabs.append(h('button', { class: `seg-b${tab === id ? ' on' : ''}`, type: 'button', role: 'tab', 'aria-selected': tab === id ? 'true' : 'false', onClick: () => { tab = id; drawTabs(); show(); } }, ic(ico, 22), label));
    }
  };
  const show = () => {
    if (cleanup) cleanup();
    clear(body);
    cleanup = tab === 'start' ? startOfDay(body) : tab === 'handover' ? handover(body) : endOfShift(body);
  };
  drawTabs(); show();
  return () => { if (cleanup) cleanup(); };
}

// ------------------------------------------------------------------ start of day
function startOfDay(el) {
  const auto = h('section', { class: 'card checks-auto' });
  const nurse = h('section', { class: 'card nurse-check' });
  el.append(h('div', { class: 'checks-grid' }, nurse, auto));
  let result = null;
  const renderAuto = async () => {
    const r = await api.checksRun();
    result = r.ok ? r.data : null;
    clear(auto);
    auto.append(h('div', { class: 'card-h' }, h('h2', {}, 'Robot checks'), button('Run again', { size: 'operator', kind: 'ghost', icon: 'refresh', onClick: renderAuto })));
    if (!result) { auto.append(h('p', { class: 'muted' }, r.message || 'Could not run the checks')); return; }
    if (S.session.role === 'technician' && S.mode && S.mode.name === 'DAMP') {
      auto.append(h('h3', { class: 'sec-t' }, 'Stand-up test (technician)'),
        h('p', { class: 'muted' }, 'Robot on the gantry, area clear. It says "Ready" when standing.'),
        slideToConfirm('Slide to stand up', () => standUp(), { kind: 'standby', id: 'stand-up', sub: 'Robot on the gantry, area clear' }));
    }
    const ul = h('ul', { class: 'check-list' });
    for (const it of result.items) {
      ul.append(h('li', { class: `ck ck-${it.status}` },
        h('span', { class: 'ck-ic', html: icon(it.status === 'ok' ? 'checkCircle' : it.status === 'warn' ? 'triangle' : it.status === 'fail' ? 'octagon' : 'info', 26) }),
        h('div', { class: 'ck-t' }, h('div', { class: 'ck-name' }, it.name), h('div', { class: 'ck-v' }, it.value || ''), it.status !== 'ok' && it.fix ? h('div', { class: 'ck-fix' }, it.fix) : null),
        h('span', { class: 'ck-word' }, ({ ok: 'OK', warn: 'Check', fail: 'Fix', unknown: 'Unknown' })[it.status])));
    }
    auto.append(ul);
    if (result.motion_locked) auto.append(h('p', { class: 'note note-warn' }, ic('lock', 22), 'Moving stays locked until the failed items are fixed.'));
  };
  renderAuto();

  // nurse part: three questions, the third is "press Stop now"
  const Q = [
    { id: 'rack', q: 'Is the instrument rack loaded and in place?' },
    { id: 'path', q: 'Is the path from here to the theatre clear?' },
    { id: 'stop', q: 'Stop test: tap the red STOP button on the right now.' },
  ];
  const answers = {};
  let step = 0;
  let stopWatch = 0;
  const t0 = Date.now();
  const renderNurse = () => {
    clear(nurse);
    nurse.append(h('div', { class: 'card-h' }, h('h2', {}, 'Nurse check'), h('span', { class: 'muted' }, 'About 60 seconds')));
    const prog = h('ol', { class: 'q-prog', 'aria-label': 'Progress' }, Q.map((q, i) => h('li', { class: i < step ? 'done' : i === step ? 'now' : '' })));
    nurse.append(prog);
    if (step < 2) {
      const q = Q[step];
      nurse.append(h('p', { class: 'q-text' }, q.q),
        h('div', { class: 'q-yn' },
          button('Yes', { kind: 'primary', icon: 'check', cls: 'btn-xl', onClick: () => { answers[q.id] = true; step++; renderNurse(); } }),
          button('No', { kind: 'secondary', icon: 'x', cls: 'btn-xl', onClick: () => { answers[q.id] = false; toast(q.id === 'rack' ? 'Load the rack before the first request. Tell the scrub nurse.' : 'Clear the path, then answer again.', { level: 'warn' }); } })));
    } else if (step === 2) {
      stopWatch = Date.now();
      nurse.append(h('p', { class: 'q-text' }, Q[2].q), h('div', { class: 'q-pointer', 'aria-hidden': 'true' }, h('span', {}, 'STOP is here'), ic('chevron', 32)),
        h('p', { class: 'muted' }, 'The robot holds still. It does not fall. Then you slide to resume.'));
      const iv = setInterval(() => {
        if (!nurse.isConnected) { clearInterval(iv); return; }
        if (shell.stopPressedAt >= stopWatch) { clearInterval(iv); answers.stop = true; step = 3; renderNurse(); }
      }, 150);
    } else if (step === 3) {
      nurse.append(h('div', { class: 'q-right' }, ic('checkCircle', 48), h('div', {}, h('div', { class: 'q-text' }, 'Stopped by you. That is right.'), h('p', { class: 'muted' }, 'Stop freezes the robot where it is. Now let it stand normally again.'))),
        slideToConfirm('Slide to resume standing', async () => { await api.resume('stand'); step = 4; record(); renderNurse(); }, { kind: 'standby', sub: 'Arms move slowly back to rest' }),
        button('Resume later', { kind: 'ghost', onClick: () => { step = 4; record(); renderNurse(); } }));
    } else {
      const ready = result ? result.ready && answers.rack && answers.path : answers.rack && answers.path;
      nurse.append(h('div', { class: `q-done ${ready ? 'ok' : 'warn'}` }, ic(ready ? 'checkCircle' : 'triangle', 56),
        h('div', { class: 'q-text' }, ready ? 'Ready for today' : 'Check done, with items to fix'),
        h('p', { class: 'muted' }, `Recorded at ${fmt.time(new Date())} · took ${Math.round((Date.now() - t0) / 1000)} s`)),
        !sound.verified ? button('Do the sound check', { icon: 'speaker', onClick: () => import('../sheets.js').then((m) => m.openSoundCheck()) }) : null,
        ready ? button('Send to Theatre 1 standby', { kind: 'primary', icon: 'pin', onClick: () => dispatchRequest('send_to', () => api.sendTo('theatre_instrument_table')) }) : null);
    }
  };
  const record = async () => {
    const r = await api.checksRecord('nurse', { ...answers, duration_s: Math.round((Date.now() - t0) / 1000) });
    if (!r.ok) toast(r.message, { level: 'warn' });
  };
  renderNurse();
  return () => {};
}

// ------------------------------------------------------------------ handover card (F8, HF-15: < 15 s read)
function handover(el) {
  let big = false;
  const card = h('section', { class: 'card handover-card' });
  el.append(card);
  const render = async () => {
    const r = await api.handoverCard();
    const c = r.ok ? r.data : {};
    const d = derive();
    const b = batteryText();
    clear(card);
    card.classList.toggle('big', big);
    const row = (k, v, ico, lvl = '') => h('div', { class: `ho-row ${lvl}` }, ic(ico, big ? 36 : 26), h('span', { class: 'ho-k' }, k), h('span', { class: 'ho-v' }, v));
    const handed = c.instruments_handed || S.handed;
    card.append(
      h('div', { class: 'card-h' }, h('h2', {}, 'Shift handover'), h('div', { class: 'row gap' },
        button(big ? 'Normal size' : 'Show big', { size: 'operator', icon: 'eye', onClick: () => { big = !big; render(); } }),
        button('Refresh', { size: 'operator', kind: 'ghost', icon: 'refresh', onClick: render }))),
      row('Now', `${d.activity}`, 'status'),
      row('Status', d.status.word, d.status.icon, `lvl-${d.status.level}`),
      row('Control', d.controller, 'hand'),
      row('Open alarms', String(c.alarms_open ?? S.alarms.active.filter((a) => !a.acknowledged).length), 'bell', (c.alarms_open || 0) > 0 ? 'lvl-needs' : ''),
      row('Instruments handed', handed.length ? `${handed.length}: ${handed.slice(-4).map((x) => x.name).join(', ')}${handed.length > 4 ? '…' : ''}` : 'None yet', 'handover'),
      row('Trips today', String(c.trips ?? 0), 'robotArrow'),
      row('Open problems', String(c.incidents_open ?? 0), 'send'),
      row('Battery', b.soc === null ? 'Not reported' : `${b.text} left`, 'battery'),
      c.suppressed && c.suppressed.length ? row('Suppressed alarms', c.suppressed.join(', '), 'info', 'lvl-needs') : null,
    );
  };
  render();
  return () => {};
}

// ------------------------------------------------------------------ end of shift (F7)
function endOfShift(el) {
  const steps = h('ol', { class: 'eos' });
  el.append(h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', {}, 'End of shift')), steps));
  const SURF = [['hands', 'Hands'], ['forearms', 'Forearms'], ['torso', 'Torso front'], ['head', 'Head'], ['handles', 'Handles']];
  const done = new Set();
  const render = () => {
    clear(steps);
    const role = S.session.role;
    steps.append(
      h('li', {}, h('div', { class: 'eos-t' }, '1. Read the handover card'), h('p', { class: 'muted' }, 'Share it with the next shift.'), button('Open handover card', { size: 'operator', icon: 'people', onClick: () => { tab = 'handover'; location.hash = '#/checks'; document.querySelector('.seg-b:nth-child(2)')?.click(); } })),
      h('li', {}, h('div', { class: 'eos-t' }, '2. Send the robot to the dock'), button('Go to dock', { size: 'operator', icon: 'dock', kind: 'primary', onClick: () => dispatchRequest('send_to', () => api.dock()) })),
      h('li', {}, h('div', { class: 'eos-t' }, '3. Wipe the robot'), h('p', { class: 'muted' }, role === 'clinical' ? 'An operator or technician puts it in the cleaning pose (arms out, hands open) on the stand.' : 'Robot at the dock on its stand: arms out, hands open. Wipe with the approved agent.'),
        h('div', { class: 'chips' }, SURF.map(([id, l]) => h('button', { class: `chip-btn${done.has(id) ? ' on' : ''}`, type: 'button', 'aria-pressed': done.has(id) ? 'true' : 'false', onClick: () => { done.has(id) ? done.delete(id) : done.add(id); if (done.size === SURF.length) { api.checksRecord('clean_robot', Object.fromEntries(SURF.map(([k]) => [k, true]))); toast('Robot cleaning logged', { level: 'ok' }); } render(); } }, done.has(id) ? ic('check', 20) : null, l)))),
      h('li', {}, h('div', { class: 'eos-t' }, '4. Clean this iPad'), h('p', { class: 'muted' }, 'The screen ignores touches for 30 seconds. Stop still works with a 2-second hold.'), button('Lock screen for cleaning', { size: 'operator', icon: 'clean', onClick: () => window.G1.startCleanMode(30) })),
      role !== 'clinical' ? h('li', {}, h('div', { class: 'eos-t' }, '5. Sign out'), button('Sign out', { size: 'operator', icon: 'lock', onClick: async () => { if (S.lease.you) await api.leaseRelease(); await api.logout(); location.hash = '#/home'; } })) : null);
  };
  render();
  return () => {};
}
