// Team keys on this device, key backup, recovery code, password, and team members.
import { importTeamKey, isValidKeyFormat } from '../crypto.js';
import { react, dalaAway, pose } from '../dala.js';
import { tr } from '../i18n.js';
import { deriveBackupKey, deriveRecoveryKey, lockTeamKey, unlockTeamKey, saveBackupKey, loadBackupKey, newAccountKeyBytes, importAccountKey, lockAccountKey, unlockAccountKey, newRecoveryCode } from '../keyring.js';
import { esc, icon, initials, toast, dialog, copyText, field, withLoading } from '../ui.js';
import { connectEvents } from './live.js';
import { current, route, layout } from './shell.js';
import { api, app, S } from './state.js';

const KEYSTORE = 'padala.keys';
export const storedKeys = () => { try { return JSON.parse(localStorage.getItem(KEYSTORE) || '{}'); } catch { return {}; } };
export const storeKey = (teamId, key) => localStorage.setItem(KEYSTORE, JSON.stringify({ ...storedKeys(), [teamId]: key }));

export const isTeamOwner = (team = S.team) => team?.members?.find((m) => m.id === S.me?.id)?.role === 'owner';

/** A team is gone for this person (left, or deleted): tidy up and go to another team, or to setup. */
export async function afterTeamGone(teamId) {
  S.teams = S.teams.filter((t) => t.id !== teamId);
  delete S.teamUnread[teamId];
  const keys = storedKeys();
  if (keys[teamId]) { delete keys[teamId]; localStorage.setItem(KEYSTORE, JSON.stringify(keys)); }
  if (S.team?.id === teamId) {
    if (S.teams.length) await activateTeam(S.teams[0]);
    else S.team = null;
  }
  location.hash = S.team ? '#/' : '#/setup';
  connectEvents();
  route();
}

export async function activateTeam(team) {
  S.team = team;
  localStorage.setItem('padala.team', String(team.id));
  S.keys = null;
  S.keyMissing = false;
  const key = storedKeys()[team.id];
  if (key) {
    try {
      const keys = await importTeamKey(key);
      if (keys.check === team.keyCheck) S.keys = keys;
    } catch { /* invalid stored key */ }
  }
  S.keyMissing = !S.keys;
  S.texts.clear();
  S.projectData.clear();
  await loadProjects();
}

/**
 * Team key backup: restore keys this person backed up from their other devices, and back up the keys
 * this device has. Keys are locked with a key made from the password on this device; the server only
 * ever stores the locked copies. Pass the password right after signing in (or confirming it).
 */
export async function syncKeys({ password } = {}) {
  if (!S.me) return 0;
  let data;
  try { data = await api.get('/api/keys'); } catch { return 0; }
  S.keySalt = data.salt;
  S.hasRecovery = data.hasRecovery;
  // The key made from the password: from the password just typed, or (older app versions) kept on this device.
  let amk = S.backupKey || await loadBackupKey(S.me.id);
  let pwKey = password ? await deriveBackupKey(password, data.salt) : null;
  if (amk && !amk.extractable) { pwKey ||= amk; amk = null; } // what older versions kept here was the password key
  // The account key: kept on this device, or unlocked with the password, or created the first time.
  if (!amk && data.amkPw && pwKey) { try { amk = await unlockAccountKey(pwKey, data.amkPw); } catch { /* older password */ } }
  if (!amk && !data.amkPw && pwKey) {
    amk = await importAccountKey(newAccountKeyBytes());
    try {
      await api.put('/api/keys/account', { amkPw: await lockAccountKey(pwKey, amk) });
    } catch { // another device made one at the same moment: use that one
      try { data = await api.get('/api/keys'); amk = await unlockAccountKey(pwKey, data.amkPw); } catch { amk = null; }
    }
  }
  if (amk) { S.backupKey = amk; await saveBackupKey(S.me.id, amk); }
  S.backupOn = !!amk;
  if (!amk) return 0;

  let restored = 0;
  const done = new Set();
  for (const w of data.wraps) {
    let key = null;
    try {
      if (w.scheme === 'amk') key = await unlockTeamKey(amk, w.teamId, w.wrapped);
      else if (pwKey) key = await unlockTeamKey(pwKey, w.teamId, w.wrapped);
    } catch { /* locked with an older password */ }
    if (w.scheme === 'amk') done.add(w.teamId); // backups made the old way get moved over below
    if (key && isValidKeyFormat(key) && !storedKeys()[w.teamId]) { storeKey(w.teamId, key); restored++; }
  }
  for (const t of S.teams) {
    const key = storedKeys()[t.id];
    if (!key || done.has(t.id)) continue;
    try { if ((await importTeamKey(key)).check !== t.keyCheck) continue; } catch { continue; } // only back up the right key
    await api.put(`/api/teams/${t.id}/key-backup`, { wrapped: await lockTeamKey(amk, t.id, key), scheme: 'amk' }).catch(() => {});
  }
  return restored;
}

/**
 * Show a new recovery code once and store the account key locked with it. The password confirms it's the
 * owner; the code itself is only kept on the server as a hash (plus the locked account key).
 */
export async function setUpRecovery({ password, afterSignup = false } = {}) {
  if (!password) {
    const d = await dialog(`<h2>${S.hasRecovery ? 'Make a new recovery code' : 'Set up a recovery code'}</h2>
      <p class="muted" style="font-size:14px">${S.hasRecovery ? 'Your old code will stop working.' : 'If you ever forget your password, this code lets you set a new one and keep all your files.'}</p>
      ${field({ id: 'rp', name: 'password', type: 'password', label: 'Your password', icon: 'lock', autocomplete: 'current-password', autofocus: true })}
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn btn--primary">Continue</button></div>`);
    if (!d) return false;
    password = String(d.get('password') || '');
    try { await api.post('/api/me/verify-password', { password }); } catch (err) { toast(esc(err.message), { error: true }); return false; }
  }
  if (!S.backupKey) await syncKeys({ password });
  if (!S.backupKey || !S.keySalt) { toast('Couldn’t set up recovery right now. Try again.', { error: true }); return false; }
  const code = newRecoveryCode();
  try {
    const amkRc = await lockAccountKey(await deriveRecoveryKey(code, S.keySalt), S.backupKey);
    await api.post('/api/me/recovery', { password, code, amkRc });
  } catch (err) { toast(esc(err.message), { error: true }); return false; }
  S.hasRecovery = true;
  await showRecoveryCode(code, { afterSignup });
  return true;
}

function showRecoveryCode(code, { afterSignup }) {
  return new Promise((resolve) => {
    dalaAway(true);
    const html = `<div class="auth-wrap auth-wrap--single"><div class="auth stack" style="gap:16px">
      <a class="brand" href="#/"><img src="/icons/icon-64.png" alt="">Padala</a>
      <div class="stack" style="gap:4px"><h1>Save your recovery code</h1>
        <p class="muted" style="font-size:15px">If you ever forget your password, this code is the only way to get back into your account <b>with your files</b>. Nobody else has it, not even Padala.</p></div>
      <div class="recovery-code" data-code aria-label="Recovery code">${code.split('-').map((g) => `<span>${g}</span>`).join('')}</div>
      <div class="row" style="flex-wrap:wrap;gap:8px">
        <button class="btn btn--sm" data-copy-code>${icon.copy({ size: 14 })} Copy</button>
        <button class="btn btn--sm" data-save-code>${icon.download({ size: 14 })} Save as a file</button>
      </div>
      <div class="notice">${icon.lock({ size: 18 })}<span class="grow"><b>Keep it somewhere safe</b><span>A photo in a private album, a note in your password manager, or written on paper. You’ll see it only this once.</span></span></div>
      <label class="pick"><input type="checkbox" data-saved-it><span class="grow"><b>I saved my recovery code</b></span></label>
      <button class="btn btn--primary btn--big btn--block" data-done disabled>${afterSignup ? 'Continue' : 'Done'}</button>
    </div></div>`;
    layout(html, { sidebar: false });
    app.querySelector('[data-copy-code]').onclick = () => copyText(code);
    app.querySelector('[data-save-code]').onclick = () => {
      const blob = new Blob([`${tr(`Padala recovery code for @${S.me.username}`)}\n\n${code}\n\n${tr('Use it on the sign-in page › Forgot password? to set a new password without losing your files.')}\n`], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `padala-recovery-code-${S.me.username}.txt`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    };
    const box = app.querySelector('[data-saved-it]');
    const done = app.querySelector('[data-done]');
    box.onchange = () => { done.disabled = !box.checked; };
    done.onclick = () => resolve();
  });
}

async function changePassword() {
  const d = await dialog(`<h2>Change password</h2>
    <p class="muted" style="font-size:14px">Your files stay unlocked. Other devices will need to sign in again.</p>
    ${field({ id: 'cp-old', name: 'current', type: 'password', label: 'Current password', icon: 'lock', autocomplete: 'current-password', autofocus: true })}
    ${field({ id: 'cp-new', name: 'next', type: 'password', label: 'New password', icon: 'lock', autocomplete: 'new-password', minlength: 8, strength: true, hint: 'At least 8 characters.' })}
    <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn btn--primary">Change password</button></div>`);
  if (!d) return;
  const current = String(d.get('current') || '');
  const next = String(d.get('next') || '');
  if (next.length < 8) { toast('Use a new password of at least 8 characters.', { error: true }); return; }
  try {
    await api.post('/api/me/verify-password', { password: current });
    if (!S.backupKey) await syncKeys({ password: current });
    const amkPw = S.backupKey && S.keySalt ? await lockAccountKey(await deriveBackupKey(next, S.keySalt), S.backupKey) : undefined;
    await api.post('/api/me/password', { current, next, amkPw });
    toast('Password changed. Your other devices were signed out.');
    react('nudge', { pose: 'thumbs', html: 'New password saved. Your files are still unlocked.' });
  } catch (err) { toast(esc(err.message), { error: true }); }
}

/** Ask for the password again, then unlock (or back up) team keys on this device. */
async function confirmPassword({ reason = 'unlock' } = {}) {
  const data = await dialog(`<h2>${reason === 'backup' ? 'Turn on key backup' : 'Unlock your teams'}</h2>
    <p class="muted" style="font-size:14px">${reason === 'backup'
      ? 'Your team keys will be locked with your password and saved, so signing in on a new phone or computer unlocks your files automatically. Nobody can open them without your password.'
      : 'Enter your password to unlock your teams’ files on this device.'}</p>
    ${field({ id: 'cp', name: 'password', type: 'password', label: 'Password', icon: 'lock', autocomplete: 'current-password', autofocus: true })}
    <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn btn--primary">Continue</button></div>`);
  if (!data) return false;
  const password = String(data.get('password') || '');
  try {
    await api.post('/api/me/verify-password', { password });
    const restored = await syncKeys({ password });
    await activateTeam(S.teams.find((t) => t.id === S.team?.id) || S.teams[0]);
    route();
    toast(S.keyMissing ? 'Password confirmed. This team’s key hasn’t been backed up yet: open Padala once on the device that has it.'
      : restored ? 'Your teams are unlocked on this device.' : 'Key backup is on.');
    return true;
  } catch (err) { toast(esc(err.message), { error: true }); return false; }
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-confirm-password]');
  if (!b) return;
  e.preventDefault();
  confirmPassword({ reason: b.dataset.confirmPassword });
});
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-check-keys]');
  if (!b) return;
  e.preventDefault();
  await withLoading(b, async () => { await syncKeys(); await activateTeam(S.team); });
  if (S.keyMissing) toast('Still no key for this team. Open Padala on the device that created or joined it, then try again.', { error: true });
  else { toast('Unlocked.'); route(); }
});

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-go-storage]')) S.goStorage = true;
  if (e.target.closest('[data-setup-recovery]')) { e.preventDefault(); setUpRecovery().then((ok) => { if (ok) route(); }); }
  if (e.target.closest('[data-change-password]')) { e.preventDefault(); changePassword(); }
});

/** On a device that has keys but never turned on backup (signed in before backups existed). */
export function backupBanner() {
  if (S.backupOn && !S.hasRecovery && !S.keyMissing) {
    return `<div class="notice">${icon.key({ size: 18 })}<span class="grow"><b>Set up a recovery code</b><span>So a forgotten password never means losing your account and files.</span></span>
      <button class="btn btn--sm btn--primary" data-setup-recovery>Set up</button></div>`;
  }
  if (S.backupOn || S.keyMissing || !S.teams.some((t) => storedKeys()[t.id])) return '';
  return `<div class="notice">${icon.shield({ size: 18 })}<span class="grow"><b>Back up your team keys</b><span>So your phone and other devices unlock your files automatically when you sign in.</span></span>
    <button class="btn btn--sm btn--primary" data-confirm-password="backup">Turn on</button></div>`;
}

export async function loadProjects() {
  if (!S.team) return;
  S.projects = (await api.get(`/api/teams/${S.team.id}/projects`)).projects;
}

/** A person's avatar: their photo if they set one, otherwise their initials. `extra` goes inside (a presence dot). */
export function avatarHtml(user, cls = '', extra = '') {
  const photo = user?.avatarV ? `<img class="avatar-img" src="/api/users/${Number(user.id)}/avatar?v=${Number(user.avatarV)}" alt="" loading="lazy">` : '';
  return `<span class="avatar ${cls} ${photo ? 'has-photo' : ''}">${photo || esc(initials(user?.name || '?'))}${extra}</span>`;
}
const memberById = (id) => (id === S.me?.id ? S.me : S.team?.members.find((m) => m.id === id));

export const memberName = (id) => {
  if (id === S.me?.id) return 'You';
  return S.team?.members.find((m) => m.id === id)?.name || 'Someone';
};
export const partners = () => (S.team?.members || []).filter((m) => m.id !== S.me.id);
const partnerOnline = () => partners().some((m) => S.online.has(m.id));
