// Operator → Missions: scrub-assist mission (g1_mission) with the behaviour tree in plain language
// (current step highlighted, next visible, done steps ticked), start / pause / resume / abort, queue, history.
import { store, api, instrumentName, placeName } from '../client.js';
import { h, ic, button, slideToConfirm, toast, fmt, clear } from '../ui.js';
import { icon } from '../icons.js';
import { STEP_WORDS } from '../data.js';
import { stepper } from './home.js';
import { derive } from '../status.js';

const S = store.state;
const STATE_WORD = { idle: 'Not running', running: 'Running', paused: 'Paused', succeeded: 'Finished', failed: 'Failed', aborted: 'Stopped' };
const STATUS_WORD = { RUNNING: 'now', SUCCESS: 'done', FAILURE: 'failed', IDLE: '' };
// nodes that are structure, not steps a person cares about
const HIDE = new Set(['Serve', 'ServeOrRecover', 'ServeOne', 'ToSurgeon', 'ReachStation', 'scrub_nurse', 'Recover']);

export function mount(el) {
  const top = h('section', { class: 'card mission-top' });
  const tree = h('section', { class: 'card mission-tree' });
  const hist = h('section', { class: 'card mission-hist' });
  el.append(h('header', { class: 'screen-head' }, h('div', {}, h('h1', {}, 'Scrub assist'), h('p', { class: 'muted' }, 'The robot fetches instruments from the rack and hands them over. The scrub nurse stays primary.'))),
    h('div', { class: 'mission-grid' }, h('div', { class: 'mission-col' }, top, hist), tree));
  let lastKey = '';
  const render = () => {
    const m = S.mission;
    const key = JSON.stringify(m ? [m.state, m.step, m.instrument, m.queue, (m.tree || []).map((n) => n.status), (m.history || []).length, m.message] : null);
    if (key === lastKey) return;
    lastKey = key;
    clear(top); clear(tree); clear(hist);
    if (!m) {
      top.append(h('div', { class: 'empty' }, ic('steps', 40), h('div', { class: 'empty-t' }, 'No mission on this robot'), h('div', { class: 'empty-s' }, 'The scrub-assist mission (g1_mission) is not running. A technician starts it with the robot software.')));
      return;
    }
    const d = derive();
    const running = m.state === 'running', paused = m.state === 'paused';
    top.append(
      h('div', { class: 'ms-state' }, h('span', { class: `pill pill-${running ? 'robot' : paused ? 'med' : m.state === 'failed' ? 'high' : 'unk'}` }, STATE_WORD[m.state] || m.state),
        m.kind && String(m.kind).startsWith('goto:') ? h('span', { class: 'muted' }, `Going to ${placeName(String(m.kind).slice(5))}`) : null),
      h('div', { class: 'ms-now' }, m.instrument ? `Bringing ${instrumentName(m.instrument).toLowerCase()}` : STEP_WORDS[m.step] || (m.step || 'Waiting')),
      m.instrument ? stepper(d.mission ? d.mission.reqIdx : -1) : null,
      m.message ? h('p', { class: 'muted' }, m.message) : null,
      m.queue && m.queue.length ? h('p', {}, h('b', {}, 'Queue: '), m.queue.map(instrumentName).join(', ')) : null,
      h('div', { class: 'row gap wrap' },
        !running && !paused ? slideToConfirm('Slide to start scrub assist', async () => { const r = await api.missionCommand('start'); toast(r.ok ? 'Starting scrub assist' : r.message, { level: r.ok ? 'ok' : 'warn' }); }, { kind: 'robot', sub: 'Walks to the instrument table, then waits' }) : null,
        running ? button('Pause', { size: 'operator', icon: 'pause', onClick: () => api.missionCommand('pause') }) : null,
        paused ? slideToConfirm('Slide to resume', async () => { await api.missionCommand('resume'); }, { kind: 'robot' }) : null,
        running || paused ? button('Stop the task', { size: 'operator', icon: 'x', onClick: async () => { const r = await api.missionCommand('abort'); toast(r.ok ? 'Task stopped. The robot stands still.' : r.message, { level: r.ok ? 'ok' : 'warn' }); } }) : null,
        m.queue && m.queue.length ? button('Clear queue', { size: 'operator', kind: 'ghost', onClick: () => api.missionCommand('clear_queue') }) : null),
    );
    // plain-language tree
    tree.append(h('h2', { class: 'sec-t' }, 'Steps'));
    const ol = h('ol', { class: 'bt' });
    let seenNow = false;
    for (const n of m.tree || []) {
      if (HIDE.has(n.name)) continue;
      const base = n.name.replace(/\(.*$/, '');
      const word = STEP_WORDS[base] || STEP_WORDS[n.name] || base.replace(/([a-z])([A-Z])/g, '$1 $2');
      const arg = n.name.includes('(') ? n.name.slice(n.name.indexOf('(') + 1, -1) : '';
      const st = n.status === 'RUNNING' ? 'now' : n.status === 'SUCCESS' ? 'done' : n.status === 'FAILURE' ? 'failed' : 'todo';
      const isNext = st === 'todo' && seenNow && !ol.querySelector('.bt-next');
      if (st === 'now') seenNow = true;
      ol.append(h('li', { class: `bt-${st}${isNext ? ' bt-next' : ''}`, style: { '--depth': Math.max(0, (n.depth || 0) - 1) }, 'aria-current': st === 'now' ? 'step' : undefined },
        h('span', { class: 'bt-dot', html: st === 'done' ? icon('check', 16) : st === 'failed' ? icon('x', 16) : '' }),
        h('span', { class: 'bt-w' }, word, arg ? h('span', { class: 'muted' }, ` · ${placeName(arg)}`) : null),
        isNext ? h('span', { class: 'bt-tag' }, 'next') : st === 'now' ? h('span', { class: 'bt-tag now' }, 'now') : null,
        S.session.role === 'technician' ? h('span', { class: 'bt-raw mono' }, n.name) : null));
    }
    tree.append(ol);
    // history
    hist.append(h('h2', { class: 'sec-t' }, `History · ${m.counts ? `${m.counts.ok || 0} handed, ${m.counts.failed || 0} failed` : ''}`));
    const hs = (m.history || []).slice().reverse();
    if (!hs.length) hist.append(h('p', { class: 'muted' }, 'No requests yet.'));
    else hist.append(h('ul', { class: 'tl-list' }, hs.slice(0, 12).map((x) => h('li', { class: x.success ? '' : 'lvl-needs' }, ic(x.success ? 'checkCircle' : 'triangle', 20), h('span', {}, instrumentName(x.instrument)), h('span', { class: 'muted' }, x.duration ? ` · ${Math.round(x.duration)} s` : ''), !x.success && x.message ? h('span', { class: 'muted' }, ` · ${x.message}`) : null))));
  };
  render();
  const offs = [store.on('mission', render)];
  return () => offs.forEach((o) => o());
}
