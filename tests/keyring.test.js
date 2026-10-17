import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveBackupKey, lockTeamKey, unlockTeamKey } from '../web/js/keyring.js';
import { generateTeamKey } from '../web/js/crypto.js';

test('a team key backup opens only with the right password, for the right team', async () => {
  const teamKey = generateTeamKey();
  const salt = 'abcdefghijklmnop';
  const k = await deriveBackupKey('correct horse battery', salt);
  const locked = await lockTeamKey(k, 7, teamKey);
  assert.match(locked, /^[A-Za-z0-9_-]+$/);
  assert.ok(!locked.includes(teamKey));
  assert.equal(await unlockTeamKey(await deriveBackupKey('correct horse battery', salt), 7, locked), teamKey, 'another device with the same password unlocks it');
  await assert.rejects(unlockTeamKey(await deriveBackupKey('wrong password!', salt), 7, locked));
  await assert.rejects(unlockTeamKey(k, 8, locked), 'a backup cannot be swapped onto another team');
});

test('account key: password and recovery code both open it; a new password re-locks it', async () => {
  const { newAccountKeyBytes, importAccountKey, lockAccountKey, unlockAccountKey, deriveRecoveryKey, newRecoveryCode, accountKeyBytes } = await import('../web/js/keyring.js');
  const salt = 'saltsaltsaltsalt';
  const amk = await importAccountKey(newAccountKeyBytes());
  const code = newRecoveryCode();
  assert.match(code, /^([2-9A-HJKMNP-Z]{4}-){5}[2-9A-HJKMNP-Z]{4}$/);
  const byPw = await lockAccountKey(await deriveBackupKey('old password', salt), amk);
  const byCode = await lockAccountKey(await deriveRecoveryKey(code, salt), amk);
  const fromCode = await unlockAccountKey(await deriveRecoveryKey(code.toLowerCase().replace(/-/g, ' '), salt), byCode);
  assert.deepEqual(await accountKeyBytes(fromCode), await accountKeyBytes(amk), 'the recovery code (typed loosely) opens it');
  const teamLocked = await lockTeamKey(amk, 3, 'team-key-value');
  assert.equal(await unlockTeamKey(fromCode, 3, teamLocked), 'team-key-value');
  const byNewPw = await lockAccountKey(await deriveBackupKey('new password', salt), fromCode);
  assert.deepEqual(await accountKeyBytes(await unlockAccountKey(await deriveBackupKey('new password', salt), byNewPw)), await accountKeyBytes(amk));
  await assert.rejects(unlockAccountKey(await deriveBackupKey('wrong', salt), byPw));
});
