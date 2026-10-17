// End-to-end encryption. Runs in the browser (and in Node for the tests) using the built-in Web Crypto API.
//
// Each team has one secret "team key" that only members' devices hold. It travels inside the invite
// link's #fragment, which browsers never send to the server. From it we derive:
//   - an AES-256-GCM key that encrypts every file piece, message and note
//   - an HMAC key that turns file contents into ids (same file -> same id, so unchanged files are skipped,
//     but the server can't tell what the file is)
//   - a short "key check" the server keeps so a pasted key can be verified without revealing it

const te = new TextEncoder();
const td = new TextDecoder();

export const b64u = {
  encode(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(str) {
    const s = atob(String(str).replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  },
};

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

export function generateTeamKey() {
  return b64u.encode(crypto.getRandomValues(new Uint8Array(32)));
}

export function isValidKeyFormat(key) {
  try { return /^[A-Za-z0-9_-]{43}$/.test(key) && b64u.decode(key).length === 32; } catch { return false; }
}

export async function importTeamKey(key) {
  if (!isValidKeyFormat(key)) throw new Error('That team key is not valid.');
  const base = await crypto.subtle.importKey('raw', b64u.decode(key), 'HKDF', false, ['deriveKey', 'deriveBits']);
  const params = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt: te.encode('padala-v1'), info: te.encode(info) });
  const encKey = await crypto.subtle.deriveKey(params('encrypt'), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const idKey = await crypto.subtle.deriveKey(params('file-id'), base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
  const check = b64u.encode(new Uint8Array(await crypto.subtle.deriveBits(params('key-check'), base, 256)).subarray(0, 24));
  return { encKey, idKey, check };
}

/** Keyed fingerprint of some bytes: 64 hex characters. */
export async function contentId(keys, bytes) {
  return hex(await crypto.subtle.sign('HMAC', keys.idKey, bytes));
}

/**
 * Encrypts bytes. `context` is bound in as additional data, so a piece can't be swapped for another
 * piece (or moved to another file) without decryption failing.
 * Output: 12-byte random IV followed by the ciphertext + 16-byte tag.
 */
export async function encryptBytes(keys, bytes, context) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(context) }, keys.encKey, bytes));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0);
  out.set(ct, 12);
  return out;
}

export async function decryptBytes(keys, data, context) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < 28) throw new Error('Encrypted data is damaged.');
  try {
    return new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: te.encode(context) }, keys.encKey, bytes.subarray(12)));
  } catch {
    throw new Error('Could not decrypt. The data is damaged or this device has the wrong team key.');
  }
}

export async function encryptText(keys, text, context) {
  return b64u.encode(await encryptBytes(keys, te.encode(text), context));
}

export async function decryptText(keys, cipher, context) {
  return td.decode(await decryptBytes(keys, b64u.decode(cipher), context));
}

export const pieceContext = (blobId, n, count) => `piece:${blobId}:${n}:${count}`;
