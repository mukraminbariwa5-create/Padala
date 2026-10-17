// Getting a version: browse, preview, save to a folder or download a ZIP.
import { setupFromPaths, setupSteps } from '../checkup.js';
import { contentId } from '../crypto.js';
import { react } from '../dala.js';
import { canWriteFolders, openFolderForUpdate, readFileAt, writeFileAt, removeFileAt, rememberFolder, savedFolder, allowWrite, isEmptyFolder } from '../folders.js';
import { openPreview, fileIcon } from '../preview.js';
import { diffFiles, toMap, planUpdate, resolvePlan, formatBytes } from '../sync.js';
import { loadManifest, receiveFiles } from '../transfer.js';
import { esc, icon, timeOf, dayOf, toast, dialog } from '../ui.js';
import { makeZip } from '../zip.js';
import { getProject } from './chat.js';
import { memberName } from './keys.js';
import { textOf } from './live.js';
import { progressHtml, arrival, makeProgressUpdater, keepAwake, successHtml, guideHtml, wireGuide, lockedScreen } from './progress.js';
import { current, skeletonHtml, layout } from './shell.js';
import { api, app, S } from './state.js';

export async function screenVersion(id, number) {
  const data = await getProject(id, { fresh: true });
  const v = data.versions.find((x) => x.number === number);
  if (!v) throw new Error('That version doesn’t exist.');
  if (!S.keys) { lockedScreen(`#/p/${id}`, 'Get files'); return; }
  const p = data.project;
  const prev = data.versions.find((x) => x.number === number - 1);
  const latest = data.versions[data.versions.length - 1];
  document.title = `Version ${number} · ${p.name} · Padala`;

  const shell = (inner) => layout(`<div class="screen">
    <div class="topbar"><a class="icon-btn icon-btn--ghost" href="#/p/${id}" aria-label="Back to the chat" style="margin-left:-10px">${icon.back({ size: 22 })}</a>
      <span class="label grow">Get files · ${esc(p.name)}</span></div>${inner}</div>`);
  shell(skeletonHtml('files', `Opening ${p.name}…`));

  const [manifest, prevManifest, note, saved] = await Promise.all([
    loadManifest({ api, teamId: S.team.id, keys: S.keys, manifestId: v.manifest }),
    prev ? loadManifest({ api, teamId: S.team.id, keys: S.keys, manifestId: prev.manifest }).catch(() => null) : null,
    v.note ? textOf(id, v.note, 'note') : '',
    canWriteFolders() ? savedFolder(id) : null,
  ]);
  const diff = diffFiles(prevManifest ? toMap(prevManifest.files) : null, toMap(manifest.files));
  const rows = prev ? [
    ...diff.modified.map((x) => ['Changed', 'mod', x]), ...diff.added.map((x) => ['New', 'add', x]), ...diff.removed.map((x) => ['Deleted', 'del', x]),
  ] : [];
  const mine = v.createdBy === S.me.id;
  const writable = canWriteFolders();
  const guide = setupSteps(manifest.setup || setupFromPaths(manifest.files.map((f) => f.p), p.name), p.name);
  const sender = mine ? 'You' : memberName(v.createdBy).split(' ')[0];

  const choiceHtml = () => {
    if (!writable) {
      return `<button class="option option--main" data-zip><span class="option-ic">${icon.download({ size: 22 })}</span>
          <span class="grow"><b>Download as ZIP</b><span>One file with everything inside. Unzip it, then open the folder.</span></span></button>
        <p class="hint">Tip: on a computer with Chrome or Edge, Padala can save straight into a folder and update it in one click next time.</p>`;
    }
    if (saved) {
      return `<button class="option option--main" data-update-saved><span class="option-ic">${icon.refresh({ size: 22 })}</span>
          <span class="grow"><b>Update my copy</b><span>In your folder <b style="color:var(--pd-text)">${esc(saved.name)}</b>. ${prev ? 'Only the changed files are replaced.' : 'All files are saved there.'}</span></span></button>
        <button class="option" data-update><span class="option-ic">${icon.folder({ size: 20 })}</span><span class="grow"><b>Save to a different folder</b></span></button>
        <button class="option" data-zip><span class="option-ic">${icon.download({ size: 20 })}</span><span class="grow"><b>Download as ZIP instead</b></span></button>`;
    }
    return `<button class="option option--main" data-update><span class="option-ic">${icon.folder({ size: 22 })}</span>
        <span class="grow"><b>Save to a folder</b> <span class="rec">Recommended</span><span>Choose or create an <b style="color:var(--pd-text)">empty folder</b>, for example <b style="color:var(--pd-text)">Desktop › ${esc(p.name)}</b>. Next time, updates go there in one click.</span></span></button>
      <button class="option" data-zip><span class="option-ic">${icon.download({ size: 20 })}</span>
        <span class="grow"><b>Download as ZIP</b><span>One file. Unzip it, then open the folder.</span></span></button>`;
  };

  shell(`
    <div class="stack" style="gap:8px">
      <h1 style="font-size:28px;line-height:1.15">${mine ? `You sent ${number === 1 ? 'the project files' : 'an update'}` : `${esc(sender)} sent you ${number === 1 ? 'the project files' : 'an update'}`}</h1>
      <span class="muted" style="font-size:14px">${esc(p.name)} · Version ${number}${number < latest.number ? ` <span class="warn-text">(there’s a newer version ${latest.number})</span>` : ''} · ${esc(dayOf(v.createdAt))}, ${timeOf(v.createdAt)}</span>
      ${note ? `<div class="quote"><span translate="no">“${esc(note)}”</span><span>${esc(sender)}</span></div>` : ''}
    </div>
    <section class="stack" style="gap:12px" aria-label="Files">
      <div class="row" style="justify-content:space-between;align-items:flex-end">
        <span class="stack" style="gap:2px"><b>${v.fileCount} files · ${formatBytes(v.totalBytes)}</b>
          <span class="muted" style="font-size:13px">${prev ? `${v.changedCount} changed since version ${prev.number} · ` : ''}Tap a file to look inside before downloading</span></span>
      </div>
      ${manifest.files.length > 8 ? `<div class="fx"><div class="fx-box fx-box--sm"><span class="fx-ic">${icon.search({ size: 16 })}</span><input type="search" data-filter placeholder="Find a file…" aria-label="Find a file"></div></div>` : ''}
      ${prev && rows.length ? `<div class="seg" role="group" aria-label="Show">
        <label><input type="radio" name="show" value="changed" checked><span>Changed (${rows.length})</span></label>
        <label><input type="radio" name="show" value="all"><span>All files (${manifest.files.length})</span></label></div>` : ''}
      <div class="card card--flush file-list" data-file-list></div>
    </section>
    <span class="label" style="margin-top:4px">How do you want to get the files?</span>
    <div class="stack" style="gap:12px">${choiceHtml()}</div>
    ${writable ? `<p class="hint">Your browser will ask to let Padala <b>edit files</b> in the folder you pick. Click <b>Edit files</b> / <b>Allow</b>. Padala only touches this project’s files, and asks first if you edited any of them.</p>` : ''}
    ${guideHtml(guide, { open: !saved && number === 1 })}`);
  wireGuide(app, guide, p.name);

  if (!mine) react('get-files');

  // ----- file browser + preview
  const changeOf = new Map(rows.map(([k, cls, x]) => [x, [k, cls]]));
  const removed = rows.filter((r) => r[1] === 'del').map((r) => r[2]);
  const listEl = app.querySelector('[data-file-list]');
  const filterEl = app.querySelector('[data-filter]');
  let showAll = !(prev && rows.length);
  let limit = 60;
  const renderList = () => {
    const q = (filterEl?.value || '').trim().toLowerCase();
    let files = manifest.files.filter((f) => showAll || changeOf.has(f.p));
    if (q) files = files.filter((f) => f.p.toLowerCase().includes(q));
    const shown = files.slice(0, limit);
    listEl.innerHTML = (shown.map((f, i) => {
      const name = f.p.split('/').pop();
      const dir = f.p.slice(0, -name.length);
      const ch = changeOf.get(f.p);
      return `<button class="file-row" data-i="${manifest.files.indexOf(f)}">
        <span class="file-kind">${icon[fileIcon(f.p)]({ size: 18 })}</span>
        <span class="grow stack" style="gap:0;min-width:0;text-align:left"><span class="file-name" translate="no">${esc(name)}</span>${dir ? `<span class="file-dir" translate="no">${esc(dir)}</span>` : ''}</span>
        ${ch ? `<span class="change-label change--${ch[1]}">${ch[0]}</span>` : ''}
        <span class="file-size">${formatBytes(f.s)}</span>
        <span class="file-view">${icon.eye({ size: 16 })}<span>View</span></span></button>`;
    }).join('') || `<div class="list-row faint" style="padding:14px 0">No files match “${esc(q)}”.</div>`)
      + (!showAll && !q && removed.length ? removed.slice(0, 20).map((x) => `<div class="file-row is-removed"><span class="file-kind">${icon.x({ size: 16 })}</span><span class="grow file-name" translate="no">${esc(x)}</span><span class="change-label change--del">Deleted</span></div>`).join('') : '')
      + (files.length > shown.length ? `<button class="file-more" data-more>Show ${Math.min(files.length - shown.length, 200)} more of ${files.length - shown.length}</button>` : '');
  };
  renderList();
  listEl.addEventListener('click', (e) => {
    if (e.target.closest('[data-more]')) { limit += 200; renderList(); return; }
    const row = e.target.closest('[data-i]');
    if (!row) return;
    const file = manifest.files[Number(row.dataset.i)];
    openPreview({ api, teamId: S.team.id, keys: S.keys, file });
    react('preview');
  });
  filterEl?.addEventListener('input', () => { limit = 60; renderList(); });
  app.querySelectorAll('input[name=show]').forEach((r) => r.addEventListener('change', () => { showAll = app.querySelector('input[name=show]:checked').value === 'all'; limit = 60; renderList(); }));
  app.querySelector('[data-zip]')?.addEventListener('click', () => downloadZip());
  const guard = (fn) => () => fn().catch((err) => { S.busy = null; if (err.name !== 'AbortError') toast(esc(err.message), { error: true }); });
  app.querySelector('[data-update]')?.addEventListener('click', guard(async () => {
    const dir = await openFolderForUpdate();
    if (!dir) return;
    if (!(await readFileAt(dir, '.padala.json')) && !(await isEmptyFolder(dir))) {
      const go = await dialog(`<h2>This folder isn’t empty</h2>
        <p class="muted">It already has other files in it. It’s easiest to pick an <b>empty</b> folder (you can create one with the “New folder” button in the picker).</p>
        <p class="muted">If you continue, Padala adds the project files here and asks you about any file with the same name.</p>
        <div class="row" style="justify-content:flex-end;flex-wrap:wrap"><button type="button" class="btn" data-cancel>Pick another folder</button><button class="btn btn--primary">Continue anyway</button></div>`);
      if (!go) return;
    }
    await saveInto(dir);
  }));
  app.querySelector('[data-update-saved]')?.addEventListener('click', guard(async () => {
    if (!(await allowWrite(saved))) { toast('Padala needs permission to save into that folder.', { error: true }); return; }
    await saveInto(saved);
  }));

  const receipt = () => api.post(`/api/versions/${v.id}/downloaded`).catch(() => {});
  const localInfo = () => ({ padala: 1, teamId: S.team.id, projectId: id, project: p.name, version: number, versionId: v.id, files: toMap(manifest.files) });
  const folderName = p.name.replace(/[^\w.-]+/g, '-');

  function progressScreen(title, count) {
    shell(progressHtml({ title, from: sender, to: 'This computer', count, sending: false }) + '<div class="spacer"></div><button class="btn btn--big" data-cancel-transfer>Stop</button>');
    const ctrl = new AbortController();
    S.busy = { abort: () => ctrl.abort(), hash: location.hash };
    app.querySelector('[data-cancel-transfer]').onclick = () => { S.busy = null; ctrl.abort(); screenVersion(id, number); };
    react('receiving');
    return { update: makeProgressUpdater(app.querySelector('.screen')), signal: ctrl.signal };
  }

  async function downloadZip() {
    const { update, signal } = progressScreen('Downloading…', manifest.files.length);
    const lock = await keepAwake();
    try {
      const entries = [];
      await receiveFiles({ api, teamId: S.team.id, keys: S.keys, files: manifest.files, signal, progress: update,
        onFile: (path, bytes) => { entries.push({ path: `${folderName}/${path}`, data: bytes }); } });
      entries.push({ path: `${folderName}/.padala.json`, data: new TextEncoder().encode(JSON.stringify(localInfo(), null, 2)) });
      const blob = makeZip(entries);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${folderName}-v${number}.zip`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      S.busy = null;
      receipt();
      const here = current;
      await arrival();
      if (current !== here) return;
      react('received');
      shell(successHtml({
        extra: guideHtml(guide, { sub: 'Next step' }),
        title: 'Downloaded!',
        text: `Look for <b style="color:var(--pd-text)">${esc(a.download)}</b> in your Downloads folder. Right-click it → <b style="color:var(--pd-text)">Extract All</b>, then open the folder in VS Code.`,
        primary: `<a class="btn btn--primary btn--big" href="#/p/${id}">Back to the chat</a>`,
      }));
      wireGuide(app, guide, p.name);
    } catch (err) {
      S.busy = null;
      if (err.name !== 'AbortError') { toast(esc(err.message), { error: true }); screenVersion(id, number); }
    } finally { lock?.release?.(); }
  }

  async function saveInto(dir) {
    let base = null;
    const infoBytes = await readFileAt(dir, '.padala.json');
    if (infoBytes) {
      try {
        const info = JSON.parse(new TextDecoder().decode(infoBytes));
        if (info.projectId !== id || info.teamId !== S.team.id) {
          const ok = await dialog(`<h2>That folder has a different project</h2><p class="muted">It has the files of <b>${esc(info.project || 'another project')}</b>. Save ${esc(p.name)} into it anyway?</p>
            <div class="row" style="justify-content:flex-end;flex-wrap:wrap"><button type="button" class="btn" data-cancel>Pick another folder</button><button class="btn btn--primary">Save anyway</button></div>`);
          if (!ok) return;
        } else {
          base = info.files;
        }
      } catch { /* unreadable info file: treat as unknown folder */ }
    }
    const target = toMap(manifest.files);
    shell(`<div class="stack" style="gap:4px"><h1 style="font-size:28px">Checking your folder…</h1><span class="muted">Looking at what’s already there. Nothing is changed yet.</span></div><div class="meter"><i data-bar style="width:0%"></i></div>`);
    const ctrl = new AbortController();
    S.busy = { abort: () => ctrl.abort(), hash: location.hash };
    const paths = [...new Set([...Object.keys(base || {}), ...Object.keys(target)])];
    const local = {};
    let i = 0;
    for (const path of paths) {
      if (ctrl.signal.aborted) return;
      const bytes = await readFileAt(dir, path);
      if (bytes !== undefined) local[path] = await contentId(S.keys, bytes);
      app.querySelector('[data-bar]').style.width = `${Math.round((++i / paths.length) * 100)}%`;
    }
    S.busy = null;
    const plan = planUpdate(base, target, local);
    if (plan.conflicts.length) react('conflict', { name: sender });
    const choices = plan.conflicts.length ? await askConflicts(plan.conflicts) : {};
    if (!choices) { screenVersion(id, number); return; }
    const ops = resolvePlan(plan, choices, (path) => local[path] !== undefined);
    const byPath = new Map(manifest.files.map((f) => [f.p, f]));
    const toFetch = ops.writes.map((path) => byPath.get(path));

    const { update, signal } = progressScreen(`Saving into ${dir.name}…`, ops.writes.length);
    const lock = await keepAwake();
    try {
      for (const r of ops.renames) {
        const bytes = await readFileAt(dir, r.from);
        if (bytes !== undefined) await writeFileAt(dir, r.to, bytes);
      }
      await receiveFiles({ api, teamId: S.team.id, keys: S.keys, files: toFetch, signal, progress: update,
        onFile: (path, bytes) => writeFileAt(dir, path, bytes) });
      for (const path of ops.deletes) await removeFileAt(dir, path);
      await writeFileAt(dir, '.padala.json', new TextEncoder().encode(JSON.stringify(localInfo(), null, 2)));
      await rememberFolder(id, dir);
      S.busy = null;
      receipt();
      const here = current;
      if (ops.writes.length) await arrival();
      if (current !== here) return;
      react('received');
      const kept = plan.keptLocal.length + Object.values(choices).filter((c) => c === 'mine').length;
      const details = [
        ops.writes.length && `${ops.writes.length} file${ops.writes.length === 1 ? '' : 's'} saved`,
        ops.deletes.length && `${ops.deletes.length} old file${ops.deletes.length === 1 ? '' : 's'} removed`,
        ops.renames.length && `your own version kept as ${ops.renames.map((r) => r.to).join(', ')}`,
        kept && `your own edits kept in ${kept} file${kept === 1 ? '' : 's'}`,
      ].filter(Boolean).join(' · ');
      shell(successHtml({
        extra: number === 1 || !base ? guideHtml(guide, { sub: 'Next step' }) : '',
        title: ops.writes.length + ops.deletes.length ? 'Your copy is up to date!' : 'Already up to date',
        text: `<b style="color:var(--pd-text)">${esc(dir.name)}</b> now has version ${number}. ${esc(details || 'Nothing needed to change.')}<br><br>Next time ${esc(sender === 'You' ? 'you send' : `${sender} sends`)} an update, just click <b style="color:var(--pd-text)">Update my copy</b>.`,
        primary: `<a class="btn btn--primary btn--big" href="#/p/${id}">Back to the chat</a>`,
      }));
      wireGuide(app, guide, p.name);
    } catch (err) {
      S.busy = null;
      if (err.name !== 'AbortError') { toast(esc(err.message), { error: true }); screenVersion(id, number); }
    } finally { lock?.release?.(); }
  }

  async function askConflicts(conflicts) {
    const label = {
      'both-changed': `You edited this file on your computer, and ${sender === 'You' ? 'the new version' : sender} changed it too.`,
      'they-deleted': `${sender === 'You' ? 'The new version' : sender} deleted this file, but you edited it.`,
      'you-deleted': `You deleted this file, but ${sender === 'You' ? 'the new version' : sender} changed it.`,
    };
    const opts = (c) => c.type === 'both-changed'
      ? [['mine', 'Keep my version'], ['theirs', 'Use the new version'], ['both', 'Keep both']]
      : c.type === 'they-deleted' ? [['mine', 'Keep my version'], ['theirs', 'Delete it']] : [['mine', 'Keep it deleted'], ['theirs', 'Bring back the new one']];
    const data = await dialog(`
      <h2>You also changed ${conflicts.length === 1 ? 'a file' : `${conflicts.length} files`}</h2>
      <p class="muted" style="font-size:14px">Padala won’t overwrite your work without asking. Choose what to keep:</p>
      <div style="max-height:55vh;overflow:auto">${conflicts.map((c, i) => `
        <fieldset class="conflict" style="border:0;margin:0;padding:14px 0">
          <legend class="path" translate="no" style="padding:0;margin-bottom:6px;font-size:14px">${esc(c.path)}</legend>
          <span class="muted" style="font-size:13px">${label[c.type]}</span>
          <div class="seg">${opts(c).map(([val, text], j) => `<label><input type="radio" name="c${i}" value="${val}" ${j === 0 ? 'checked' : ''}><span>${text}</span></label>`).join('')}</div>
        </fieldset>`).join('')}</div>
      <p class="hint">“Keep both” saves yours with “.mine” in the name (like config.mine.php) next to the new one.</p>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn btn--primary">Continue</button></div>`);
    if (!data) return null;
    return Object.fromEntries(conflicts.map((c, i) => [c.path, data.get(`c${i}`)]));
  }
}
