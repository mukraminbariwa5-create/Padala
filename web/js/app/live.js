// Decrypting messages, and live updates (long polling) with catch-up.
import { decryptText } from '../crypto.js';
import { react, dalaEnabled } from '../dala.js';
import { forgetFolder } from '../folders.js';
import { tr } from '../i18n.js';
import { esc, icon, toast } from '../ui.js';
import { getProject, updateChatHead, rerenderTimeline, appendMessage } from './chat.js';
import { loadProjects, memberName } from './keys.js';
import { current, route, refreshChrome } from './shell.js';
import { api, STATUS, S } from './state.js';

export async function textOf(projectId, cipher, kind = 'msg') {
  if (!cipher) return '';
  const cacheKey = `${kind}:${projectId}:${cipher}`;
  if (S.texts.has(cacheKey)) return S.texts.get(cacheKey);
  let out;
  try { out = S.keys ? await decryptText(S.keys, cipher, `${kind}:${projectId}`) : null; } catch { out = null; }
  S.texts.set(cacheKey, out);
  return out;
}

export async function summaryOf(project) {
  const m = project.lastMessage;
  if (!m) return tr('No messages yet');
  const who = memberName(m.userId);
  switch (m.kind) {
    case 'text': {
      if (m.deleted) return tr(`${who} deleted a message`);
      const t = await textOf(project.id, m.body);
      // the message itself is someone's own words: only the name part gets translated
      return `${who === 'You' ? tr('You') : who}: ${t ?? tr('Encrypted message')}`;
    }
    case 'version': return tr(`${who} sent ${m.meta.number === 1 ? 'the project files' : 'an update'} (version ${m.meta.number})`);
    case 'download': return tr(`${who} downloaded version ${m.meta.number}`);
    case 'status': return tr(m.meta.auto ? `Marked as ${STATUS[m.meta.to]}` : `${who} marked it as ${STATUS[m.meta.to]}`);
    default: return tr(`${who} created the project`);
  }
}

let lastBeat = Date.now();

/**
 * Live updates by long polling: one request waits at the server and returns the moment something happens
 * (a delivery, a message, someone coming online), then the next one starts. Unlike a streaming connection,
 * this gets through every proxy, tunnel and mobile network, so new files show up without refreshing.
 */
let pollGen = 0;
let pollCtrl = null;
export function stopEvents() { pollGen++; pollCtrl?.abort(); S.live = false; }

export function connectEvents() {
  stopEvents();
  const gen = pollGen;
  const ctrl = new AbortController();
  pollCtrl = ctrl;
  lastBeat = Date.now();
  const handlers = {};
  const es = { addEventListener: (type, fn) => { handlers[type] = fn; } };
  (async () => {
    let session = null;
    let fails = 0;
    while (gen === pollGen && S.me) {
      try {
        const r = await api.get(`/api/events/poll${session ? `?session=${encodeURIComponent(session)}` : ''}`, { signal: ctrl.signal });
        if (gen !== pollGen) return;
        session = r.session;
        lastBeat = Date.now();
        fails = 0;
        if (!S.live) { S.live = true; refreshChrome(); }
        for (const ev of r.events) {
          try { await handlers[ev.type]?.({ data: JSON.stringify(ev.data) }); } catch (err) { console.error(err); }
        }
      } catch (err) {
        if (err.name === 'AbortError' || gen !== pollGen) return;
        if (err.status === 401) { stopEvents(); return; }
        if (S.live) { S.live = false; refreshChrome(); }
        fails++;
        await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** Math.min(fails, 4), 15000)));
      }
    }
  })();
  es.addEventListener('hello', (e) => {
    S.online = new Set(JSON.parse(e.data).online);
    S.live = true;
    refreshChrome();
    if (S.connectedOnce) resync(); // reconnected: catch up on anything sent while the connection was down
    S.connectedOnce = true;
  });
  es.addEventListener('presence', (e) => {
    const d = JSON.parse(e.data);
    if (d.online && !S.online.has(d.userId) && d.userId !== S.me?.id) react('partner-online', { name: memberName(d.userId).split(' ')[0] });
    if (d.online) S.online.add(d.userId); else S.online.delete(d.userId);
    refreshChrome();
  });
  es.addEventListener('message', (e) => onLiveMessage(JSON.parse(e.data)));
  es.addEventListener('project', (e) => {
    const d = JSON.parse(e.data);
    if (d.teamId !== S.team?.id) return;
    const p = S.projects.find((x) => x.id === d.project.id);
    if (p) Object.assign(p, d.project); else loadProjects().then(refreshChrome);
    const cached = S.projectData.get(d.project.id);
    if (cached) Object.assign(cached.project, d.project);
    refreshChrome();
    if (current.name === 'project' && current.id === d.project.id) updateChatHead();
  });
  es.addEventListener('version', (e) => {
    const d = JSON.parse(e.data);
    S.versions.set(d.version.id, d.version);
    const proj = S.projects.find((x) => x.id === d.projectId);
    if (proj && d.version.number >= (proj.latest?.number || 0)) {
      proj.latestVersion = d.version.number;
      proj.latest = { number: d.version.number, by: d.version.createdBy, at: d.version.createdAt, downloadedBy: d.version.downloadedBy.map((x) => x.userId) };
    }
    const cached = S.projectData.get(d.projectId);
    if (cached) {
      const i = cached.versions.findIndex((v) => v.id === d.version.id);
      if (i >= 0) cached.versions[i] = d.version; else cached.versions.push(d.version);
      if (current.name === 'project' && current.id === d.projectId) rerenderTimeline();
    }
  });
  es.addEventListener('message-updated', async (e) => {
    const d = JSON.parse(e.data);
    const cached = S.projectData.get(d.projectId);
    const m = cached?.messages.find((x) => x.id === d.message.id);
    if (m) Object.assign(m, d.message);
    const p = S.projects.find((x) => x.id === d.projectId);
    if (p?.lastMessage?.id === d.message.id) p.lastMessage = d.message;
    if (current.name === 'project' && current.id === d.projectId) await rerenderTimeline();
    refreshChrome();
  });
  es.addEventListener('versions-removed', async (e) => {
    const d = JSON.parse(e.data);
    const cached = S.projectData.get(d.projectId);
    if (cached) cached.versions = cached.versions.filter((v) => !d.numbers.includes(v.number));
    if (current.name === 'version' && current.id === d.projectId && d.numbers.includes(current.number)) {
      toast('That version was cleared to save space.');
      location.hash = `#/p/${d.projectId}`;
      return;
    }
    if (current.name === 'project' && current.id === d.projectId) await rerenderTimeline();
  });
  es.addEventListener('project-deleted', (e) => {
    const d = JSON.parse(e.data);
    if (d.teamId !== S.team?.id) return;
    S.projects = S.projects.filter((p) => p.id !== d.projectId);
    S.projectData.delete(d.projectId);
    forgetFolder(d.projectId);
    if (d.by !== S.me.id) {
      toast(`<b>${esc(memberName(d.by))}</b> deleted <b>${esc(d.name)}</b>.`);
      if (['project', 'send', 'version'].includes(current.name) && current.id === d.projectId) { location.hash = '#/'; return; }
    }
    refreshChrome();
  });
  es.addEventListener('team', async (e) => {
    const d = JSON.parse(e.data);
    const known = S.teams.find((t) => t.id === d.teamId);
    const before = (d.teamId === S.team?.id ? S.team.members : known?.members) || [];
    const gone = before.filter((m) => m.id !== S.me.id && !d.team.members.some((x) => x.id === m.id));
    if (gone.length) toast(`<b>${esc(gone.map((m) => m.name).join(', '))}</b> left <b>${esc(d.team.name)}</b>.`);
    if (known) { known.name = d.team.name; known.members = d.team.members; }
    if (d.teamId === S.team?.id) {
      const joinedNew = d.team.members.length > S.team.members.length;
      S.team.name = d.team.name;
      S.team.members = d.team.members;
      if (joinedNew) react('joined', { name: d.team.members[d.team.members.length - 1].name.split(' ')[0] });
      refreshChrome();
      if (current.name === 'team') route();
    }
  });
}

/**
 * Catch up with the server: new projects, deliveries and messages that arrived while the phone was asleep,
 * the app was in the background, or the connection was down. Live events keep things instant; this makes
 * sure nothing is missed when they can't get through.
 */
let resyncing = null;
export function resync() {
  if (!S.me || !S.team || resyncing) return resyncing;
  resyncing = (async () => {
    const before = new Map(S.projects.map((p) => [p.id, p.latest?.number || 0]));
    try { await loadProjects(); } catch { return; }
    for (const p of S.projects) {
      const l = p.latest;
      const viewingIt = ['project', 'version'].includes(current.name) && current.id === p.id;
      if (l && l.by !== S.me.id && l.number > (before.get(p.id) || 0) && !l.downloadedBy.includes(S.me.id) && !S.announced.has(l.id) && !viewingIt) {
        S.announced.add(l.id);
        react('new-files', { name: memberName(l.by).split(' ')[0], project: p.name, href: `#/p/${p.id}/v/${l.number}` });
      }
    }
    if (current.name === 'project' && current.id && !S.busy) {
      try {
        await getProject(current.id, { fresh: true });
        await rerenderTimeline();
        updateChatHead();
      } catch { /* the project may have been deleted */ }
    }
    refreshChrome();
  })().finally(() => { resyncing = null; });
  return resyncing;
}

// A poll answers at least every 25 seconds. If nothing came back for much longer (the phone paused the
// app in the background, the network dropped the request), start again and catch up.
setInterval(() => {
  if (!S.me || document.hidden) return;
  if (Date.now() - lastBeat > 40000) { connectEvents(); resync(); }
}, 10000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !S.me) return;
  if (Date.now() - lastBeat > 30000) connectEvents();
  resync();
});
window.addEventListener('online', () => { if (S.me) { connectEvents(); resync(); } });
window.addEventListener('pageshow', (e) => { if (e.persisted && S.me) { connectEvents(); resync(); } });

async function onLiveMessage({ teamId, projectId, message }) {
  if (teamId !== S.team?.id) {
    if (message.userId && message.userId !== S.me.id && (message.kind === 'text' || message.kind === 'version')) {
      S.teamUnread[teamId] = (S.teamUnread[teamId] || 0) + 1;
      const t = S.teams.find((x) => x.id === teamId);
      const who = t?.members.find((m) => m.id === message.userId)?.name.split(' ')[0] || 'Someone';
      toast(`${message.kind === 'version' ? `<b>${esc(who)}</b> sent files` : `New message from <b>${esc(who)}</b>`} in <b>${esc(t?.name || 'another team')}</b> <a href="#" data-go-team="${teamId}">Switch</a>`, { ms: 7000 });
      refreshChrome();
    }
    return;
  }
  const project = S.projects.find((p) => p.id === projectId);
  const viewing = current.name === 'project' && current.id === projectId && !document.hidden;
  if (project) {
    project.lastMessage = message;
    project.updatedAt = message.createdAt;
    if (message.userId !== S.me.id && !viewing) project.unread = (project.unread || 0) + 1;
    S.projects.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  const cached = S.projectData.get(projectId);
  if (cached && !cached.messages.some((m) => m.id === message.id)) cached.messages.push(message);
  if (viewing) {
    await appendMessage(message);
    markRead(projectId, message.id);
  } else if (message.userId !== S.me.id && message.userId) {
    if (message.kind === 'text') react('message', { name: memberName(message.userId).split(' ')[0] });
    const delivered = message.kind === 'version' && message.meta && !document.hidden && dalaEnabled();
    if (delivered) {
      const v = message.meta.versionId && S.versions.get(message.meta.versionId);
      S.announced.add(message.meta.versionId);
      react('new-files', {
        name: memberName(message.userId).split(' ')[0], project: project?.name,
        count: v ? (v.number === 1 ? v.fileCount : v.changedCount) : 0, href: `#/p/${projectId}/v/${message.meta.number}`,
      });
    }
    const text = await summaryOf({ id: projectId, lastMessage: message });
    const name = project?.name || 'a project';
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      const n = new Notification(name, { body: text, tag: `project-${projectId}`, icon: '/icons/icon-192.png' });
      n.onclick = () => { window.focus(); location.hash = `#/p/${projectId}`; };
    } else if (!document.hidden && current.id !== projectId && !delivered) {
      toast(`<b>${esc(name)}</b> · <span translate="no">${esc(text)}</span> <a href="#/p/${projectId}">Open</a>`);
    }
  }
  refreshChrome();
}

export function markRead(projectId, lastId) {
  api.post(`/api/projects/${projectId}/read`, { lastId }).catch(() => {});
  const p = S.projects.find((x) => x.id === projectId);
  if (p) p.unread = 0;
}
