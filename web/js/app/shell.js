// Routing, the app shell (sidebar, tab bar, team switcher), loading placeholders and errors.
import { importTeamKey, isValidKeyFormat } from '../crypto.js';
import { react, dalaAway, pose } from '../dala.js';
import { tr, locale } from '../i18n.js';
import { esc, icon, initials, ago, toast, dialog, field } from '../ui.js';
import { screenForgot, screenAuth, screenSetup, joinByLink, createTeam, screenJoin } from './auth.js';
import { screenProject, updateChatHead } from './chat.js';
import { statsHtml, attentionHtml, overviewHtml, teamCardHtml, screenHome, projectsGridHtml, screenProjects } from './home.js';
import { storeKey, activateTeam, syncKeys, backupBanner, avatarHtml, partners } from './keys.js';
import { summaryOf } from './live.js';
import { screenVersion } from './receive.js';
import { screenSend } from './send.js';
import { screenSettings } from './settings.js';
import { api, app, STATUS, STATUS_ORDER, S } from './state.js';
import { screenTeam } from './team.js';

/** The key part of an invite link, forgiving extra spaces, line breaks or a trailing dot from copy-pasting. */
function cleanKey(raw) {
  let k = raw;
  try { k = decodeURIComponent(raw); } catch { /* keep as is */ }
  return k.replace(/\s+/g, '').replace(/[^A-Za-z0-9_-]+$/, '');
}

export let current = { name: null };

function parseRoute() {
  const h = location.hash.replace(/^#/, '') || '/';
  let m;
  if ((m = h.match(/^\/join\/([^/]+)\/([^/]+?)\/?$/))) return { name: 'join', token: m[1].trim(), key: cleanKey(m[2]) };
  if ((m = h.match(/^\/p\/(\d+)\/send$/))) return { name: 'send', id: Number(m[1]) };
  if (h === '/send' || h === '/send?shared') return { name: 'send', id: null, shared: h.endsWith('?shared') };
  if ((m = h.match(/^\/p\/(\d+)\/v\/(\d+)$/))) return { name: 'version', id: Number(m[1]), number: Number(m[2]) };
  if ((m = h.match(/^\/p\/(\d+)$/))) return { name: 'project', id: Number(m[1]) };
  if (['/signin', '/signup', '/forgot', '/setup', '/team', '/projects', '/settings'].includes(h)) return { name: h.slice(1) };
  return { name: 'home' };
}

export async function route() {
  if (S.busy && !confirm(tr('A transfer is still running. Leave this screen and stop it?'))) {
    history.replaceState(null, '', S.busy.hash);
    return;
  }
  S.busy?.abort();
  S.busy = null;
  const r = parseRoute();
  S.enter = current.name !== r.name || current.id !== r.id;
  current = r;
  document.body.dataset.screen = r.name;
  dalaAway(false);
  react('calm');
  document.title = 'Padala';
  if (r.name === 'join') return screenJoin(r);
  if (!S.me) return r.name === 'signup' ? screenAuth('signup') : r.name === 'forgot' ? screenForgot() : screenAuth('signin');
  if (r.name === 'signin' || r.name === 'signup' || r.name === 'forgot') { location.hash = '#/'; return; }
  if (!S.teams.length) return screenSetup();
  if (r.name === 'setup') return screenSetup();
  try {
    if (r.name === 'team') return await screenTeam();
    if (r.name === 'projects') return await screenProjects();
    if (r.name === 'settings') return screenSettings();
    if (r.name === 'project') return await screenProject(r.id);
    if (r.name === 'send') return await screenSend(r.id, { shared: r.shared });
    if (r.name === 'version') return await screenVersion(r.id, r.number);
    return await screenHome();
  } catch (err) {
    showError(err);
  }
}

export function showError(err) {
  if (err?.status === 401) { S.me = null; location.hash = '#/signin'; return; }
  const offline = err?.message === 'No connection';
  dalaAway(true);
  layout(`<div class="screen"><div class="empty" style="min-height:50vh;justify-content:center">
    <img class="art art--md" src="${pose(offline ? 'sad' : 'dizzy')}" alt="">
    <h2>${offline ? 'No connection' : 'Something went wrong'}</h2>
    <p>${esc(offline ? 'Padala can’t reach the server. Check your signal and try again.' : err?.message || 'Please try again.')}</p>
    <button class="btn" data-retry>${icon.refresh()} Try again</button></div></div>`);
  app.querySelector('[data-retry]').onclick = () => route();
}

/** Grey shapes of the screen that's coming (feels faster than a spinner), with a short line for screen readers. */
export function skeletonHtml(kind, label) {
  const bar = (w, h = 14) => `<div class="skeleton" style="width:${w};height:${h}px"></div>`;
  const list = (n) => `<div class="card card--flush sk-list">${Array.from({ length: n }, () => `<div class="sk-row"><div class="skeleton sk-mark"></div><div class="stack" style="gap:8px;flex:1">${bar('55%')}${bar('35%', 12)}</div></div>`).join('')}</div>`;
  const body = kind === 'home'
    ? `<div class="stack" style="gap:8px">${bar('140px', 12)}${bar('60%', 28)}</div>${bar('100%', 76)}${list(3)}`
    : kind === 'files'
      ? `<div class="stack" style="gap:8px">${bar('70%', 28)}${bar('45%', 14)}</div>${list(5)}${bar('100%', 64)}`
      : `<div class="stack" style="gap:8px">${bar('60%', 28)}${bar('80%', 14)}</div>${bar('100%', 120)}`;
  const inner = `<span class="sr-only" role="status">${esc(label)}</span>${body}`;
  return kind === 'files' ? `<div class="stack sk" style="gap:24px" aria-busy="true">${inner}</div>` : `<div class="screen sk" aria-busy="true">${inner}</div>`;
}

export function authLayout(inner) {
  dalaAway(true);
  layout(`<div class="auth-wrap">
    <aside class="auth-side">
      <img class="art art--hero art--float" src="${pose('wave')}" alt="Dala, the Padala robot, waving hello">
      <h2>Send project folders to your partner. Even on weak signal.</h2>
      <div class="auth-points">
        <span>${icon.check({ size: 18, width: 2.6 })} Only the files you changed are sent</span>
        <span>${icon.check({ size: 18, width: 2.6 })} Picks up where it stopped if the signal drops</span>
        <span>${icon.check({ size: 18, width: 2.6 })} Locked with your team’s secret key</span>
      </div>
    </aside>
    <div class="auth"><img class="auth-mini art--float" src="${pose('wave')}" alt="">${inner}</div></div>`, { sidebar: false });
}

export const TAB_SCREENS = ['home', 'projects', 'team', 'settings'];

export function layout(mainHtml, { sidebar = true } = {}) {
  const tabs = sidebar && TAB_SCREENS.includes(current.name) && S.me && S.team;
  document.body.toggleAttribute('data-tabbar', !!tabs);
  app.innerHTML = `<div class="shell">${sidebar ? `<aside class="sidebar" aria-label="Navigation">${sidebarHtml()}</aside>` : ''}
    <main class="main ${S.enter ? 'is-entering' : ''}" id="main">${mainHtml}</main>${tabs ? tabbarHtml() : ''}</div>`;
  S.enter = false;
  hydrateSummaries();
  const filter = app.querySelector('[data-side-filter]');
  if (filter) filter.value = S.sideFilter;
}

function tabbarHtml() {
  const tab = (name, href, label, ic, badge = 0) => `<a class="tab ${current.name === name ? 'is-on' : ''}" href="${href}" ${current.name === name ? 'aria-current="page"' : ''}>
    <span class="tab-ic">${ic}${badge ? `<span class="tab-badge">${badge > 9 ? '9+' : badge}</span>` : ''}</span><span>${label}</span></a>`;
  const unread = S.projects.reduce((n, p) => n + (p.unread || 0), 0);
  return `<nav class="tabbar only-mobile" aria-label="Main">
    ${tab('home', '#/', 'Home', icon.home({ size: 22 }))}
    ${tab('projects', '#/projects', 'Projects', icon.folders({ size: 22 }), unread)}
    <button class="tab-send" data-send-files aria-label="Send files"><span>${icon.up({ size: 24, width: 2.6 })}</span></button>
    ${tab('team', '#/team', 'Team', icon.users({ size: 22 }), otherUnread())}
    ${tab('settings', '#/settings', 'You', avatarHtml(S.me, 'avatar--xs'))}
  </nav>`;
}

export function refreshChrome() {
  const side = app.querySelector('.sidebar');
  if (side) {
    const focused = document.activeElement?.matches?.('[data-side-filter]');
    side.innerHTML = sidebarHtml();
    hydrateSummaries();
    const f = side.querySelector('[data-side-filter]');
    if (f) { f.value = S.sideFilter; if (focused) f.focus(); }
  }
  const tabbar = app.querySelector('.tabbar');
  if (tabbar) tabbar.outerHTML = tabbarHtml();
  if (current.name === 'home') {
    const list = app.querySelector('[data-home-list]');
    if (list) { list.innerHTML = projectCards(); hydrateSummaries(); }
    const stats = app.querySelector('[data-stats]');
    if (stats) stats.innerHTML = statsHtml();
    const att = app.querySelector('[data-attention]');
    if (att) att.innerHTML = attentionHtml();
    const ov = app.querySelector('[data-overview]');
    if (ov) ov.innerHTML = overviewHtml();
    const tc = app.querySelector('[data-team-card]');
    if (tc) tc.innerHTML = teamCardHtml();
  }
  if (current.name === 'projects') {
    const grid = app.querySelector('[data-proj-grid]');
    if (grid) { grid.innerHTML = projectsGridHtml(); hydrateSummaries(); }
  }
  for (const el of app.querySelectorAll('[data-presence]')) el.innerHTML = presenceHtml();
  const homeSwitch = app.querySelector('.screen .team-switch');
  if (homeSwitch) homeSwitch.outerHTML = teamSwitchHtml();
  if (current.name === 'project') updateChatHead();
}

export function presenceHtml() {
  const ps = partners();
  if (!ps.length) return '<span class="dot"></span>Just you so far';
  const on = ps.filter((m) => S.online.has(m.id));
  return `<span class="dot ${on.length ? 'dot--on' : ''}"></span>${on.length ? `${esc(on.map((m) => m.name).join(', '))} online` : `${esc(ps.map((m) => m.name).join(', '))} offline`}`;
}

function stagesHtml(status) {
  const n = STATUS_ORDER.indexOf(status);
  return `<div class="stages" aria-label="Status: ${STATUS[status]}">${STATUS_ORDER.map((s, i) => `<div class="${i <= n ? 'on' : ''} ${i === n ? 'is-now' : ''}">${STATUS[s]}</div>`).join('')}</div>
    <span class="stages-now">${STATUS[status]}</span>`;
}

export function projectCards() {
  if (!S.projects.length) {
    return `<div class="empty card">${icon.folder({ size: 28 })}<b style="color:var(--pd-text)">No projects yet</b><span>A project is one website you’re making. Click <b>Send files</b> and Padala helps you create the first one.</span></div>`;
  }
  return S.projects.slice(0, 4).map(projectCardHtml).join('');
}

export function projectCardHtml(p) {
  return `
    <a class="project-card project-tile" href="#/p/${p.id}">
      <div class="row" style="gap:12px"><span class="proj-mark proj-mark--lg" style="--h:${hueOf(p.name)}">${esc(projInitials(p.name))}</span>
        <span class="grow stack" style="gap:2px;min-width:0"><span class="name" translate="no">${esc(p.name)}</span>
          <span class="faint" style="font-size:12.5px">${p.latestVersion ? `Version ${p.latestVersion}` : 'No files yet'} · ${esc(shortAgo(p.updatedAt) === 'now' ? 'just now' : ago(p.updatedAt))}</span></span>
        ${p.unread ? `<span class="badge" aria-label="${p.unread} unread">${p.unread}</span>` : ''}</div>
      <span class="last" data-summary="${p.id}" translate="no">&nbsp;</span>
      ${stagesHtml(p.status)}
    </a>`;
}

export function hydrateSummaries() {
  for (const el of app.querySelectorAll('[data-summary]')) {
    const p = S.projects.find((x) => x.id === Number(el.dataset.summary));
    if (p) summaryOf(p).then((t) => { el.textContent = t; });
  }
}

function otherUnread() {
  return Object.entries(S.teamUnread).filter(([id]) => Number(id) !== S.team?.id).reduce((n, [, c]) => n + c, 0);
}

export function teamSwitchHtml() {
  const n = otherUnread();
  return `<button class="team-switch" data-switch-team aria-label="Switch team. Current team: ${esc(S.team?.name || '')}">
    <span class="team-mark">${esc(initials(S.team?.name || '?'))}</span>
    <span class="grow stack" style="gap:2px;min-width:0;text-align:left"><b class="team-name">${esc(S.team?.name || '')}</b>
      <span class="muted row" style="gap:4px;font-size:12.5px" data-presence>${presenceHtml()}</span></span>
    ${n ? `<span class="badge" aria-label="${n} new in your other teams">${n}</span>` : ''}
    ${icon.chevron({ size: 16 })}</button>`;
}

async function switchTeamDialog() {
  const data = await dialog(`
    <h2>Your teams</h2>
    <p class="muted" style="font-size:14px">Each team has its own people and projects. They can’t see each other’s files.</p>
    <div class="stack" style="gap:8px;max-height:50vh;overflow:auto">
      ${S.teams.map((t) => {
        const others = t.members.filter((m) => m.id !== S.me.id).map((m) => m.name.split(' ')[0]);
        const n = t.id === S.team?.id ? 0 : (S.teamUnread[t.id] || 0);
        return `<label class="pick"><input type="radio" name="team" value="${t.id}" ${t.id === S.team?.id ? 'checked' : ''}>
          <span class="team-mark">${esc(initials(t.name))}</span>
          <span class="grow"><b>${esc(t.name)}</b><br><span class="muted" style="font-size:12.5px">${others.length ? `With ${esc(others.join(', '))}` : 'Just you so far'}</span></span>
          ${n ? `<span class="badge">${n}</span>` : ''}</label>`;
      }).join('')}
    </div>
    <div class="row" style="flex-wrap:wrap;gap:8px"><button type="button" class="btn btn--sm" data-new-team>${icon.plus({ size: 14 })} New team</button><button type="button" class="btn btn--sm" data-join-team>${icon.link({ size: 14 })} Join with a link</button></div>
    <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-cancel>Close</button><button class="btn btn--primary">Switch</button></div>`,
  { onOpen: (d) => {
    d.querySelector('[data-new-team]').onclick = () => { d.close(); createTeam(); };
    d.querySelector('[data-join-team]').onclick = () => { d.close(); joinByLink(); };
  } });
  if (!data) return;
  const team = S.teams.find((t) => t.id === Number(data.get('team')));
  if (team && team.id !== S.team.id) await switchTo(team);
}

async function switchTo(team) {
  await activateTeam(team);
  delete S.teamUnread[team.id];
  location.hash = '#/';
  route();
  react('team-switched', { name: team.name });
}

/** Unread counts for teams that aren't open right now (for the switcher badge). */
export async function loadOtherUnread() {
  await Promise.all(S.teams.filter((t) => t.id !== S.team?.id).map(async (t) => {
    try {
      const { projects } = await api.get(`/api/teams/${t.id}/projects`);
      S.teamUnread[t.id] = projects.reduce((n, p) => n + (p.unread || 0), 0);
    } catch { /* ignore */ }
  }));
  refreshChrome();
}

document.addEventListener('click', async (e) => {
  if (e.target.closest('[data-switch-team]')) { e.preventDefault(); switchTeamDialog(); }
  const go = e.target.closest('[data-go-team]');
  if (go) { e.preventDefault(); const t = S.teams.find((x) => x.id === Number(go.dataset.goTeam)); if (t) switchTo(t); }
});

function sidebarHtml() {
  const nav = (name, href, label, ic, extra = '') => `<a class="nav-item ${current.name === name ? 'is-on' : ''}" href="${href}" ${current.name === name ? 'aria-current="page"' : ''}>${ic}<span class="grow">${label}</span>${extra}</a>`;
  const unread = S.projects.reduce((n, p) => n + (p.unread || 0), 0);
  const online = S.me && S.live !== false;
  return `
    <div class="side-top"><a class="brand" href="#/"><img src="/icons/icon-64.png" alt=""><span>Padala</span></a></div>
    ${teamSwitchHtml()}
    <button class="btn btn--primary btn--big side-send" data-send-files>${icon.up({ size: 18, width: 2.4 })} Send files</button>
    <nav class="side-nav" aria-label="Main">
      ${nav('home', '#/', 'Home', icon.home({ size: 19 }))}
      ${nav('projects', '#/projects', 'Projects', icon.folders({ size: 19 }), unread ? `<span class="badge">${unread}</span>` : `<span class="nav-count">${S.projects.length}</span>`)}
      ${nav('team', '#/team', 'Team', icon.users({ size: 19 }), partners().length ? `<span class="nav-count">${S.team?.members.length || 1}</span>` : '<span class="nav-hint">Invite</span>')}
      ${nav('settings', '#/settings', 'Settings', icon.gear({ size: 19 }))}
    </nav>
    <div class="side-section">
      <div class="side-head"><span class="label">Projects</span>
        <button class="icon-btn icon-btn--sm" data-new-project aria-label="New project" title="New project">${icon.plus({ size: 16 })}</button></div>
      ${S.projects.length > 4 ? `<div class="side-search">${icon.search({ size: 15 })}<input type="search" data-side-filter placeholder="Find a project" aria-label="Find a project"></div>` : ''}
      <div class="side-list" data-side-list>${projectRows()}</div>
    </div>
    <a class="me-card" href="#/settings" aria-label="Your account and settings">
      ${avatarHtml(S.me, '', `<span class="presence ${online ? 'is-on' : ''}"></span>`)}
      <span class="grow stack" style="gap:0;min-width:0"><b>${esc(S.me?.name || '')}</b><span>@${esc(S.me?.username || '')}</span></span>
      ${icon.gear({ size: 17 })}</a>`;
}

export const projInitials = (name) => {
  const words = String(name).split(/[^A-Za-z0-9]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2)).toUpperCase();
};
const HUES = ['#62f28a', '#4fd1c5', '#60a5fa', '#a78bfa', '#fbbf24', '#fb7185'];
export const hueOf = (name) => HUES[[...String(name)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % HUES.length];
export const STATUS_COLOR = { building: '#fbbf24', sent: '#60a5fa', handed_over: '#a78bfa', paid: '#62f28a' };

export function shortAgo(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return new Date(ts).toLocaleDateString(locale(), { weekday: 'short' });
  return new Date(ts).toLocaleDateString(locale(), { month: 'short', day: 'numeric' });
}

/** Compact, chat-app style rows for the sidebar. */
function projectRows() {
  const q = S.sideFilter.trim().toLowerCase();
  const list = q ? S.projects.filter((p) => p.name.toLowerCase().includes(q)) : S.projects;
  if (!S.projects.length) return `<div class="side-empty">${icon.folder({ size: 20 })}<span>No projects yet. <b>Send files</b> to start one.</span></div>`;
  if (!list.length) return `<div class="side-empty"><span>No project matches “${esc(q)}”.</span></div>`;
  return list.map((p) => `
    <a class="project-card project-row ${p.unread ? 'has-unread' : ''}" href="#/p/${p.id}" ${current.id === p.id && current.name !== 'home' ? 'aria-current="page"' : ''}>
      <span class="proj-mark" style="--h:${hueOf(p.name)}">${esc(projInitials(p.name))}<i style="background:${STATUS_COLOR[p.status]}" title="${STATUS[p.status]}"></i></span>
      <span class="grow stack" style="gap:2px;min-width:0">
        <span class="row" style="gap:4px"><b class="name grow" translate="no">${esc(p.name)}</b><time class="when">${shortAgo(p.updatedAt)}</time></span>
        <span class="row" style="gap:4px"><span class="last grow" data-summary="${p.id}" translate="no">&nbsp;</span>${p.unread ? `<span class="badge" aria-label="${p.unread} unread">${p.unread}</span>` : ''}</span>
      </span>
    </a>`).join('');
}

document.addEventListener('input', (e) => {
  if (!e.target.matches('[data-side-filter]')) return;
  S.sideFilter = e.target.value;
  const list = app.querySelector('[data-side-list]');
  if (list) { list.innerHTML = projectRows(); hydrateSummaries(); }
});

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-new-project]')) { e.preventDefault(); newProject(); }
  if (e.target.closest('[data-send-files]')) { e.preventDefault(); startSend(); }
});

async function newProject({ thenSend = false } = {}) {
  const data = await dialog(`
    <h2>${thenSend ? 'Name the project first' : 'New project'}</h2>
    <p class="muted" style="font-size:14px">A project is one website or system you’re making. Its chat keeps every file you send and every message about it.</p>
    ${field({ id: 'np-name', name: 'name', label: 'Project name', icon: 'tag', maxlength: 80, validate: 'name', autofocus: true })}
    <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn btn--primary">${thenSend ? 'Next' : 'Create'}</button></div>`,
    { onOpen: (d) => d.querySelector('input').focus() });
  if (!data) return;
  try {
    const { project } = await api.post(`/api/teams/${S.team.id}/projects`, { name: data.get('name') });
    if (!S.projects.some((p) => p.id === project.id)) S.projects.unshift(project);
    location.hash = thenSend ? `#/p/${project.id}/send` : `#/p/${project.id}`;
  } catch (err) { toast(esc(err.message), { error: true }); }
}

export function keyBanner() {
  if (!S.keyMissing) return backupBanner();
  return `<div class="notice notice--warn">${icon.key({ size: 18 })}<span class="grow">
    <b>Unlock ${esc(S.team.name)} on this device</b>
    <span>${S.backupOn
      ? 'This team’s key hasn’t been backed up yet. Open Padala once on the device you used to create or join the team (it backs up the key by itself), then tap <b>Check again</b>.'
      : 'Files are locked with your team’s secret key. Confirm your password to unlock them here.'}</span>
    <span class="row" style="margin-top:8px;flex-wrap:wrap;gap:8px">${S.backupOn
      ? '<button class="btn btn--sm btn--primary" data-check-keys>Check again</button>'
      : '<button class="btn btn--sm btn--primary" data-confirm-password="unlock">Unlock with password</button>'}
      <button class="btn btn--sm" data-enter-key>Enter key instead</button>
      ${S.backupOn ? '' : '<a class="btn btn--sm btn--ghost" href="#/setup">Start a new team instead</a>'}</span></span></div>`;
}

document.addEventListener('click', async (e) => {
  if (!e.target.closest('[data-enter-key]')) return;
  const data = await dialog(`
    <h2>Enter team key</h2>
    <p class="muted">Find it on a device that has it: Team → Show team key.</p>
    ${field({ id: 'tk', name: 'key', label: 'Team key', icon: 'key', placeholder: 'Paste the 43-character key', mono: true, validate: 'key', autofocus: true })}
    <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn btn--primary">Save key</button></div>`);
  if (!data) return;
  // Forgive copy-paste: spaces or line breaks, or a whole invite link pasted instead of just the key
  let key = String(data.get('key') || '').replace(/\s+/g, '');
  const inLink = key.match(/#\/join\/[^/]+\/([A-Za-z0-9_-]{43})/);
  if (inLink) key = inLink[1];
  try {
    if (!isValidKeyFormat(key)) throw new Error('That doesn’t look like a team key. It’s 43 letters and numbers: copy it again with the Copy button.');
    const keys = await importTeamKey(key);
    const team = S.teams.find((t) => t.keyCheck === keys.check);
    if (!team) throw new Error('That key doesn’t belong to any of your teams. On the other device, open the right team first, then Settings › Show key.');
    storeKey(team.id, key);
    syncKeys().catch(() => {});
    await activateTeam(team.id === S.team.id ? S.team : team);
    toast(team.id === S.team.id ? 'Team key saved. Your files are unlocked.' : `That was the key for <b>${esc(team.name)}</b>. Saved, and switched to it.`);
    route();
  } catch (err) { toast(esc(err.message), { error: true }); }
});

/** "Send files" from anywhere: straight to choosing a folder; Padala works out where it belongs. */
function startSend() {
  location.hash = '#/send';
}
