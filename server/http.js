// Small HTTP helpers: a router, JSON bodies, errors and cookies.

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const fail = (status, message, code) => { throw new HttpError(status, message, code); };

export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    this.routes.push({ method, re, keys, handler });
  }
  get(p, h) { this.add('GET', p, h); }
  post(p, h) { this.add('POST', p, h); }
  put(p, h) { this.add('PUT', p, h); }
  patch(p, h) { this.add('PATCH', p, h); }
  delete(p, h) { this.add('DELETE', p, h); }
  match(method, pathname) {
    let allowed = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      if (r.method !== method) { allowed = true; continue; }
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { handler: r.handler, params };
    }
    return allowed ? 'method' : null;
  }
}

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) { req.resume(); return reject(new HttpError(413, 'That upload is too large.')); }
    const parts = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'That upload is too large.')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

export async function readJson(req, limit = 64 * 1024) {
  const type = req.headers['content-type'] || '';
  if (!type.startsWith('application/json')) fail(415, 'Expected JSON.');
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { fail(400, 'Invalid JSON.'); }
}

export function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name, value, { maxAge, secure } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;
  if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
  if (secure) c += '; Secure';
  return c;
}

/** Validation helpers: return clean values or throw a 422 with a readable message. */
export function str(v, label, { min = 0, max = 200, required = true } = {}) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s && required) fail(422, `${label} is required.`);
  if (s.length < min) fail(422, `${label} must be at least ${min} characters.`);
  if (s.length > max) fail(422, `${label} can be at most ${max} characters.`);
  return s;
}

export function int(v, label) {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) fail(422, `${label} must be a whole number.`);
  return n;
}
