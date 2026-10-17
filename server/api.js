// JSON API. Every route that touches a team checks that the signed-in user belongs to it.
import { Router, fail, readJson, readBody, sendJson, cookie, str, int } from './http.js';
import { hashPassword, checkLogin, checkRecovery, createSession, destroySession, randomToken, sha256 } from './auth.js';
import { BLOB_ID } from './storage.js';
import { sendPush } from './push.js';

const STATUSES = ['building', 'sent', 'handed_over', 'paid'];
const USERNAME = /^[a-z0-9._-]{3,32}$/;
const KEY_CHECK = /^[A-Za-z0-9_-]{20,64}$/;
const CIPHERTEXT = /^[A-Za-z0-9_-]+$/;
const INVITE_DAYS = 7;
export const CHUNK_BYTES = 512 * 1024;              // plaintext bytes per piece
const CHUNK_LIMIT = CHUNK_BYTES + 1024;             // + encryption overhead

export function buildApi({ db, store, hub, config, vapid }) {
  const r = new Router();

  // ---------- helpers ----------
  const now = () => Date.now();
  const needUser = (ctx) => ctx.user || fail(401, 'Please sign in.');
  const member = (userId, teamId) =>
    db.get('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?', teamId, userId);
  const needMember = (ctx, teamId) => {
    const user = needUser(ctx);
    const tid = int(teamId, 'Team');
    const m = member(user.id, tid);
    if (!m) fail(404, 'Team not found.');
    return { user, teamId: tid, role: m.role };
  };
  const needProject = (ctx, projectId) => {
    const user = needUser(ctx);
    const p = db.get('SELECT * FROM projects WHERE id = ?', int(projectId, 'Project'));
    if (!p || !member(user.id, p.team_id)) fail(404, 'Project not found.');
    return { user, project: p };
  };
  const cipher = (v, label, max) => {
    if (typeof v !== 'string' || !v || v.length > max || !CIPHERTEXT.test(v)) fail(422, `${label} is missing or too long.`);
    return v;
  };
  const msgOut = (m) => ({
    id: m.id, projectId: m.project_id, userId: m.user_id, kind: m.kind, body: m.deleted_at ? null : m.body,
    meta: m.meta ? JSON.parse(m.meta) : null, createdAt: m.created_at,
    replyTo: m.reply_to || null, deleted: !!m.deleted_at,
  });
  const versionOut = (v) => ({
    id: v.id, projectId: v.project_id, number: v.number, manifest: v.manifest, note: v.note,
    fileCount: v.file_count, totalBytes: v.total_bytes, sentBytes: v.sent_bytes, changedCount: v.changed_count,
    createdBy: v.created_by, createdAt: v.created_at,
    downloadedBy: db.all('SELECT user_id, at FROM downloads WHERE version_id = ?', v.id).map((d) => ({ userId: d.user_id, at: d.at })),
  });
  const projectOut = (p, userId) => {
    const latest = db.get('SELECT id, number, created_at, created_by FROM versions WHERE project_id = ? ORDER BY number DESC LIMIT 1', p.id);
    const last = db.get('SELECT * FROM messages WHERE project_id = ? ORDER BY id DESC LIMIT 1', p.id);
    const read = db.get('SELECT last_id FROM reads WHERE project_id = ? AND user_id = ?', p.id, userId);
    const unread = db.get('SELECT COUNT(*) AS n FROM messages WHERE project_id = ? AND id > ? AND (user_id IS NULL OR user_id <> ?)',
      p.id, read ? read.last_id : 0, userId).n;
    return {
      id: p.id, teamId: p.team_id, name: p.name, status: p.status, createdAt: p.created_at, updatedAt: p.updated_at,
      latestVersion: latest ? latest.number : 0,
      latest: latest ? {
        id: latest.id, number: latest.number, by: latest.created_by, at: latest.created_at,
        downloadedBy: db.all('SELECT user_id FROM downloads WHERE version_id = ?', latest.id).map((d) => d.user_id),
      } : null,
      lastMessage: last ? msgOut(last) : null, unread,
    };
  };
  const addMessage = (projectId, userId, kind, body = null, meta = null) => {
    const t = now();
    const res = db.run('INSERT INTO messages (project_id, user_id, kind, body, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      projectId, userId, kind, body, meta ? JSON.stringify(meta) : null, t);
    db.run('UPDATE projects SET updated_at = ? WHERE id = ?', t, projectId);
    if (userId) markRead(projectId, userId, Number(res.lastInsertRowid));
    return msgOut(db.get('SELECT * FROM messages WHERE id = ?', res.lastInsertRowid));
  };
  const markRead = (projectId, userId, lastId) => {
    db.run(`INSERT INTO reads (project_id, user_id, last_id) VALUES (?, ?, ?)
            ON CONFLICT (project_id, user_id) DO UPDATE SET last_id = MAX(last_id, excluded.last_id)`, projectId, userId, lastId);
  };
  const broadcastMessage = (project, message) => hub.toTeam(project.team_id, 'message', { projectId: project.id, message });

  // ---------- notifications when the app is closed ----------
  // Only real push services: the server sends to whatever address a device gives, so nothing else is allowed.
  const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /(^|\.)push\.apple\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];
  const pushFetch = config.pushFetch || ((...a) => fetch(...a));
  /** Tell everyone else in the team (on devices with notifications on). Never slows down or breaks the request. */
  const notifyTeam = (teamId, exceptUserId, message) => {
    if (!vapid) return;
    const subs = db.all(`SELECT s.* FROM push_subs s JOIN team_members m ON m.user_id = s.user_id
                         WHERE m.team_id = ? AND s.user_id <> ?`, teamId, exceptUserId);
    for (const sub of subs) {
      sendPush({ sub, message: typeof message === 'function' ? message(sub.lang === 'fil' ? 'fil' : 'en') : message, vapid, fetchImpl: pushFetch }).then((r) => {
        if (r === 'gone') db.run('DELETE FROM push_subs WHERE endpoint = ?', sub.endpoint);
      });
    }
  };
  const broadcastProject = (projectId) => {
    const p = db.get('SELECT * FROM projects WHERE id = ?', projectId);
    hub.toTeam(p.team_id, 'project', { project: { id: p.id, name: p.name, status: p.status, updatedAt: p.updated_at } });
  };
  const teamOut = (teamId, role) => {
    const t = db.get('SELECT id, name, key_check, keep_versions FROM teams WHERE id = ?', teamId);
    return {
      id: t.id, name: t.name, role, keyCheck: t.key_check, keepVersions: t.keep_versions || null,
      members: db.all(`SELECT u.id, u.username, u.name, m.role, u.avatar_v AS avatarV FROM team_members m JOIN users u ON u.id = m.user_id
                       WHERE m.team_id = ? ORDER BY m.joined_at`, teamId),
    };
  };
  const signIn = (ctx, user) => {
    const { token, maxAge } = createSession(db, user.id);
    ctx.setCookie(cookie('padala_session', token, { maxAge, secure: config.secureCookies }));
    return user;
  };

  // ---------- accounts ----------
  r.get('/api/health', () => ({ ok: true }));
  // The address other devices should use (set by `npm run share` or PUBLIC_URL when hosted).
  r.get('/api/config', () => ({ publicUrl: config.publicUrl || null }));

  r.post('/api/signup', async (ctx) => {
    const b = await readJson(ctx.req);
    const username = str(b.username, 'Username', { max: 32 }).toLowerCase();
    if (!USERNAME.test(username)) fail(422, 'Username must be 3–32 characters: letters, numbers, dots, dashes or underscores.');
    const name = str(b.name, 'Your name', { max: 60 });
    const password = typeof b.password === 'string' ? b.password : '';
    if (password.length < 8) fail(422, 'Use a password of at least 8 characters.');
    if (password.length > 128) fail(422, 'Passwords can be at most 128 characters.');
    if (db.get('SELECT 1 FROM users WHERE username = ?', username)) fail(409, 'That username is taken.');
    const res = db.run('INSERT INTO users (username, name, pass_hash, created_at) VALUES (?, ?, ?, ?)',
      username, name, await hashPassword(password), now());
    return { user: signIn(ctx, { id: Number(res.lastInsertRowid), username, name }) };
  });

  r.post('/api/login', async (ctx) => {
    const b = await readJson(ctx.req);
    const username = String(b.username || '').trim().toLowerCase().slice(0, 32);
    const password = String(b.password || '').slice(0, 128);
    if (!username || !password) fail(422, 'Enter your username and password.');
    const user = await checkLogin(db, username, password, ctx.ip);
    return { user: signIn(ctx, user) };
  });

  // Confirm the password again (used to turn on key backup on a device that's already signed in).
  r.post('/api/me/verify-password', async (ctx) => {
    const user = needUser(ctx);
    const b = await readJson(ctx.req);
    await checkLogin(db, user.username, String(b.password || '').slice(0, 128), ctx.ip);
    return { ok: true };
  });

  r.get('/api/push/key', () => ({ publicKey: vapid?.publicKey || null }));

  r.post('/api/push/subscribe', async (ctx) => {
    const user = needUser(ctx);
    const b = await readJson(ctx.req);
    let host = '';
    try { const u = new URL(String(b.endpoint || '')); if (u.protocol === 'https:') host = u.hostname; } catch { /* invalid */ }
    if (!host || !PUSH_HOSTS.some((re) => re.test(host)) || String(b.endpoint).length > 1000) fail(422, 'Notifications aren’t supported in this browser.');
    const p256dh = str(b.keys?.p256dh, 'Key', { max: 200 });
    const auth = str(b.keys?.auth, 'Key', { max: 100 });
    const lang = b.lang === 'fil' ? 'fil' : 'en';
    db.run(`INSERT INTO push_subs (endpoint, user_id, p256dh, auth, created_at, lang) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, lang = excluded.lang`,
    String(b.endpoint), user.id, p256dh, auth, now(), lang);
    return { ok: true };
  });

  r.post('/api/push/unsubscribe', async (ctx) => {
    const user = needUser(ctx);
    const b = await readJson(ctx.req);
    db.run('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?', String(b.endpoint || ''), user.id);
    return { ok: true };
  });

  // ---------- team key backup ----------
  // Only locked copies are stored: the lock is made from the person's password on their own device.
  r.get('/api/keys', (ctx) => {
    const user = needUser(ctx);
    let salt = db.get('SELECT wrap_salt FROM users WHERE id = ?', user.id).wrap_salt;
    if (!salt) {
      salt = randomToken(16);
      db.run('UPDATE users SET wrap_salt = ? WHERE id = ? AND wrap_salt IS NULL', salt, user.id);
      salt = db.get('SELECT wrap_salt FROM users WHERE id = ?', user.id).wrap_salt;
    }
    const wraps = db.all(`SELECT k.team_id AS teamId, k.wrapped, k.scheme FROM key_wraps k
      JOIN team_members m ON m.team_id = k.team_id AND m.user_id = k.user_id WHERE k.user_id = ?`, user.id);
    const u = db.get('SELECT amk_pw, recovery_hash FROM users WHERE id = ?', user.id);
    return { salt, amkPw: u.amk_pw || null, hasRecovery: !!u.recovery_hash, wraps };
  });

  const lockedValue = (v, label) => {
    const out = str(v, label, { max: 400 });
    if (!/^[A-Za-z0-9_-]+$/.test(out)) fail(422, `${label} is not valid.`);
    return out;
  };

  // First time only: store the account key (locked with the password). Changing it needs the password.
  r.put('/api/keys/account', async (ctx) => {
    const user = needUser(ctx);
    const b = await readJson(ctx.req);
    const amkPw = lockedValue(b.amkPw, 'Account key');
    const res = db.run('UPDATE users SET amk_pw = ? WHERE id = ? AND amk_pw IS NULL', amkPw, user.id);
    if (!res.changes) fail(409, 'This account already has a key backup.');
    return { ok: true };
  });

  // Set up (or replace) the recovery code: confirm the password; store the account key locked with the code.
  r.post('/api/me/recovery', async (ctx) => {
    const user = needUser(ctx);
    const b = await readJson(ctx.req);
    await checkLogin(db, user.username, String(b.password || '').slice(0, 128), ctx.ip);
    const code = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 20) fail(422, 'That recovery code is not valid.');
    db.run('UPDATE users SET amk_rc = ?, recovery_hash = ? WHERE id = ?', lockedValue(b.amkRc, 'Recovery key'), await hashPassword(code), user.id);
    return { ok: true };
  });

  // Change password: the device re-locks the account key with the new password; other devices are signed out.
  r.post('/api/me/password', async (ctx) => {
    const user = needUser(ctx);
    const b = await readJson(ctx.req);
    await checkLogin(db, user.username, String(b.current || '').slice(0, 128), ctx.ip);
    const next = typeof b.next === 'string' ? b.next : '';
    if (next.length < 8) fail(422, 'Use a new password of at least 8 characters.');
    if (next.length > 128) fail(422, 'Passwords can be at most 128 characters.');
    const amkPw = b.amkPw ? lockedValue(b.amkPw, 'Account key') : null;
    const passHash = await hashPassword(next);
    db.tx(() => {
      db.run('UPDATE users SET pass_hash = ?, amk_pw = COALESCE(?, amk_pw) WHERE id = ?', passHash, amkPw, user.id);
      db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', user.id, sha256(ctx.sessionToken || ''));
    });
    return { ok: true };
  });

  // Forgot password, step 1: username + recovery code -> the locked account key (only the code can open it).
  const resets = new Map(); // token -> { userId, expires }
  r.post('/api/recovery/start', async (ctx) => {
    const b = await readJson(ctx.req);
    const username = String(b.username || '').trim().toLowerCase().slice(0, 32);
    const code = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 64);
    if (!username || !code) fail(422, 'Enter your username and recovery code.');
    const user = await checkRecovery(db, username, code, ctx.ip);
    const token = randomToken(24);
    for (const [k, v] of resets) if (v.expires < Date.now()) resets.delete(k);
    resets.set(token, { userId: user.id, expires: Date.now() + 10 * 60000 });
    return { token, salt: user.wrap_salt, amkRc: user.amk_rc };
  });

  // Forgot password, step 2: set the new password (and the account key re-locked with it), then sign in.
  r.post('/api/recovery/finish', async (ctx) => {
    const b = await readJson(ctx.req);
    const reset = resets.get(String(b.token || ''));
    if (!reset || reset.expires < Date.now()) fail(410, 'This reset has expired. Start again.');
    const password = typeof b.password === 'string' ? b.password : '';
    if (password.length < 8) fail(422, 'Use a password of at least 8 characters.');
    if (password.length > 128) fail(422, 'Passwords can be at most 128 characters.');
    const amkPw = b.amkPw ? lockedValue(b.amkPw, 'Account key') : null;
    resets.delete(String(b.token));
    db.run('UPDATE users SET pass_hash = ?, amk_pw = COALESCE(?, amk_pw) WHERE id = ?', await hashPassword(password), amkPw, reset.userId);
    db.run('DELETE FROM sessions WHERE user_id = ?', reset.userId);
    const user = db.get('SELECT id, username, name FROM users WHERE id = ?', reset.userId);
    return { user: signIn(ctx, user) };
  });

  r.put('/api/teams/:tid/key-backup', async (ctx, p) => {
    const { user, teamId } = needMember(ctx, p.tid);
    const b = await readJson(ctx.req);
    const wrapped = str(b.wrapped, 'Key backup', { max: 400 });
    if (!/^[A-Za-z0-9_-]+$/.test(wrapped)) fail(422, 'That key backup is not valid.');
    const scheme = b.scheme === 'amk' ? 'amk' : 'pw';
    db.run(`INSERT INTO key_wraps (user_id, team_id, wrapped, scheme, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, team_id) DO UPDATE SET wrapped = excluded.wrapped, scheme = excluded.scheme, updated_at = excluded.updated_at`, user.id, teamId, wrapped, scheme, now());
    return { ok: true };
  });

  r.post('/api/logout', (ctx) => {
    destroySession(db, ctx.sessionToken);
    ctx.setCookie(cookie('padala_session', '', { maxAge: 0, secure: config.secureCookies }));
    return { ok: true };
  });

  // ---------- profile photo ----------
  const IMAGE_TYPES = { webp: 'image/webp', jpeg: 'image/jpeg', png: 'image/png' };
  const sniffImage = (buf) => {
    if (buf.length > 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'webp';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
    if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
    return null;
  };
  r.put('/api/me/avatar', async (ctx) => {
    const user = needUser(ctx);
    const buf = await readBody(ctx.req, 300 * 1024);
    const kind = sniffImage(buf);
    if (!kind) fail(422, 'Use a JPG, PNG or WebP picture.');
    const v = now();
    db.run('UPDATE users SET avatar = ?, avatar_type = ?, avatar_v = ? WHERE id = ?', buf, IMAGE_TYPES[kind], v, user.id);
    for (const t of db.all('SELECT team_id FROM team_members WHERE user_id = ?', user.id)) {
      hub.toTeam(t.team_id, 'team', { team: teamOut(t.team_id, 'member') });
    }
    return { avatarV: v };
  });
  r.delete('/api/me/avatar', (ctx) => {
    const user = needUser(ctx);
    db.run('UPDATE users SET avatar = NULL, avatar_type = NULL, avatar_v = NULL WHERE id = ?', user.id);
    for (const t of db.all('SELECT team_id FROM team_members WHERE user_id = ?', user.id)) {
      hub.toTeam(t.team_id, 'team', { team: teamOut(t.team_id, 'member') });
    }
    return { ok: true };
  });
  // Only yourself and people you share a team with can see your photo.
  r.get('/api/users/:uid/avatar', (ctx, p) => {
    const user = needUser(ctx);
    const uid = int(p.uid, 'User');
    const shares = uid === user.id || db.get(`SELECT 1 FROM team_members a JOIN team_members b ON a.team_id = b.team_id
                                               WHERE a.user_id = ? AND b.user_id = ? LIMIT 1`, user.id, uid);
    const row = shares && db.get('SELECT avatar, avatar_type FROM users WHERE id = ?', uid);
    if (!row?.avatar) fail(404, 'No photo.');
    ctx.res.writeHead(200, { 'Content-Type': row.avatar_type, 'Cache-Control': 'private, max-age=31536000, immutable', 'Content-Length': row.avatar.length });
    ctx.res.end(Buffer.from(row.avatar));
    return undefined;
  });

  r.get('/api/me', (ctx) => {
    const user = needUser(ctx);
    const teams = db.all('SELECT team_id, role FROM team_members WHERE user_id = ? ORDER BY joined_at', user.id)
      .map((m) => teamOut(m.team_id, m.role));
    return { user, teams, online: hub.onlineIn(teams.map((t) => t.id)) };
  });

  // ---------- teams & invites ----------
  r.post('/api/teams', async (ctx) => {
    const user = needUser(ctx);
    const b = await readJson(ctx.req);
    const name = str(b.name, 'Team name', { max: 60 });
    const keyCheck = String(b.keyCheck || '');
    if (!KEY_CHECK.test(keyCheck)) fail(422, 'Missing team key check.');
    const teamId = db.tx(() => {
      const res = db.run('INSERT INTO teams (name, key_check, created_by, created_at) VALUES (?, ?, ?, ?)', name, keyCheck, user.id, now());
      const id = Number(res.lastInsertRowid);
      db.run("INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)", id, user.id, now());
      return id;
    });
    hub.addTeam(user.id, teamId);
    return { team: teamOut(teamId, 'owner') };
  });

  r.post('/api/teams/:tid/invites', (ctx, p) => {
    const { user, teamId } = needMember(ctx, p.tid);
    const token = randomToken(18);
    const expiresAt = now() + INVITE_DAYS * 86400000;
    db.run('INSERT INTO invites (token_hash, team_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      sha256(token), teamId, user.id, now(), expiresAt);
    return { token, expiresAt };
  });

  const findInvite = (token) => db.get(`SELECT i.*, t.name AS team_name, u.name AS inviter FROM invites i
    JOIN teams t ON t.id = i.team_id JOIN users u ON u.id = i.created_by WHERE i.token_hash = ?`, sha256(String(token)));

  r.get('/api/invites/:token', (ctx, p) => {
    const inv = findInvite(p.token);
    if (!inv) fail(404, 'This invite link is not valid.');
    return {
      team: { id: inv.team_id, name: inv.team_name }, invitedBy: inv.inviter,
      expired: inv.expires_at < now(), used: !!inv.used_by,
      alreadyMember: !!(ctx.user && member(ctx.user.id, inv.team_id)),
    };
  });

  r.post('/api/invites/:token/accept', (ctx, p) => {
    const user = needUser(ctx);
    const inv = findInvite(p.token);
    if (!inv) fail(404, 'This invite link is not valid.');
    if (member(user.id, inv.team_id)) return { team: teamOut(inv.team_id, member(user.id, inv.team_id).role) };
    if (inv.used_by) fail(410, 'This invite link was already used. Ask for a new one.');
    if (inv.expires_at < now()) fail(410, 'This invite link has expired. Ask for a new one.');
    db.tx(() => {
      db.run('UPDATE invites SET used_by = ? WHERE token_hash = ?', user.id, inv.token_hash);
      db.run("INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)", inv.team_id, user.id, now());
    });
    hub.addTeam(user.id, inv.team_id);
    hub.toTeam(inv.team_id, 'team', { team: teamOut(inv.team_id, 'member') });
    return { team: teamOut(inv.team_id, 'member') };
  });

  r.patch('/api/teams/:tid', async (ctx, p) => {
    const { teamId } = needMember(ctx, p.tid);
    const b = await readJson(ctx.req);
    if (b.name !== undefined) db.run('UPDATE teams SET name = ? WHERE id = ?', str(b.name, 'Team name', { max: 60 }), teamId);
    let cleared = { removed: 0, freedBytes: 0 };
    if (b.keepVersions !== undefined) {
      const keep = b.keepVersions === null ? null : int(b.keepVersions, 'Versions to keep');
      if (keep !== null && (keep < 1 || keep > 1000)) fail(422, 'Keep between 1 and 1000 versions.');
      db.run('UPDATE teams SET keep_versions = ? WHERE id = ?', keep, teamId);
      if (keep) {
        for (const pr of db.all('SELECT * FROM projects WHERE team_id = ?', teamId)) {
          const r2 = pruneProject(pr, keep);
          cleared.removed += r2.removed.length;
          cleared.freedBytes += r2.freedBytes;
        }
      }
    }
    const team = teamOut(teamId, member(ctx.user.id, teamId).role);
    hub.toTeam(teamId, 'team', { team });
    return { team, cleared };
  });

  r.post('/api/teams/:tid/leave', (ctx, p) => {
    const { user, teamId, role } = needMember(ctx, p.tid);
    const others = db.all('SELECT user_id FROM team_members WHERE team_id = ? AND user_id <> ? ORDER BY joined_at', teamId, user.id);
    if (!others.length) {
      // Last person out: the team and everything in it is removed.
      db.run('DELETE FROM teams WHERE id = ?', teamId);
      store.removeTeam(teamId);
      hub.dropTeam(teamId);
      return { ok: true, deletedTeam: true };
    }
    db.tx(() => {
      db.run('DELETE FROM team_members WHERE team_id = ? AND user_id = ?', teamId, user.id);
      db.run('DELETE FROM key_wraps WHERE team_id = ? AND user_id = ?', teamId, user.id);
      if (role === 'owner') db.run("UPDATE team_members SET role = 'owner' WHERE team_id = ? AND user_id = ?", teamId, others[0].user_id);
    });
    hub.dropTeam(teamId, user.id);
    hub.toTeam(teamId, 'team', { team: teamOut(teamId, 'member') });
    return { ok: true, deletedTeam: false };
  });

  // ---------- projects ----------
  r.get('/api/teams/:tid/projects', (ctx, p) => {
    const { user, teamId } = needMember(ctx, p.tid);
    return { projects: db.all('SELECT * FROM projects WHERE team_id = ? ORDER BY updated_at DESC', teamId).map((x) => projectOut(x, user.id)) };
  });

  r.post('/api/teams/:tid/projects', async (ctx, p) => {
    const { user, teamId } = needMember(ctx, p.tid);
    const b = await readJson(ctx.req);
    const name = str(b.name, 'Project name', { max: 80 });
    if (db.get('SELECT 1 FROM projects WHERE team_id = ? AND name = ? COLLATE NOCASE', teamId, name)) fail(409, 'Your team already has a project with that name.');
    const t = now();
    const res = db.run('INSERT INTO projects (team_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', teamId, name, user.id, t, t);
    const project = db.get('SELECT * FROM projects WHERE id = ?', res.lastInsertRowid);
    const message = addMessage(project.id, user.id, 'created', null, { name });
    broadcastProject(project.id);
    broadcastMessage(project, message);
    return { project: projectOut(project, user.id) };
  });

  r.get('/api/projects/:pid', (ctx, p, url) => {
    const { user, project } = needProject(ctx, p.pid);
    const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
    const messages = db.all('SELECT * FROM messages WHERE project_id = ? AND id < ? ORDER BY id DESC LIMIT 100', project.id, before)
      .reverse().map(msgOut);
    return {
      project: projectOut(project, user.id),
      versions: db.all('SELECT * FROM versions WHERE project_id = ? ORDER BY number', project.id).map(versionOut),
      messages,
      hasMore: messages.length === 100,
    };
  });

  r.patch('/api/projects/:pid', async (ctx, p) => {
    const { user, project } = needProject(ctx, p.pid);
    const b = await readJson(ctx.req);
    if (b.name !== undefined) {
      const name = str(b.name, 'Project name', { max: 80 });
      if (db.get('SELECT 1 FROM projects WHERE team_id = ? AND name = ? COLLATE NOCASE AND id <> ?', project.team_id, name, project.id)) {
        fail(409, 'Your team already has a project with that name.');
      }
      db.run('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?', name, now(), project.id);
    }
    if (b.status !== undefined) {
      if (!STATUSES.includes(b.status)) fail(422, 'Unknown status.');
      if (b.status !== project.status) {
        db.run('UPDATE projects SET status = ? WHERE id = ?', b.status, project.id);
        broadcastMessage(project, addMessage(project.id, user.id, 'status', null, { from: project.status, to: b.status }));
      }
    }
    broadcastProject(project.id);
    return { project: projectOut(db.get('SELECT * FROM projects WHERE id = ?', project.id), user.id) };
  });

  /** Remove stored files that no remaining version in the team uses (file contents and file lists). */
  const freeUnused = (teamId, candidates) => {
    const out = [];
    for (const id of new Set(candidates)) {
      const used = db.get(`SELECT 1 FROM version_blobs vb JOIN versions v ON v.id = vb.version_id JOIN projects pr ON pr.id = v.project_id
                           WHERE vb.blob_id = ? AND pr.team_id = ? LIMIT 1`, id, teamId)
        || db.get('SELECT 1 FROM versions v JOIN projects pr ON pr.id = v.project_id WHERE v.manifest = ? AND pr.team_id = ? LIMIT 1', id, teamId);
      if (used) continue;
      const row = db.get('SELECT size FROM blobs WHERE team_id = ? AND id = ?', teamId, id);
      db.run('DELETE FROM blobs WHERE team_id = ? AND id = ?', teamId, id);
      out.push({ id, size: row?.size || 0 });
    }
    return out;
  };

  /** Keep only the newest `keep` versions of a project; returns { removed, freedBytes }. */
  const pruneProject = (project, keep) => {
    if (!keep || keep < 1) return { removed: [], freedBytes: 0 };
    const old = db.all('SELECT id, number, manifest FROM versions WHERE project_id = ? ORDER BY number DESC LIMIT -1 OFFSET ?', project.id, keep);
    if (!old.length) return { removed: [], freedBytes: 0 };
    const freed = db.tx(() => {
      const candidates = [];
      for (const v of old) {
        candidates.push(v.manifest, ...db.all('SELECT blob_id FROM version_blobs WHERE version_id = ?', v.id).map((r) => r.blob_id));
        db.run('DELETE FROM versions WHERE id = ?', v.id);
      }
      return freeUnused(project.team_id, candidates);
    });
    for (const f of freed) store.remove(project.team_id, f.id);
    const removed = old.map((v) => v.number);
    hub.toTeam(project.team_id, 'versions-removed', { projectId: project.id, numbers: removed });
    return { removed, freedBytes: freed.reduce((n, f) => n + f.size, 0) };
  };

  // How much the team stores, and how much each project takes.
  r.get('/api/teams/:tid/storage', (ctx, p) => {
    const { teamId } = needMember(ctx, p.tid);
    const used = db.get('SELECT COALESCE(SUM(size), 0) AS n FROM blobs WHERE team_id = ?', teamId).n;
    const projects = db.all(`SELECT pr.id, pr.name, COUNT(DISTINCT v.id) AS versions,
        (SELECT COALESCE(SUM(b.size), 0) FROM blobs b WHERE b.team_id = pr.team_id AND b.id IN (
          SELECT vb.blob_id FROM version_blobs vb JOIN versions v2 ON v2.id = vb.version_id WHERE v2.project_id = pr.id
          UNION SELECT v3.manifest FROM versions v3 WHERE v3.project_id = pr.id)) AS bytes
      FROM projects pr LEFT JOIN versions v ON v.project_id = pr.id WHERE pr.team_id = ? GROUP BY pr.id ORDER BY bytes DESC`, teamId);
    const keep = db.get('SELECT keep_versions FROM teams WHERE id = ?', teamId).keep_versions;
    return { used, limit: config.maxTeamStorageMB * 1024 * 1024, keepVersions: keep || null, projects };
  });

  r.delete('/api/projects/:pid', (ctx, p) => {
    const { user, project } = needProject(ctx, p.pid);
    const role = member(user.id, project.team_id).role;
    if (project.created_by !== user.id && role !== 'owner') {
      const who = db.get('SELECT name FROM users WHERE id = ?', project.created_by)?.name || 'the person who created it';
      fail(403, `Only ${who} or the team owner can delete this project.`);
    }
    // Pieces used only by this project are removed; pieces another project also uses are kept.
    const used = [
      ...db.all(`SELECT DISTINCT vb.blob_id FROM version_blobs vb JOIN versions v ON v.id = vb.version_id
                 WHERE v.project_id = ?`, project.id).map((r) => r.blob_id),
      ...db.all('SELECT manifest FROM versions WHERE project_id = ?', project.id).map((r) => r.manifest),
    ];
    const freed = db.tx(() => {
      db.run('DELETE FROM projects WHERE id = ?', project.id); // versions, messages, receipts go with it
      return freeUnused(project.team_id, used);
    }).map((f) => f.id);
    for (const id of freed) store.remove(project.team_id, id);
    hub.toTeam(project.team_id, 'project-deleted', { projectId: project.id, name: project.name, by: user.id });
    return { ok: true, freedFiles: freed.length };
  });

  // Delete your own message: its text is erased for everyone; a small "deleted" note stays in its place.
  r.delete('/api/messages/:mid', (ctx, p) => {
    const user = needUser(ctx);
    const m = db.get('SELECT * FROM messages WHERE id = ?', int(p.mid, 'Message'));
    const project = m && db.get('SELECT * FROM projects WHERE id = ?', m.project_id);
    if (!project || !member(user.id, project.team_id)) fail(404, 'Message not found.');
    if (m.kind !== 'text' || m.user_id !== user.id) fail(403, 'You can only delete your own messages.');
    db.run('UPDATE messages SET body = NULL, deleted_at = ? WHERE id = ?', now(), m.id);
    const message = msgOut(db.get('SELECT * FROM messages WHERE id = ?', m.id));
    hub.toTeam(project.team_id, 'message-updated', { projectId: project.id, message });
    return { message };
  });

  r.post('/api/projects/:pid/messages', async (ctx, p) => {
    const { user, project } = needProject(ctx, p.pid);
    const b = await readJson(ctx.req);
    let replyTo = null;
    if (b.replyTo !== undefined && b.replyTo !== null) {
      replyTo = int(b.replyTo, 'Reply');
      if (!db.get("SELECT 1 FROM messages WHERE id = ? AND project_id = ? AND kind = 'text'", replyTo, project.id)) fail(422, 'That message isn’t in this project.');
    }
    const message = addMessage(project.id, user.id, 'text', cipher(b.body, 'Message', 24000));
    if (replyTo) {
      db.run('UPDATE messages SET reply_to = ? WHERE id = ?', replyTo, message.id);
      message.replyTo = replyTo;
    }
    broadcastMessage(project, message);
    notifyTeam(project.team_id, user.id, (lang) => ({
      title: user.name, body: lang === 'fil' ? `Bagong mensahe sa ${project.name}` : `New message in ${project.name}`,
      url: `/#/p/${project.id}`, tag: `project-${project.id}`,
    }));
    return { message };
  });

  r.post('/api/projects/:pid/read', async (ctx, p) => {
    const { user, project } = needProject(ctx, p.pid);
    const b = await readJson(ctx.req);
    markRead(project.id, user.id, int(b.lastId, 'Message id'));
    return { ok: true };
  });

  r.post('/api/projects/:pid/versions', async (ctx, p) => {
    const { user, project } = needProject(ctx, p.pid);
    const b = await readJson(ctx.req, 4 * 1024 * 1024);
    const manifest = String(b.manifest || '');
    if (!BLOB_ID.test(manifest)) fail(422, 'Missing file list.');
    const blob = db.get('SELECT complete FROM blobs WHERE team_id = ? AND id = ?', project.team_id, manifest);
    if (!blob || !blob.complete) fail(409, 'The file list has not finished uploading.');
    const note = b.note ? cipher(b.note, 'Note', 8000) : null;
    const fileCount = int(b.fileCount, 'File count');
    const totalBytes = int(b.totalBytes, 'Total size');
    const sentBytes = int(b.sentBytes, 'Sent size');
    const changedCount = int(b.changedCount, 'Changed files');
    const blobs = Array.isArray(b.blobs) ? [...new Set([...b.blobs, manifest])] : [manifest];
    if (blobs.length > 50000 || !blobs.every((id) => BLOB_ID.test(id))) fail(422, 'Invalid file list.');

    const { version, messages } = db.tx(() => {
      const number = (db.get('SELECT MAX(number) AS n FROM versions WHERE project_id = ?', project.id).n || 0) + 1;
      const res = db.run(`INSERT INTO versions (project_id, number, manifest, note, file_count, total_bytes, sent_bytes, changed_count, created_by, created_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        project.id, number, manifest, note, fileCount, totalBytes, sentBytes, changedCount, user.id, now());
      for (const id of blobs) {
        if (!db.get('SELECT 1 FROM blobs WHERE team_id = ? AND id = ? AND complete = 1', project.team_id, id)) fail(409, 'Some files have not finished uploading.');
        db.run('INSERT OR IGNORE INTO version_blobs (version_id, blob_id) VALUES (?, ?)', res.lastInsertRowid, id);
      }
      const version = versionOut(db.get('SELECT * FROM versions WHERE id = ?', res.lastInsertRowid));
      const out = [addMessage(project.id, user.id, 'version', null, { versionId: version.id, number })];
      if (project.status === 'building') {
        db.run("UPDATE projects SET status = 'sent' WHERE id = ?", project.id);
        out.push(addMessage(project.id, null, 'status', null, { from: 'building', to: 'sent', auto: true }));
      }
      return { version, messages: out };
    });
    hub.toTeam(project.team_id, 'version', { projectId: project.id, version });
    messages.forEach((m) => broadcastMessage(project, m));
    broadcastProject(project.id);
    notifyTeam(project.team_id, user.id, (lang) => ({
      title: lang === 'fil' ? `Nagpadala si ${user.name} ng bagong files` : `${user.name} sent new files`,
      body: `${project.name} · ${version.number === 1
        ? (lang === 'fil' ? `${version.fileCount} file` : `${version.fileCount} files`)
        : (lang === 'fil' ? `bersyon ${version.number}, ${version.changedCount} ang binago` : `version ${version.number}, ${version.changedCount} changed`)}`,
      url: `/#/p/${project.id}/v/${version.number}`, tag: `project-${project.id}`,
    }));
    const keep = db.get('SELECT keep_versions FROM teams WHERE id = ?', project.team_id).keep_versions;
    if (keep) pruneProject(project, keep);
    return { version };
  });

  r.post('/api/versions/:vid/downloaded', (ctx, p) => {
    const user = needUser(ctx);
    const v = db.get('SELECT * FROM versions WHERE id = ?', int(p.vid, 'Version'));
    const project = v && db.get('SELECT * FROM projects WHERE id = ?', v.project_id);
    if (!project || !member(user.id, project.team_id)) fail(404, 'Version not found.');
    const res = db.run('INSERT OR IGNORE INTO downloads (version_id, user_id, at) VALUES (?, ?, ?)', v.id, user.id, now());
    if (res.changes && v.created_by !== user.id) {
      broadcastMessage(project, addMessage(project.id, user.id, 'download', null, { versionId: v.id, number: v.number }));
      hub.toTeam(project.team_id, 'version', { projectId: project.id, version: versionOut(v) });
    }
    return { ok: true };
  });

  // ---------- encrypted file pieces ----------
  r.post('/api/teams/:tid/blobs/check', async (ctx, p) => {
    const { teamId } = needMember(ctx, p.tid);
    const b = await readJson(ctx.req, 512 * 1024);
    if (!Array.isArray(b.ids) || b.ids.length > 5000 || !b.ids.every((id) => BLOB_ID.test(id))) fail(422, 'Invalid file ids.');
    const done = new Set();
    const partial = {}; // started but unfinished uploads: which pieces are already here (to resume without asking again)
    for (const id of b.ids) {
      const row = db.get('SELECT chunk_count, complete FROM blobs WHERE team_id = ? AND id = ?', teamId, id);
      if (row?.complete) done.add(id);
      else if (row) partial[id] = { chunkCount: row.chunk_count, have: store.have(teamId, id) };
    }
    return { missing: b.ids.filter((id) => !done.has(id)), partial };
  });

  r.get('/api/teams/:tid/blobs/:bid', (ctx, p) => {
    const { teamId } = needMember(ctx, p.tid);
    if (!BLOB_ID.test(p.bid)) fail(404, 'Not found.');
    const row = db.get('SELECT chunk_count, complete FROM blobs WHERE team_id = ? AND id = ?', teamId, p.bid);
    if (!row) return { exists: false, complete: false, chunkCount: 0, have: [] };
    return { exists: true, complete: !!row.complete, chunkCount: row.chunk_count, have: row.complete ? [] : store.have(teamId, p.bid) };
  });

  r.put('/api/teams/:tid/blobs/:bid/:n', async (ctx, p, url) => {
    const { teamId } = needMember(ctx, p.tid);
    if (!BLOB_ID.test(p.bid)) fail(422, 'Invalid file id.');
    const n = int(p.n, 'Piece');
    const count = int(url.searchParams.get('count'), 'Piece count');
    const maxChunks = Math.ceil((config.maxFileMB * 1024 * 1024) / CHUNK_BYTES);
    if (count < 1 || count > maxChunks) fail(413, `Files can be at most ${config.maxFileMB} MB.`);
    if (n >= count) fail(422, 'Piece number out of range.');

    let row = db.get('SELECT chunk_count, complete FROM blobs WHERE team_id = ? AND id = ?', teamId, p.bid);
    if (row && row.complete) { ctx.req.resume(); return { complete: true }; }
    if (row && row.chunk_count !== count) fail(409, 'Piece count does not match the earlier upload.');
    const used = db.get('SELECT COALESCE(SUM(size), 0) AS s FROM blobs WHERE team_id = ?', teamId).s;
    if (used > config.maxTeamStorageMB * 1024 * 1024) fail(507, 'Your team has used all of its storage.');

    const buf = await readBody(ctx.req, CHUNK_LIMIT);
    if (buf.length < 28) fail(422, 'That piece is empty or damaged.');
    if (!row) db.run('INSERT OR IGNORE INTO blobs (team_id, id, chunk_count, created_at) VALUES (?, ?, ?, ?)', teamId, p.bid, count, now());
    const previous = store.pieceSize(teamId, p.bid, n); // null when this piece is new
    store.write(teamId, p.bid, n, buf);
    db.run(`UPDATE blobs SET size = size + ?, received = received + ?,
              complete = CASE WHEN received + ? >= chunk_count THEN 1 ELSE 0 END
            WHERE team_id = ? AND id = ?`,
      buf.length - (previous ?? 0), previous === null ? 1 : 0, previous === null ? 1 : 0, teamId, p.bid);
    const after = db.get('SELECT received, complete FROM blobs WHERE team_id = ? AND id = ?', teamId, p.bid);
    return { complete: !!after.complete, received: after.received };
  });

  r.get('/api/teams/:tid/blobs/:bid/:n', (ctx, p) => {
    const { teamId } = needMember(ctx, p.tid);
    if (!BLOB_ID.test(p.bid)) fail(404, 'Not found.');
    const buf = store.read(teamId, p.bid, int(p.n, 'Piece'));
    if (!buf) fail(404, 'That piece is not on the server.');
    ctx.res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=31536000, immutable' });
    ctx.res.end(buf);
    return undefined;
  });

  // ---------- live updates ----------
  r.get('/api/events', (ctx) => {
    const user = needUser(ctx);
    const teams = db.all('SELECT team_id FROM team_members WHERE user_id = ?', user.id).map((t) => t.team_id);
    hub.connect(ctx.req, ctx.res, user.id, teams);
    return undefined;
  });

  r.get('/api/events/poll', async (ctx, p, url) => {
    const user = needUser(ctx);
    const teams = db.all('SELECT team_id FROM team_members WHERE user_id = ?', user.id).map((t) => t.team_id);
    const session = String(url.searchParams.get('session') || '').slice(0, 64) || null;
    return hub.poll(ctx.req, user.id, teams, session);
  });

  return r;
}

export { sendJson };
