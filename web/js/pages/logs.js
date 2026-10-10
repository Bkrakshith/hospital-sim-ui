// Logs: /rosout, launched stacks' output, dashboard events. Filter, search, pause, download.
import { robot } from '../robot.js';
import { h, fmt } from '../ui.js';

export function mount(root) {
  const level = h('select', {}, h('option', { value: 'info' }, 'Info and above'), h('option', { value: 'warn' }, 'Warnings and errors'),
    h('option', { value: 'error' }, 'Errors only'), h('option', { value: 'debug' }, 'Everything (incl. stack output)'));
  const search = h('input', { type: 'search', placeholder: 'Filter text or source…', style: { flex: 1, minWidth: '160px' } });
  const follow = h('input', { type: 'checkbox', checked: true });
  const count = h('span', { class: 'muted small' });
  const view = h('div', { class: 'log-view' });
  const download = h('button', { class: 'btn sm' }, 'Download');
  const clear = h('button', { class: 'btn sm ghost' }, 'Clear view');
  root.append(h('div', { class: 'page' },
    h('section', { class: 'card' },
      h('div', { class: 'row', style: { marginBottom: '10px' } }, level, search,
        h('label', { class: 'inline' }, follow, 'Auto-scroll'), count, download, clear),
      view)));

  const rank = { debug: 0, info: 1, warn: 2, error: 3 };
  let clearedAt = 0;
  const pass = (l) => {
    if (l.t < clearedAt) return false;
    if (rank[l.level] < rank[level.value]) return false;
    const q = search.value.trim().toLowerCase();
    return !q || l.msg.toLowerCase().includes(q) || String(l.src).toLowerCase().includes(q);
  };
  const line = (l) => h('div', { class: `log-line ${l.level}` },
    h('span', { class: 'muted' }, fmt.time(l.t)), h('span', { class: 'lv' }, l.level), h('span', { class: 'src', title: l.src }, l.src), h('span', {}, l.msg));

  function renderAll() {
    view.innerHTML = '';
    const rows = robot.state.logs.filter(pass).slice(-1500);
    const frag = document.createDocumentFragment();
    rows.forEach((l) => frag.append(line(l)));
    view.append(frag);
    count.textContent = `${rows.length} lines`;
    if (follow.checked) view.scrollTop = view.scrollHeight;
  }
  function add(l) {
    if (!pass(l)) return;
    view.append(line(l));
    while (view.childElementCount > 1500) view.firstChild.remove();
    count.textContent = `${view.childElementCount} lines`;
    if (follow.checked) view.scrollTop = view.scrollHeight;
  }
  level.onchange = renderAll;
  search.oninput = renderAll;
  clear.onclick = () => { clearedAt = Date.now() / 1000; renderAll(); };
  download.onclick = () => {
    const txt = robot.state.logs.map((l) => `${new Date(l.t * 1000).toISOString()} ${l.level.toUpperCase()} [${l.src}] ${l.msg}`).join('\n');
    const a = h('a', { href: URL.createObjectURL(new Blob([txt], { type: 'text/plain' })), download: `g1_dashboard_${Date.now()}.log` });
    a.click();
  };
  const unsubs = [robot.on('log', add), robot.on('logs', renderAll)];
  renderAll();
  return () => unsubs.forEach((u) => u());
}
