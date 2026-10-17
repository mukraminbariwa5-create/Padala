// Team key backup and account recovery.
//
//   team keys ──locked with──▶ account key ──locked with──▶ password key   (made from the password)
//                                          └─locked with──▶ recovery key   (made from the recovery code)
//
// Only locked copies are stored on the server. Signing in on a new device unlocks the account key with the
// password, and through it every team. Changing the password re-locks just the account key. If the
// password is forgotten, the recovery code opens the account key instead. The password and recovery code
// are turned into keys here, on the device (PBKDF2); the account key is kept on this device between visits.
// (Older backups locked team keys with the password key directly; they're moved over at the next sign-in.)

const ITERATIONS = 310000;
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

export async function deriveBackupKey(password, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(`padala-key-backup:${salt}`), iterations: ITERATIONS },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

export async function deriveRecoveryKey(code, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(normalizeRecoveryCode(code)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(`padala-recovery:${salt}`), iterations: 100000 },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

// ---- the account key (random, 32 bytes). Kept exportable so it can be re-locked (new password or code).
export const newAccountKeyBytes = () => crypto.getRandomValues(new Uint8Array(32));
export const importAccountKey = (bytes) => crypto.subtle.importKey('raw', bytes, 'AES-GCM', true, ['encrypt', 'decrypt']);
export const accountKeyBytes = async (key) => new Uint8Array(await crypto.subtle.exportKey('raw', key));

async function lockBytes(key, label, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(label) }, key, bytes));
  const out = new Uint8Array(12 + sealed.length);
  out.set(iv);
  out.set(sealed, 12);
  return b64(out);
}
async function unlockBytes(key, label, wrapped) {
  const bytes = unb64(wrapped);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: enc.encode(label) }, key, bytes.subarray(12)));
}
export const lockAccountKey = async (withKey, accountKey) => lockBytes(withKey, 'account', await accountKeyBytes(accountKey));
export const unlockAccountKey = async (withKey, wrapped) => importAccountKey(await unlockBytes(withKey, 'account', wrapped));

// ---- recovery codes: 24 characters, easy to read and type (no 0/O, 1/I/L)
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export function newRecoveryCode() {
  let chars = '';
  while (chars.length < 24) {
    for (const b of crypto.getRandomValues(new Uint8Array(32))) {
      if (b < 248 && chars.length < 24) chars += ALPHABET[b % 31]; // 248 = 31 × 8: every character equally likely
    }
  }
  return chars.match(/.{4}/g).join('-');
}
export const normalizeRecoveryCode = (code) => String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');

export async function lockTeamKey(backupKey, teamId, teamKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(`team:${teamId}`) }, backupKey, enc.encode(teamKey)));
  const out = new Uint8Array(12 + sealed.length);
  out.set(iv);
  out.set(sealed, 12);
  return b64(out);
}

export async function unlockTeamKey(backupKey, teamId, wrapped) {
  const bytes = unb64(wrapped);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: enc.encode(`team:${teamId}`) }, backupKey, bytes.subarray(12));
  return dec.decode(plain);
}

// ---- keep the password-made key on this device (IndexedDB can hold non-exportable keys)
const DB = 'padala-keyring';
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('keys');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function tx(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('keys', mode);
    const req = fn(t.objectStore('keys'));
    t.oncomplete = () => { db.close(); resolve(req?.result); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}
export const saveBackupKey = (userId, key) => tx('readwrite', (s) => s.put(key, `user:${userId}`)).catch(() => {});
export const loadBackupKey = (userId) => tx('readonly', (s) => s.get(`user:${userId}`)).catch(() => null);
export const forgetBackupKey = (userId) => tx('readwrite', (s) => s.delete(`user:${userId}`)).catch(() => {});
