// Dala's checkup: before sending, look through the project the way a careful teammate would
// (passwords left in code, a missing database file, backups and logs that don't need to travel),
// and work out how the project is opened, so the receiver gets step-by-step setup notes.
// Pure functions: the browser passes in file paths, sizes and a way to read small text files.
import { tr, trHtml } from './i18n.js';

const TEXT_EXT = new Set(['php', 'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'html', 'htm', 'env', 'json', 'py', 'ini', 'yml', 'yaml', 'sql', 'inc', 'conf', 'cfg', 'vue', 'twig', 'xml', 'txt', 'rb', 'java', 'cs', 'go']);
const MAX_READ = 256 * 1024;       // skip huge text files
const MAX_READ_TOTAL = 12 * 1024 * 1024;
const MAX_SQL_READ = 4 * 1024 * 1024; // only the start of a .sql file is needed

const h = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const base = (p) => p.split('/').pop();
const extOf = (p) => {
  const n = base(p).toLowerCase();
  if (n.startsWith('.') && !n.slice(1).includes('.')) return n.slice(1);
  return n.includes('.') ? n.split('.').pop() : '';
};
const top = (p) => (p.includes('/') ? p.split('/')[0] : '');
const shortest = (paths) => [...paths].sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length)[0];

const ENV_FILE = /^\.env(\.(local|production|prod|development|dev|staging))?$/i;
const ARCHIVE = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz']);
const JUNK_NAME = /^(error_log|php_errors?\.log|debug\.log|npm-debug\.log.*|yarn-error\.log)$/i;

/** Values that are real secrets (not the empty XAMPP defaults). */
const SECRET_PATTERNS = [
  { kind: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { kind: 'mail', re: /(?:->\s*Password\s*=\s*|MAIL_PASSWORD\s*=\s*|SMTP_PASS(?:WORD)?\s*[=:]\s*|smtp_?pass(?:word)?['"]?\s*[=:>]+\s*)(['"]?)([^'"\s;]{6,})\1/i },
  { kind: 'api-key', re: /\b(?:sk_live_[0-9a-zA-Z]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|ghp_[0-9A-Za-z]{36}|xox[bp]-[0-9A-Za-z-]{20,})/ },
];

const DB_USE = /\b(?:mysqli_connect|new\s+mysqli|new\s+PDO|mysql:host=|mysql\.createConnection|mysql2|mongoose\.connect|DB_CONNECTION\s*=\s*mysql|pg\.Pool)\b/;
const DB_NAME_PATTERNS = [
  /DB_DATABASE\s*=\s*['"]?([\w-]+)/,
  /define\(\s*['"]DB_NAME['"]\s*,\s*['"]([\w-]+)['"]/i,
  /\$(?:db_?name|database|dbname|db_database)\s*=\s*['"]([\w-]+)['"]/i,
  /mysqli_connect\(\s*['"][^'"]*['"]\s*,\s*['"][^'"]*['"]\s*,\s*['"][^'"]*['"]\s*,\s*['"]([\w-]+)['"]/i,
  /new\s+mysqli\(\s*['"][^'"]*['"]\s*,\s*['"][^'"]*['"]\s*,\s*['"][^'"]*['"]\s*,\s*['"]([\w-]+)['"]/i,
  /dbname=([\w-]+)/i,
  /database\s*:\s*['"]([\w-]+)['"]/i,
];
const SQL_CREATES_DB = /CREATE\s+DATABASE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([\w-]+)`?/i;
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::(\d+))?\/([\w.-]+)\//g;
const NOT_A_FOLDER = new Set(['phpmyadmin', 'dashboard', 'api', 'assets', 'index.php', 'index.html', 'public', 'img', 'css', 'js']);

/** What kind of project this is, from the file names alone. */
export function detectKind(paths) {
  const names = new Map();
  for (const p of paths) {
    const n = base(p).toLowerCase();
    if (!names.has(n)) names.set(n, []);
    names.get(n).push(p);
  }
  const has = (n) => names.has(n);
  const exts = new Set(paths.map(extOf));
  if (has('artisan') && has('composer.json')) return 'laravel';
  if (has('manage.py')) return 'django';
  if (has('package.json') && !exts.has('php')) return 'node';
  if (exts.has('php')) return 'php';
  if (has('requirements.txt') || has('app.py') || has('main.py')) return 'python';
  if (exts.has('html') || exts.has('htm')) return 'static';
  return 'other';
}

/**
 * Look through the folder.
 * files: [{ path, size, read: () => Promise<Uint8Array> }]
 * Returns { findings, setup } where setup is saved with the delivery for the receiver's notes.
 */
export async function inspectProject({ files, folderName = '', skipped = [] }) {
  const paths = files.map((f) => f.path);
  const kind = detectKind(paths);
  const findings = [];
  const decoder = new TextDecoder('utf-8', { fatal: false });

  const secrets = [];
  const envFiles = [];
  let usesDb = false;
  let dbName = null;
  const urlFolders = new Map();
  let port = null;
  let sqlCreatesDb = null;
  let pkg = null;
  let read = 0;

  // config-looking files first, so the budget is spent where it matters
  const score = (p) => (/(config|conn|db|database|env|settings|mail)/i.test(p) ? 0 : 1) + p.split('/').length / 100;
  const candidates = files
    .filter((f) => TEXT_EXT.has(extOf(f.path)) || ENV_FILE.test(base(f.path)) || base(f.path) === 'artisan')
    .sort((a, b) => score(a.path) - score(b.path));

  for (const f of candidates) {
    const isSql = extOf(f.path) === 'sql';
    if (f.size > (isSql ? 64 * 1024 * 1024 : MAX_READ) || read + Math.min(f.size, MAX_SQL_READ) > MAX_READ_TOTAL) continue;
    let bytes;
    try { bytes = await f.read(); } catch { continue; }
    read += Math.min(bytes.length, MAX_SQL_READ);
    const text = decoder.decode(isSql ? bytes.subarray(0, MAX_SQL_READ) : bytes);
    if (isSql) {
      const m = text.match(SQL_CREATES_DB);
      if (m && !sqlCreatesDb) sqlCreatesDb = m[1];
      continue;
    }
    if (base(f.path) === 'package.json' && !f.path.includes('/')) {
      try { pkg = JSON.parse(text); } catch { /* broken json */ }
    }
    if (ENV_FILE.test(base(f.path))) envFiles.push(f.path);
    for (const s of SECRET_PATTERNS) {
      if (s.re.test(text) && !secrets.some((x) => x.path === f.path)) secrets.push({ path: f.path, kind: s.kind });
    }
    if (DB_USE.test(text)) usesDb = true;
    if (!dbName && (/(config|conn|db|database|\.env|settings)/i.test(f.path) || DB_USE.test(text))) {
      for (const re of DB_NAME_PATTERNS) {
        const m = text.match(re);
        if (m && !/^(root|localhost|test|example|your_?database|database_name)$/i.test(m[1])) { dbName = m[1]; break; }
      }
    }
    for (const m of text.matchAll(LOCAL_URL)) {
      if (m[1]) port = port || m[1];
      if (m[1] && m[1] !== '80') continue;
      const seg = m[2];
      if (NOT_A_FOLDER.has(seg.toLowerCase()) || seg.includes('.')) continue;
      urlFolders.set(seg, (urlFolders.get(seg) || 0) + 1);
    }
  }

  const sql = paths.filter((p) => extOf(p) === 'sql');
  const hasMigrations = kind === 'laravel' || kind === 'django' || paths.some((p) => /(^|\/)(migrations|prisma)\//.test(p));
  const urlFolder = [...urlFolders.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const archives = files.filter((f) => ARCHIVE.has(extOf(f.path)));
  const junk = files.filter((f) => JUNK_NAME.test(base(f.path)) || (extOf(f.path) === 'log'));
  const vendorBytes = files.filter((f) => f.path.startsWith('vendor/')).reduce((s, f) => s + f.size, 0);
  const hasComposer = paths.includes('composer.json');

  // ---- findings, most important first
  const mailOrKey = secrets.filter((s) => s.kind !== 'private-key');
  if (mailOrKey.length) {
    findings.push({
      id: 'secrets', level: 'warn',
      title: mailOrKey.some((s) => s.kind === 'mail') ? 'An email password is in the code' : 'A private key or password is in the code',
      text: 'Your partner will be able to see it, and so will the client after you hand the project over. Before giving it to the client, switch it to their own email or key.',
      paths: mailOrKey.map((s) => s.path),
    });
  }
  const keys = secrets.filter((s) => s.kind === 'private-key');
  if (keys.length) {
    findings.push({ id: 'private-key', level: 'warn', title: 'A private key file is included', text: 'Private keys give access to servers or accounts. Leave it out unless your partner really needs it.', paths: keys.map((s) => s.path), leaveOut: keys.map((s) => s.path) });
  }
  if (envFiles.length) {
    findings.push({
      id: 'env', level: kind === 'laravel' ? 'info' : 'warn',
      title: `${envFiles.length === 1 ? h(base(envFiles[0])) : '.env files'} ${envFiles.length === 1 ? 'has' : 'have'} your settings and passwords`,
      text: paths.some((p) => /\.env\.example$/i.test(p))
        ? 'There’s also a .env.example, so your partner can make their own. You can leave yours out.'
        : 'Your partner may need it to run the project. Keep it, or leave it out and send the settings in the chat.',
      paths: envFiles, leaveOut: envFiles,
    });
  }
  if (usesDb && !sql.length && !hasMigrations) {
    findings.push({
      id: 'no-sql', level: 'warn', title: 'The database file is missing',
      text: `The code uses a MySQL database${dbName ? ` (<b>${h(dbName)}</b>)` : ''}, but there’s no .sql file, so it won’t work on your partner’s computer. In phpMyAdmin: open the database › <b>Export</b> › <b>Go</b>, save the .sql file inside this folder, then choose the folder again.`,
      paths: [], again: true,
    });
  }
  if (archives.length) {
    const bytes = archives.reduce((s, f) => s + f.size, 0);
    findings.push({ id: 'archives', level: 'info', title: `${archives.length === 1 ? 'A backup file' : `${archives.length} backup files`} inside the project`, text: `Old copies like ${h(base(archives[0].path))} (${fmt(bytes)}) usually don’t need to travel.`, paths: archives.map((f) => f.path), leaveOut: archives.map((f) => f.path) });
  }
  if (junk.length) {
    findings.push({ id: 'logs', level: 'info', title: 'Log files', text: 'Error logs from your computer aren’t part of the project.', paths: junk.map((f) => f.path), leaveOut: junk.map((f) => f.path) });
  }
  if (hasComposer && vendorBytes > 15 * 1024 * 1024) {
    findings.push({ id: 'vendor', level: 'info', title: `The vendor folder is ${fmt(vendorBytes)}`, text: 'Your partner can download it again with one command (composer install). It’s included in their setup guide.', paths: ['vendor/'], leaveOut: paths.filter((p) => p.startsWith('vendor/')) });
  }
  if (urlFolder && folderName && urlFolder.toLowerCase() !== folderName.toLowerCase() && (kind === 'php' || kind === 'static')) {
    findings.push({ id: 'url-folder', level: 'info', title: `Links point to localhost/${h(urlFolder)}/`, text: `Your partner should name the folder <b>${h(urlFolder)}</b> (not ${h(folderName)}) or some links will break. The setup guide tells them.`, paths: [] });
  }
  if (sql.length) {
    findings.push({ id: 'sql', level: 'good', title: 'Database included', text: sql.length === 1 ? h(sql[0]) : `${sql.length} .sql files`, paths: sql });
  }
  if (skipped.some((p) => p.startsWith('node_modules'))) {
    findings.push({ id: 'node-modules', level: 'good', title: 'node_modules left out', text: 'Your partner gets it back with npm install. It’s included in their setup guide.', paths: [] });
  }

  const setup = {
    kind,
    folder: urlFolder || folderName || null,
    sql: sql.length ? shortest(sql) : null,
    sqlCount: sql.length,
    dbName: dbName || sqlCreatesDb || null,
    sqlCreatesDb: !!sqlCreatesDb,
    usesDb: usesDb || sql.length > 0,
    entry: entryOf(paths, kind),
    port: port && port !== '80' ? Number(port) : null,
    scripts: pkg?.scripts ? Object.keys(pkg.scripts).filter((s) => ['dev', 'start', 'serve'].includes(s)) : [],
    envExample: paths.find((p) => /(^|\/)\.env\.example$/i.test(p)) || null,
    requirements: paths.includes('requirements.txt'),
    composer: hasComposer && !paths.some((p) => p.startsWith('vendor/')),
  };
  return { findings, setup };
}

function entryOf(paths, kind) {
  if (kind === 'python') return ['app.py', 'main.py', 'run.py'].find((n) => paths.includes(n)) || null;
  const idx = paths.filter((p) => /(^|\/)index\.(php|html?)$/i.test(p) && !/(^|\/)(vendor|node_modules|admin)\//i.test(p));
  if (!idx.length) return paths.find((p) => /\.(php|html?)$/i.test(p) && !p.includes('/')) || null;
  return shortest(idx);
}

function fmt(n) {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** Fallback for deliveries sent before checkups existed: file names only. */
export function setupFromPaths(paths, projectName) {
  const kind = detectKind(paths);
  const sql = paths.filter((p) => extOf(p) === 'sql');
  return {
    kind, folder: projectName || null, sql: sql.length ? shortest(sql) : null, sqlCount: sql.length, dbName: null, sqlCreatesDb: false,
    usesDb: sql.length > 0, entry: entryOf(paths, kind), port: null, scripts: [],
    envExample: paths.find((p) => /(^|\/)\.env\.example$/i.test(p)) || null,
    requirements: paths.includes('requirements.txt'),
    composer: paths.includes('composer.json') && !paths.some((p) => p.startsWith('vendor/')),
  };
}

/**
 * Turn setup facts into steps a beginner (or the client) can follow.
 * Returns { title, steps: [{ title, text, code? , link? }] }. text may contain <b>.
 */
export function setupSteps(setup, projectName) {
  const s = setup || {};
  const folder = safeFolder(s.folder || projectName || 'project');
  const steps = [];
  const dbStep = () => {
    if (!s.sql) return;
    const name = s.dbName;
    steps.push(s.sqlCreatesDb
      ? { title: 'Load the database', text: `Open phpMyAdmin, click <b>Import</b>, choose <b>${h(s.sql)}</b> from the project folder, then click <b>Import</b> / <b>Go</b>. The file creates the database by itself.`, link: 'http://localhost/phpmyadmin' }
      : { title: 'Load the database', text: `Open phpMyAdmin › <b>New</b>. Create a database named ${name ? `<b>${h(name)}</b>` : 'exactly like the one in the project’s config file'}. Select it, click <b>Import</b>, choose <b>${h(s.sql)}</b> from the project folder, then click <b>Import</b> / <b>Go</b>.`, link: 'http://localhost/phpmyadmin', ...(name ? { code: name } : {}) });
  };

  switch (s.kind) {
    case 'php': {
      steps.push({ title: 'Put the folder in htdocs', text: `Move the project folder into <b>C:\\xampp\\htdocs</b> and name it <b>${h(folder)}</b>.`, code: `C:\\xampp\\htdocs\\${folder}` });
      steps.push({ title: 'Start XAMPP', text: `Open the XAMPP Control Panel and press <b>Start</b> next to <b>Apache</b>${s.usesDb ? ' and <b>MySQL</b>' : ''}.` });
      if (s.composer) steps.push({ title: 'Download the PHP packages', text: 'Open a terminal in the project folder and run:', code: 'composer install' });
      dbStep();
      const entryDir = s.entry && s.entry.includes('/') ? `${s.entry.slice(0, s.entry.lastIndexOf('/') + 1)}` : '';
      const url = `http://localhost/${folder}/${entryDir}`;
      steps.push({ title: 'Open it', text: 'Open this address in the browser:', link: url, code: url });
      return { title: 'PHP website (XAMPP)', steps };
    }
    case 'laravel':
      steps.push({ title: 'Download the packages', text: 'Open a terminal in the project folder and run:', code: 'composer install' });
      steps.push({ title: 'Make the settings file', text: 'Copy the example settings and create the app key:', code: 'copy .env.example .env\nphp artisan key:generate' });
      if (s.sql) dbStep();
      else steps.push({ title: 'Create the database', text: `Start <b>MySQL</b> in XAMPP, create a database in phpMyAdmin${s.dbName ? ` named <b>${h(s.dbName)}</b>` : ''}, put its name in <b>.env</b> (DB_DATABASE), then run:`, code: 'php artisan migrate --seed' });
      steps.push({ title: 'Start it', text: 'Run this, then open the address it shows:', code: 'php artisan serve', link: 'http://127.0.0.1:8000' });
      return { title: 'Laravel app', steps };
    case 'node': {
      steps.push({ title: 'Download the packages', text: 'Open a terminal in the project folder and run:', code: 'npm install' });
      if (s.envExample) steps.push({ title: 'Make the settings file', text: `Copy <b>${h(s.envExample)}</b> to <b>.env</b> and fill it in.` });
      dbStep();
      const script = s.scripts?.includes('dev') ? 'npm run dev' : s.scripts?.includes('start') ? 'npm start' : s.scripts?.includes('serve') ? 'npm run serve' : 'npm start';
      steps.push({ title: 'Start it', text: 'Run this, then open the address it shows in the terminal:', code: script });
      return { title: 'Node.js app', steps };
    }
    case 'django':
      steps.push({ title: 'Install what it needs', text: 'Open a terminal in the project folder and run:', code: s.requirements ? 'pip install -r requirements.txt' : 'pip install django' });
      steps.push({ title: 'Set up the database', text: 'Run:', code: 'python manage.py migrate' });
      steps.push({ title: 'Start it', text: 'Run this, then open the address:', code: 'python manage.py runserver', link: 'http://127.0.0.1:8000' });
      return { title: 'Django app', steps };
    case 'python':
      if (s.requirements) steps.push({ title: 'Install what it needs', text: 'Open a terminal in the project folder and run:', code: 'pip install -r requirements.txt' });
      steps.push({ title: 'Start it', text: 'Run:', code: `python ${s.entry || 'app.py'}` });
      return { title: 'Python app', steps };
    case 'static':
      steps.push({ title: 'Open it', text: `Double-click <b>${h(s.entry || 'index.html')}</b> in the project folder. In VS Code you can also right-click it › <b>Open with Live Server</b>.` });
      return { title: 'Website (HTML)', steps };
    default:
      steps.push({ title: 'Open the folder', text: 'Open the project folder in VS Code (File › Open Folder).' });
      return { title: 'Project files', steps };
  }
}

function safeFolder(name) {
  return String(name).trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-') || 'project';
}

/** Plain-text version of the steps, to paste into Messenger for a client. */
export function setupText(guide, projectName) {
  const strip = (t) => t.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  return [tr(`How to open ${projectName}`), '', ...guide.steps.flatMap((st, i) => [
    `${i + 1}. ${tr(st.title)}: ${strip(trHtml(st.text))}`,
    ...(st.code && !st.text.includes(st.code) ? st.code.split('\n').map((l) => `   ${l}`) : []),
    ...(st.link && st.link !== st.code ? [`   ${st.link}`] : []),
  ])].join('\n');
}
