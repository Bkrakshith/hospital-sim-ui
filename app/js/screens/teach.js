// Teach a new task: UPCOMING. A labelled preview of the flow (04 §9), not functional:
// define → demonstrate (teleop) → curate → train → sim scorecard → supervised dry run → two-person approval →
// versioned, frozen publish. "Notify me" is remembered on this iPad only.
import { h, ic, button, toast, clear } from '../ui.js';
import { icon } from '../icons.js';

const STEPS = [
  { id: 'define', t: 'Define', who: 'Technician', ico: 'flag', what: 'Name the task, say what it is for, where it starts and ends, the objects involved, where it may run and who may run it. Pick a speed and force profile and the success check.',
    gate: 'Every field filled and the risk questions answered. Tasks near a patient, with sharps or in the sterile field are blocked in this version.',
    preview: () => h('div', { class: 'tp-form' }, row('Task name', 'Fetch suture pack from sterile store'), row('Starts at', 'Sterile store'), row('Ends at', 'Theatre 1 · instrument table'), row('May run in', 'Corridor, sterile store, Theatre 1'), row('Near a patient?', 'No'), row('Sharps?', 'No')) },
  { id: 'demo', t: 'Demonstrate', who: 'Operator', ico: 'handArm', what: 'Do the task 5 to 20 times with manual walking and arms. Mark each take good or bad as you go. The app suggests variations, such as turning the rack.',
    gate: 'At least 10 good takes, none with a proximity warning.',
    preview: () => h('div', { class: 'tp-rec' }, h('span', { class: 'pill pill-rec' }, h('span', { class: 'rec-dot' }), 'REC · take 7'), h('div', { class: 'tp-takes' }, ...[1, 1, 0, 1, 1, 1].map((g, i) => h('span', { class: `tp-take ${g ? 'good' : 'bad'}` }, `${i + 1}`, ic(g ? 'check' : 'x', 14)))), h('p', { class: 'muted' }, 'Hint: try with the pack rotated a quarter turn.')) },
  { id: 'curate', t: 'Review', who: 'Task author', ico: 'eye', what: 'Scrub through each take: robot view, joint plot and contact events. Trim the start and end, drop bad takes, and check the spread of object positions.',
    gate: 'The author confirms the set. It gets a version number.',
    preview: () => h('div', { class: 'tp-curate' }, h('div', { class: 'tp-strip' }, ...Array.from({ length: 10 }, (_, i) => h('span', { class: i === 2 ? 'cut' : '' }))), h('p', { class: 'muted' }, 'Dataset v3 · 12 takes · 1 dropped')) },
  { id: 'train', t: 'Train', who: 'Workstation', ico: 'sim', what: 'Training runs on the workstation, not the iPad. The iPad shows progress and the time left.',
    gate: 'Training finished; the policy and its settings file are exported.',
    preview: () => h('div', { class: 'tp-train' }, h('div', { class: 'bar' }, h('span', { style: { width: '62%' } })), h('p', { class: 'muted' }, 'Step 62 000 of 100 000 · about 40 min left')) },
  { id: 'sim', t: 'Test in sim', who: 'Automatic', ico: 'gauge', what: 'The test suite runs the task many times in the simulated hospital with random changes. The scorecard shows success rate, time, closest distance to people, peak force and joint margins.',
    gate: 'Success at or above 95 % over 100 trials, and no safety violations.',
    preview: () => h('div', { class: 'tp-score' }, score('Success', '97 %', 'ok'), score('Median time', '48 s', ''), score('Closest to a person', '0.9 m', 'ok'), score('Peak force', '11 N', 'ok'), score('Safety violations', '0', 'ok')) },
  { id: 'dry', t: 'Dry run', who: 'Operator + observer', ico: 'robot', what: 'Supervised runs on the real robot in an empty theatre. The operator keeps a hand on Stop.',
    gate: '10 of 10 runs succeed with no interventions.',
    preview: () => h('div', { class: 'tp-takes' }, ...Array.from({ length: 10 }, (_, i) => h('span', { class: `tp-take ${i < 7 ? 'good' : ''}` }, `${i + 1}`, i < 7 ? ic('check', 14) : null))) },
  { id: 'approve', t: 'Approve', who: 'Clinical lead + technician', ico: 'shield', what: 'Two people review the scorecard, the dry-run video and the risk answers, and sign with badge and PIN. The author cannot approve their own task.',
    gate: 'Both signatures, neither of them the author.',
    preview: () => h('div', { class: 'tp-sign' }, sign('Clinical lead', true), sign('Technician', false), h('p', { class: 'muted' }, 'Author: task author · cannot sign')) },
  { id: 'publish', t: 'Publish', who: 'Automatic', ico: 'checkCircle', what: 'The task appears as a tile for the chosen roles and rooms, with its version and track record. It is frozen: any change makes a new version that goes back through testing. Rollback is one tap for a technician.',
    gate: '–',
    preview: () => h('div', { class: 'tp-tile' }, h('span', { class: 'tile-ic', html: icon('sparkles', 36) }), h('span', { class: 'tile-t' }, 'Fetch suture pack'), h('span', { class: 'tile-sub' }, 'v1.0 · taught by operator · approved 2 of 2')) },
];
function row(k, v) { return h('div', { class: 'tp-row' }, h('span', { class: 'muted' }, k), h('span', {}, v)); }
function score(k, v, lvl) { return h('div', { class: `tp-sc lvl-${lvl || 'none'}` }, h('span', { class: 'tp-sc-v' }, v), h('span', { class: 'muted' }, k)); }
function sign(who, done) { return h('div', { class: `tp-sig ${done ? 'done' : ''}` }, ic(done ? 'checkCircle' : 'badge', 26), h('span', {}, who), h('span', { class: 'muted' }, done ? 'signed' : 'waiting')); }

let sel = 'define';
export function mount(el) {
  let notify = false; try { notify = JSON.parse(localStorage.getItem('g1.teach_notify')) || false; } catch { /* ignore */ }
  const flow = h('ol', { class: 'teach-flow', 'aria-label': 'Teach steps' });
  const detail = h('section', { class: 'card teach-detail', 'aria-live': 'polite' });
  const nb = h('button', { class: `btn btn-${notify ? 'secondary' : 'primary'} btn-operator`, type: 'button', 'aria-pressed': notify ? 'true' : 'false', onClick: () => {
    notify = !notify; try { localStorage.setItem('g1.teach_notify', JSON.stringify(notify)); } catch { /* ignore */ }
    nb.className = `btn btn-${notify ? 'secondary' : 'primary'} btn-operator`; nb.setAttribute('aria-pressed', String(notify));
    nb.querySelector('.btn-label').textContent = notify ? 'We will tell you here' : 'Notify me';
    toast(notify ? 'This iPad will show a note when Teach is ready' : 'Notification off', { level: 'ok' });
  } }, ic('bell', 22), h('span', { class: 'btn-label' }, notify ? 'We will tell you here' : 'Notify me'));
  el.append(
    h('section', { class: 'teach-hero' },
      h('div', {}, h('span', { class: 'soon' }, ic('sparkles', 18), 'Coming soon · preview only'), h('h1', {}, 'Teach the robot a new task'),
        h('p', { class: 'lead' }, 'Show it by doing the task yourself with manual control. It learns, is tested in simulation, runs supervised, and needs two people to approve it before anyone can use it in a clinical area.')),
      h('div', { class: 'teach-cta' }, nb, h('p', { class: 'muted small-note' }, 'Nothing on this screen controls the robot.'))),
    flow, detail);
  const renderFlow = () => {
    clear(flow);
    STEPS.forEach((s, i) => flow.append(h('li', {}, h('button', { class: `tf-step${sel === s.id ? ' on' : ''}`, type: 'button', 'aria-current': sel === s.id ? 'step' : undefined, onClick: () => { sel = s.id; renderFlow(); renderDetail(); } },
      h('span', { class: 'tf-n' }, String(i + 1)), h('span', { class: 'tf-ic', html: icon(s.ico, 26) }), h('span', { class: 'tf-t' }, s.t), h('span', { class: 'tf-who' }, s.who)))));
  };
  const renderDetail = () => {
    const i = STEPS.findIndex((s) => s.id === sel);
    const s = STEPS[i];
    clear(detail);
    detail.append(h('div', { class: 'td-grid' },
      h('div', {}, h('div', { class: 'td-k' }, `Step ${i + 1} of ${STEPS.length} · ${s.who}`), h('h2', {}, s.t), h('p', { class: 'td-what' }, s.what),
        h('div', { class: 'td-gate' }, ic('lock', 20), h('div', {}, h('div', { class: 'td-k' }, 'To move on'), h('div', {}, s.gate))),
        h('div', { class: 'row gap' }, i > 0 ? button('Previous', { size: 'operator', kind: 'ghost', icon: 'back', onClick: () => { sel = STEPS[i - 1].id; renderFlow(); renderDetail(); } }) : null,
          i < STEPS.length - 1 ? button('Next step', { size: 'operator', kind: 'secondary', icon: 'chevron', onClick: () => { sel = STEPS[i + 1].id; renderFlow(); renderDetail(); } }) : null)),
      h('div', { class: 'td-preview', 'aria-label': 'Illustration of this step (example data)' }, h('span', { class: 'td-ex' }, 'Example'), s.preview())));
  };
  renderFlow(); renderDetail();
  return null;
}
