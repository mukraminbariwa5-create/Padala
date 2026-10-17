// Sending and receiving deliveries: encrypted pieces, skip what the server already has,
// and keep going through dropped connections.
import { contentId, encryptBytes, decryptBytes, encryptText, pieceContext } from './crypto.js';
import { isTransient } from './api.js';
import { diffFiles, toMap } from './sync.js';

export const PIECE = 512 * 1024; // must match the server's CHUNK_BYTES

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Cancelled', 'AbortError')); }, { once: true });
});

/**
 * Runs `fn` until it succeeds. Connection problems are waited out (1s, 2s, 4s… up to 15s between tries)
 * instead of failing, which is what makes transfers survive weak signal. Real errors (like "no space") are thrown.
 */
export async function persist(fn, { signal, onWaiting, onResumed, maxWait = 15000 } = {}) {
  let delay = 1000;
  let waited = false;
  for (;;) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    try {
      const out = await fn();
      if (waited) onResumed?.();
      return out;
    } catch (err) {
      if (err.name === 'AbortError' || !isTransient(err)) throw err;
      waited = true;
      onWaiting?.(err);
      await sleep(delay, signal);
      delay = Math.min(delay * 2, maxWait);
    }
  }
}

const pieceCount = (size) => Math.max(1, Math.ceil(size / PIECE));

// How much happens at once. On a phone connection most time is spent waiting for replies, so a few
// requests in flight at the same time make transfers several times faster without flooding the network.
const FILES_AT_ONCE = 6;
const BYTES_AT_ONCE = 64 * 1024 * 1024; // at most this much file data in memory at the same time
const PIECES_AT_ONCE = 3;
const REQUESTS_AT_ONCE = 6;

/** A small limiter: at most `limit` of the wrapped jobs run at the same time. */
function limiter(limit) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

/** Memory budget: big files wait their turn so a few huge ones never sit in memory together. */
export function budget(max) {
  let used = 0;
  const waiting = [];
  const fits = (n) => used === 0 || used + n <= max;
  return {
    take(n) {
      if (fits(n) && !waiting.length) { used += n; return Promise.resolve(); }
      return new Promise((r) => waiting.push({ n, r })); // counted in by give() when it's their turn
    },
    give(n) {
      used -= n;
      while (waiting.length && fits(waiting[0].n)) { const w = waiting.shift(); used += w.n; w.r(); }
    },
  };
}

/**
 * Run fn over items, `limit` at a time. The first real error stops the others (through `signal`)
 * and is the one thrown.
 */
export async function eachLimit(items, limit, signal, fn) {
  const inner = new AbortController();
  const stop = () => inner.abort();
  signal?.addEventListener('abort', stop, { once: true });
  let i = 0;
  let failure = null;
  const worker = async () => {
    while (i < items.length && !failure) {
      const k = i++;
      try { await fn(items[k], k, inner.signal); } catch (err) {
        if (!failure) failure = err;
        inner.abort();
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  } finally { signal?.removeEventListener('abort', stop); }
  if (failure) throw signal?.aborted ? new DOMException('Cancelled', 'AbortError') : failure;
}

/** Upload one file's content as encrypted pieces, skipping pieces the server already has. */
export async function uploadBlob({ api, teamId, keys, id, data, signal, hooks = {}, request = (fn) => fn(), status: known = null }) {
  const count = pieceCount(data.length);
  // `known` comes from the batch check at the start of a delivery, so each new file saves a round trip
  const status = known || await persist(() => request(() => api.get(`/api/teams/${teamId}/blobs/${id}`, { signal })), { signal, ...hooks });
  if (status.complete) { hooks.onPieces?.(count, data.length, true); return; }
  const have = new Set(status.chunkCount === count ? status.have : []);
  if (have.size) hooks.onPieces?.(have.size, [...have].reduce((s, n) => s + Math.min(PIECE, data.length - n * PIECE), 0), true);
  const todo = [];
  for (let n = 0; n < count; n++) if (!have.has(n)) todo.push(n);
  await eachLimit(todo, PIECES_AT_ONCE, signal, async (n, _k, sig) => {
    const plain = data.subarray(n * PIECE, Math.min(data.length, (n + 1) * PIECE));
    const sealed = await encryptBytes(keys, plain, pieceContext(id, n, count));
    hooks.onPieceStart?.(n);
    await persist(() => request(() => api.put(`/api/teams/${teamId}/blobs/${id}/${n}?count=${count}`, sealed, { signal: sig })), { signal: sig, ...hooks });
    hooks.onPieces?.(1, plain.length, false);
  });
}

/** Download and decrypt one file. */
export async function downloadBlob({ api, teamId, keys, id, size, signal, hooks = {}, request = (fn) => fn() }) {
  const count = size === undefined
    ? (await persist(() => request(() => api.get(`/api/teams/${teamId}/blobs/${id}`, { signal })), { signal, ...hooks })).chunkCount
    : pieceCount(size);
  const out = new Uint8Array(size ?? count * PIECE);
  let total = 0;
  const pieces = Array.from({ length: count }, (_, n) => n);
  await eachLimit(pieces, PIECES_AT_ONCE, signal, async (n, _k, sig) => {
    const sealed = await persist(() => request(() => api.raw(`/api/teams/${teamId}/blobs/${id}/${n}`, { signal: sig })), { signal: sig, ...hooks });
    const plain = await decryptBytes(keys, sealed, pieceContext(id, n, count));
    // every piece but the last is exactly PIECE bytes, so each one knows where it goes
    if (plain.length > PIECE || n * PIECE + plain.length > out.length || (n < count - 1 && plain.length !== PIECE)) {
      throw new Error('A downloaded file is larger than expected.');
    }
    out.set(plain, n * PIECE);
    total += plain.length;
    hooks.onPieces?.(1, plain.length, false);
  });
  if (size !== undefined && total !== size) throw new Error('A downloaded file is incomplete.');
  return size === undefined ? out.subarray(0, total) : out;
}

/** Fetch and decrypt a version's file list: { v, files: [{ p, s, id }] } */
export async function loadManifest({ api, teamId, keys, manifestId, signal }) {
  const bytes = await downloadBlob({ api, teamId, keys, id: manifestId, signal });
  const m = JSON.parse(new TextDecoder().decode(bytes));
  if (m.v !== 1 || !Array.isArray(m.files)) throw new Error('This version uses a format this app does not understand. Refresh the page.');
  return m;
}

/**
 * Fingerprint every file and compare with the previous version.
 * files: [{ path, size, read: () => Promise<Uint8Array> }]
 */
export async function prepareDelivery({ keys, files, previous, onProgress, signal }) {
  const entries = [];
  let done = 0;
  let sinceBreath = 0;
  await eachLimit(files, 4, signal, async (f) => {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const data = await f.read();
    entries.push({ p: f.path, s: data.length, id: await contentId(keys, data), read: f.read });
    done += data.length;
    onProgress?.(done);
    // let the screen breathe now and then, so big folders never freeze the app
    if ((sinceBreath += data.length) > 8 * 1024 * 1024 || entries.length % 200 === 0) {
      sinceBreath = 0;
      await new Promise((r) => setTimeout(r, 0));
    }
  });
  entries.sort((a, b) => (a.p < b.p ? -1 : 1));
  const diff = diffFiles(previous ? toMap(previous.files) : null, toMap(entries));
  return { entries, diff };
}

/**
 * Send a prepared delivery: upload only the file contents the server doesn't have yet,
 * then the encrypted file list, then create the version.
 * progress(state) receives { phase, pieces, piecesDone, bytes, bytesDone, current, waiting, resumes }.
 */
export async function sendDelivery({ api, teamId, projectId, keys, prepared, note, setup, progress, signal }) {
  const { entries, diff } = prepared;
  const unique = new Map();
  for (const e of entries) if (!unique.has(e.id)) unique.set(e.id, e);
  const { missing, partial = null } = await persist(() => api.post(`/api/teams/${teamId}/blobs/check`, { ids: [...unique.keys()] }, { signal }), { signal });
  // Newer servers say which pieces of unfinished uploads they already have; older ones don't (then ask per file).
  const statusOf = (id) => (partial ? (partial[id] ? { complete: false, ...partial[id] } : { complete: false, chunkCount: 0, have: [] }) : null);

  const state = {
    phase: 'uploading', pieces: 0, piecesDone: 0, bytes: 0, bytesDone: 0, current: null,
    waiting: false, resumes: 0, startedAt: Date.now(), files: missing.length, filesDone: 0,
  };
  for (const id of missing) { state.pieces += pieceCount(unique.get(id).s); state.bytes += unique.get(id).s; }
  const emit = () => progress?.({ ...state });
  const hooks = {
    onWaiting: () => { if (!state.waiting) { state.waiting = true; emit(); } },
    onResumed: () => { state.waiting = false; state.resumes++; emit(); },
    onPieceStart: () => { state.current = state.piecesDone; emit(); },
    onPieces: (n, bytes) => { state.piecesDone += n; state.bytesDone += bytes; state.current = null; emit(); },
  };
  emit();

  const request = limiter(REQUESTS_AT_ONCE);
  const memory = budget(BYTES_AT_ONCE);
  await eachLimit(missing, FILES_AT_ONCE, signal, async (id, _k, sig) => {
    const e = unique.get(id);
    await memory.take(e.s);
    try { await sendOne(e, id, sig); } finally { memory.give(e.s); }
  });
  async function sendOne(e, id, sig) {
    const data = await e.read();
    if (data.length !== e.s || (await contentId(keys, data)) !== id) {
      throw new Error(`${e.p} changed while it was being sent. Choose the folder again.`);
    }
    await uploadBlob({ api, teamId, keys, id, data, signal: sig, hooks, request, status: statusOf(id) });
    state.filesDone++;
    emit();
  }

  state.phase = 'finishing';
  emit();
  const manifestBytes = new TextEncoder().encode(JSON.stringify({ v: 1, files: entries.map(({ p, s, id }) => ({ p, s, id })), ...(setup ? { setup } : {}) }));
  const manifestId = await contentId(keys, manifestBytes);
  await uploadBlob({ api, teamId, keys, id: manifestId, data: manifestBytes, signal, hooks: { onWaiting: hooks.onWaiting, onResumed: hooks.onResumed } });

  const { version } = await persist(async () => api.post(`/api/projects/${projectId}/versions`, {
    manifest: manifestId,
    fileCount: entries.length,
    totalBytes: entries.reduce((s, e) => s + e.s, 0),
    sentBytes: state.bytes,
    changedCount: diff.added.length + diff.modified.length + diff.removed.length,
    blobs: [...unique.keys()],
    ...(note ? { note: await encryptText(keys, note, `note:${projectId}`) } : {}),
  }, { signal }), { signal, onWaiting: hooks.onWaiting, onResumed: hooks.onResumed });
  state.phase = 'done';
  emit();
  return version;
}

/**
 * Download the listed files of a manifest. Identical contents are fetched once.
 * onFile(path, data) is called as each file is ready.
 */
export async function receiveFiles({ api, teamId, keys, files, onFile, progress, signal }) {
  const state = { phase: 'downloading', pieces: 0, piecesDone: 0, bytes: 0, bytesDone: 0, waiting: false, resumes: 0, startedAt: Date.now() };
  const byId = new Map();
  for (const f of files) {
    if (!byId.has(f.id)) { byId.set(f.id, []); state.pieces += pieceCount(f.s); state.bytes += f.s; }
    byId.get(f.id).push(f);
  }
  const emit = () => progress?.({ ...state });
  const hooks = {
    onWaiting: () => { if (!state.waiting) { state.waiting = true; emit(); } },
    onResumed: () => { state.waiting = false; state.resumes++; emit(); },
    onPieces: (n, bytes) => { state.piecesDone += n; state.bytesDone += bytes; emit(); },
  };
  emit();
  const request = limiter(REQUESTS_AT_ONCE);
  const memory = budget(BYTES_AT_ONCE);
  await eachLimit([...byId], FILES_AT_ONCE, signal, async ([id, group], _k, sig) => {
    await memory.take(group[0].s);
    try {
      const data = await downloadBlob({ api, teamId, keys, id, size: group[0].s, signal: sig, hooks, request });
      for (const f of group) await onFile(f.p, data);
    } finally { memory.give(group[0].s); }
  });
  state.phase = 'done';
  emit();
}
