// Sending files: choose, check, send.
import { inspectProject, setupSteps } from '../checkup.js';
import { react, pose } from '../dala.js';
import { pickFolder, pickFiles, filesFromDrop } from '../folders.js';
import { diffFiles, toMap, formatBytes } from '../sync.js';
import { prepareDelivery, sendDelivery, loadManifest } from '../transfer.js';
import { esc, icon, initials, toast, dialog, field, fieldError, withLoading } from '../ui.js';
import { getProject } from './chat.js';
import { partnerName } from './home.js';
import { activateTeam, loadProjects, partners } from './keys.js';
import { stepsHtml, progressHtml, arrival, makeProgressUpdater, keepAwake, successHtml, lockedScreen } from './progress.js';
import { current, layout } from './shell.js';
import { api, app, S, leftOutFor, saveLeftOut } from './state.js';

// Files shared into Padala from another app (Android share menu), kept by the service worker.
function sharedStore(mode, fn) {
  return new Promise((resolve) => {
    if (!('indexedDB' in window)) { resolve(null); return; }
    const req = indexedDB.open('padala-share', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('shared');
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      const db = req.result;
      const t = db.transaction('shared', mode);
      const r = fn(t.objectStore('shared'));
      t.oncomplete = () => { db.close(); resolve(r?.result ?? null); };
      t.onerror = () => { db.close(); resolve(null); };
    };
  });
}
export const peekShared = () => sharedStore('readonly', (st) => st.get('latest'));
async function takeShared() {
  const item = await peekShared();
  await sharedStore('readwrite', (st) => st.delete('latest'));
  if (!item?.files?.length || Date.now() - item.at > 3600000) return null; // shared over an hour ago: stale
  return item;
}

export async function screenSend(id, { shared = false } = {}) {
  if (!S.keys) { lockedScreen(id ? `#/p/${id}` : '#/', 'Send files'); return; }
  const from = id ? await getProject(id, { fresh: true }) : null;
  const to = partnerName();
  const back = id ? `#/p/${id}` : '#/';
  document.title = 'Send files · Padala';
  const manifests = new Map(); // projectId -> latest manifest (for comparing)
  let checkup = { findings: [], setup: null }; // what Dala found in the chosen folder
  let excluded = new Set();                     // files the person chose to leave out
  const remembered = new Set();                 // projects whose saved "left out" list was applied

  const shell = (step, inner) => layout(`<div class="screen">
    <div class="topbar"><a class="icon-btn icon-btn--ghost" href="${back}" aria-label="Back" style="margin-left:-10px">${icon.back({ size: 22 })}</a>
      <span class="label grow">Send files${from ? ` · ${esc(from.project.name)}` : ''}</span></div>
    ${stepsHtml(step)}${inner}</div>`);

  const teamPicker = !id && S.teams.length > 1 ? `<div class="stack" style="gap:8px"><span class="label">Send to</span>
      <div class="team-chips">${S.teams.map((t) => {
        const others = t.members.filter((m) => m.id !== S.me.id).map((m) => m.name.split(' ')[0]);
        return `<button class="team-chip ${t.id === S.team.id ? 'is-on' : ''}" data-team="${t.id}" aria-pressed="${t.id === S.team.id}">
          <span class="team-mark">${esc(initials(t.name))}</span><span class="stack" style="gap:0;text-align:left"><b>${esc(t.name)}</b><span>${others.length ? esc(others.join(', ')) : 'Just you'}</span></span></button>`;
      }).join('')}</div></div>` : '';
  shell(0, `
    ${teamPicker}
    <div class="stack" style="gap:4px"><h1 style="font-size:28px;line-height:1.15">Choose what to send</h1>
      <span class="muted">Pick the <b style="color:var(--pd-text)">whole project folder</b>. ${esc(to)} gets it exactly the way you have it.</span></div>
    <button class="drop" data-drop>
      <span class="up">${icon.folder({ size: 24, width: 2.2 })}</span>
      <b style="font-size:17px">Choose folder</b>
      <span class="muted" style="font-size:13px">or drag the folder here</span>
    </button>
    <div class="banner">${icon.alert({ size: 18, stroke: 'var(--pd-info)' })}<span>Your browser will ask <b>“Let site view files?”</b> Click <b>View files</b> (or <b>Upload</b>). Padala only reads the files, nothing on your computer is changed.</span></div>
    <button class="linkish" data-files style="align-self:flex-start">Or choose single files instead</button>
    <p class="hint">Sending the same folder again later? Padala recognizes it and sends only what you changed.</p>`);

  react('send-choose');
  app.querySelectorAll('[data-team]').forEach((b) => b.addEventListener('click', async () => {
    const t = S.teams.find((x) => x.id === Number(b.dataset.team));
    if (!t || t.id === S.team.id) return;
    await activateTeam(t);
    delete S.teamUnread[t.id];
    screenSend(null);
  }));
  const drop = app.querySelector('[data-drop]');
  const choose = async (picker) => {
    try {
      const sel = await picker();
      if (sel) await check(sel);
    } catch (err) { toast(esc(err.message), { error: true }); }
  };
  drop.onclick = () => choose(pickFolder);
  app.querySelector('[data-files]').onclick = () => choose(pickFiles);
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('is-over'); choose(() => filesFromDrop(e.dataTransfer)); });
  if (shared) {
    const item = await takeShared();
    history.replaceState(null, '', '#/send');
    if (item) {
      react('nudge', { pose: 'point', html: `Got ${item.files.length === 1 ? 'the file' : `${item.files.length} files`} you shared. Let’s send ${item.files.length === 1 ? 'it' : 'them'}!` });
      choose(async () => ({
        name: '',
        files: item.files.map((f) => ({ path: f.name, size: f.size, read: async () => new Uint8Array(await f.arrayBuffer()) })),
        skipped: [],
      }));
    }
  }

  async function latestManifest(projectId) {
    if (manifests.has(projectId)) return manifests.get(projectId);
    const d = await getProject(projectId, { fresh: true });
    const v = d.versions[d.versions.length - 1];
    const m = v ? { version: v, manifest: await loadManifest({ api, teamId: S.team.id, keys: S.keys, manifestId: v.manifest }) } : null;
    manifests.set(projectId, m);
    return m;
  }

  /** An existing project with this name gets the update; otherwise it becomes a new one. */
  const byName = (name) => {
    const match = S.projects.find((p) => p.name.toLowerCase() === name.toLowerCase());
    return match ? { project: match } : { project: null, name };
  };

  const overlapOf = (prev, entries) => {
    const a = new Set(prev.files.map((f) => f.p));
    const shared = entries.filter((e) => a.has(e.p)).length;
    return shared / Math.max(a.size, entries.length, 1);
  };

  // 1) fingerprint the files, 2) work out where they belong, 3) show what will be sent
  async function check(sel) {
    if (!sel.files.length) { toast('That folder is empty. Choose the folder that has your project files.', { error: true }); return; }
    const total = sel.files.reduce((s, f) => s + f.size, 0);
    shell(1, `<div class="stack" style="gap:4px"><h1 style="font-size:28px">Checking your files…</h1>
      <span class="muted">${sel.files.length} files · ${formatBytes(total)}. This happens on your computer.</span></div>
      <div class="meter"><i data-bar style="width:0%"></i></div>`);
    const bar = app.querySelector('[data-bar]');
    react('checking');
    const ctrl = new AbortController();
    S.busy = { abort: () => ctrl.abort(), hash: location.hash };
    let entries;
    try {
      ({ entries } = await prepareDelivery({ keys: S.keys, files: sel.files, previous: null, signal: ctrl.signal, onProgress: (done) => { bar.style.width = `${Math.round((done / Math.max(total, 1)) * 100)}%`; } }));
    } catch (err) {
      S.busy = null;
      if (err.name !== 'AbortError') { toast(esc(err.message), { error: true }); screenSend(id); }
      return;
    }
    const folder = (sel.name || '').trim();
    excluded = new Set();
    remembered.clear();
    try {
      checkup = await inspectProject({ files: sel.files, folderName: folder, skipped: sel.skipped });
    } catch { checkup = { findings: [], setup: null }; }
    S.busy = null;
    const suggested = folder || `Files ${new Date().toLocaleDateString([], { month: 'short', day: 'numeric' })}`;

    let target;
    if (from) {
      const prev = await latestManifest(from.project.id);
      const sameName = !folder || folder.toLowerCase() === from.project.name.toLowerCase();
      const overlap = prev ? overlapOf(prev.manifest, entries) : 1;
      if (prev && ((!sameName && overlap < 0.5) || overlap < 0.2)) {
        const choice = await dialog(`
          <h2>This looks like a different folder</h2>
          <p class="muted" style="font-size:14px"><b style="color:var(--pd-text)">${esc(suggested)}</b> has ${Math.round(overlap * 100)}% of the same files as <b style="color:var(--pd-text)">${esc(from.project.name)}</b>. How should ${esc(to)} receive it?</p>
          <div class="stack" style="gap:8px">
            <label class="pick"><input type="radio" name="as" value="new" checked><span class="grow"><b>Send it separately</b><br><span class="muted" style="font-size:12.5px">As its own project: “${esc(suggested)}”</span></span></label>
            <label class="pick"><input type="radio" name="as" value="update"><span class="grow"><b>It’s an update to ${esc(from.project.name)}</b><br><span class="muted" style="font-size:12.5px">Becomes version ${prev.version.number + 1}</span></span></label>
          </div>
          <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn btn--primary">Continue</button></div>`);
        if (!choice) { screenSend(id); return; }
        target = choice.get('as') === 'update' ? { project: from.project } : byName(suggested);
      } else {
        target = { project: from.project };
      }
    } else {
      target = byName(suggested);
    }
    await review(sel, entries, total, target);
  }

  async function review(sel, allEntries, _total, target, draft = {}) {
    if (target.project && !remembered.has(target.project.id)) {
      remembered.add(target.project.id);
      const present = new Set(allEntries.map((e) => e.p));
      for (const x of leftOutFor(target.project.id)) if (present.has(x)) excluded.add(x);
    }
    const entries = allEntries.filter((e) => !excluded.has(e.p));
    const total = entries.reduce((sum, e) => sum + e.s, 0);
    const prev = target.project ? await latestManifest(target.project.id) : null;
    const diff = diffFiles(prev ? toMap(prev.manifest.files) : null, toMap(entries));
    const sizeOf = new Map(entries.map((e) => [e.p, e.s]));
    const changed = [...diff.added, ...diff.modified];
    const estimate = prev ? changed.reduce((s, pth) => s + sizeOf.get(pth), 0) : total;
    const nChanged = changed.length + diff.removed.length;
    const rows = [
      ...diff.modified.map((x) => ['Changed', 'mod', x]),
      ...diff.added.map((x) => ['New', 'add', x]),
      ...diff.removed.map((x) => ['Deleted', 'del', x]),
    ];
    const shown = rows.slice(0, 60);
    const nothing = prev && nChanged === 0;
    const isNew = !target.project;
    shell(1, `
      <div class="stack" style="gap:4px">
        <h1 style="font-size:28px;line-height:1.15">${nothing ? 'Nothing has changed' : !prev ? 'Ready to send' : `You changed ${nChanged} file${nChanged === 1 ? '' : 's'}`}</h1>
        <span class="muted">${nothing ? `This folder is the same as version ${prev.version.number}, which ${esc(to)} already has.`
          : !prev ? `${esc(to)} will get the whole folder, exactly as it is. Next time, only the files you change are sent.`
          : `Since version ${prev.version.number}. Only these files will be sent, and ${esc(to)} still gets the complete, updated project.`}</span>
      </div>
      <div class="card stack" style="gap:12px">
        <div class="row" style="gap:16px"><span class="file-ic">${icon.folder({ size: 22 })}</span>
          <span class="grow stack" style="gap:0">
            <span class="label" style="font-size:10.5px">${isNew ? 'New project' : prev ? `Update · version ${prev.version.number + 1}` : 'First version'}</span>
            <b>${esc(isNew ? target.name : target.project.name)}</b>
            <span class="muted" style="font-size:13px">${entries.length} files · ${formatBytes(total)}</span></span>
          <span class="row" style="gap:4px;color:var(--pd-accent);font-size:13px;font-weight:600">${icon.check({ size: 16, width: 2.6 })} Ready</span></div>
        ${isNew ? field({ id: 'pname', name: 'pname', label: 'Name it', icon: 'tag', value: target.name, maxlength: 80, validate: 'name', hint: 'Send a folder with this name again later and Padala treats it as an update.' }) : ''}
        <div class="row" style="flex-wrap:wrap;gap:8px">
          ${isNew && S.projects.length ? '<button class="linkish" data-as-update>It’s an update to something I sent before</button>' : ''}
          ${!isNew ? '<button class="linkish" data-as-new>Send it separately instead</button>' : ''}
        </div>
      </div>
      ${prev && !nothing ? `<div class="card row" style="justify-content:space-between;align-items:center">
          <span class="stack" style="gap:2px"><span class="muted" style="font-size:13px">Will be sent</span><span class="big-number">${formatBytes(estimate)}</span></span>
          <span class="stack" style="gap:2px;text-align:right"><span class="muted" style="font-size:13px">Instead of</span><span class="strike">${formatBytes(total)}</span></span></div>
        <div class="card card--flush">
          ${shown.map(([k, cls, x]) => `<div class="list-row"><span class="change-label change--${cls}">${k}</span><span class="path grow" translate="no">${esc(x)}</span></div>`).join('')}
          ${rows.length > shown.length ? `<div class="list-row"><span class="faint">…and ${rows.length - shown.length} more</span></div>` : ''}
          <div class="list-row"><span class="change-label change--same">Same</span><span class="path grow faint">${diff.unchanged.length} other files (not sent again)</span></div>
        </div>` : ''}
      ${checkupHtml(isNew ? target.name : target.project.name)}
      ${sel.skipped.length ? `<p class="hint">Left out automatically: ${esc(sel.skipped.slice(0, 3).join(', '))}${sel.skipped.length > 3 ? '…' : ''} (not needed by ${esc(to)}).</p>` : ''}
      ${nothing ? '' : field({ id: 'note', name: 'note', label: `Message for ${to}`, optional: true, required: false, icon: 'chat', maxlength: 500, placeholder: 'Add a note about this delivery' })}
      <div class="spacer"></div>
      <div class="row">
        <button class="btn" data-again>${nothing ? 'Choose another folder' : 'Back'}</button>
        ${nothing ? '' : `<button class="btn btn--primary btn--big grow" data-go>${icon.up({ size: 18, width: 2.4 })} Send to ${esc(to)}</button>`}
      </div>`);
    react('review', { nothing, changed: prev ? nChanged : 0 });
    const open = checkup.findings.filter((f) => f.level !== 'good' && !(f.leaveOut && f.leaveOut.every((x) => excluded.has(x))));
    const shownAt = app.querySelector('.screen');
    if (!draft.quiet && open.length) {
      setTimeout(() => {
        if (app.querySelector('.screen') !== shownAt) return; // the screen changed (e.g. something was left out)
        react('checkup', { warn: open.filter((f) => f.level === 'warn').length, info: open.filter((f) => f.level === 'info').length });
      }, 900);
    }
    if (draft.pname !== undefined && app.querySelector('#pname')) app.querySelector('#pname').value = draft.pname;
    if (draft.note && app.querySelector('#note')) app.querySelector('#note').value = draft.note;
    const again = (quiet) => review(sel, allEntries, 0, target, {
      quiet, pname: app.querySelector('#pname')?.value, note: app.querySelector('#note')?.value,
    });
    app.querySelectorAll('[data-leave]').forEach((b) => b.addEventListener('click', () => {
      const f = checkup.findings.find((x) => x.id === b.dataset.leave);
      f.leaveOut.forEach((x) => excluded.add(x));
      again(true);
    }));
    app.querySelectorAll('[data-keep]').forEach((b) => b.addEventListener('click', () => {
      const f = checkup.findings.find((x) => x.id === b.dataset.keep);
      f.leaveOut.forEach((x) => excluded.delete(x));
      again(true);
    }));
    app.querySelector('[data-choose-again]')?.addEventListener('click', () => screenSend(id));
    app.querySelector('[data-again]').onclick = () => screenSend(id);
    app.querySelector('[data-as-new]')?.addEventListener('click', () => review(sel, allEntries, 0, { project: null, name: `${(sel.name || target.project.name).trim()}${sel.name && sel.name.toLowerCase() !== target.project.name.toLowerCase() ? '' : ' (copy)'}` }));
    app.querySelector('[data-as-update]')?.addEventListener('click', async () => {
      const pick = await dialog(`<h2>Which one is it an update to?</h2>
        <div class="stack" style="gap:8px;max-height:50vh;overflow:auto">${S.projects.map((p, i) => `<label class="pick"><input type="radio" name="project" value="${p.id}" ${i === 0 ? 'checked' : ''}>
          <span class="grow"><b>${esc(p.name)}</b><br><span class="muted" style="font-size:12.5px">${p.latestVersion ? `Last sent: version ${p.latestVersion}` : 'Nothing sent yet'}</span></span></label>`).join('')}</div>
        <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn btn--primary">Use this</button></div>`);
      if (!pick) return;
      const project = S.projects.find((p) => p.id === Number(pick.get('project')));
      if (project) review(sel, allEntries, 0, { project });
    });
    app.querySelector('[data-go]')?.addEventListener('click', async (e) => {
      const note = app.querySelector('#note').value.trim();
      let projectId = target.project?.id;
      if (!projectId) {
        const name = app.querySelector('#pname').value.trim();
        if (!name) { fieldError(app.querySelector('.screen'), 'pname', 'Give it a name.'); return; }
        try {
          projectId = await withLoading(e.currentTarget, async () => (await api.post(`/api/teams/${S.team.id}/projects`, { name })).project.id);
        } catch (err) {
          const existing = S.projects.find((p) => p.name.toLowerCase() === name.toLowerCase());
          if (err.status === 409 && existing) { review(sel, allEntries, 0, { project: existing }); toast(`You already have “${esc(name)}”, so this is now an update to it.`); return; }
          fieldError(app.querySelector('.screen'), 'pname', err.message);
          return;
        }
        await loadProjects();
      }
      const setup = checkup.setup ? { ...checkup.setup } : null;
      if (setup && [...excluded].some((x) => x.startsWith('vendor/'))) setup.composer = true;
      saveLeftOut(projectId, [...excluded]);
      send(projectId, { entries, diff }, note, setup);
    });
  }

  function checkupHtml(projectName) {
    const list = checkup.findings;
    if (!list.length && !checkup.setup) return '';
    const isOut = (f) => f.leaveOut && f.leaveOut.every((x) => excluded.has(x));
    const warn = list.filter((f) => f.level === 'warn' && !isOut(f)).length;
    const todo = list.filter((f) => f.level !== 'good' && !isOut(f)).length;
    const guide = checkup.setup ? setupSteps(checkup.setup, projectName) : null;
    const lvlIcon = { warn: icon.alert({ size: 16 }), info: icon.tag({ size: 15 }), good: icon.check({ size: 15, width: 2.6 }) };
    return `<section class="card checkup" aria-label="Folder check">
      <div class="checkup-head"><img src="${pose(warn ? 'alert' : todo ? 'point' : 'thumbs')}" alt="">
        <span class="stack" style="gap:2px"><b>Folder check</b>
          <span class="muted" style="font-size:13px">${warn ? `${warn} thing${warn === 1 ? '' : 's'} to look at before sending` : todo ? 'A few optional things to tidy up' : 'Nothing risky found'}</span></span></div>
      ${list.map((f) => `<div class="finding finding--${isOut(f) ? 'out' : f.level}">
        <span class="finding-ic">${isOut(f) ? icon.x({ size: 15 }) : lvlIcon[f.level]}</span>
        <span class="grow stack" style="gap:2px;min-width:0"><b>${isOut(f) ? `Left out: ${f.title.charAt(0).toLowerCase()}${f.title.slice(1)}` : f.title}</b>
          ${isOut(f) ? '' : `<span class="finding-text">${f.text}</span>`}
          ${f.paths.length && !isOut(f) && f.id !== 'sql' ? `<span class="finding-paths">${f.paths.slice(0, 3).map((x) => esc(x)).join(' · ')}${f.paths.length > 3 ? ` +${f.paths.length - 3}` : ''}</span>` : ''}</span>
        ${f.leaveOut ? (isOut(f) ? `<button class="btn btn--sm" data-keep="${f.id}">Undo</button>` : `<button class="btn btn--sm" data-leave="${f.id}">Leave out</button>`) : ''}
        ${f.again ? '<button class="btn btn--sm" data-choose-again>Choose again</button>' : ''}
      </div>`).join('')}
      ${guide ? `<details class="checkup-guide"><summary>${icon.chat({ size: 15 })}<span>${esc(to)} also gets a setup guide: <b>${esc(guide.title)}</b>, ${guide.steps.length} step${guide.steps.length === 1 ? '' : 's'}</span></summary>
        <ol>${guide.steps.map((st) => `<li><b>${esc(st.title)}.</b> ${st.text}</li>`).join('')}</ol></details>` : ''}
    </section>`;
  }

  async function send(projectId, prepared, note, setup) {
    const online = partners().some((m) => S.online.has(m.id));
    const count = prepared.diff.added.length + prepared.diff.modified.length || prepared.entries.length;
    shell(2, progressHtml({ title: `Sending to ${to}…`, from: 'You', to, count,
      toNote: partners().length ? (online ? '<span class="dot dot--on"></span>Online' : 'Offline · gets it later') : '' })
      + '<div class="spacer"></div><button class="btn btn--big" data-cancel-transfer>Stop sending</button>');
    const update = makeProgressUpdater(app.querySelector('.screen'));
    react('sending', { name: to });
    const ctrl = new AbortController();
    S.busy = { abort: () => ctrl.abort(), hash: location.hash };
    app.querySelector('[data-cancel-transfer]').onclick = () => { S.busy = null; ctrl.abort(); location.hash = `#/p/${projectId}`; };
    const lock = await keepAwake();
    try {
      const version = await sendDelivery({ api, teamId: S.team.id, projectId, keys: S.keys, prepared, note, setup, progress: update, signal: ctrl.signal });
      S.busy = null;
      const here = current;
      await arrival();
      if (current !== here) return; // they left the page meanwhile
      react('sent', { name: to });
      shell(3, successHtml({
        title: 'Sent!',
        text: `${partners().some((m) => S.online.has(m.id)) ? `${esc(to)} is online and sees it now.` : `${esc(to)} gets a notification the next time they open Padala.`} They can view or download <b style="color:var(--pd-text)">${version.number === 1 ? 'the files' : `version ${version.number}`}</b>${setup ? ', with a setup guide' : ''}. You’ll see in the chat when they do.`,
        primary: `<a class="btn btn--primary btn--big" href="#/p/${projectId}">Open the chat</a>`,
      }));
    } catch (err) {
      S.busy = null;
      if (err.name === 'AbortError') return;
      react('error', { message: err.message });
      toast(`Not sent: ${esc(err.message)}`, { error: true });
      screenSend(id);
    } finally { lock?.release?.(); }
  }
}
