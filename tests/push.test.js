import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encryptPush, vapidAuth, loadVapid, sendPush } from '../server/push.js';

// RFC 8291, Section 5 (the worked example)
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  result: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

test('push encryption matches the RFC 8291 example byte for byte', () => {
  const out = encryptPush(RFC.plaintext, { p256dh: RFC.uaPublic, auth: RFC.auth }, { local: { privateKey: RFC.asPrivate }, salt: Buffer.from(RFC.salt, 'base64url') });
  assert.equal(out.toString('base64url'), RFC.result);
});

test('a browser can decrypt what we send (round trip with fresh keys)', () => {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const msg = JSON.stringify({ title: 'Mukramin sent new files', body: 'booktrack-v2 · version 3' });
  const out = encryptPush(msg, { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') });
  // decrypt the way a browser does
  const salt = out.subarray(0, 16);
  const idlen = out[20];
  const asPublic = out.subarray(21, 21 + idlen);
  const shared = ua.computeSecret(asPublic);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const body = out.subarray(21 + idlen);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(body.subarray(body.length - 16));
  const plain = Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, 'last-record delimiter');
  assert.equal(plain.subarray(0, -1).toString(), msg);
});

test('VAPID: key pair kept in the data folder, and the token verifies with the public key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'padala-vapid-'));
  const v1 = loadVapid(dir);
  const v2 = loadVapid(dir);
  assert.equal(v1.publicKey, v2.publicKey, 'the same key after a restart');
  const auth = vapidAuth({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', vapid: v1 });
  const [, token, k] = auth.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, v1.publicKey);
  const [h, c, s] = token.split('.');
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  const raw = Buffer.from(v1.publicKey, 'base64url');
  const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
  // a push service that says the subscription is gone
  const gone = await sendPush({ sub: { endpoint: 'https://push.example/x', p256dh: RFC.uaPublic, auth: RFC.auth }, message: { title: 'x' }, vapid: v1, fetchImpl: async () => ({ ok: false, status: 410 }) });
  assert.equal(gone, 'gone');
  fs.rmSync(dir, { recursive: true, force: true });
});
