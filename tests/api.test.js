// End-to-end over HTTP: two teammates, encrypted chat, sending a folder, sending only what changed,
// surviving a flaky connection, and access control.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/index.js';
import { runBackup } from '../server/backup.js';
import { DatabaseSync } from 'node:sqlite';
import { createApi, ApiError } from '../web/js/api.js';
import { generateTeamKey, importTeamKey, encryptText, decryptText } from '../web/js/crypto.js';
import { prepareDelivery, sendDelivery, loadManifest, receiveFiles, PIECE } from '../web/js/transfer.js';

const te = new TextEncoder();

/** A fetch that keeps a cookie jar, like a browser tab. `chaos` can fail requests to simulate weak signal. */
function browser(base, chaos) {
  let jar = '';
  const f = async (url, init = {}) => {
    if (chaos && chaos(url, init)) throw new TypeError('fetch failed (simulated signal drop)');
    const res = await fetch(url, { ...init, headers: { ...init.headers, ...(jar ? { cookie: jar } : {}) } });
    const set = res.headers.getSetCookie?.() || [];
    for (const c of set) {
      const [pair] = c.split(';');
      jar = pair.endsWith('=') ? '' : pair;
    }
    return res;
  };
  return createApi(base, f);
}

const filesFrom = (obj) => Object.entries(obj).map(([p, content]) => {
  const data = typeof content === 'string' ? te.encode(content) : content;
  return { path: p, size: data.length, read: async () => data };
});

let server, base, dataDir, serverDb;
test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'padala-test-'));
  ({ server, db: serverDb } = createServer({ port: 0, dataDir, secureCookies: false, trustProxy: false, maxFileMB: 50, maxTeamStorageMB: 500 }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('two teammates deliver a project end to end', async (t) => {
  const me = browser(base);
  const partner = browser(base);
  const outsider = browser(base);
  const key = generateTeamKey();
  const keys = await importTeamKey(key);

  // Accounts
  await me.post('/api/signup', { username: 'mukramin', name: 'Mukramin', password: 'password123' });
  await assert.rejects(me.post('/api/signup', { username: 'MUKRAMIN', name: 'X', password: 'password123' }), /taken/);
  await assert.rejects(browser(base).post('/api/signup', { username: 'ab', name: 'X', password: 'password123' }), /3–32/);
  await partner.post('/api/signup', { username: 'jolo.partner', name: 'Partner', password: 'password456' });
  await outsider.post('/api/signup', { username: 'outsider', name: 'Outsider', password: 'password789' });

  // Team + invite
  const { team } = await me.post('/api/teams', { name: 'Jolo Dev Team', keyCheck: keys.check });
  const { token } = await me.post(`/api/teams/${team.id}/invites`);
  const info = await partner.get(`/api/invites/${token}`);
  assert.equal(info.team.name, 'Jolo Dev Team');
  assert.equal(info.invitedBy, 'Mukramin');
  const joined = await partner.post(`/api/invites/${token}/accept`);
  assert.equal(joined.team.keyCheck, (await importTeamKey(key)).check, 'partner can verify the key from the link');
  await assert.rejects(outsider.post(`/api/invites/${token}/accept`), /already used/);
  const meInfo = await me.get('/api/me');
  assert.equal(meInfo.teams[0].members.length, 2);

  // Project + encrypted chat
  const { project } = await me.post(`/api/teams/${team.id}/projects`, { name: 'booktrack-v2' });
  await assert.rejects(partner.post(`/api/teams/${team.id}/projects`, { name: 'BookTrack-V2' }), /already has/);
  const body = await encryptText(keys, 'Client says login shows an error', `msg:${project.id}`);
  await partner.post(`/api/projects/${project.id}/messages`, { body });
  const list = await me.get(`/api/teams/${team.id}/projects`);
  assert.equal(list.projects[0].unread, 1);
  const detail = await me.get(`/api/projects/${project.id}`);
  const text = detail.messages.find((m) => m.kind === 'text');
  assert.equal(await decryptText(keys, text.body, `msg:${project.id}`), 'Client says login shows an error');
  assert.ok(!JSON.stringify(detail).includes('login shows'), 'server never sees message text');

  // Outsiders see nothing
  await assert.rejects(outsider.get(`/api/projects/${project.id}`), (e) => e instanceof ApiError && e.status === 404);
  await assert.rejects(outsider.get(`/api/teams/${team.id}/projects`), (e) => e.status === 404);

  // v1: a folder with a big file (several pieces) and duplicate content
  const big = new Uint8Array(PIECE * 2 + 1234).map((_, i) => (i * 7) % 256);
  const v1Files = {
    'index.php': '<?php require "includes/auth.php";',
    'includes/auth.php': '<?php // v1',
    'config.php': '<?php $db = "root";',
    'assets/cover.bin': big,
    'assets/copy-of-cover.bin': big,
    'empty.txt': '',
  };
  const prep1 = await prepareDelivery({ keys, files: filesFrom(v1Files), previous: null });
  assert.equal(prep1.diff.added.length, 6);
  let last;
  const v1 = await sendDelivery({ api: me, teamId: team.id, projectId: project.id, keys, prepared: prep1, note: 'First version', progress: (s) => { last = s; } });
  assert.equal(v1.number, 1);
  assert.equal(last.phase, 'done');
  assert.equal(last.files, 5, 'duplicate content uploaded once');

  // Status moved from building -> sent automatically
  assert.equal((await me.get(`/api/projects/${project.id}`)).project.status, 'sent');

  // Partner receives v1
  const manifest1 = await loadManifest({ api: partner, teamId: team.id, keys, manifestId: v1.manifest });
  const got = {};
  await receiveFiles({ api: partner, teamId: team.id, keys, files: manifest1.files, onFile: (p, d) => { got[p] = d; } });
  assert.equal(Object.keys(got).length, 6);
  assert.deepEqual(got['assets/copy-of-cover.bin'], big);
  assert.equal(new TextDecoder().decode(got['config.php']), v1Files['config.php']);
  await partner.post(`/api/versions/${v1.id}/downloaded`);
  const after = await me.get(`/api/projects/${project.id}`);
  assert.equal(after.versions[0].downloadedBy.length, 1);
  assert.ok(after.messages.some((m) => m.kind === 'download'));
  assert.equal(await decryptText(keys, after.versions[0].note, `note:${project.id}`), 'First version');

  // Outsider can't read pieces even with the id
  await assert.rejects(outsider.raw(`/api/teams/${team.id}/blobs/${v1.manifest}/0`), (e) => e.status === 404);

  // v2 over a flaky connection: only the changed files are sent
  let calls = 0;
  const flaky = browser(base, (url, init) => init.method === 'PUT' && ++calls % 2 === 1);
  await flaky.post('/api/login', { username: 'mukramin', password: 'password123' });
  const v2Files = { ...v1Files, 'includes/auth.php': '<?php // v2 fixed login', 'database/upgrade.sql': 'ALTER TABLE x;' };
  delete v2Files['empty.txt'];
  const prep2 = await prepareDelivery({ keys, files: filesFrom(v2Files), previous: manifest1 });
  assert.deepEqual(prep2.diff.added, ['database/upgrade.sql']);
  assert.deepEqual(prep2.diff.modified, ['includes/auth.php']);
  assert.deepEqual(prep2.diff.removed, ['empty.txt']);
  let s2;
  const v2 = await sendDelivery({ api: flaky, teamId: team.id, projectId: project.id, keys, prepared: prep2, progress: (s) => { s2 = s; } });
  assert.equal(v2.number, 2);
  assert.equal(v2.changedCount, 3);
  assert.ok(v2.sentBytes < 100, `only changed bytes sent (${v2.sentBytes})`);
  assert.ok(s2.resumes >= 1, 'recovered from dropped connections');

  // Status + validation
  await partner.patch(`/api/projects/${project.id}`, { status: 'handed_over' });
  await assert.rejects(partner.patch(`/api/projects/${project.id}`, { status: 'lost' }), /Unknown status/);
  const final = await me.get(`/api/projects/${project.id}`);
  assert.equal(final.project.status, 'handed_over');
  assert.equal(final.versions.length, 2);
});

test('deleting a project frees only its own files; permissions; several teams', async () => {
  const owner = browser(base);
  const helper = browser(base);
  const other = browser(base);
  const keys = await importTeamKey(generateTeamKey());
  await owner.post('/api/signup', { username: 'owner1', name: 'Owner', password: 'password123' });
  await helper.post('/api/signup', { username: 'helper1', name: 'Helper', password: 'password123' });
  await other.post('/api/signup', { username: 'other1', name: 'Other', password: 'password123' });
  const { team } = await owner.post('/api/teams', { name: 'Studio', keyCheck: keys.check });
  const { token } = await owner.post(`/api/teams/${team.id}/invites`);
  await helper.post(`/api/invites/${token}/accept`);

  const shared = 'shared file used by both projects';
  const mk = async (who, name, files) => {
    const { project } = await who.post(`/api/teams/${team.id}/projects`, { name });
    const prepared = await prepareDelivery({ keys, files: filesFrom(files), previous: null });
    await sendDelivery({ api: who, teamId: team.id, projectId: project.id, keys, prepared });
    return project;
  };
  const a = await mk(helper, 'site-a', { 'a.txt': 'only in a', 'common.txt': shared });
  const b = await mk(owner, 'site-b', { 'b.txt': 'only in b', 'common.txt': shared });

  // someone outside the team can't; a teammate who didn't create it can't (unless owner)
  await assert.rejects(other.del(`/api/projects/${a.id}`), (e) => e.status === 404);
  const res = await fetch(`${base}/api/projects/${b.id}`, { method: 'DELETE', headers: { 'X-Padala': '1', cookie: '' } });
  assert.equal(res.status, 401);

  const blobsBefore = fs.readdirSync(path.join(dataDir, 'blobs', String(team.id))).length;
  // the owner may delete a project a teammate created
  const out = await owner.del(`/api/projects/${a.id}`);
  assert.equal(out.freedFiles, 2, 'a.txt and a’s file list are removed');
  const blobsAfter = fs.readdirSync(path.join(dataDir, 'blobs', String(team.id))).length;
  assert.equal(blobsBefore - blobsAfter, 2);
  // site-b still downloads completely, including the shared file
  const detail = await owner.get(`/api/projects/${b.id}`);
  const manifest = await loadManifest({ api: owner, teamId: team.id, keys, manifestId: detail.versions[0].manifest });
  const got = {};
  await receiveFiles({ api: owner, teamId: team.id, keys, files: manifest.files, onFile: (pp, d) => { got[pp] = new TextDecoder().decode(d); } });
  assert.equal(got['common.txt'], shared);
  await assert.rejects(owner.get(`/api/projects/${a.id}`), (e) => e.status === 404);
  // helper didn't create site-b and isn't the owner
  await assert.rejects(helper.del(`/api/projects/${b.id}`), /Only Owner or the team owner/);

  // a second team with different people
  const keys2 = await importTeamKey(generateTeamKey());
  const { team: t2 } = await owner.post('/api/teams', { name: 'Thesis Clients', keyCheck: keys2.check });
  const me = await owner.get('/api/me');
  assert.deepEqual(me.teams.map((t) => t.name).sort(), ['Studio', 'Thesis Clients']);
  await assert.rejects(helper.get(`/api/teams/${t2.id}/projects`), (e) => e.status === 404, 'helper can’t see the other team');
  await owner.patch(`/api/teams/${t2.id}`, { name: 'Thesis' });
  // leaving: owner leaves Studio -> helper becomes owner; last person leaving deletes the team
  await owner.post(`/api/teams/${team.id}/leave`);
  assert.equal((await helper.get('/api/me')).teams[0].role, 'owner');
  const left = await owner.post(`/api/teams/${t2.id}/leave`);
  assert.equal(left.deletedTeam, true);
  assert.equal((await owner.get('/api/me')).teams.length, 0);
});

test('a team is only removed when its last member leaves', async () => {
  const boss = browser(base);
  const mate = browser(base);
  const third = browser(base);
  const keys = await importTeamKey(generateTeamKey());
  await boss.post('/api/signup', { username: 'boss1', name: 'Boss', password: 'password123' });
  await mate.post('/api/signup', { username: 'mate1', name: 'Mate', password: 'password123' });
  await third.post('/api/signup', { username: 'third1', name: 'Third', password: 'password123' });
  const { team } = await boss.post('/api/teams', { name: 'Clinic', keyCheck: keys.check });
  await mate.post(`/api/invites/${(await boss.post(`/api/teams/${team.id}/invites`)).token}/accept`);
  const { project } = await mate.post(`/api/teams/${team.id}/projects`, { name: 'clinic-site' });
  const prepared = await prepareDelivery({ keys, files: filesFrom({ 'index.html': '<h1>Clinic</h1>' }), previous: null });
  await sendDelivery({ api: mate, teamId: team.id, projectId: project.id, keys, prepared });
  const blobDir = path.join(dataDir, 'blobs', String(team.id));
  assert.ok(fs.existsSync(blobDir));

  // there is no "delete team for everyone"
  await assert.rejects(boss.del(`/api/teams/${team.id}`), (e) => e.status === 405);
  // owner leaves: the team lives on with Mate as owner, files intact
  assert.equal((await boss.post(`/api/teams/${team.id}/leave`)).deletedTeam, false);
  assert.equal((await mate.get('/api/me')).teams[0].role, 'owner');
  assert.ok(fs.existsSync(blobDir));
  // a remaining member can still invite someone new
  await third.post(`/api/invites/${(await mate.post(`/api/teams/${team.id}/invites`)).token}/accept`);
  assert.equal((await third.get(`/api/projects/${project.id}`)).project.name, 'clinic-site');
  assert.equal((await mate.post(`/api/teams/${team.id}/leave`)).deletedTeam, false);
  // the last one out removes it for good
  assert.equal((await third.post(`/api/teams/${team.id}/leave`)).deletedTeam, true);
  assert.equal((await third.get('/api/me')).teams.length, 0);
  await assert.rejects(third.get(`/api/projects/${project.id}`), (e) => e.status === 404);
  assert.equal(fs.existsSync(blobDir), false, 'stored files removed');
});

test('security: CSRF header, sign-in lockout, session required', async () => {
  const res = await fetch(`${base}/api/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 403);
  const evil = await fetch(`${base}/api/logout`, { method: 'POST', headers: { 'X-Padala': '1', Origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
  const anon = browser(base);
  await assert.rejects(anon.get('/api/me'), (e) => e.status === 401);
  const u = browser(base);
  await u.post('/api/signup', { username: 'lockme', name: 'L', password: 'password123' });
  for (let i = 0; i < 5; i++) await assert.rejects(browser(base).post('/api/login', { username: 'lockme', password: 'wrong' }), /don't match/);
  await assert.rejects(browser(base).post('/api/login', { username: 'lockme', password: 'password123' }), /Too many/);
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  const traversal = await fetch(`${base}/..%2fserver%2fdb.js`);
  assert.equal(traversal.status, 404);
});

test('behind a tunnel: invite address and cross-site check use PUBLIC_URL', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'padala-pub-'));
  const { server: s2 } = createServer({ port: 0, dataDir: dir, secureCookies: false, trustProxy: true, publicUrl: 'https://quiet-river.trycloudflare.com', maxFileMB: 50, maxTeamStorageMB: 500 });
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  try {
    assert.equal((await (await fetch(`${b2}/api/config`)).json()).publicUrl, 'https://quiet-river.trycloudflare.com');
    const post = (origin) => fetch(`${b2}/api/signup`, { method: 'POST', headers: { 'X-Padala': '1', 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ username: `u${Math.random().toString(36).slice(2, 8)}`, name: 'Phone', password: 'password123' }) });
    assert.equal((await post('https://quiet-river.trycloudflare.com')).status, 200, 'the phone (through the tunnel) is allowed');
    assert.equal((await post('https://evil.example')).status, 403, 'other sites are still blocked');
  } finally { s2.close(); s2.closeAllConnections(); }
});

test('team key backup: only locked copies, only for members, removed on leave', async () => {
  const a = browser(base);
  const b = browser(base);
  await a.post('/api/signup', { username: 'backup1', name: 'Backup One', password: 'password123' });
  await b.post('/api/signup', { username: 'backup2', name: 'Backup Two', password: 'password123' });
  const keys = await importTeamKey(generateTeamKey());
  const { team } = await a.post('/api/teams', { name: 'Backups', keyCheck: keys.check });
  const first = await a.get('/api/keys');
  assert.match(first.salt, /^[A-Za-z0-9_-]{16,}$/);
  assert.equal((await a.get('/api/keys')).salt, first.salt, 'salt stays the same');
  assert.deepEqual(first.wraps, []);
  await a.put(`/api/teams/${team.id}/key-backup`, { wrapped: 'locked_copy-abc' });
  assert.deepEqual((await a.get('/api/keys')).wraps, [{ teamId: team.id, wrapped: 'locked_copy-abc', scheme: 'pw' }]);
  await assert.rejects(b.put(`/api/teams/${team.id}/key-backup`, { wrapped: 'x' }), (e) => e.status === 404, 'non-members cannot store a backup');
  await assert.rejects(a.put(`/api/teams/${team.id}/key-backup`, { wrapped: 'not valid!' }), (e) => e.status === 422);
  await assert.rejects(a.post('/api/me/verify-password', { password: 'wrong-password' }), (e) => e.status === 401);
  assert.deepEqual(await a.post('/api/me/verify-password', { password: 'password123' }), { ok: true });
  await a.post(`/api/teams/${team.id}/leave`);
  assert.deepEqual((await a.get('/api/keys')).wraps, []);
});

test('live updates by long polling: a waiting request returns the moment something happens', async () => {
  const a = browser(base);
  const b = browser(base);
  await a.post('/api/signup', { username: 'poll1', name: 'Poll One', password: 'password123' });
  await b.post('/api/signup', { username: 'poll2', name: 'Poll Two', password: 'password123' });
  const keys = await importTeamKey(generateTeamKey());
  const { team } = await a.post('/api/teams', { name: 'Polling', keyCheck: keys.check });
  await b.post(`/api/invites/${(await a.post(`/api/teams/${team.id}/invites`)).token}/accept`);
  const { project } = await a.post(`/api/teams/${team.id}/projects`, { name: 'live-site' });

  const first = await b.get('/api/events/poll');
  assert.equal(first.events[0].type, 'hello');
  const started = Date.now();
  const waiting = b.get(`/api/events/poll?session=${first.session}`);
  await new Promise((r) => setTimeout(r, 300));
  await a.post(`/api/projects/${project.id}/messages`, { body: 'x'.repeat(40) });
  const got = await waiting;
  assert.ok(Date.now() - started < 3000, 'answered right away, not after the 25 second wait');
  assert.equal(got.session, first.session);
  assert.ok(got.events.some((e) => e.type === 'message' && e.data.projectId === project.id), JSON.stringify(got));

  // events that happen between two polls wait in the queue
  await a.post(`/api/projects/${project.id}/messages`, { body: 'y'.repeat(40) });
  const queued = await b.get(`/api/events/poll?session=${first.session}`);
  assert.ok(queued.events.some((e) => e.type === 'message'));

  // an unknown session (the server restarted) simply starts a new one
  const fresh = await b.get('/api/events/poll?session=not-a-session');
  assert.notEqual(fresh.session, first.session);
  assert.equal(fresh.events[0].type, 'hello');
});

test('account key, recovery code, change password and forgot password', async () => {
  const phone = browser(base);
  const laptop = browser(base);
  await phone.post('/api/signup', { username: 'recover1', name: 'Re Cover', password: 'password123' });
  await laptop.post('/api/login', { username: 'recover1', password: 'password123' });
  const k = await phone.get('/api/keys');
  assert.equal(k.amkPw, null);
  assert.equal(k.hasRecovery, false);
  await phone.put('/api/keys/account', { amkPw: 'locked-account-key' });
  await assert.rejects(laptop.put('/api/keys/account', { amkPw: 'other' }), (e) => e.status === 409, 'the account key is set once');
  assert.equal((await laptop.get('/api/keys')).amkPw, 'locked-account-key');

  await assert.rejects(phone.post('/api/me/recovery', { password: 'nope-nope', code: 'ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2', amkRc: 'x' }), (e) => e.status === 401);
  await phone.post('/api/me/recovery', { password: 'password123', code: 'ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2', amkRc: 'locked-with-code' });
  assert.equal((await phone.get('/api/keys')).hasRecovery, true);

  // change password: re-locked account key saved, other devices signed out
  await phone.post('/api/me/password', { current: 'password123', next: 'new-password-1', amkPw: 'relocked-1' });
  await assert.rejects(laptop.get('/api/me'), (e) => e.status === 401, 'the laptop was signed out');
  assert.equal((await phone.get('/api/keys')).amkPw, 'relocked-1');
  const again = browser(base);
  await assert.rejects(again.post('/api/login', { username: 'recover1', password: 'password123' }), (e) => e.status === 401);
  await again.post('/api/login', { username: 'recover1', password: 'new-password-1' });

  // forgot password with the recovery code (spaces and lowercase are fine)
  const lost = browser(base);
  await assert.rejects(lost.post('/api/recovery/start', { username: 'recover1', code: 'WRONG-CODE-0000-0000-0000-0000' }), (e) => e.status === 401);
  const start = await lost.post('/api/recovery/start', { username: 'recover1', code: 'abcd efgh jkmn pqrs tuvw xyz2' });
  assert.equal(start.amkRc, 'locked-with-code');
  assert.ok(start.salt);
  const done = await lost.post('/api/recovery/finish', { token: start.token, password: 'fresh-password', amkPw: 'relocked-2' });
  assert.equal(done.user.username, 'recover1');
  assert.equal((await lost.get('/api/keys')).amkPw, 'relocked-2');
  await assert.rejects(again.get('/api/me'), (e) => e.status === 401, 'every old session ends after a reset');
  await assert.rejects(lost.post('/api/recovery/finish', { token: start.token, password: 'another-one' }), (e) => e.status === 410, 'a reset link works once');
});

test('storage: meter, keep the last N versions, and shared files are only freed when unused', async () => {
  const a = browser(base);
  await a.post('/api/signup', { username: 'store1', name: 'Store One', password: 'password123' });
  const keys = await importTeamKey(generateTeamKey());
  const { team } = await a.post('/api/teams', { name: 'Storage', keyCheck: keys.check });
  const { project: p1 } = await a.post(`/api/teams/${team.id}/projects`, { name: 'site-one' });
  const { project: p2 } = await a.post(`/api/teams/${team.id}/projects`, { name: 'site-two' });
  const send = async (project, files) => {
    const d = await a.get(`/api/projects/${project.id}`);
    const prevV = d.versions[d.versions.length - 1];
    const previous = prevV ? await loadManifest({ api: a, teamId: team.id, keys, manifestId: prevV.manifest }) : null;
    const prepared = await prepareDelivery({ keys, files: filesFrom(files), previous });
    return sendDelivery({ api: a, teamId: team.id, projectId: project.id, keys, prepared });
  };
  const shared = 'shared logo '.repeat(500);
  await send(p1, { 'index.html': 'v1 '.repeat(3000), 'logo.svg': shared });
  await send(p1, { 'index.html': 'v2 '.repeat(3000), 'logo.svg': shared });
  await send(p1, { 'index.html': 'v3 '.repeat(3000), 'logo.svg': shared });
  await send(p2, { 'other.html': 'hello', 'logo.svg': shared });

  const before = await a.get(`/api/teams/${team.id}/storage`);
  assert.ok(before.used > 0 && before.limit > before.used);
  assert.equal(before.projects.find((x) => x.id === p1.id).versions, 3);

  const { cleared } = await a.patch(`/api/teams/${team.id}`, { keepVersions: 1 });
  assert.equal(cleared.removed, 2, 'two old versions of site-one cleared');
  assert.ok(cleared.freedBytes > 0);
  const after = await a.get(`/api/teams/${team.id}/storage`);
  assert.ok(after.used < before.used);
  assert.equal(after.keepVersions, 1);
  const d1 = await a.get(`/api/projects/${p1.id}`);
  assert.deepEqual(d1.versions.map((v) => v.number), [3], 'only the latest version is left');
  // the latest version (and the logo both projects use) still download fine
  const m = await loadManifest({ api: a, teamId: team.id, keys, manifestId: d1.versions[0].manifest });
  for (const f of m.files) assert.equal((await a.get(`/api/teams/${team.id}/blobs/${f.id}`)).complete, true);

  // new versions keep pruning automatically
  await send(p2, { 'other.html': 'hello again', 'logo.svg': shared });
  assert.deepEqual((await a.get(`/api/projects/${p2.id}`)).versions.map((v) => v.number), [2]);
  await a.patch(`/api/teams/${team.id}`, { keepVersions: null });
  assert.equal((await a.get(`/api/teams/${team.id}/storage`)).keepVersions, null);
});

test('daily backup: database copy, pieces copied once, cleared pieces kept for a week', async () => {
  const a = browser(base);
  await a.post('/api/signup', { username: 'backupper', name: 'Back Upper', password: 'password123' });
  const keys = await importTeamKey(generateTeamKey());
  const { team } = await a.post('/api/teams', { name: 'Backed up', keyCheck: keys.check });
  const { project } = await a.post(`/api/teams/${team.id}/projects`, { name: 'to-back-up' });
  const prepared = await prepareDelivery({ keys, files: filesFrom({ 'index.html': 'back me up '.repeat(2000) }), previous: null });
  await sendDelivery({ api: a, teamId: team.id, projectId: project.id, keys, prepared });

  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'padala-backup-'));
  const day = Date.UTC(2026, 8, 30, 3);
  const first = runBackup({ db: serverDb, dataDir, backupDir, now: day });
  assert.equal(first.database, 'padala-2026-09-30.db');
  assert.ok(first.piecesCopied > 0);
  const copy = new DatabaseSync(path.join(backupDir, first.database), { readOnly: true });
  assert.equal(copy.prepare('SELECT name FROM projects WHERE id = ?').get(project.id).name, 'to-back-up', 'the copy has the data');
  copy.close();
  const again = runBackup({ db: serverDb, dataDir, backupDir, now: day + 3600000 });
  assert.equal(again.database, null, 'one database copy per day');
  assert.equal(again.piecesCopied, 0, 'pieces are only copied once');

  const pieceDir = path.join(backupDir, 'pieces', String(team.id));
  const blobs = fs.readdirSync(pieceDir);
  await a.del(`/api/projects/${project.id}`);
  runBackup({ db: serverDb, dataDir, backupDir, now: day + 86400000 });
  assert.deepEqual(fs.readdirSync(pieceDir).sort(), blobs.sort(), 'deleted files stay in the backup for now');
  for (let d = 2; d <= 10; d++) runBackup({ db: serverDb, dataDir, backupDir, now: day + d * 86400000 });
  assert.equal(fs.readdirSync(pieceDir).length, 0, 'and are removed once no kept copy needs them');
  assert.equal(fs.readdirSync(backupDir).filter((f) => f.endsWith('.db')).length, 7, 'the last 7 daily copies are kept');
  fs.rmSync(backupDir, { recursive: true, force: true });
});

test('notifications when the app is closed: sent to teammates, never to the sender; only real push services', async () => {
  const sent = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'padala-push-'));
  const pushFetch = async (url, init) => { sent.push({ url, init }); return { ok: true, status: 201 }; };
  const { server: s3 } = createServer({ port: 0, dataDir: dir, secureCookies: false, maxFileMB: 50, maxTeamStorageMB: 500, pushFetch });
  await new Promise((r) => s3.listen(0, '127.0.0.1', r));
  const b3 = `http://127.0.0.1:${s3.address().port}`;
  try {
    const me = browser(b3);
    const phone = browser(b3);
    await me.post('/api/signup', { username: 'pusher', name: 'Mukramin', password: 'password123' });
    await phone.post('/api/signup', { username: 'camiela', name: 'Camiela', password: 'password123' });
    const keys = await importTeamKey(generateTeamKey());
    const { team } = await me.post('/api/teams', { name: 'Push', keyCheck: keys.check });
    await phone.post(`/api/invites/${(await me.post(`/api/teams/${team.id}/invites`)).token}/accept`);
    assert.match((await phone.get('/api/push/key')).publicKey, /^B[A-Za-z0-9_-]{86}$/);

    await assert.rejects(phone.post('/api/push/subscribe', { endpoint: 'http://127.0.0.1:22/admin', keys: { p256dh: 'x', auth: 'y' } }), (e) => e.status === 422, 'no arbitrary addresses');
    const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
    const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/device-1', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
    await phone.post('/api/push/subscribe', sub);

    const { project } = await me.post(`/api/teams/${team.id}/projects`, { name: 'clinic' });
    await me.post(`/api/projects/${project.id}/messages`, { body: 'z'.repeat(40) });
    const prepared = await prepareDelivery({ keys, files: filesFrom({ 'index.php': '<?php echo 1;' }), previous: null });
    await sendDelivery({ api: me, teamId: team.id, projectId: project.id, keys, prepared });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(sent.length, 2, 'one for the message, one for the files');
    assert.ok(sent.every((x) => x.url === sub.endpoint));
    assert.equal(sent[0].init.headers['Content-Encoding'], 'aes128gcm');
    assert.match(sent[0].init.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=B/);

    // the phone replies: nobody else subscribed, and the sender never gets their own notice
    await phone.post(`/api/projects/${project.id}/messages`, { body: 'y'.repeat(40) });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(sent.length, 2);
    await phone.post('/api/push/unsubscribe', { endpoint: sub.endpoint });
    await me.post(`/api/projects/${project.id}/messages`, { body: 'w'.repeat(40) });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(sent.length, 2, 'turned off: no more notices');
  } finally { s3.close(); s3.closeAllConnections(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('messages: reply to one, delete your own (text erased for everyone); profile photos only for teammates', async () => {
  const a = browser(base);
  const b = browser(base);
  const stranger = browser(base);
  await a.post('/api/signup', { username: 'chat1', name: 'Chat One', password: 'password123' });
  await b.post('/api/signup', { username: 'chat2', name: 'Chat Two', password: 'password123' });
  await stranger.post('/api/signup', { username: 'chat3', name: 'Stranger', password: 'password123' });
  const keys = await importTeamKey(generateTeamKey());
  const { team } = await a.post('/api/teams', { name: 'Chat', keyCheck: keys.check });
  await b.post(`/api/invites/${(await a.post(`/api/teams/${team.id}/invites`)).token}/accept`);
  const { project } = await a.post(`/api/teams/${team.id}/projects`, { name: 'chat-site' });
  const { message: first } = await a.post(`/api/projects/${project.id}/messages`, { body: 'q'.repeat(40) });
  const { message: reply } = await b.post(`/api/projects/${project.id}/messages`, { body: 'r'.repeat(40), replyTo: first.id });
  assert.equal(reply.replyTo, first.id);
  await assert.rejects(b.post(`/api/projects/${project.id}/messages`, { body: 's'.repeat(40), replyTo: 999999 }), (e) => e.status === 422);
  await assert.rejects(b.del(`/api/messages/${first.id}`), (e) => e.status === 403, "can't delete someone else's message");
  const { message: gone } = await a.del(`/api/messages/${first.id}`);
  assert.equal(gone.deleted, true);
  assert.equal(gone.body, null, 'the encrypted text is erased on the server');
  const list = (await b.get(`/api/projects/${project.id}`)).messages;
  assert.equal(list.find((m) => m.id === first.id).deleted, true);
  assert.equal(list.find((m) => m.id === reply.id).replyTo, first.id);

  // profile photo: a tiny real PNG
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cfc0f01f0005000201a2e3ec4a0000000049454e44ae426082', 'hex');
  await assert.rejects(a.put('/api/me/avatar', new Uint8Array(Buffer.from('not an image at all'))), (e) => e.status === 422);
  const { avatarV } = await a.put('/api/me/avatar', new Uint8Array(png));
  assert.ok(avatarV);
  const me = (await a.get('/api/me')).user;
  assert.equal(me.avatarV, avatarV);
  assert.equal((await b.get('/api/me')).teams[0].members.find((m) => m.id === me.id).avatarV, avatarV);
  const img = await b.raw(`/api/users/${me.id}/avatar?v=${avatarV}`);
  assert.deepEqual(Buffer.from(img), png, 'teammates see the photo');
  await assert.rejects(stranger.raw(`/api/users/${me.id}/avatar`), (e) => e.status === 404, 'people outside the team do not');
  await a.del('/api/me/avatar');
  await assert.rejects(b.raw(`/api/users/${me.id}/avatar`), (e) => e.status === 404);
});
