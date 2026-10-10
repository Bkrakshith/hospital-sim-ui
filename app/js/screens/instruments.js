// Request instrument (F3): tiles with an illustration, name and rack count, grouped as on the tray.
// Requester defaults to Surgeon. Readback card + spoken readback + 3 s Undo. No "urgent" button (HF-8).
// Handed instruments are listed for the count (HF-3).
import { store, api, instrumentName } from '../client.js';
import { h, ic, toast, fmt, clear } from '../ui.js';
import { INSTRUMENT_ART } from '../data.js';
import { dispatchRequest } from '../shell.js';
import { motionBlock, stepper } from './home.js';
import { derive } from '../status.js';

const S = store.state;
let requester = 'surgeon';

export function mount(el, { go }) {
  const head = h('header', { class: 'screen-head' },
    h('div', {}, h('h1', {}, 'Request an instrument'), h('p', { class: 'muted' }, 'The robot fetches it from the rack and offers it handle first.')),
    h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Who is it for?' }));
  const seg = head.querySelector('.seg');
  const drawSeg = () => {
    clear(seg);
    seg.append(h('span', { class: 'seg-k' }, 'For'));
    for (const [id, label] of [['surgeon', 'Surgeon'], ['scrub_nurse', 'Scrub nurse']]) {
      seg.append(h('button', { class: `seg-b${requester === id ? ' on' : ''}`, type: 'button', role: 'radio', 'aria-checked': requester === id ? 'true' : 'false', onClick: () => { requester = id; drawSeg(); } }, label));
    }
  };
  drawSeg();
  const current = h('div', { class: 'inst-current' });
  const block = h('div', { class: 'block-note' });
  const groups = h('div', { class: 'inst-groups' });
  const handed = h('section', { class: 'card handed', 'aria-label': 'Handed today' });
  el.append(head, h('p', { class: 'note note-info urgent-note' }, ic('info', 22), 'Urgent instrument? Ask the scrub nurse. The robot is for planned requests.'), current, block, groups, handed);

  let lastKey = '';
  const render = () => {
    const why = motionBlock();
    const m = S.mission || {};
    const key = JSON.stringify([why, S.instruments, m.instrument, m.state, m.step, m.queue, S.handed.length]);
    if (key === lastKey) return;
    lastKey = key;
    clear(block);
    if (why) block.append(h('p', { class: 'note note-warn' }, ic('info', 22), why));
    const mis = S.mission;
    const busy = mis && mis.instrument && ['running', 'paused'].includes(mis.state);
    clear(current);
    if (busy) {
      const d = derive();
      current.append(h('div', { class: 'card inst-now' }, h('div', { class: 'in-t' }, ic('handover', 28), `Bringing ${instrumentName(mis.instrument).toLowerCase()}`), stepper(d.mission ? d.mission.reqIdx : -1),
        mis.queue && mis.queue.length ? h('div', { class: 'muted' }, `Next in queue: ${mis.queue.map(instrumentName).join(', ')}`) : null));
    }
    clear(groups);
    const byGroup = new Map();
    for (const i of S.instruments) { const g = i.group || 'Other'; if (!byGroup.has(g)) byGroup.set(g, []); byGroup.get(g).push(i); }
    for (const [g, list] of byGroup) {
      const row = h('div', { class: 'inst-row' });
      for (const i of list) {
        const withSurgeon = i.held_by === 'surgeon';
        const count = i.rack_count !== undefined && i.rack_count !== null ? i.rack_count : i.on_rack;
        const none = count === 0 && !withSurgeon;
        const countText = withSurgeon ? 'With the surgeon' : count === null || count === undefined ? 'On the rack' : count === 0 ? 'None on the rack' : `${count} on the rack`;
        const dis = !!why || none || withSurgeon;
        const t = h('button', { class: `inst-tile${dis ? ' blocked' : ''}`, type: 'button', 'aria-disabled': dis ? 'true' : 'false', dataset: { inst: i.id },
          'aria-label': `${i.name}. ${countText}.`,
          onClick: async () => {
            if (why) { toast(why, { icon: 'info' }); return; }
            if (none || withSurgeon) { toast(`${i.name}: ${countText.toLowerCase()}`, { icon: 'info' }); return; }
            const r = await dispatchRequest('instrument_request', () => api.requestInstrument(i.id, requester));
            if (r.ok) go('home');
          } },
          h('span', { class: 'it-art', html: `<svg viewBox="0 0 72 72" width="84" height="84" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${INSTRUMENT_ART[i.kind] || INSTRUMENT_ART.forceps}</svg>` }),
          h('span', { class: 'it-name' }, i.name),
          h('span', { class: `it-count${none || withSurgeon ? ' zero' : ''}` }, countText),
          i.sharp ? h('span', { class: 'it-flag' }, 'Sharp · to the neutral zone') : i.standin ? h('span', { class: 'it-flag' }, 'Stand-in (simulation)') : null);
        row.append(t);
      }
      groups.append(h('section', { class: 'inst-group' }, h('h2', { class: 'sec-t' }, g), row));
    }
    clear(handed);
    handed.append(h('h2', { class: 'sec-t' }, ic('handover', 22), `Handed today · ${S.handed.length}`));
    if (!S.handed.length) handed.append(h('p', { class: 'muted' }, 'Instruments the robot hands over are listed here for the count.'));
    else handed.append(h('ul', { class: 'tl-list' }, S.handed.slice().reverse().map((x) => h('li', {}, h('span', { class: 'tl-t' }, x.t ? fmt.time(x.t) : 'today'), h('span', {}, x.name)))));
  };
  render();
  const offs = [store.on('instruments', render), store.on('mission', render), store.on('state', render), store.on('lease', render)];
  return () => offs.forEach((o) => o());
}
