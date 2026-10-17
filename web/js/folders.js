// Reading and writing folders in the browser.
// Chrome and Edge on computers can open a folder and write into it (File System Access API).
// Other browsers can still pick a folder to send; they receive deliveries as a .zip.
import { isIgnored, cleanPath } from './sync.js';

export const canWriteFolders = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window;

async function walk(dir, prefix, out, skipped) {
  for await (const [name, handle] of dir.entries()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'directory') {
      if (isIgnored(`${path}/x`)) { skipped.push(path + '/'); continue; }
      await walk(handle, path, out, skipped);
    } else if (isIgnored(path)) {
      skipped.push(path);
    } else {
      out.push({ path, handle });
    }
  }
}

function fromHandles(entries) {
  return Promise.all(entries.map(async ({ path, handle }) => {
    const file = await handle.getFile();
    return { path, size: file.size, read: async () => new Uint8Array(await (await handle.getFile()).arrayBuffer()) };
  }));
}

function fromFileList(list, stripTop) {
  const files = [];
  const skipped = [];
  let top = null;
  for (const f of list) {
    let rel = f.webkitRelativePath || f.name;
    if (stripTop) {
      const i = rel.indexOf('/');
      top ??= i > 0 ? rel.slice(0, i) : null;
      rel = i > 0 ? rel.slice(i + 1) : rel;
    }
    const path = cleanPath(rel);
    if (!path) continue;
    if (isIgnored(path)) { skipped.push(path); continue; }
    files.push({ path, size: f.size, read: async () => new Uint8Array(await f.arrayBuffer()) });
  }
  return { name: top, files, skipped };
}

function pickWithInput({ folder }) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    if (folder) input.webkitdirectory = true;
    input.addEventListener('change', () => resolve(input.files.length ? fromFileList(input.files, folder) : null));
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/** Pick a folder to send. Returns { name, files: [{path, size, read}], skipped: [path] } or null. */
export async function pickFolder() {
  if (canWriteFolders()) {
    try {
      const dir = await window.showDirectoryPicker({ id: 'padala-send', mode: 'read' });
      const entries = [];
      const skipped = [];
      await walk(dir, '', entries, skipped);
      return { name: dir.name, files: await fromHandles(entries), skipped };
    } catch (e) {
      if (e.name === 'AbortError') return null;
      throw e;
    }
  }
  return pickWithInput({ folder: true });
}

export const pickFiles = () => pickWithInput({ folder: false });

/** Files dropped onto the page (folders included, where the browser supports it). */
export async function filesFromDrop(dataTransfer) {
  const items = [...(dataTransfer.items || [])].filter((i) => i.kind === 'file');
  const entries = items.map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return fromFileList(dataTransfer.files, false);
  const files = [];
  const skipped = [];
  const single = entries.length === 1 && entries[0].isDirectory;
  const readEntry = (entry, prefix) => new Promise((resolve) => {
    if (entry.isFile) {
      entry.file((f) => {
        const path = cleanPath(prefix + entry.name);
        if (path && isIgnored(path)) skipped.push(path);
        else if (path) files.push({ path, size: f.size, read: async () => new Uint8Array(await f.arrayBuffer()) });
        resolve();
      }, () => resolve());
    } else {
      if (isIgnored(`${prefix}${entry.name}/x`)) { skipped.push(prefix + entry.name + '/'); resolve(); return; }
      const reader = entry.createReader();
      const all = [];
      const next = () => reader.readEntries(async (batch) => {
        if (!batch.length) {
          const base = single && !prefix ? '' : `${prefix}${entry.name}/`;
          for (const e of all) await readEntry(e, base);
          resolve();
        } else { all.push(...batch); next(); }
      }, () => resolve());
      next();
    }
  });
  for (const e of entries) await readEntry(e, '');
  return { name: single ? entries[0].name : null, files, skipped };
}

// ---------- writing into a folder (update in place) ----------

export async function openFolderForUpdate() {
  try {
    const dir = await window.showDirectoryPicker({ id: 'padala-receive', mode: 'readwrite' });
    if ((await dir.queryPermission?.({ mode: 'readwrite' })) !== 'granted') {
      if ((await dir.requestPermission?.({ mode: 'readwrite' })) !== 'granted') throw new Error('Padala needs permission to save into that folder.');
    }
    return dir;
  } catch (e) {
    if (e.name === 'AbortError') return null;
    throw e;
  }
}

async function parentOf(root, path, create) {
  const parts = path.split('/');
  let dir = root;
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create });
  return { dir, name: parts[parts.length - 1] };
}

export async function readFileAt(root, path) {
  try {
    const { dir, name } = await parentOf(root, path, false);
    const fh = await dir.getFileHandle(name);
    return new Uint8Array(await (await fh.getFile()).arrayBuffer());
  } catch (e) {
    if (e.name === 'NotFoundError' || e.name === 'TypeMismatchError') return undefined;
    throw e;
  }
}

export async function writeFileAt(root, path, data) {
  const { dir, name } = await parentOf(root, path, true);
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
}

export async function removeFileAt(root, path) {
  try {
    const { dir, name } = await parentOf(root, path, false);
    await dir.removeEntry(name);
  } catch (e) {
    if (e.name !== 'NotFoundError') throw e;
  }
}

// ---------- remembering where each project was saved (so updates are one click) ----------

function openStore() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('padala-folders', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('handles');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function rememberFolder(projectId, handle) {
  try {
    const db = await openStore();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('handles', 'readwrite');
      tx.objectStore('handles').put(handle, String(projectId));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* the browser can't store folder handles; the person just picks the folder again */ }
}

export async function savedFolder(projectId) {
  try {
    const db = await openStore();
    const handle = await new Promise((resolve, reject) => {
      const req = db.transaction('handles').objectStore('handles').get(String(projectId));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return handle && typeof handle.requestPermission === 'function' ? handle : null;
  } catch {
    return null;
  }
}

/** Ask (once) for permission to save into a remembered folder. Must run from a click. */
export async function allowWrite(handle) {
  if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
  return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
}

export async function isEmptyFolder(dir) {
  for await (const [name] of dir.entries()) if (name !== '.padala.json') return false;
  return true;
}

export async function forgetFolder(projectId) {
  try {
    const db = await openStore();
    db.transaction('handles', 'readwrite').objectStore('handles').delete(String(projectId));
  } catch { /* nothing remembered */ }
}
