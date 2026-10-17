import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectProject, detectKind, setupSteps, setupText, setupFromPaths } from '../web/js/checkup.js';

const enc = new TextEncoder();
const files = (map) => Object.entries(map).map(([path, v]) => {
  const data = typeof v === 'number' ? new Uint8Array(v) : enc.encode(v);
  return { path, size: data.length, read: async () => data };
});

test('a PHP project without its database file gets a warning', async () => {
  const { findings, setup } = await inspectProject({
    folderName: 'clinic',
    files: files({
      'index.php': '<?php require "config.php"; ?><a href="http://localhost/clinic-system/login.php">Login</a>',
      'config.php': '<?php $conn = mysqli_connect("localhost", "root", "", "clinic_db");',
    }),
  });
  const ids = findings.map((f) => f.id);
  assert.ok(ids.includes('no-sql'));
  assert.match(findings.find((f) => f.id === 'no-sql').text, /clinic_db/);
  assert.ok(ids.includes('url-folder'), 'links point to a differently named folder');
  assert.equal(setup.kind, 'php');
  assert.equal(setup.folder, 'clinic-system');
  assert.equal(setup.dbName, 'clinic_db');
});

test('secrets, env files, backups and logs are found; the database is noticed', async () => {
  const { findings, setup } = await inspectProject({
    folderName: 'shop',
    files: files({
      'index.php': '<?php $pdo = new PDO("mysql:host=localhost;dbname=shop_db", "root", "");',
      'mail/send.php': '<?php $mail->Password = \'abcd efgh ijkl\'; $mail->Password = "realapppassword";',
      '.env': 'APP_KEY=x',
      '.env.example': 'APP_KEY=',
      'backup/shop-old.zip': 2048,
      'error_log': 'PHP Warning',
      'database/shop.sql': 'CREATE DATABASE IF NOT EXISTS `shop_db`; CREATE TABLE users (id int);',
    }),
  });
  const byId = Object.fromEntries(findings.map((f) => [f.id, f]));
  assert.equal(byId.secrets.level, 'warn');
  assert.deepEqual(byId.secrets.paths, ['mail/send.php']);
  assert.deepEqual(byId.env.leaveOut, ['.env']);
  assert.match(byId.env.text, /\.env\.example/);
  assert.deepEqual(byId.archives.leaveOut, ['backup/shop-old.zip']);
  assert.deepEqual(byId.logs.leaveOut, ['error_log']);
  assert.equal(byId.sql.level, 'good');
  assert.equal(byId['no-sql'], undefined);
  assert.equal(setup.sql, 'database/shop.sql');
  assert.equal(setup.sqlCreatesDb, true);
});

test('empty XAMPP passwords and example files are not flagged', async () => {
  const { findings } = await inspectProject({
    folderName: 'site',
    files: files({ 'db.php': '<?php $conn = new mysqli("localhost","root","","site"); $password = "";', 'site.sql': 'CREATE TABLE a (id int);' }),
  });
  assert.equal(findings.filter((f) => f.level === 'warn').length, 0);
});

test('project kinds and their setup steps', () => {
  assert.equal(detectKind(['artisan', 'composer.json', 'app/Http/Kernel.php']), 'laravel');
  assert.equal(detectKind(['package.json', 'src/main.jsx', 'index.html']), 'node');
  assert.equal(detectKind(['manage.py', 'requirements.txt']), 'django');
  assert.equal(detectKind(['index.html', 'style.css']), 'static');

  const php = setupSteps({ kind: 'php', folder: 'booktrack', sql: 'db/booktrack.sql', dbName: 'booktrack', usesDb: true, entry: 'index.php' }, 'booktrack');
  assert.deepEqual(php.steps.map((s) => s.title), ['Put the folder in htdocs', 'Start XAMPP', 'Load the database', 'Open it']);
  assert.equal(php.steps[3].link, 'http://localhost/booktrack/');
  assert.match(php.steps[1].text, /MySQL/);

  const node = setupSteps({ kind: 'node', scripts: ['dev', 'start'] }, 'app');
  assert.equal(node.steps.at(-1).code, 'npm run dev');

  const text = setupText(php, 'booktrack');
  assert.match(text, /^How to open booktrack/);
  assert.match(text, /1\. Put the folder in htdocs/);
  assert.ok(!text.includes('<b>'), 'plain text for Messenger');
});

test('older deliveries still get notes from the file names', () => {
  const s = setupFromPaths(['public/index.php', 'app.sql', 'composer.json'], 'Old Project');
  assert.equal(s.kind, 'php');
  assert.equal(s.entry, 'public/index.php');
  const g = setupSteps(s, 'Old Project');
  assert.equal(g.steps.at(-1).link, 'http://localhost/Old-Project/public/');
  assert.ok(g.steps.some((x) => x.code === 'composer install'));
});

test('file names cannot inject HTML into the notes', async () => {
  const { findings } = await inspectProject({ folderName: 'x', files: files({ '<img src=x onerror=alert(1)>.sql': 'x', 'index.php': '<?php' }) });
  const sql = findings.find((f) => f.id === 'sql');
  assert.ok(!sql.text.includes('<img'));
});
