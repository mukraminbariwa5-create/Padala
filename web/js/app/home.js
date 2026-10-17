// Home and the Projects page, and Dala's reminders about waiting files.
import { encryptText } from '../crypto.js';
import { react, pose } from '../dala.js';
import { tr, locale } from '../i18n.js';
import { esc, icon, ago, toast, withLoading, initials } from '../ui.js';
import { formatBytes } from '../sync.js';
import { installHtml } from './install.js';
import { loadProjects, avatarHtml, memberName, partners } from './keys.js';
import { notifyBanner } from './push.js';
import { peekShared } from './send.js';
import { current, layout, refreshChrome, presenceHtml, projectCards, projectCardHtml, hydrateSummaries, teamSwitchHtml, projInitials, hueOf, keyBanner, shortAgo, STATUS_COLOR } from './shell.js';
import { api, app, STATUS, STATUS_ORDER, S } from './state.js';

export function statsHtml() {
  const count = (st) => S.projects.filter((p) => p.status === st).length;
  const stat = (_, n, label) => `<div class="stat"><b>${n}</b><span>${label}</span></div>`;
  const toGet = S.projects.filter((p) => p.latest && p.latest.by !== S.me.id && !p.latest.downloadedBy.includes(S.me.id)).length;
  return stat(null, S.projects.length - count('paid'), 'Active projects')
    + stat(null, toGet, 'Files to get')
    + stat(null, count('handed_over'), 'Waiting for payment');
}

/** What needs doing: files waiting for you, deliveries not picked up, clients who haven't paid. */
export function attentionHtml() {
  const me = S.me.id;
  const items = [];
  for (const p of S.projects) {
    const l = p.latest;
    if (l && l.by !== me && !l.downloadedBy.includes(me)) {
      items.push({ p, html: `<b>${esc(memberName(l.by).split(' ')[0])}</b> sent ${l.number > 1 ? `version ${l.number} of ` : ''}<b>${esc(p.name)}</b>`, sub: ago(l.at), action: `<a class="btn btn--sm btn--primary" href="#/p/${p.id}/v/${l.number}">Get files</a>` });
    } else if (l && l.by === me && partners().length && partners().some((m) => !l.downloadedBy.includes(m.id))) {
      items.push({ p, html: `Waiting for ${esc(partnerName())} to download <b>${esc(p.name)}</b>${l.number > 1 ? ` v${l.number}` : ''}`, sub: `Sent ${ago(l.at)}`, action: `<a class="btn btn--sm" href="#/p/${p.id}">Open</a>` });
    }
    if (p.status === 'handed_over') {
      items.push({ p, html: `<b>${esc(p.name)}</b> is with the client`, sub: 'Mark it paid when the payment comes in', action: `<button class="btn btn--sm" data-mark-paid="${p.id}">Mark paid</button>` });
    }
  }
  if (!items.length) {
    return `<div class="caught-up"><img src="${pose('content')}" alt=""><span><b>You’re all caught up.</b><span class="muted">Nothing waiting. Dala will tell you when files arrive.</span></span></div>`;
  }
  return items.slice(0, 5).map((it) => `<div class="att-row"><span class="proj-mark" style="--h:${hueOf(it.p.name)}">${esc(projInitials(it.p.name))}</span>
    <span class="grow stack" style="gap:2px;min-width:0"><span class="att-text">${it.html}</span><span class="faint" style="font-size:12.5px">${esc(it.sub)}</span></span>${it.action}</div>`).join('');
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-mark-paid]');
  if (!b) return;
  const id = Number(b.dataset.markPaid);
  try {
    await withLoading(b, () => api.patch(`/api/projects/${id}`, { status: 'paid' }));
    const p = S.projects.find((x) => x.id === id);
    if (p) p.status = 'paid';
    react('nudge', { pose: 'cheer', html: 'Marked as paid.' });
    refreshChrome();
  } catch (err) { toast(esc(err.message), { error: true }); }
});

export const partnerName = () => partners()[0]?.name.split(' ')[0] || 'your partner';

function checklistHtml() {
  const steps = [
    { done: partners().length > 0, title: 'Invite your partner', text: 'Send them a link so they can join your team.', action: '<a class="btn btn--sm" href="#/team">Invite</a>' },
    { done: S.projects.some((p) => p.latestVersion > 0), title: 'Send your first files', text: 'Pick a folder and Padala does the rest.', action: '<button class="btn btn--sm" data-send-files>Send</button>' },
  ];
  if (steps.every((s) => s.done)) return '';
  const next = steps.findIndex((s) => !s.done);
  return `<section class="card stack" style="gap:4px" aria-label="Getting started">
    <span class="label" style="margin-bottom:6px">Getting started · ${steps.filter((s) => s.done).length} of ${steps.length} done</span>
    ${steps.map((s, i) => `<div class="checkstep ${s.done ? 'is-done' : ''} ${i === next ? 'is-next' : ''}">
      <span class="checkmark" aria-hidden="true">${s.done ? icon.check({ size: 14, width: 3 }) : i + 1}</span>
      <div class="grow"><b>${s.title}</b><br><span class="muted" style="font-size:13px">${s.text}</span></div>
      ${!s.done && i === next ? s.action : ''}</div>`).join('')}
  </section>`;
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function mobileTop() {
  return `<div class="topbar topbar--home only-mobile">${teamSwitchHtml()}
    <a class="avatar-link" href="#/settings" aria-label="Your account and settings">${avatarHtml(S.me, 'avatar--btn')}</a></div>`;
}

/** The right-hand column on wide screens: overview numbers, the team, and storage. */
export function overviewHtml() {
  const count = (st) => S.projects.filter((p) => p.status === st).length;
  const toGet = S.projects.filter((p) => p.latest && p.latest.by !== S.me.id && !p.latest.downloadedBy.includes(S.me.id)).length;
  const item = (label, n, href) => `<a class="ov-row" href="${href}"><span class="grow">${label}</span><b>${n}</b></a>`;
  return item('Active projects', S.projects.length - count('paid'), '#/projects')
    + item('Files to get', toGet, '#/projects')
    + item('Waiting for payment', count('handed_over'), '#/projects')
    + item('Paid', count('paid'), '#/projects');
}

export function teamCardHtml() {
  const t = S.team;
  if (!t) return '';
  const members = [...t.members].sort((a, b) => (a.id === S.me.id) - (b.id === S.me.id) || S.online.has(b.id) - S.online.has(a.id));
  return `<div class="side-head"><span class="team-mark">${esc(initials(t.name))}</span>
      <span class="grow stack" style="gap:0;min-width:0"><b class="ellipsis">${esc(t.name)}</b><span class="faint" style="font-size:12.5px">${t.members.length === 1 ? 'Just you so far' : `${t.members.length} members`}</span></span></div>
    <div class="side-members">${members.slice(0, 6).map((m) => `<div class="side-member">${avatarHtml(m, 'avatar--sm', `<span class="presence ${S.online.has(m.id) || m.id === S.me.id ? 'is-on' : ''}"></span>`)}
      <span class="grow ellipsis">${esc(m.name)}${m.id === S.me.id ? ' <span class="faint">(you)</span>' : ''}</span>
      <span class="faint" style="font-size:12px">${m.id === S.me.id || S.online.has(m.id) ? 'Online' : 'Offline'}</span></div>`).join('')}</div>
    <a class="btn btn--sm btn--block" href="#/team">${icon.userPlus({ size: 15 })} Invite someone</a>`;
}

async function loadMiniStorage() {
  const box = app.querySelector('[data-mini-storage]');
  if (!box || !S.team) return;
  try {
    const st = await api.get(`/api/teams/${S.team.id}/storage`);
    const pct = st.limit ? Math.min(100, (st.used / st.limit) * 100) : 0;
    box.innerHTML = `<div class="row" style="justify-content:space-between;align-items:baseline"><b>${formatBytes(st.used)}</b><span class="faint" style="font-size:12.5px">of ${formatBytes(st.limit)}</span></div>
      <div class="meter meter--storage ${pct > 85 ? 'is-high' : ''}"><i style="width:${Math.max(pct, st.used ? 1 : 0)}%"></i></div>
      <a class="linkish" href="#/team" data-go-storage style="font-size:13px;align-self:flex-start">Manage storage</a>`;
  } catch { box.closest('section')?.remove(); }
}

export async function screenHome() {
  if (S.keys && await peekShared()) { location.hash = '#/send?shared'; return; }
  await loadProjects();
  const today = new Date().toLocaleDateString(locale(), { weekday: 'long', month: 'long', day: 'numeric' });
  layout(`
    <div class="screen screen--dash home">
      ${mobileTop()}
      <div class="dash">
        <div class="dash-main">
          <header class="home-head">
            <span class="label">${esc(today)}</span>
            <h1>${greeting()}, ${esc(S.me.name.split(' ')[0])}</h1>
            <span class="muted row desk-only" style="gap:8px;font-size:14px" data-presence>${presenceHtml()}</span>
          </header>
          ${keyBanner()}
          <div data-install-slot="home">${installHtml('home')}</div>
          ${notifyBanner()}
          ${checklistHtml()}
          <div class="stats narrow-only" data-stats>${statsHtml()}</div>
          <section class="stack" aria-label="Needs your attention">
            <span class="label">Needs your attention</span>
            <div class="card card--flush att" data-attention>${attentionHtml()}</div>
          </section>
          <section class="stack" aria-label="Recent projects">
            <div class="row" style="justify-content:space-between"><span class="label">Recent projects</span>
              <span class="row" style="gap:8px"><button class="btn btn--sm" data-new-project>${icon.plus({ size: 14 })} New</button>${S.projects.length ? '<a class="btn btn--sm btn--ghost" href="#/projects">See all</a>' : ''}</span></div>
            <div class="project-grid" data-home-list>${projectCards()}</div>
          </section>
        </div>
        <aside class="dash-side" aria-label="Overview">
          <section class="card card--flush side-card"><span class="label side-label">Overview</span><div data-overview>${overviewHtml()}</div></section>
          <section class="card side-card" data-team-card>${teamCardHtml()}</section>
          <section class="card side-card"><span class="label">Storage</span><div class="stack" style="gap:8px" data-mini-storage><div class="skeleton" style="height:36px"></div></div></section>
        </aside>
      </div>
    </div>`);
  if (matchMedia('(min-width: 1100px)').matches) loadMiniStorage();
  react('welcome', { me: S.me.name.split(' ')[0] });
  if (!partners().length) setTimeout(() => react('invite-first'), 9000);
  else setTimeout(homeNudge, 2600);
}

// Projects page: a sortable table on computers (or cards, the person's choice), cards on phones.
const wide = () => matchMedia('(min-width: 960px)').matches;
const VIEW = 'padala.projView';
const projView = () => { try { return localStorage.getItem(VIEW) === 'cards' ? 'cards' : 'table'; } catch { return 'table'; } };
const SORTS = {
  updated: (a, b) => b.updatedAt - a.updatedAt,
  name: (a, b) => a.name.localeCompare(b.name),
  status: (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || b.updatedAt - a.updatedAt,
  version: (a, b) => (b.latestVersion || 0) - (a.latestVersion || 0),
};

function filteredProjects() {
  const q = S.projQuery.trim().toLowerCase();
  let list = S.projects;
  if (S.projFilter !== 'all') list = list.filter((p) => p.status === S.projFilter);
  if (q) list = list.filter((p) => p.name.toLowerCase().includes(q));
  const sort = SORTS[S.projSort || 'updated'];
  list = [...list].sort(sort);
  return list;
}

function projectTableHtml(list) {
  const col = (key, label, cls = '') => {
    const on = (S.projSort || 'updated') === key;
    return `<button class="pt-sort ${cls} ${on ? 'is-on' : ''}" data-sort="${key}" aria-label="Sort by ${label}">${label}${on ? icon.arrowDown({ size: 13, width: 2.4 }) : ''}</button>`;
  };
  return `<div class="ptable" role="table" aria-label="Projects">
    <div class="pt-row pt-head" role="row">${col('name', 'Project')}${col('status', 'Status')}${col('version', 'Version', 'pt-num')}<span role="columnheader">Last activity</span>${col('updated', 'Updated', 'pt-num')}</div>
    ${list.map((p) => `<a class="pt-row" role="row" href="#/p/${p.id}">
      <span class="pt-name" role="cell"><span class="proj-mark" style="--h:${hueOf(p.name)}">${esc(projInitials(p.name))}</span><b class="ellipsis" translate="no">${esc(p.name)}</b>${p.unread ? `<span class="badge" aria-label="${p.unread} unread">${p.unread}</span>` : ''}</span>
      <span role="cell"><span class="status-pill" style="--c:${STATUS_COLOR[p.status]}"><i></i>${STATUS[p.status]}</span></span>
      <span class="pt-num faint" role="cell">${p.latestVersion ? `v${p.latestVersion}` : '–'}</span>
      <span class="pt-last ellipsis" role="cell" data-summary="${p.id}" translate="no">&nbsp;</span>
      <span class="pt-num faint" role="cell">${esc(shortAgo(p.updatedAt) === 'now' ? 'just now' : ago(p.updatedAt))}</span>
    </a>`).join('')}
  </div>`;
}

export function projectsGridHtml() {
  if (!S.projects.length) return projectCards();
  const list = filteredProjects();
  if (!list.length) return `<div class="empty card" style="grid-column:1/-1">${icon.search({ size: 24 })}<b style="color:var(--pd-text)">Nothing here</b><span>No project matches this filter.</span></div>`;
  if (wide() && projView() === 'table') return projectTableHtml(list);
  return list.map(projectCardHtml).join('');
}

export async function screenProjects() {
  await loadProjects();
  document.title = 'Projects · Padala';
  const count = (st) => S.projects.filter((p) => p.status === st).length;
  const chip = (key, label, n) => `<button class="chip ${S.projFilter === key ? 'is-on' : ''}" data-filter="${key}" aria-pressed="${S.projFilter === key}">${label}<span>${n}</span></button>`;
  const viewBtn = (v, ic, label) => `<button class="seg-btn ${projView() === v ? 'is-on' : ''}" data-view="${v}" aria-pressed="${projView() === v}" aria-label="${label}" title="${label}">${ic}</button>`;
  layout(`<div class="screen screen--page">
    <header class="page-head"><div class="stack" style="gap:2px"><span class="label">${esc(S.team.name)}</span><h1>Projects</h1></div>
      <button class="btn btn--primary btn--sm" data-new-project>${icon.plus({ size: 15 })} New project</button></header>
    ${S.projects.length ? `<div class="toolbar">
      <div class="fx toolbar-search"><div class="fx-box fx-box--sm"><span class="fx-ic">${icon.search({ size: 16 })}</span><input type="search" data-proj-search placeholder="Search projects…" aria-label="Search projects" value="${esc(S.projQuery)}"></div></div>
      <div class="chips" role="group" aria-label="Filter by status">
        ${chip('all', 'All', S.projects.length)}${STATUS_ORDER.map((st) => chip(st, STATUS[st], count(st))).join('')}
      </div>
      <div class="seg-icons desk-only" role="group" aria-label="View">${viewBtn('table', icon.list({ size: 16 }), 'List')}${viewBtn('cards', icon.grid({ size: 16 }), 'Cards')}</div>
    </div>` : ''}
    <div class="project-grid" data-proj-grid data-view="${projView()}">${projectsGridHtml()}</div>
  </div>`);
  hydrateSummaries();
  const redraw = () => {
    const g = app.querySelector('[data-proj-grid]');
    if (!g) return;
    g.dataset.view = projView();
    g.innerHTML = projectsGridHtml();
    hydrateSummaries();
  };
  app.querySelector('[data-proj-search]')?.addEventListener('input', (e) => { S.projQuery = e.target.value; redraw(); });
  app.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
    S.projFilter = b.dataset.filter;
    app.querySelectorAll('[data-filter]').forEach((x) => { x.classList.toggle('is-on', x === b); x.setAttribute('aria-pressed', x === b); });
    redraw();
  }));
  app.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
    try { localStorage.setItem(VIEW, b.dataset.view); } catch { /* ignore */ }
    app.querySelectorAll('[data-view]').forEach((x) => { x.classList.toggle('is-on', x === b); x.setAttribute('aria-pressed', x === b); });
    redraw();
  }));
  app.querySelector('[data-proj-grid]').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sort]');
    if (!b) return;
    e.preventDefault();
    S.projSort = b.dataset.sort;
    redraw();
  });
  const mq = matchMedia('(min-width: 960px)');
  const onChange = () => { if (current.name === 'projects') redraw(); else mq.removeEventListener('change', onChange); };
  mq.addEventListener('change', onChange);
}

/** Dala keeps an eye on deliveries: files waiting for you, or files your partner hasn't picked up. */
function homeNudge() {
  if (current.name !== 'home' || !S.keys) return;
  const me = S.me.id;
  const waiting = S.projects.find((p) => p.latest && p.latest.by !== me && !p.latest.downloadedBy.includes(me) && !S.nudged.has(`in:${p.id}:${p.latest.number}`));
  if (waiting) {
    S.nudged.add(`in:${waiting.id}:${waiting.latest.number}`);
    react('nudge', {
      pose: 'point',
      html: `<b>${esc(memberName(waiting.latest.by).split(' ')[0])}</b>’s files for <b>${esc(waiting.name)}</b> are waiting for you${waiting.latest.number > 1 ? ` (version ${waiting.latest.number})` : ''}.`,
      actions: [{ label: 'Get files', href: `#/p/${waiting.id}/v/${waiting.latest.number}`, primary: true }, { label: 'Later' }],
    });
    return;
  }
  const HALF_DAY = 12 * 3600 * 1000;
  const stale = S.projects.find((p) => p.latest && p.latest.by === me && Date.now() - p.latest.at > HALF_DAY
    && partners().some((m) => !p.latest.downloadedBy.includes(m.id)) && !S.nudged.has(`out:${p.id}:${p.latest.number}`));
  if (stale) {
    S.nudged.add(`out:${stale.id}:${stale.latest.number}`);
    const who = partners().find((m) => !stale.latest.downloadedBy.includes(m.id)).name.split(' ')[0];
    react('nudge', {
      pose: 'question',
      html: `${esc(who)} hasn’t downloaded <b>${esc(stale.name)}</b>${stale.latest.number > 1 ? ` version ${stale.latest.number}` : ''} yet. You sent it ${esc(ago(stale.latest.at))}.`,
      actions: [{ label: `Remind ${who}`, primary: true, onClick: () => remind(stale, who) }, { label: 'Later' }],
    });
  }
}

async function remind(project, who) {
  const text = tr(`Hi ${who}! Just a reminder: ${project.latest.number > 1 ? `version ${project.latest.number} of ` : ''}${project.name} is ready for you in Padala.`);
  try {
    const body = await encryptText(S.keys, text, `msg:${project.id}`);
    await api.post(`/api/projects/${project.id}/messages`, { body });
    S.texts.set(`msg:${project.id}:${body}`, text);
    toast(`Reminder sent to ${esc(who)} in the <a href="#/p/${project.id}">chat</a>.`);
    react('nudge', { pose: 'thumbs', html: 'Reminder sent.' });
  } catch (err) { toast(esc(err.message), { error: true }); }
}
