// Automatic backups: once a day (and at start-up), a copy of the database plus every stored piece.
//
//   <backup dir>/padala-2026-09-30.db   one database copy per day, the last 7 are kept
//   <backup dir>/pieces/<team>/<file>/  the encrypted pieces (copied once; they never change)
//
// Pieces are only copied once, so daily backups are fast after the first one. A piece that disappears
// from the live store (a cleared version, a deleted project) is kept in the backup until no kept database
// copy can need it anymore (a little over a week), so any of the 7 copies can be restored.
// Point BACKUP_DIR at another drive (an external disk, or a synced cloud folder) to survive a broken disk.
import fs from 'node:fs';
import path from 'node:path';

const KEEP_DAYS = 7;
const DAY = 86400000;

const list = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
const dateOf = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

/** Make today's backup (if there isn't one yet). Returns a small report. */
export function runBackup({ db, dataDir, backupDir, now = Date.now() }) {
  fs.mkdirSync(backupDir, { recursive: true });
  const report = { database: null, piecesCopied: 0, piecesKept: 0, removedCopies: 0, removedPieces: 0 };

  // 1. The database: one consistent copy per day (VACUUM INTO works while the app is running)
  const dbFile = path.join(backupDir, `padala-${dateOf(now)}.db`);
  if (!fs.existsSync(dbFile)) {
    const tmp = `${dbFile}.part`;
    fs.rmSync(tmp, { force: true });
    db.raw.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    fs.renameSync(tmp, dbFile);
    report.database = path.basename(dbFile);
  }

  // 2. The pieces: copy anything new
  const live = path.join(dataDir, 'blobs');
  const mirror = path.join(backupDir, 'pieces');
  for (const team of list(live)) {
    for (const blob of list(path.join(live, team))) {
      const from = path.join(live, team, blob);
      const to = path.join(mirror, team, blob);
      for (const piece of list(from)) {
        if (!/^\d+$/.test(piece)) continue; // skip half-written .part files
        const target = path.join(to, piece);
        if (fs.existsSync(target)) { report.piecesKept++; continue; }
        fs.mkdirSync(to, { recursive: true });
        fs.copyFileSync(path.join(from, piece), `${target}.part`);
        fs.renameSync(`${target}.part`, target);
        report.piecesCopied++;
      }
    }
  }

  // 3. Keep the last KEEP_DAYS database copies
  const copies = list(backupDir).filter((f) => /^padala-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  for (const f of copies.slice(0, Math.max(0, copies.length - KEEP_DAYS))) {
    fs.rmSync(path.join(backupDir, f), { force: true });
    report.removedCopies++;
  }

  // 4. Pieces gone from the live store: remember since when, and remove them once no kept copy needs them
  const goneFile = path.join(backupDir, 'pieces-gone.json');
  let gone = {};
  try { gone = JSON.parse(fs.readFileSync(goneFile, 'utf8')); } catch { /* first run */ }
  const next = {};
  for (const team of list(mirror)) {
    for (const blob of list(path.join(mirror, team))) {
      const key = `${team}/${blob}`;
      if (fs.existsSync(path.join(live, team, blob))) continue;
      const since = gone[key] || now;
      if (now - since > (KEEP_DAYS + 1) * DAY) {
        fs.rmSync(path.join(mirror, team, blob), { recursive: true, force: true });
        report.removedPieces++;
      } else {
        next[key] = since;
      }
    }
  }
  fs.writeFileSync(goneFile, JSON.stringify(next));
  return report;
}

/** Back up at start-up (after a short delay) and then every day. Returns a stop function. */
export function scheduleBackups({ db, dataDir, backupDir, log = console.log }) {
  const go = () => {
    try {
      const r = runBackup({ db, dataDir, backupDir });
      if (r.database || r.piecesCopied) log(`  Backup saved: ${r.database || 'database already backed up today'}, ${r.piecesCopied} new file pieces → ${backupDir}`);
    } catch (err) {
      log(`  Backup failed: ${err.message}`);
    }
  };
  const first = setTimeout(go, 60000);
  const daily = setInterval(go, 6 * 3600000); // checks every 6 hours; makes one copy per day
  first.unref();
  daily.unref();
  return () => { clearTimeout(first); clearInterval(daily); };
}
