// Passwords (scrypt), sessions and sign-in throttling.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { fail } from './http.js';

const scrypt = promisify(crypto.scrypt);
const SESSION_DAYS = 30;
const LOCK_WINDOW = 5 * 60 * 1000;
const MAX_PER_USER = 5;
const MAX_PER_IP = 20;

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [alg, saltB64, keyB64] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(key, expected);
}

// A fixed hash so unknown usernames take as long as wrong passwords (no username probing by timing).
let dummyHash = null;
const getDummy = async () => (dummyHash ??= await hashPassword(randomToken()));

export function createSession(db, userId) {
  const token = randomToken();
  const now = Date.now();
  db.run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    sha256(token), userId, now, now + SESSION_DAYS * 86400000);
  return { token, maxAge: SESSION_DAYS * 86400 };
}

export function userFromToken(db, token) {
  if (!token) return null;
  const row = db.get(`SELECT u.id, u.username, u.name, u.avatar_v, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
                      WHERE s.token_hash = ?`, sha256(token));
  if (!row || row.expires_at < Date.now()) return null;
  return { id: row.id, username: row.username, name: row.name, avatarV: row.avatar_v || null };
}

export function destroySession(db, token) {
  if (token) db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
}

export async function checkLogin(db, username, password, ip) {
  const now = Date.now();
  const since = now - LOCK_WINDOW;
  const byUser = db.get('SELECT COUNT(*) AS n, MAX(at) AS latest FROM login_attempts WHERE username = ? AND at > ?', username, since);
  const byIp = db.get('SELECT COUNT(*) AS n, MAX(at) AS latest FROM login_attempts WHERE ip = ? AND at > ?', ip, since);
  if (byUser.n >= MAX_PER_USER || byIp.n >= MAX_PER_IP) {
    const latest = Math.max(byUser.latest || 0, byIp.latest || 0);
    const mins = Math.max(1, Math.ceil((latest + LOCK_WINDOW - now) / 60000));
    fail(429, `Too many failed attempts. Try again in ${mins} minute${mins > 1 ? 's' : ''}.`);
  }
  const user = db.get('SELECT id, username, name, pass_hash FROM users WHERE username = ?', username);
  const ok = await verifyPassword(password, user ? user.pass_hash : await getDummy());
  if (!user || !ok) {
    db.run('INSERT INTO login_attempts (username, ip, at) VALUES (?, ?, ?)', username, ip, now);
    db.run('DELETE FROM login_attempts WHERE at < ?', now - 86400000);
    fail(401, "That username and password don't match.");
  }
  db.run('DELETE FROM login_attempts WHERE username = ?', username);
  return { id: user.id, username: user.username, name: user.name };
}

/**
 * Check a recovery code (hashed like a password), with the same throttling as sign-in.
 * Returns the user row, or fails with 401/429.
 */
export async function checkRecovery(db, username, code, ip) {
  const key = `recovery:${username}`;
  const now = Date.now();
  const since = now - LOCK_WINDOW;
  const byUser = db.get('SELECT COUNT(*) AS n, MAX(at) AS latest FROM login_attempts WHERE username = ? AND at > ?', key, since);
  const byIp = db.get('SELECT COUNT(*) AS n, MAX(at) AS latest FROM login_attempts WHERE ip = ? AND at > ?', ip, since);
  if (byUser.n >= MAX_PER_USER || byIp.n >= MAX_PER_IP) {
    const latest = Math.max(byUser.latest || 0, byIp.latest || 0);
    const mins = Math.max(1, Math.ceil((latest + LOCK_WINDOW - now) / 60000));
    fail(429, `Too many tries. Try again in ${mins} minute${mins > 1 ? 's' : ''}.`);
  }
  const user = db.get('SELECT id, username, name, recovery_hash, wrap_salt, amk_rc FROM users WHERE username = ?', username);
  const ok = await verifyPassword(code, user?.recovery_hash || await getDummy());
  if (!user || !user.recovery_hash || !ok) {
    db.run('INSERT INTO login_attempts (username, ip, at) VALUES (?, ?, ?)', key, ip, now);
    fail(401, "That username and recovery code don't match.");
  }
  db.run('DELETE FROM login_attempts WHERE username = ?', key);
  return user;
}
