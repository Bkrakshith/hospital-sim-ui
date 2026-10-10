// Sheets opened from the chrome: sign in, alarm list, send problem to technician, control lease, help,
// settings, sound check.
import { store, api, device, isV2, sourceLabel, whoText } from './client.js';
import { h, ic, button, sheet, toast, fmt, clear, slideToConfirm } from './ui.js';
import { icon } from './icons.js';
import { sound, speech } from './platform.js';
import { PLACES } from './data.js';

const S = store.state;
export const sheetState = { lastIncident: null };

// ------------------------------------------------------------------ sign in (PIN keypad)
export function openSignIn() {
  sound.unlock();
  const role = S.session.role || 'clinical';
  if (role !== 'clinical') {
    const body = h('div', { class: 'signin' },
      h('p', { class: 'lead' }, `Signed in as ${role === 'operator' ? 'Operator' : 'Technician'}${S.session.user ? ' · ' + S.session.user : ''}.`),
      h('p', { class: 'muted' }, `The iPad goes back to Clinical mode after ${role === 'operator' ? '10' : '5'} minutes without a touch.`),
      S.lease.you ? h('p', { class: 'note note-warn' }, ic('hand', 22), 'You hold manual control. Signing out releases it.') : null,
      h('div', { class: 'row gap' },
        button('Done: back to Clinical', { kind: 'primary', icon: 'check', onClick: async () => {
          if (S.lease.you) await api.leaseRelease();
          const r = await api.logout(); rec.close(); if (r.ok) { toast('Back to Clinical mode', { level: 'ok' }); location.hash = '#/home'; } },
        }),
        role === 'operator' ? button('Switch to Technician', { onClick: () => { rec.close(); pinPad('technician'); } }) : null));
    const rec = sheet(body, { title: 'Signed in' });
    return;
  }
  const body = h('div', { class: 'signin' },
    h('p', { class: 'lead' }, 'Clinical mode needs no sign-in. Operators and technicians sign in for more.'),
    h('div', { class: 'role-pick' },
      h('button', { class: 'role-card', type: 'button', onClick: () => { rec.close(); pinPad('operator'); } },
        ic('joystick', 36), h('span', { class: 'rc-t' }, 'Operator'), h('span', { class: 'rc-s' }, 'Map, manual walking, camera arms, missions')),
      h('button', { class: 'role-card', type: 'button', onClick: () => { rec.close(); pinPad('technician'); } },
        ic('wrench', 36), h('span', { class: 'rc-t' }, 'Technician'), h('span', { class: 'rc-s' }, 'Diagnostics, mapping, logs, audit, calibration'))),
    h('p', { class: 'muted small-note' }, ic('badge', 20), 'Badge reader: tap your badge on the reader at the mount when it is fitted. Until then use your PIN.'));
  const rec = sheet(body, { title: 'Sign in' });
}

function pinPad(role) {
  const len = 6;
  let pin = '';
  let lastUser = ''; try { lastUser = JSON.parse(localStorage.getItem('g1.last_user')) || ''; } catch { /* ignore */ }
  const dots = h('div', { class: 'pin-dots', 'aria-live': 'polite', 'aria-label': '0 of 6 digits' });
  const msg = h('div', { class: 'pin-msg', role: 'alert' });
  const name = h('input', { class: 'input', id: 'signin-name', type: 'text', value: lastUser, placeholder: 'Your name, as shown to others', autocomplete: 'off', autocapitalize: 'words', 'aria-label': 'Your name' });
  const draw = () => {
    dots.innerHTML = Array.from({ length: len }, (_, i) => `<i class="${i < pin.length ? 'on' : ''}"></i>`).join('');
    dots.setAttribute('aria-label', `${pin.length} of ${len} digits`);
  };
  const submit = async () => {
    msg.textContent = 'Checking…';
    const user = name.value.trim() || (role === 'operator' ? 'Operator' : 'Technician');
    try { localStorage.setItem('g1.last_user', JSON.stringify(name.value.trim())); } catch { /* ignore */ }
    const r = await api.login(role, pin, user);
    if (r.ok) {
      sound.unlock();
      rec.close();
      toast(`Signed in as ${role === 'operator' ? 'Operator' : 'Technician'}`, { level: 'ok' });
      location.hash = role === 'operator' ? '#/map' : '#/system';
    } else {
      pin = ''; draw();
      msg.textContent = r.data && r.data.code === 'locked' ? 'Too many wrong PINs. Wait a minute and try again.' : r.data && r.data.code === 'bad_pin' ? 'That PIN is not right. Try again.' : (r.message || 'Sign-in failed');
      dots.classList.add('shake'); setTimeout(() => dots.classList.remove('shake'), 400);
    }
  };
  const key = (k) => h('button', { class: 'key', type: 'button', 'aria-label': k === 'del' ? 'Delete' : k, onClick: () => {
    sound.unlock();
    if (k === 'del') pin = pin.slice(0, -1);
    else if (pin.length < len) pin += k;
    draw();
    if (pin.length === len) submit();
  } }, k === 'del' ? ic('back', 28) : k);
  draw();
  const body = h('div', { class: 'pinpad' },
    h('div', { class: 'pin-left' },
      h('p', { class: 'lead' }, `Enter your ${len}-digit ${role} PIN.`),
      h('label', { class: 'field' }, h('span', { class: 'field-k' }, 'Name'), name),
      dots, msg,
      null),
    h('div', { class: 'keys' }, ...['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(key), h('span'), key('0'), key('del')));
  const rec = sheet(body, { title: role === 'operator' ? 'Operator sign-in' : 'Technician sign-in', wide: true });
}

// ------------------------------------------------------------------ alarm list
export function openAlarmList() {
  const body = h('div', { class: 'alarm-list' });
  const render = () => {
    clear(body);
    const act = S.alarms.active;
    if (!act.length) body.append(h('div', { class: 'empty' }, ic('checkCircle', 40), h('div', { class: 'empty-t' }, 'No alarms'), h('div', { class: 'empty-s' }, 'Nothing needs attention right now.')));
    for (const a of act) {
      body.append(h('div', { class: `al-row pri-${a.priority}${a.acknowledged ? ' acked' : ''}` },
        h('span', { class: 'al-ic', html: icon(a.priority === 'high' ? 'octagon' : a.priority === 'medium' ? 'triangle' : 'info', 30) }),
        h('div', { class: 'al-text' },
          h('div', { class: 'al-pri' }, { high: 'High', medium: 'Medium', low: 'Low' }[a.priority], a.since ? ` · since ${fmt.time(a.since)}` : '', a.condition_active === false ? ' · condition cleared' : ''),
          h('div', { class: 'al-what' }, a.what),
          h('div', { class: 'al-do' }, a.do, a.who ? ` Who: ${String(a.who).replace(/\.$/, '')}.` : ''),
          a.acknowledged ? h('div', { class: 'al-ack' }, `Acknowledged by ${whoText(a.acknowledged.by) || 'someone'}${a.acknowledged.t ? ' at ' + fmt.time(a.acknowledged.t) : ''}`) : null,
          S.session.role === 'technician' && (a.tech_code || a.code) ? h('div', { class: 'al-code mono' }, a.tech_code || a.code) : null),
        h('div', { class: 'al-act' },
          !a.acknowledged ? button('Acknowledge', { kind: 'primary', icon: 'check', onClick: async () => { await api.ackAlarm(a.id); render(); } }) : null,
          S.session.role === 'technician' && a.priority === 'low' ? button('Suppress for session', { size: 'tech', onClick: async () => { const r = await api.suppressAlarm(a.code); toast(r.ok ? 'Suppressed until the session ends' : r.message); render(); } }) : null)));
    }
    if (S.alarms.suppressed && S.alarms.suppressed.length) body.append(h('p', { class: 'note note-info' }, ic('info', 22), `${S.alarms.suppressed.length} alarm type suppressed this session: ${S.alarms.suppressed.join(', ')}`));
    const today = S.timeline.filter((e) => e.kind === 'alarm' || e.kind === 'alarm_ack').slice(-8).reverse();
    if (today.length) body.append(h('h3', { class: 'sec-t' }, 'Earlier today'), h('ul', { class: 'tl-list' }, today.map((e) => h('li', {}, h('span', { class: 'tl-t' }, fmt.time(e.t)), h('span', {}, e.text)))));
    body.append(h('p', { class: 'muted small-note' }, 'Alarms cannot be switched off here. The robot also shows them with its light and voice.'));
  };
  render();
  const off = store.on('alarms', render);
  sheet(body, { title: 'Alarms', onClose: off });
}

// ------------------------------------------------------------------ send problem to technician (F6)
export function openProblem({ alarm = null, chips: pre = [] } = {}) {
  const CH = [['stuck', 'Stuck'], ['fell', 'Fell'], ['wrong_place', 'Wrong place'], ['wrong_instrument', 'Wrong instrument'], ['noise_smell', 'Noise or smell'], ['behaving_oddly', 'Behaving oddly'], ['other', 'Other']];
  const sel = new Set(pre);
  const chipsEl = h('div', { class: 'chips' });
  const draw = () => {
    clear(chipsEl);
    for (const [id, label] of CH) chipsEl.append(h('button', { class: `chip-btn${sel.has(id) ? ' on' : ''}`, type: 'button', 'aria-pressed': sel.has(id) ? 'true' : 'false', onClick: () => { sel.has(id) ? sel.delete(id) : sel.add(id); draw(); } }, sel.has(id) ? ic('check', 20) : null, label));
  };
  draw();
  const sendBtn = button('Send to technician', { kind: 'primary', icon: 'send', onClick: async () => {
    sendBtn.disabled = true;
    const r = await api.incidentCreate([...sel], alarm ? `alarm: ${alarm.code || alarm.what}` : '');
    if (r.ok) {
      sheetState.lastIncident = { id: r.data && r.data.id, t: Date.now() / 1000 };
      store.emit('incident', sheetState.lastIncident);
      rec.close();
      const done = h('div', { class: 'incident-done' }, ic('checkCircle', 56), h('div', { class: 'inc-id' }, r.data && r.data.id ? r.data.id : 'Sent'),
        h('p', { class: 'lead' }, `Technician notified at ${fmt.time(new Date())}.`),
        h('p', { class: 'muted' }, 'The last 5 minutes of robot data were saved with it. No patient data is included.'),
        button('OK', { kind: 'primary', onClick: () => d.close() }));
      const d = sheet(done, { title: 'Problem sent' });
    } else { sendBtn.disabled = false; toast(r.message, { level: 'warn' }); }
  } });
  const body = h('div', { class: 'problem' },
    h('p', { class: 'lead' }, 'What is wrong? Tap any that fit. The app adds the last 5 minutes of robot data (modes, commands, alarms, position, versions). No patient data.'),
    alarm ? h('p', { class: 'note note-info' }, ic('info', 22), `Includes the alarm: ${alarm.what}`) : null,
    chipsEl,
    h('div', { class: 'row gap end' }, sendBtn));
  const rec = sheet(body, { title: 'Send problem to technician' });
}

// ------------------------------------------------------------------ control lease
export function openLease() {
  const role = S.session.role;
  const body = h('div', { class: 'lease' });
  const render = () => {
    clear(body);
    const hdr = S.lease.holder;
    body.append(h('div', { class: 'lease-now' },
      ic(S.lease.you ? 'hand' : hdr ? 'people' : 'unlock', 40),
      h('div', {},
        h('div', { class: 'lease-t' }, S.lease.you ? 'This iPad has manual control' : hdr ? `${hdr.user ? hdr.user + ' on ' : ''}${hdr.device_name || 'another device'} has manual control` : 'Nobody has manual control'),
        h('div', { class: 'muted' }, hdr && hdr.since ? `Since ${fmt.time(hdr.since)}${hdr.implicit ? ' (console)' : ''}` : 'Only one device at a time can walk the robot or move its arms.'))));
    body.append(h('p', { class: 'note note-info' }, ic('stop', 22), 'Stop works from every iPad, whoever has control.'));
    if (role === 'clinical') {
      body.append(h('p', { class: 'muted' }, 'Operators take control to drive the robot by hand. Sign in as an operator to do that.'));
      return;
    }
    if (S.lease.you) body.append(button('Hand back control', { kind: 'secondary', icon: 'unlock', size: 'operator', onClick: async () => { const r = await api.leaseRelease(); toast(r.ok ? 'Control released' : r.message, { level: r.ok ? 'ok' : 'warn' }); render(); } }));
    else if (!hdr) body.append(slideToConfirm('Slide to take control', async () => { const r = await api.leaseAcquire('from the app'); toast(r.ok ? 'You have control' : r.message, { level: r.ok ? 'ok' : 'warn' }); render(); }, { kind: 'person', sub: 'Others can still press Stop' }));
    else {
      let reason = 'The operator left the iPad';
      body.append(h('p', {}, 'Take over only if the other person agrees or has left. They are told, and if the robot is being driven by hand it stops first.'),
        h('div', { class: 'chips' }, ['The operator left the iPad', 'Agreed with the operator', 'Emergency'].map((r) => h('button', { class: 'chip-btn', type: 'button', onClick: (e) => { reason = r; body.querySelectorAll('.lease .chip-btn').forEach((b) => b.classList.remove('on')); e.currentTarget.classList.add('on'); } }, r))),
        slideToConfirm('Slide to take over control', async () => { const r = await api.leaseSteal(reason); toast(r.ok ? 'You have control. The robot is holding still.' : r.message, { level: r.ok ? 'ok' : 'warn' }); render(); }, { kind: 'person', sub: 'The robot holds still first' }));
    }
  };
  render();
  const off = store.on('lease', render);
  sheet(body, { title: 'Manual control', onClose: off });
}

// ------------------------------------------------------------------ help (HF-29, HF-32)
export function openHelp() {
  const how = (title, steps, ico) => h('div', { class: 'help-card' }, h('div', { class: 'hc-h' }, ic(ico, 28), h('h3', {}, title)), h('ol', {}, steps.map((s) => h('li', {}, s))));
  const body = h('div', { class: 'help' },
    h('div', { class: 'help-grid' },
      how('Send the robot somewhere', ['Tap Send to…', 'Tap the place', 'Check the words on the card. Undo within 3 seconds if wrong'], 'pin'),
      how('Ask for an instrument', ['Tap Instruments', 'Tap the picture (for the surgeon unless you change it)', 'The robot repeats it. Undo if wrong'], 'handover'),
      how('Stop the robot', ['Tap STOP on the right. One tap, no confirm', 'The robot holds still where it is, arms frozen', 'Slide to resume when it is safe'], 'stop'),
      how('If something is wrong', ['Tap STOP', 'Tap Send problem to technician', 'Pick what happened. The data goes with it'], 'send')),
    h('h3', { class: 'sec-t' }, 'What the robot does not do'),
    h('ul', { class: 'plain-list' },
      h('li', {}, 'It does not touch patients.'),
      h('li', {}, 'It does not handle urgent requests: ask the scrub nurse.'),
      h('li', {}, 'It does not hand sharps into a hand: sharps go to the scrub nurse\'s neutral zone.'),
      h('li', {}, 'It does not go into the sterile field.'),
      h('li', {}, 'The iPad is not an emergency stop. The red hardware e-stop remote is.')),
    h('p', { class: 'muted' }, 'Short how-to clips will appear here (offline, captioned, no sound needed).'));
  sheet(body, { title: 'Help', wide: true });
}

// ------------------------------------------------------------------ settings
export function openSettings() {
  const tech = S.session.role === 'technician';
  const body = h('div', { class: 'settings' });
  const toggle = (label, get, set, sub) => {
    const b = h('button', { class: `toggle${get() ? ' on' : ''}`, type: 'button', role: 'switch', 'aria-checked': get() ? 'true' : 'false', onClick: () => { set(!get()); b.classList.toggle('on', get()); b.setAttribute('aria-checked', get() ? 'true' : 'false'); } }, h('span', { class: 'tg-knob' }));
    return h('div', { class: 'set-row' }, h('div', {}, h('div', { class: 'set-k' }, label), sub ? h('div', { class: 'set-s' }, sub) : null), b);
  };
  body.append(
    h('div', { class: 'set-row' }, h('div', {}, h('div', { class: 'set-k' }, 'This iPad'), h('div', { class: 'set-s' }, `${device.name} · mounted at ${(PLACES.find((p) => p.id === device.place) || {}).name || device.place}`))),
    tech ? h('div', { class: 'set-row' }, h('label', { class: 'set-k', for: 'set-name' }, 'Device name'), h('input', { class: 'input', id: 'set-name', value: device.name, onChange: (e) => { device.name = e.target.value; } })) : null,
    tech ? h('div', { class: 'set-row' }, h('label', { class: 'set-k', for: 'set-place' }, '"Come here" goes to'),
      (() => { const s = h('select', { class: 'input', id: 'set-place', onChange: (e) => { device.place = e.target.value; } }, PLACES.map((p) => h('option', { value: p.id, selected: p.id === device.place }, `${p.name} · ${p.sub}`))); return s; })()) : null,
    toggle('iPad speaks readbacks', () => device.speak, (v) => { device.speak = v; speech.enabled = v; }, 'The robot speaks them too; this adds the iPad voice.'),
    toggle('Left-handed layout', () => device.mirror, (v) => { device.mirror = v; if (v) document.documentElement.dataset.mirror = '1'; else delete document.documentElement.dataset.mirror; }, 'Puts Stop and the safety rail on the left.'),
    !tech ? h('p', { class: 'muted small-note' }, 'A technician sets where this iPad is mounted.') : null,
  );
  sheet(body, { title: 'Settings' });
}

// ------------------------------------------------------------------ sound check (05 §7)
export function openSoundCheck() {
  sound.unlock();
  const body = h('div', { class: 'soundcheck' },
    h('p', { class: 'lead' }, 'iPads cannot report their volume. Play the tone and say whether you heard it. The robot\'s own speaker is the main alarm sound.'),
    button('Play the tone', { kind: 'secondary', icon: 'speaker', onClick: () => { sound.unlock(); sound.check(); } }),
    h('div', { class: 'row gap' },
      button('I heard it', { kind: 'primary', icon: 'check', onClick: () => { sound.verified = true; store.emit('sound'); rec.close(); toast('Sound checked', { level: 'ok' }); } }),
      button('I did not hear it', { onClick: () => { sound.verified = false; store.emit('sound'); rec.close(); toast('Turn the iPad volume up with its side buttons, then try again.', { level: 'warn' }); } })),
    h('p', { class: 'muted small-note' }, 'Alarm sounds cannot be switched off in the app.'));
  const rec = sheet(body, { title: 'Sound check' });
}

export { sourceLabel };
