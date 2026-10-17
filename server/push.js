// Web Push, with no extra libraries: notifications reach a phone even when Padala is closed.
//  - VAPID (RFC 8292): the server signs each push with its own key pair, so push services know it's us.
//  - Message encryption (RFC 8291, "aes128gcm"): only the subscribed browser can read what we send.
// What we send is a short notice ("Mukramin sent new files · booktrack-v2"). Message text and files stay
// end-to-end encrypted with the team key and never go through the push service.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const b64u = (buf) => Buffer.from(buf).toString('base64url');

/** Load the server's push key pair, creating it on first use (kept in the data folder). */
export function loadVapid(dataDir) {
  const file = path.join(dataDir, 'vapid.json');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { publicKey: saved.publicKey, privateKey: crypto.createPrivateKey({ key: saved.privateJwk, format: 'jwk' }) };
  } catch { /* first run */ }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  const saved = { publicKey: b64u(raw), privateJwk: privateKey.export({ format: 'jwk' }) };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(saved), { mode: 0o600 });
  return { publicKey: saved.publicKey, privateKey };
}

/** The Authorization header for one push service (a short-lived signed token). */
export function vapidAuth({ endpoint, vapid, subject = 'mailto:padala@localhost', now = Date.now() }) {
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: vapid.privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${vapid.publicKey}`;
}

/**
 * Encrypt a push message for one browser (RFC 8291). `p256dh` and `auth` come from its subscription.
 * `local` (a key pair) and `salt` are only passed in by tests, to check against the RFC's example.
 */
export function encryptPush(payload, { p256dh, auth }, { local, salt = crypto.randomBytes(16) } = {}) {
  const uaPublic = Buffer.from(p256dh, 'base64url');
  const authSecret = Buffer.from(auth, 'base64url');
  const ecdh = crypto.createECDH('prime256v1');
  if (local) ecdh.setPrivateKey(Buffer.from(local.privateKey, 'base64url')); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

/**
 * Send one notice. Resolves to 'ok', 'gone' (the subscription expired: forget it) or 'failed'.
 * Never throws: a push that can't be delivered must not break sending files.
 */
export async function sendPush({ sub, message, vapid, fetchImpl = fetch }) {
  try {
    const res = await fetchImpl(sub.endpoint, {
      method: 'POST',
      headers: {
        TTL: '86400',
        Urgency: 'high',
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        Authorization: vapidAuth({ endpoint: sub.endpoint, vapid }),
      },
      body: encryptPush(JSON.stringify(message), sub),
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404 || res.status === 410) return 'gone';
    return res.ok ? 'ok' : 'failed';
  } catch { return 'failed'; }
}
