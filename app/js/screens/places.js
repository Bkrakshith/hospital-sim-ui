// Send to… (F2): place tiles with a floor-plan thumbnail, room name, number stripe and ETA from here.
// One tap sends; the readback card (3 s Undo) is the confirmation.
import { store, api } from '../client.js';
import { h, ic, toast, fmt, clear } from '../ui.js';
import { icon } from '../icons.js';
import { placeThumb } from '../floorplan.js';
import { dispatchRequest } from '../shell.js';
import { motionBlock } from './home.js';

const S = store.state;

export function etaTo(p) {
  if (!S.pose || S.pose.frame !== 'map') return null;
  const d = Math.hypot(p.x - S.pose.x, p.y - S.pose.y) * 1.35;   // corridors are not straight lines
  return { d, t: d / 0.3 + 5 };
}

export function mount(el, { go }) {
  const head = h('header', { class: 'screen-head' }, h('div', {}, h('h1', {}, 'Send the robot to…'), h('p', { class: 'muted' }, 'Tap a place. You can undo for 3 seconds.')));
  const block = h('div', { class: 'block-note' });
  const grid = h('div', { class: 'place-grid' });
  el.append(head, block, grid);
  const role = () => S.session.role || 'clinical';

  let lastKey = '';
  const render = () => {
    const why = motionBlock();
    const key = JSON.stringify([why, S.session.role, S.places.map((p) => p.id), S.pose ? [Math.round(S.pose.x / 2), Math.round(S.pose.y / 2)] : null]);
    if (key === lastKey) return;
    lastKey = key;
    clear(block);
    if (why) block.append(h('p', { class: 'note note-warn' }, ic('info', 22), why));
    clear(grid);
    const list = S.places.filter((p) => (p.allowed_roles || p.roles || ['clinical']).includes(role()) || p.allowed === true);
    for (const p of list) {
      const e = etaTo(p);
      const here = e && e.d < 1.0;
      const t = h('button', { class: `place-tile${p.stripe ? ' has-stripe' : ''}`, type: 'button', 'aria-disabled': why || here ? 'true' : 'false', dataset: { place: p.id },
        'aria-label': `${p.name}, ${p.sub || ''}${e ? ', about ' + fmt.eta(e.t) : ''}${here ? ', the robot is already here' : ''}`,
        onClick: async () => {
          if (why) { toast(why, { icon: 'info' }); return; }
          if (here) { toast(`The robot is already at ${p.name}`, { icon: 'info' }); return; }
          const r = await dispatchRequest('send_to', () => api.sendTo(p.id));
          if (r.ok) go('home');
        } },
        h('span', { class: 'pt-thumb', html: placeThumb(p) }),
        p.stripe ? h('span', { class: 'pt-stripe', 'aria-hidden': 'true' }, String(p.stripe)) : null,
        h('span', { class: 'pt-body' },
          h('span', { class: 'pt-name' }, p.dock ? h('span', { class: 'pt-ic', html: icon('dock', 22) }) : null, p.name),
          h('span', { class: 'pt-sub' }, p.sub || ''),
          h('span', { class: 'pt-eta' }, here ? 'Robot is here' : e ? `${fmt.eta(e.t)} from where it is` : 'ETA unknown'),
          p.track ? h('span', { class: 'pt-track' }, p.track) : null));
      grid.append(t);
    }
    if (!list.length) grid.append(h('div', { class: 'empty' }, ic('pin', 40), h('div', { class: 'empty-t' }, 'No places yet'), h('div', { class: 'empty-s' }, 'A technician adds named places for this wing.')));
  };
  render();
  const offs = [store.on('places', render), store.on('state', render), store.on('session', render), store.on('pose', render)];
  return () => offs.forEach((o) => o());
}
