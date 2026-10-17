// npm run backup            make a backup now (the server also does this by itself every day)
// npm run backup -- restore padala-2026-09-30.db
//                           put a backup back: stop Padala first, then run this, then start Padala again
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../server/index.js';
import { openDb } from '../server/db.js';
import { runBackup } from '../server/backup.js';

const config = loadConfig();
const [cmd, file] = process.argv.slice(2);

if (cmd === 'restore') {
  const src = path.join(config.backupDir, file || '');
  if (!file || !fs.existsSync(src)) {
    const copies = fs.existsSync(config.backupDir) ? fs.readdirSync(config.backupDir).filter((f) => f.endsWith('.db')).sort() : [];
    console.log(`Choose a backup to restore:\n${copies.map((f) => `  npm run backup -- restore ${f}`).join('\n') || '  (no backups yet)'}`);
    process.exit(1);
  }
  fs.mkdirSync(config.dataDir, { recursive: true });
  const dbPath = path.join(config.dataDir, 'padala.db');
  if (fs.existsSync(dbPath)) fs.copyFileSync(dbPath, `${dbPath}.before-restore`);
  for (const extra of ['-wal', '-shm']) fs.rmSync(dbPath + extra, { force: true });
  fs.copyFileSync(src, dbPath);
  const pieces = path.join(config.backupDir, 'pieces');
  if (fs.existsSync(pieces)) fs.cpSync(pieces, path.join(config.dataDir, 'blobs'), { recursive: true, force: false, errorOnExist: false });
  console.log(`Restored ${file}. (The previous database was kept as padala.db.before-restore.) Start Padala with npm start.`);
} else {
  const db = openDb(config.dataDir);
  const r = runBackup({ db, dataDir: config.dataDir, backupDir: config.backupDir });
  db.close();
  console.log(`Backup in ${config.backupDir}\n  database: ${r.database || 'already backed up today'}\n  new file pieces copied: ${r.piecesCopied}`);
}
