// A project: its chat, deliveries, status and actions.
import { encryptText } from '../crypto.js';
import { react, pose } from '../dala.js';
import { forgetFolder } from '../folders.js';
import { formatBytes } from '../sync.js';
import { esc, icon, timeOf, dayOf, toast, dialog, copyText, field } from '../ui.js';
import { partnerName } from './home.js';
import { memberName, partners, avatarHtml } from './keys.js';
import { textOf, markRead } from './live.js';
import { current, layout, refreshChrome, STATUS_COLOR, keyBanner } from './shell.js';
import { api, app, STATUS, STATUS_HELP, STATUS_ORDER, S } from './state.js';
import { enableSwipeToReply } from './touch.js';

export async function getProject(id, { fresh = false } = {}) {
  if (!fresh && S.projectData.has(id)) return S.projectData.get(id);
  const data = await api.get(`/api/projects/${id}`);
  S.projectData.set(id, data);
  const p = S.projects.find((x) => x.id === id);
  if (p) Object.assign(p, data.project); else S.projects.unshift(data.project);
  return data;
}

export async function screenProject(id) {
  const data = await getProject(id, { fresh: true });
  document.title = `${data.project.name} · Padala`;
  layout(`
    <div class="chat-wrap ${detailsOpen() ? '' : 'is-closed'}">
    <section class="chat" aria-label="${esc(data.project.name)}">
      <header class="chat-head" data-chat-head></header>
      ${S.keyMissing ? `<div style="padding:12px 16px 0">${keyBanner()}</div>` : ''}
      <div data-new-files></div>
      <div class="timeline" data-timeline aria-live="polite"></div>
      <div class="reply-bar" data-reply-bar hidden></div>
      <form class="composer" data-composer>
        <label for="msg" class="sr-only">Message</label>
        <textarea class="textarea grow" id="msg" rows="1" maxlength="4000" placeholder="Write a message…" ${S.keyMissing ? 'disabled' : ''}></textarea>
        <button class="send" aria-label="Send message" ${S.keyMissing ? 'disabled' : ''}>${icon.send({ size: 18, width: 2.4 })}</button>
      </form>
    </section>
    <aside class="details" data-details aria-label="Project details"></aside>
    </div>`);
  updateChatHead();
  await rerenderTimeline();
  const last = data.messages[data.messages.length - 1];
  if (last) markRead(id, last.id);
  refreshChrome();

  const form = app.querySelector('[data-composer]');
  const ta = form.querySelector('textarea');
  ta.value = S.drafts[id] || '';
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(160, ta.scrollHeight) + 'px'; };
  ta.addEventListener('input', () => { S.drafts[id] = ta.value; grow(); });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer: fine)').matches) { e.preventDefault(); form.requestSubmit(); }
  });
  grow();
  setReply(id, S.replyTo[id] || null);
  wireMessageActions(id);
  enableSwipeToReply(id);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = ta.value.trim();
    if (!text || !S.keys) return;
    ta.value = '';
    S.drafts[id] = '';
    grow();
    const replyTo = S.replyTo[id] || null;
    setReply(id, null);
    try {
      const body = await encryptText(S.keys, text, `msg:${id}`);
      const { message } = await api.post(`/api/projects/${id}/messages`, { body, ...(replyTo ? { replyTo } : {}) });
      S.texts.set(`msg:${id}:${body}`, text);
      const cached = S.projectData.get(id);
      if (cached && !cached.messages.some((m) => m.id === message.id)) { cached.messages.push(message); await appendMessage(message); }
    } catch (err) {
      ta.value = text;
      S.drafts[id] = text;
      toast(`Message not sent: ${esc(err.message)}`, { error: true });
    }
  });
}

/** Reply bar above the message box. */
export async function setReply(projectId, messageId) {
  S.replyTo[projectId] = messageId;
  const bar = app.querySelector('[data-reply-bar]');
  if (!bar) return;
  const data = S.projectData.get(projectId);
  const m = messageId && data?.messages.find((x) => x.id === messageId);
  if (!m) { bar.hidden = true; bar.innerHTML = ''; return; }
  const text = await textOf(projectId, m.body);
  bar.innerHTML = `<span class="reply-bar-ic">${icon.chat({ size: 15 })}</span><span class="grow stack" style="gap:0;min-width:0"><b>Replying to ${esc(memberName(m.userId))}</b><span translate="no">${esc(text ?? 'Message')}</span></span>
    <button class="icon-btn icon-btn--ghost icon-btn--sm" data-reply-cancel aria-label="Cancel reply">${icon.x({ size: 16 })}</button>`;
  bar.hidden = false;
  bar.querySelector('[data-reply-cancel]').onclick = () => setReply(projectId, null);
}

/** Tap (or right-click) a message: Reply, Copy, and Delete for your own. */
function wireMessageActions(projectId) {
  const tl = app.querySelector('[data-timeline]');
  if (!tl) return;
  const open = async (bubble, x, y) => {
    document.querySelector('.msg-menu')?.remove();
    const data = S.projectData.get(projectId);
    const m = data?.messages.find((z) => z.id === Number(bubble.dataset.mid));
    if (!m || m.deleted) return;
    const mine = m.userId === S.me.id;
    const menu = document.createElement('div');
    menu.className = 'menu-list msg-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `<button role="menuitem" data-act="reply">${icon.chat({ size: 16 })} Reply</button>
      <button role="menuitem" data-act="copy">${icon.copy({ size: 16 })} Copy text</button>
      ${mine ? `<button role="menuitem" class="danger" data-act="delete">${icon.trash({ size: 16 })} Delete</button>` : ''}`;
    document.body.append(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
    menu.querySelector('button').focus();
    const close = () => { menu.remove(); document.removeEventListener('pointerdown', outside, true); };
    const outside = (e) => { if (!menu.contains(e.target)) close(); };
    setTimeout(() => document.addEventListener('pointerdown', outside, true));
    menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    menu.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      close();
      if (act === 'reply') { await setReply(projectId, m.id); app.querySelector('#msg')?.focus(); }
      if (act === 'copy') copyText((await textOf(projectId, m.body)) || '');
      if (act === 'delete') {
        const ok = await dialog(`<h2>Delete this message?</h2><p class="muted" style="font-size:14px">It’s removed for everyone in the chat.</p>
          <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn btn--danger-solid">Delete</button></div>`);
        if (!ok) return;
        try {
          const { message } = await api.del(`/api/messages/${m.id}`);
          Object.assign(m, message);
          await rerenderTimeline();
        } catch (err) { toast(esc(err.message), { error: true }); }
      }
    });
  };
  tl.addEventListener('click', (e) => {
    const jump = e.target.closest('[data-jump]');
    if (jump) {
      const target = tl.querySelector(`[data-mid="${jump.dataset.jump}"]`);
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target?.classList.add('is-flash');
      setTimeout(() => target?.classList.remove('is-flash'), 1200);
      return;
    }
    const bubble = e.target.closest('.bubble[data-mid]');
    if (bubble && !getSelection()?.toString()) open(bubble, e.clientX, e.clientY);
  });
  tl.addEventListener('contextmenu', (e) => {
    const bubble = e.target.closest('.bubble[data-mid]');
    if (!bubble) return;
    e.preventDefault();
    open(bubble, e.clientX, e.clientY);
  });
  tl.addEventListener('keydown', (e) => {
    const bubble = e.target.closest?.('.bubble[data-mid]');
    if (bubble && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); const r = bubble.getBoundingClientRect(); open(bubble, r.left + 20, r.bottom); }
  });
}

// ---- the details panel next to the chat (wide screens): status, versions, people, actions
const DETAILS = 'padala.details';
const detailsOpen = () => { try { return localStorage.getItem(DETAILS) !== 'closed'; } catch { return true; } };

function renderDetails() {
  const box = app.querySelector('[data-details]');
  const data = S.projectData.get(current.id);
  if (!box || !data) return;
  const p = data.project;
  const versions = [...data.versions].reverse();
  const members = S.team?.members || [];
  box.innerHTML = `
    <div class="details-sec">
      <span class="label">Status</span>
      <div class="status-list" role="radiogroup" aria-label="Status">${STATUS_ORDER.map((st) => `<button role="radio" aria-checked="${st === p.status}" class="status-opt ${st === p.status ? 'is-on' : ''}" data-set-status="${st}" style="--c:${STATUS_COLOR[st]}">
        <i></i><span class="grow"><b>${STATUS[st]}</b><span>${STATUS_HELP[st]}</span></span>${st === p.status ? icon.check({ size: 16, width: 2.6 }) : ''}</button>`).join('')}</div>
    </div>
    <div class="details-sec">
      <span class="label">Versions${versions.length ? ` <span class="faint">${versions.length}</span>` : ''}</span>
      ${versions.length ? `<div class="ver-list">${versions.slice(0, 12).map((v) => {
        const got = v.downloadedBy.filter((d) => d.userId !== v.createdBy);
        return `<a class="ver-row" href="#/p/${p.id}/v/${v.number}"><span class="ver-num">v${v.number}</span>
          <span class="grow stack" style="gap:2px;min-width:0"><b class="ellipsis">${v.number === 1 ? `${v.fileCount} files` : `${v.changedCount} changed`} · ${formatBytes(v.number === 1 ? v.totalBytes : v.sentBytes)}</b>
            <span class="faint ellipsis" style="font-size:12px">${esc(memberName(v.createdBy))} · ${esc(dayOf(v.createdAt))}, ${timeOf(v.createdAt)}</span></span>
          ${got.length ? `<span class="ver-got" title="Downloaded">${icon.check({ size: 14, width: 2.6 })}</span>` : ''}</a>`;
      }).join('')}</div>` : '<p class="faint" style="font-size:13px">Nothing sent yet.</p>'}
    </div>
    <div class="details-sec">
      <span class="label">People</span>
      <div class="stack" style="gap:8px">${members.map((m) => `<div class="side-member">${avatarHtml(m, 'avatar--sm', `<span class="presence ${S.online.has(m.id) || m.id === S.me.id ? 'is-on' : ''}"></span>`)}
        <span class="grow ellipsis">${esc(m.name)}${m.id === S.me.id ? ' <span class="faint">(you)</span>' : ''}</span></div>`).join('')}</div>
    </div>
    <div class="details-sec details-actions">
      <button class="btn btn--sm" data-details-rename>${icon.pencil({ size: 14 })} Rename</button>
      <button class="btn btn--sm btn--danger" data-details-delete>${icon.trash({ size: 14 })} Delete</button>
    </div>`;
  box.querySelectorAll('[data-set-status]').forEach((b) => b.addEventListener('click', async () => {
    if (b.dataset.setStatus === p.status) return;
    try { await api.patch(`/api/projects/${p.id}`, { status: b.dataset.setStatus }); } catch (err) { toast(esc(err.message), { error: true }); }
  }));
  box.querySelector('[data-details-rename]').onclick = () => renameProject(p);
  box.querySelector('[data-details-delete]').onclick = () => deleteProject(p);
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-details-toggle]');
  if (!t) return;
  const wrap = app.querySelector('.chat-wrap');
  const open = wrap.classList.toggle('is-closed') === false;
  try { localStorage.setItem(DETAILS, open ? 'open' : 'closed'); } catch { /* ignore */ }
  t.setAttribute('aria-pressed', String(open));
});

export function updateChatHead() {
  const head = app.querySelector('[data-chat-head]');
  const data = S.projectData.get(current.id);
  if (!head || !data) return;
  const p = data.project;
  const ps = partners();
  const on = ps.filter((m) => S.online.has(m.id));
  head.innerHTML = `
    <a class="icon-btn icon-btn--ghost" href="#/" aria-label="Back to home">${icon.back({ size: 22 })}</a>
    <div class="grow stack" style="gap:4px;min-width:0">
      <h1 class="title" translate="no">${esc(p.name)}</h1>
      <span class="sub"><span class="dot ${on.length ? 'dot--on' : ''}"></span><span class="who">${ps.length ? (on.length ? `<span class="only-wide">${esc(on.map((m) => m.name.split(' ')[0]).join(', '))} is </span>online` : `<span class="only-wide">${esc(partnerName())} is </span>offline`) : 'Just you'}</span>
        · <span class="menu"><button class="status-chip" style="--c:${STATUS_COLOR[p.status]}" aria-haspopup="menu" aria-expanded="false" data-status-btn><i></i>${STATUS[p.status]}${icon.chevron({ size: 12 })}</button></span></span>
    </div>
    <a class="btn btn--primary btn--sm head-send" href="#/p/${p.id}/send" aria-label="Send files" title="Send files">${icon.up({ size: 16, width: 2.4 })}<span>Send files</span></a>
    <button class="icon-btn icon-btn--ghost details-toggle" data-details-toggle aria-label="Project details" title="Project details" aria-pressed="${detailsOpen()}">${icon.panel({ size: 20 })}</button>
    <div class="menu"><button class="icon-btn icon-btn--ghost" aria-haspopup="menu" aria-expanded="false" aria-label="More options for this project" data-proj-menu>${icon.more({ size: 20 })}</button></div>`;
  const btn = head.querySelector('[data-status-btn]');
  btn.onclick = (ev) => {
    ev.stopPropagation();
    const open = btn.getAttribute('aria-expanded') === 'true';
    head.querySelector('.menu-list')?.remove();
    btn.setAttribute('aria-expanded', String(!open));
    if (open) return;
    const list = document.createElement('div');
    list.className = 'menu-list menu-list--left';
    list.setAttribute('role', 'menu');
    list.innerHTML = `<span class="label" style="padding:8px 12px 4px">Where is this project?</span>` + STATUS_ORDER.map((s) => `<button role="menuitemradio" aria-checked="${s === p.status}" data-s="${s}">
      <span class="dot ${s === p.status ? 'dot--on' : ''}"></span><span class="grow">${STATUS[s]}<br><span class="faint" style="font-size:12px">${STATUS_HELP[s]}</span></span></button>`).join('');
    btn.after(list);
    list.querySelector('button').focus();
    list.onclick = async (e) => {
      const b = e.target.closest('[data-s]');
      if (!b) return;
      list.remove();
      btn.setAttribute('aria-expanded', 'false');
      try { await api.patch(`/api/projects/${p.id}`, { status: b.dataset.s }); } catch (err) { toast(esc(err.message), { error: true }); }
    };
    setTimeout(() => document.addEventListener('click', function close(e) {
      if (!e.target.closest('.menu')) { list.remove(); btn.setAttribute('aria-expanded', 'false'); document.removeEventListener('click', close); }
    }), 0);
  };
  const more = head.querySelector('[data-proj-menu]');
  more.onclick = (ev) => {
    ev.stopPropagation();
    const open = more.getAttribute('aria-expanded') === 'true';
    head.querySelectorAll('.menu-list').forEach((m) => m.remove());
    more.setAttribute('aria-expanded', String(!open));
    if (open) return;
    const list = document.createElement('div');
    list.className = 'menu-list';
    list.setAttribute('role', 'menu');
    list.innerHTML = `<button role="menuitem" data-act="rename">${icon.pencil({ size: 16 })} Rename project</button>
      <button role="menuitem" data-act="delete" class="danger">${icon.trash({ size: 16 })} Delete project</button>`;
    more.after(list);
    list.querySelector('button').focus();
    list.onclick = (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      list.remove();
      more.setAttribute('aria-expanded', 'false');
      if (b.dataset.act === 'rename') renameProject(p); else deleteProject(p);
    };
    setTimeout(() => document.addEventListener('click', function close(e) {
      if (!e.target.closest('.menu')) { list.remove(); more.setAttribute('aria-expanded', 'false'); document.removeEventListener('click', close); }
    }), 0);
  };
  updateNewFilesBanner();
  renderDetails();
}

async function renameProject(p) {
  const data = await dialog(`<h2>Rename project</h2>
    ${field({ id: 'rn', name: 'name', label: 'Project name', icon: 'tag', value: p.name, maxlength: 80, validate: 'name', autofocus: true, hint: 'Tip: if it matches the folder name, sending that folder again becomes an update.' })}
    <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn btn--primary">Save</button></div>`);
  if (!data) return;
  try {
    await api.patch(`/api/projects/${p.id}`, { name: data.get('name') });
    toast('Project renamed.');
  } catch (err) { toast(esc(err.message), { error: true }); }
}

async function deleteProject(p) {
  const data = S.projectData.get(p.id);
  const versions = data?.versions.length || 0;
  const ok = await dialog(`
    <div class="danger-head">${icon.trash({ size: 22 })}</div>
    <h2>Delete “${esc(p.name)}”?</h2>
    <p class="muted" style="font-size:14.5px">This removes it for everyone in <b style="color:var(--pd-text)">${esc(S.team.name)}</b>: ${versions ? `all ${versions} version${versions === 1 ? '' : 's'}, ` : ''}the files stored in Padala and the chat. It can’t be undone.</p>
    <p class="muted" style="font-size:14.5px">Files anyone already downloaded or saved stay on their computer.</p>
    <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn btn--danger-solid">${icon.trash({ size: 16 })} Delete project</button></div>`);
  if (!ok) return;
  try {
    await api.del(`/api/projects/${p.id}`);
    S.projects = S.projects.filter((x) => x.id !== p.id);
    S.projectData.delete(p.id);
    forgetFolder(p.id);
    location.hash = '#/';
    toast(`“${esc(p.name)}” was deleted.`);
    react('deleted');
  } catch (err) { toast(esc(err.message), { error: true }); }
}

/** A clear banner when the partner sent files this person hasn't downloaded yet. */
function updateNewFilesBanner() {
  const slot = app.querySelector('[data-new-files]');
  const data = S.projectData.get(current.id);
  if (!slot || !data) return;
  const v = [...data.versions].reverse().find((x) => x.createdBy !== S.me.id);
  const waiting = v && !v.downloadedBy.some((d) => d.userId === S.me.id) && v.number === data.versions[data.versions.length - 1].number;
  if (waiting && !S.announced.has(v.id)) {
    S.announced.add(v.id);
    react('new-files', { name: memberName(v.createdBy).split(' ')[0], project: data.project.name, count: v.number === 1 ? v.fileCount : v.changedCount, href: `#/p/${data.project.id}/v/${v.number}` });
  }
  slot.innerHTML = waiting ? `<div class="new-files">
      <span class="up">${icon.download({ size: 20, width: 2.2 })}</span>
      <span class="grow"><b>${esc(memberName(v.createdBy))} sent you new files</b><br><span style="font-size:13px">Version ${v.number} · ${v.number === 1 ? `${v.fileCount} files` : `${v.changedCount} changed`}</span></span>
      <a class="btn btn--primary btn--sm" href="#/p/${data.project.id}/v/${v.number}">Get files</a></div>` : '';
}

export async function rerenderTimeline() {
  const tl = app.querySelector('[data-timeline]');
  const data = S.projectData.get(current.id);
  if (!tl || !data) return;
  const parts = [];
  let lastDay = null;
  for (const m of data.messages) {
    if (m.kind === 'download') continue; // shown on the delivery itself ("Partner downloaded it")
    const day = dayOf(m.createdAt);
    if (day !== lastDay) { parts.push(`<div class="day">${esc(day)}</div>`); lastDay = day; }
    parts.push(await messageHtml(m, data));
  }
  if (!data.versions.length) {
    parts.push(`<div class="empty card" style="align-self:center;max-width:420px;margin-top:8px">
      <img class="art art--md art--float" src="${pose('ready')}" alt=""><b style="color:var(--pd-text)">No files sent yet</b>
      <span>When the project is ready, click <b>Send files</b> and choose its folder. ${esc(partnerName())} gets a notification and can download it right away.</span>
      <a class="btn btn--primary" href="#/p/${data.project.id}/send">${icon.up({ size: 16, width: 2.4 })} Send files</a></div>`);
  }
  tl.innerHTML = parts.join('');
  tl.dataset.lastDay = lastDay || '';
  tl.scrollTop = tl.scrollHeight;
  updateNewFilesBanner();
  renderDetails();
}

export async function appendMessage(m) {
  const tl = app.querySelector('[data-timeline]');
  const data = S.projectData.get(current.id);
  if (!tl || !data) return;
  if (m.kind === 'version' || m.kind === 'download' || !data.versions.length) return rerenderTimeline();
  const nearBottom = tl.scrollHeight - tl.scrollTop - tl.clientHeight < 120;
  const day = dayOf(m.createdAt);
  let html = '';
  if (day !== tl.dataset.lastDay) { html += `<div class="day">${esc(day)}</div>`; tl.dataset.lastDay = day; }
  html += await messageHtml(m, data);
  tl.insertAdjacentHTML('beforeend', html);
  if (nearBottom || m.userId === S.me.id) tl.scrollTop = tl.scrollHeight;
}

async function messageHtml(m, data) {
  const mine = m.userId === S.me.id;
  const who = memberName(m.userId);
  switch (m.kind) {
    case 'text': {
      if (m.deleted) {
        return `<div class="bubble bubble--deleted ${mine ? 'bubble--me' : ''}" data-mid="${m.id}"><span class="text">${icon.x({ size: 13 })} ${mine ? 'You deleted this message' : 'This message was deleted'}</span><div class="meta">${mine ? '' : `${esc(who)} · `}${timeOf(m.createdAt)}</div></div>`;
      }
      const text = await textOf(data.project.id, m.body);
      let quote = '';
      if (m.replyTo) {
        const orig = data.messages.find((x) => x.id === m.replyTo);
        const origText = !orig ? null : orig.deleted ? null : await textOf(data.project.id, orig.body);
        quote = `<button class="reply-quote" data-jump="${m.replyTo}"><b>${esc(orig ? memberName(orig.userId) : 'Message')}</b><span ${orig?.deleted ? '' : 'translate="no"'}>${orig?.deleted ? '<i>Deleted message</i>' : esc(origText ?? 'Message')}</span></button>`;
      }
      return `<div class="bubble ${mine ? 'bubble--me' : ''}" data-mid="${m.id}" tabindex="0">${quote}<span class="text"${text === null ? '' : ' translate="no"'}>${text === null ? '<i class="muted">Can’t read this message on this device (team key missing).</i>' : esc(text)}</span><div class="meta">${mine ? '' : `${esc(who)} · `}${timeOf(m.createdAt)}</div></div>`;
    }
    case 'version': {
      const v = data.versions.find((x) => x.id === m.meta.versionId);
      if (!v) return `<div class="system">${icon.clock({ size: 13 })} Version ${esc(m.meta.number)} was cleared to save space</div>`;
      const note = v.note ? await textOf(data.project.id, v.note, 'note') : '';
      const others = v.downloadedBy.filter((d) => d.userId !== v.createdBy);
      const first = v.number === 1;
      const got = v.downloadedBy.some((d) => d.userId === S.me.id);
      const receipt = mine
        ? (others.length ? `${icon.check({ size: 13, stroke: 'var(--pd-accent)', width: 2.6 })} ${esc(memberName(others[others.length - 1].userId))} downloaded it` : `Waiting for ${esc(partnerName())} to download`)
        : (got ? `${icon.check({ size: 13, stroke: 'var(--pd-accent)', width: 2.6 })} You downloaded it` : '');
      return `<a class="delivery ${mine ? 'delivery--me' : ''}" href="#/p/${data.project.id}/v/${v.number}">
        <div class="row"><span class="file-ic">${icon.folder({ size: 20 })}</span><div class="grow stack" style="gap:0">
          <b>${mine ? 'You sent' : `${esc(who)} sent`} ${first ? 'the project files' : 'an update'}</b>
          <span class="faint" style="font-size:12px">Version ${v.number} · ${timeOf(v.createdAt)}</span></div></div>
        ${note ? `<div class="note" translate="no">“${esc(note)}”</div>` : ''}
        <div class="muted" style="font-size:13px">${first ? `${v.fileCount} files · ${formatBytes(v.totalBytes)}` : `${v.changedCount} file${v.changedCount === 1 ? '' : 's'} changed · only ${formatBytes(v.sentBytes)} sent`}</div>
        <div class="foot"><span class="row" style="gap:4px">${receipt}</span>${mine ? '<span>View</span>' : `<span class="btn btn--sm ${got ? '' : 'btn--primary'}">${got ? 'Get again' : 'Get files'}</span>`}</div>
      </a>`;
    }
    case 'download':
      return `<div class="system">${icon.check({ size: 13, stroke: 'var(--pd-accent)', width: 2.6 })}${esc(who)} downloaded version ${m.meta.number}</div>`;
    case 'status':
      return `<div class="system system--plain">${m.meta.auto ? `Project marked as <b>${STATUS[m.meta.to]}</b>` : `${esc(who)} marked the project as <b>${STATUS[m.meta.to]}</b>`}</div>`;
    default:
      return `<div class="system system--plain">${esc(who)} created <b>${esc(m.meta?.name || 'the project')}</b></div>`;
  }
}
