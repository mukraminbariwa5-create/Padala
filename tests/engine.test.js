// Encryption, zip and folder-update logic.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateTeamKey, importTeamKey, isValidKeyFormat, contentId, encryptBytes, decryptBytes, encryptText, decryptText, pieceContext,
} from '../web/js/crypto.js';
import { crc32, makeZip } from '../web/js/zip.js';
import { diffFiles, planUpdate, resolvePlan, isIgnored, cleanPath, mineName, formatBytes } from '../web/js/sync.js';

const te = new TextEncoder();

test('team keys: format, deterministic key check, different keys differ', async () => {
  const key = generateTeamKey();
  assert.ok(isValidKeyFormat(key));
  assert.ok(!isValidKeyFormat(key.slice(1)));
  const a = await importTeamKey(key);
  const b = await importTeamKey(key);
  assert.equal(a.check, b.check);
  assert.notEqual(a.check, (await importTeamKey(generateTeamKey())).check);
  await assert.rejects(importTeamKey('nope'), /not valid/);
});

test('content ids: same bytes same id, different keys different ids', async () => {
  const k1 = await importTeamKey(generateTeamKey());
  const k2 = await importTeamKey(generateTeamKey());
  const data = te.encode('<?php echo "hello";');
  assert.equal(await contentId(k1, data), await contentId(k1, data));
  assert.match(await contentId(k1, data), /^[0-9a-f]{64}$/);
  assert.notEqual(await contentId(k1, data), await contentId(k2, data));
});

test('encryption round-trips and is bound to its context', async () => {
  const keys = await importTeamKey(generateTeamKey());
  const data = te.encode('secret project files');
  const sealed = await encryptBytes(keys, data, pieceContext('a'.repeat(64), 0, 2));
  assert.deepEqual(await decryptBytes(keys, sealed, pieceContext('a'.repeat(64), 0, 2)), data);
  // Same data encrypts differently each time (random IV)
  assert.notDeepEqual(sealed, await encryptBytes(keys, data, pieceContext('a'.repeat(64), 0, 2)));
  // A piece moved to another position or file fails
  await assert.rejects(decryptBytes(keys, sealed, pieceContext('a'.repeat(64), 1, 2)), /Could not decrypt/);
  // Tampering fails
  const bad = sealed.slice(); bad[20] ^= 1;
  await assert.rejects(decryptBytes(keys, bad, pieceContext('a'.repeat(64), 0, 2)), /Could not decrypt/);
  // Wrong team key fails
  const other = await importTeamKey(generateTeamKey());
  await assert.rejects(decryptBytes(other, sealed, pieceContext('a'.repeat(64), 0, 2)), /wrong team key/);
  const msg = await encryptText(keys, 'Magandang hapon! Fixed na.', 'msg:1');
  assert.equal(await decryptText(keys, msg, 'msg:1'), 'Magandang hapon! Fixed na.');
});

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(te.encode('123456789')), 0xcbf43926);
});

test('zip: valid structure with UTF-8 names and folders', async () => {
  const zip = makeZip([
    { path: 'booktrack/index.php', data: te.encode('<?php') },
    { path: 'booktrack/assets/ñ.txt', data: te.encode('ok') },
    { path: 'empty.txt', data: new Uint8Array(0) },
  ]);
  const buf = new Uint8Array(await zip.arrayBuffer());
  const dv = new DataView(buf.buffer);
  assert.equal(dv.getUint32(0, true), 0x04034b50);
  const endAt = buf.length - 22;
  assert.equal(dv.getUint32(endAt, true), 0x06054b50);
  assert.equal(dv.getUint16(endAt + 10, true), 3);
  const cdOffset = dv.getUint32(endAt + 16, true);
  assert.equal(dv.getUint32(cdOffset, true), 0x02014b50);
  const nameLen = dv.getUint16(cdOffset + 28, true);
  assert.equal(new TextDecoder().decode(buf.subarray(cdOffset + 46, cdOffset + 46 + nameLen)), 'booktrack/index.php');
});

test('paths: ignored folders and unsafe paths', () => {
  assert.ok(isIgnored('.git/config'));
  assert.ok(isIgnored('src/node_modules/x/index.js'));
  assert.ok(isIgnored('.padala.json'));
  assert.ok(!isIgnored('includes/auth.php'));
  assert.ok(!isIgnored('.htaccess'));
  assert.equal(cleanPath('a\\b\\c.php'), 'a/b/c.php');
  assert.equal(cleanPath('../etc/passwd'), null);
  assert.equal(cleanPath('C:/x'), null);
  assert.equal(cleanPath('./ok/./file.txt'), 'ok/file.txt');
});

test('diff between versions', () => {
  const d = diffFiles({ 'a.php': '1', 'b.php': '2', 'c.php': '3' }, { 'a.php': '1', 'b.php': '9', 'd.php': '4' });
  assert.deepEqual(d, { added: ['d.php'], modified: ['b.php'], removed: ['c.php'], unchanged: ['a.php'] });
  assert.deepEqual(diffFiles(null, { 'x': '1' }).added, ['x']);
});

test('folder update: applies sender changes, keeps local edits, flags real conflicts', () => {
  const base = { 'index.php': 'i1', 'config.php': 'c1', 'auth.php': 'a1', 'old.php': 'o1', 'notes.txt': 'n1', 'gone.php': 'g1' };
  const target = { 'index.php': 'i1', 'config.php': 'c2', 'auth.php': 'a2', 'new.php': 'w1', 'notes.txt': 'n1', 'gone.php': 'g2' };
  const local = {
    'index.php': 'i1',      // untouched, unchanged        -> up to date
    'config.php': 'cLOCAL', // both changed                -> conflict
    'auth.php': 'a1',       // only sender changed         -> write
    'old.php': 'o1',        // sender deleted, untouched   -> delete
    'notes.txt': 'nLOCAL',  // only local changed          -> keep local
    // gone.php deleted locally, sender changed it         -> conflict
  };
  const plan = planUpdate(base, target, local);
  assert.deepEqual(plan.writes, ['auth.php', 'new.php']);
  assert.deepEqual(plan.deletes, ['old.php']);
  assert.deepEqual(plan.keptLocal, ['notes.txt']);
  assert.equal(plan.upToDate, 1);
  assert.deepEqual(plan.conflicts, [
    { path: 'config.php', type: 'both-changed' },
    { path: 'gone.php', type: 'you-deleted' },
  ]);

  const ops = resolvePlan(plan, { 'config.php': 'both', 'gone.php': 'theirs' }, (p) => p === 'config.mine.php');
  assert.deepEqual(ops.renames, [{ from: 'config.php', to: 'config.mine2.php' }]);
  assert.deepEqual(ops.writes, ['auth.php', 'new.php', 'config.php', 'gone.php']);
  assert.throws(() => resolvePlan(plan, { 'config.php': 'mine' }), /gone.php/);

  const keepMine = resolvePlan(plan, { 'config.php': 'mine', 'gone.php': 'mine' });
  assert.deepEqual(keepMine.writes, ['auth.php', 'new.php']);
});

test('folder update: first download into an empty or non-empty folder', () => {
  const target = { 'a.php': '1', 'b.php': '2' };
  assert.deepEqual(planUpdate(null, target, {}).writes, ['a.php', 'b.php']);
  const plan = planUpdate(null, target, { 'a.php': '1', 'b.php': 'X' });
  assert.equal(plan.upToDate, 1);
  assert.deepEqual(plan.conflicts, [{ path: 'b.php', type: 'both-changed' }]);
  const theyDeleted = planUpdate({ 'x.php': '1' }, {}, { 'x.php': '2' });
  assert.deepEqual(theyDeleted.conflicts, [{ path: 'x.php', type: 'they-deleted' }]);
  assert.deepEqual(resolvePlan(theyDeleted, { 'x.php': 'theirs' }).deletes, ['x.php']);
});

test('helpers', () => {
  assert.equal(mineName('dir/Makefile', () => false), 'dir/Makefile.mine');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(24.6 * 1024 * 1024), '24.6 MB');
});

test('parallel transfer helpers: memory budget never over-commits, and one failure stops the rest', async () => {
  const { budget, eachLimit } = await import('../web/js/transfer.js');
  const b = budget(100);
  let inUse = 0;
  let peak = 0;
  const sizes = [60, 60, 30, 30, 30, 150, 10];
  await eachLimit(sizes, 6, null, async (n) => {
    await b.take(n);
    inUse += n;
    peak = Math.max(peak, n > 100 ? 0 : inUse);
    await new Promise((r) => setTimeout(r, 5));
    inUse -= n;
    b.give(n);
  });
  assert.ok(peak <= 100, `never more than the budget in memory (peak ${peak})`);

  let started = 0;
  await assert.rejects(eachLimit([1, 2, 3, 4, 5, 6, 7, 8], 2, null, async (n, _k, signal) => {
    started++;
    await new Promise((r) => setTimeout(r, 5));
    if (n === 2) throw new Error('disk full');
    if (signal.aborted) throw new DOMException('stopped', 'AbortError');
  }), /disk full/);
  assert.ok(started < 8, 'after a real error, the remaining work does not start');
});
