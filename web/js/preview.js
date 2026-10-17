// Look inside a file before downloading it. Only that one file is fetched and unlocked, in memory;
// nothing is saved on the device unless the person presses "Download this file".
import { downloadBlob } from './transfer.js';
import { formatBytes } from './sync.js';
import { esc, icon } from './ui.js';

const IMAGE = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml', avif: 'image/avif' };
const VIDEO = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4', ogv: 'video/ogg' };
const AUDIO = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac' };
const TEXT = new Set(('txt md markdown php js mjs cjs ts tsx jsx json html htm css scss sass less sql py rb java kt c cpp h hpp cs go rs swift sh bash bat cmd ps1 '
  + 'yml yaml toml xml ini env conf cfg log csv tsv vue svelte twig blade htaccess gitignore gitattributes editorconfig lock dart r pl lua').split(' '));

const MAX_TEXT_PREVIEW = 400 * 1024;   // show the first 400 KB of long text files
const MAX_PREVIEW = 150 * 1024 * 1024; // don't pull huge files just to look at them

export function extOf(path) {
  const name = path.split('/').pop().toLowerCase();
  if (name.startsWith('.') && !name.slice(1).includes('.')) return name.slice(1); // .htaccess, .env
  return name.includes('.') ? name.split('.').pop() : '';
}

/** 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'other' (text is confirmed after reading). */
export function kindOf(path) {
  const ext = extOf(path);
  if (IMAGE[ext]) return 'image';
  if (VIDEO[ext]) return 'video';
  if (AUDIO[ext]) return 'audio';
  if (ext === 'pdf') return 'pdf';
  if (TEXT.has(ext) || !ext) return 'text';
  return 'other';
}

export function fileIcon(path) {
  const k = kindOf(path);
  return k === 'image' ? 'image' : k === 'video' || k === 'audio' ? 'play' : k === 'text' ? 'code' : 'file';
}

function looksLikeText(bytes) {
  const head = bytes.subarray(0, 8192);
  if (head.includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(head.length === bytes.length ? head : bytes.subarray(0, 8000)); return true; } catch { return false; }
}

function mimeOf(path) {
  const ext = extOf(path);
  return IMAGE[ext] || VIDEO[ext] || AUDIO[ext] || (ext === 'pdf' ? 'application/pdf' : 'application/octet-stream');
}

function codeHtml(bytes) {
  const cut = bytes.length > MAX_TEXT_PREVIEW;
  const text = new TextDecoder().decode(cut ? bytes.subarray(0, MAX_TEXT_PREVIEW) : bytes);
  const lines = text.split(/\r?\n/);
  return `<pre class="code" tabindex="0">${lines.map((l) => `<span>${esc(l) || ' '}</span>`).join('\n')}</pre>
    ${cut ? `<p class="hint" style="padding:10px 16px">Showing the first ${formatBytes(MAX_TEXT_PREVIEW)}. Download the file to see all of it.</p>` : ''}`;
}

/**
 * Open the viewer for one file of a version.
 * file: { p, s, id } from the version's file list.
 */
export function openPreview({ api, teamId, keys, file, onDownloaded }) {
  const name = file.p.split('/').pop();
  const dir = file.p.slice(0, -name.length);
  const el = document.createElement('div');
  el.className = 'viewer';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', `Preview of ${name}`);
  el.innerHTML = `
    <div class="viewer-panel">
      <header class="viewer-head">
        <button class="icon-btn icon-btn--ghost" data-close aria-label="Close preview">${icon.x({ size: 20 })}</button>
        <div class="grow stack" style="gap:1px;min-width:0">
          <b class="viewer-name">${esc(name)}</b>
          <span class="faint viewer-path">${esc(dir || 'Top folder')} · ${formatBytes(file.s)}</span>
        </div>
        <button class="btn btn--sm btn--primary" data-save disabled>${icon.download({ size: 15 })} <span>Download this file</span></button>
      </header>
      <div class="viewer-body" data-body><div class="viewer-wait"><div class="spinner"></div><span data-pct>Unlocking…</span></div></div>
      <footer class="viewer-foot">${icon.lock({ size: 13 })} Unlocked on this device only. Nothing is saved until you download.</footer>
    </div>`;
  document.body.append(el);
  document.body.classList.add('no-scroll');
  const ctrl = new AbortController();
  let url = null;
  let data = null;
  const close = () => {
    ctrl.abort();
    if (url) URL.revokeObjectURL(url);
    el.remove();
    document.body.classList.remove('no-scroll');
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  el.addEventListener('click', (e) => { if (e.target === el) close(); });
  el.querySelector('[data-close]').onclick = close;
  el.querySelector('[data-close]').focus();
  el.querySelector('[data-save]').onclick = () => {
    if (!data) return;
    const a = document.createElement('a');
    a.href = url || URL.createObjectURL(new Blob([data], { type: mimeOf(file.p) }));
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    onDownloaded?.(file);
  };

  const body = el.querySelector('[data-body]');
  const pct = el.querySelector('[data-pct]');
  if (file.s > MAX_PREVIEW) {
    body.innerHTML = `<div class="viewer-wait">${icon.file({ size: 32 })}<b>This file is too big to preview (${formatBytes(file.s)}).</b><span class="muted">Download it to open it on your device.</span></div>`;
    return close;
  }

  let done = 0;
  downloadBlob({
    api, teamId, keys, id: file.id, size: file.s, signal: ctrl.signal,
    hooks: {
      onPieces: (_n, bytes) => { done += bytes; pct.textContent = file.s > 1e6 ? `Unlocking… ${Math.floor((done / file.s) * 100)}%` : 'Unlocking…'; },
      onWaiting: () => { pct.textContent = 'Waiting for signal…'; },
    },
  }).then((bytes) => {
    data = bytes;
    el.querySelector('[data-save]').disabled = false;
    const kind = kindOf(file.p);
    if (kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'pdf') {
      url = URL.createObjectURL(new Blob([bytes], { type: mimeOf(file.p) }));
    }
    if (kind === 'image') body.innerHTML = `<div class="viewer-media viewer-checker"><img src="${url}" alt="${esc(name)}"></div>`;
    else if (kind === 'video') body.innerHTML = `<div class="viewer-media"><video src="${url}" controls playsinline></video></div>`;
    else if (kind === 'audio') body.innerHTML = `<div class="viewer-media"><audio src="${url}" controls></audio></div>`;
    else if (kind === 'pdf') body.innerHTML = `<iframe class="viewer-pdf" src="${url}" title="${esc(name)}"></iframe>`;
    else if (bytes.length === 0) body.innerHTML = '<div class="viewer-wait"><b>This file is empty.</b></div>';
    else if (looksLikeText(bytes)) body.innerHTML = codeHtml(bytes);
    else body.innerHTML = `<div class="viewer-wait">${icon.file({ size: 32 })}<b>No preview for this kind of file.</b><span class="muted">It’s unlocked and ready: press Download this file to open it.</span></div>`;
  }).catch((err) => {
    if (err.name === 'AbortError') return;
    body.innerHTML = `<div class="viewer-wait">${icon.alert({ size: 28 })}<b>Couldn’t open this file.</b><span class="muted">${esc(err.message)}</span></div>`;
  });
  return close;
}
