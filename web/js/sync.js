// What changed between versions, and how to update a folder safely.
// Pure functions (no browser APIs) so they are fully covered by the tests.
//
// A "file map" is { [path]: id } where id is the file's content fingerprint.

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.svn', '.idea', '__pycache__']);
const IGNORED_FILES = new Set(['.padala.json', '.DS_Store', 'Thumbs.db', 'desktop.ini']);

/** Folders and files that are never worth sending (version control, installed packages, OS clutter). */
export function isIgnored(path) {
  const parts = path.split('/');
  return parts.slice(0, -1).some((p) => IGNORED_DIRS.has(p)) || IGNORED_FILES.has(parts[parts.length - 1]);
}

/** Safe relative path: forward slashes, no "..", no leading slash, no drive letters. */
export function cleanPath(path) {
  const parts = String(path).replace(/\\/g, '/').split('/').filter((p) => p && p !== '.');
  if (!parts.length || parts.some((p) => p === '..' || /[<>:"|?*\u0000-\u001f]/.test(p))) return null;
  return parts.join('/');
}

export function toMap(files) {
  const m = {};
  for (const f of files || []) m[f.p] = f.id;
  return m;
}

/** Compare the previous version's files with the new ones. */
export function diffFiles(prev, next) {
  const out = { added: [], modified: [], removed: [], unchanged: [] };
  const a = prev || {};
  for (const p of Object.keys(next).sort()) {
    if (!(p in a)) out.added.push(p);
    else if (a[p] !== next[p]) out.modified.push(p);
    else out.unchanged.push(p);
  }
  for (const p of Object.keys(a).sort()) if (!(p in next)) out.removed.push(p);
  return out;
}

/**
 * Plan how to bring a local folder from `base` (the version it was last updated to, or null)
 * to `target`, given what is actually in the folder now (`local`, only needs paths in base ∪ target).
 *
 * Rules, per file:
 *  - already identical to the new version       -> nothing to do
 *  - the sender didn't change it                 -> leave the local copy alone (keeps local edits)
 *  - the sender changed it, local is untouched   -> apply (write or delete)
 *  - both sides changed it                       -> conflict: the person decides
 */
export function planUpdate(base, target, local) {
  const b = base || {};
  const plan = { writes: [], deletes: [], conflicts: [], upToDate: 0, keptLocal: [] };
  const paths = new Set([...Object.keys(b), ...Object.keys(target)]);
  for (const p of [...paths].sort()) {
    const bi = b[p], ti = target[p], li = local[p];
    if (ti === li) { if (ti !== undefined) plan.upToDate++; continue; }
    if (bi === ti && base) { plan.keptLocal.push(p); continue; }
    if (li === bi) {
      if (ti === undefined) plan.deletes.push(p); else plan.writes.push(p);
      continue;
    }
    if (ti === undefined) plan.conflicts.push({ path: p, type: 'they-deleted' });
    else if (li === undefined) plan.conflicts.push({ path: p, type: 'you-deleted' });
    else plan.conflicts.push({ path: p, type: 'both-changed' });
  }
  return plan;
}

/** "config.php" -> "config.mine.php", avoiding names that already exist. */
export function mineName(path, exists) {
  const slash = path.lastIndexOf('/');
  const dir = path.slice(0, slash + 1);
  const file = path.slice(slash + 1);
  const dot = file.lastIndexOf('.');
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : '';
  for (let i = 1; ; i++) {
    const candidate = `${dir}${stem}.mine${i > 1 ? i : ''}${ext}`;
    if (!exists(candidate)) return candidate;
  }
}

/**
 * Turn a plan plus the person's choices ({ [path]: 'mine' | 'theirs' | 'both' }) into file operations.
 * Returns { writes: [path], deletes: [path], renames: [{from, to}] } — renames happen before writes.
 */
export function resolvePlan(plan, choices, exists = () => false) {
  const ops = { writes: [...plan.writes], deletes: [...plan.deletes], renames: [] };
  const taken = new Set();
  for (const c of plan.conflicts) {
    const choice = choices[c.path];
    if (!choice) throw new Error(`Choose what to do with ${c.path}.`);
    if (choice === 'mine') continue;
    if (choice === 'both' && c.type === 'both-changed') {
      const to = mineName(c.path, (p) => exists(p) || taken.has(p));
      taken.add(to);
      ops.renames.push({ from: c.path, to });
      ops.writes.push(c.path);
    } else if (c.type === 'they-deleted') {
      ops.deletes.push(c.path);
    } else {
      ops.writes.push(c.path);
    }
  }
  return ops;
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
