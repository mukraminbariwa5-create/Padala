// Padala server: JSON API + live events + the web app. No outside packages, just Node.js.
import http from 'node:http';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDb } from './db.js';
import { BlobStore } from './storage.js';
import { EventHub } from './events.js';
import { scheduleBackups } from './backup.js';
import { loadVapid } from './push.js';
import { buildApi } from './api.js';
import { HttpError, sendJson, parseCookies } from './http.js';
import { userFromToken } from './auth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webp': 'image/webp',
};
const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
    "font-src 'self'", "img-src 'self' data: blob:", "connect-src 'self'",
    "worker-src 'self'", "manifest-src 'self'", "frame-src blob:", "media-src blob:", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT || 8080),
    host: env.HOST || '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR || path.join(ROOT, 'data')),
    secureCookies: env.COOKIE_SECURE === '1',
    trustProxy: env.TRUST_PROXY === '1',
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, '') || null, // e.g. https://padala.example.com (used for invite links)
    maxFileMB: Number(env.MAX_FILE_MB || 2048),
    maxTeamStorageMB: Number(env.MAX_TEAM_STORAGE_MB || 20480),
    backupDir: path.resolve(env.BACKUP_DIR || path.join(ROOT, 'backups')), // daily backups (use another drive if you can)
    backups: env.BACKUPS !== 'off',
    publicDemo: env.PUBLIC_DEMO === '1', // shows a note on the sign-in screen: shared demo, data is erased
  };
}

export function createServer(config = loadConfig()) {
  const db = openDb(config.dataDir);
  const store = new BlobStore(path.join(config.dataDir, 'blobs'));
  const hub = new EventHub();
  const vapid = loadVapid(config.dataDir);
  const api = buildApi({ db, store, hub, config, vapid });

  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url, 'http://local');
    try {
      // Share to Padala: the app's service worker normally catches this; without it, just open Send files
      if (req.method === 'POST' && url.pathname === '/share-target') { req.resume(); res.writeHead(303, { Location: '/#/send' }); res.end(); return; }
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else serveStatic(req, res, url.pathname);
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(err);
      if (res.headersSent) { res.end(); return; }
      const status = err instanceof HttpError ? err.status : 500;
      sendJson(res, status, { error: err instanceof HttpError ? err.message : 'Something went wrong on the server.' });
    }
  });

  async function handleApi(req, res, url) {
    const found = api.match(req.method, url.pathname);
    if (!found) return sendJson(res, 404, { error: 'Not found.' });
    if (found === 'method') return sendJson(res, 405, { error: 'Method not allowed.' });

    if (req.method !== 'GET') {
      // Cross-site request protection: browsers can't add this header to a cross-origin request without our permission.
      if (req.headers['x-padala'] !== '1') return sendJson(res, 403, { error: 'Request blocked.' });
      const origin = req.headers.origin;
      if (origin) {
        const allowed = new Set([req.headers.host]);
        if (config.trustProxy && req.headers['x-forwarded-host']) allowed.add(String(req.headers['x-forwarded-host']).split(',')[0].trim());
        if (config.publicUrl) allowed.add(new URL(config.publicUrl).host);
        let host = null;
        try { host = new URL(origin).host; } catch { /* malformed */ }
        if (!allowed.has(host)) return sendJson(res, 403, { error: 'Request blocked.' });
      }
    }
    const cookies = parseCookies(req.headers.cookie);
    const setCookies = [];
    const ctx = {
      req, res,
      sessionToken: cookies.padala_session,
      user: userFromToken(db, cookies.padala_session),
      ip: (config.trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '',
      setCookie: (c) => setCookies.push(c),
    };
    const result = await found.handler(ctx, found.params, url);
    if (result === undefined) return; // handler wrote the response itself
    sendJson(res, 200, result, setCookies.length ? { 'Set-Cookie': setCookies } : {});
  }

  // Static files: compressed once (brotli or gzip) and kept in memory, with an ETag so a browser that
  // already has a file gets a tiny "304 Not Modified" instead of downloading it again.
  const packed = new Map(); // file -> { tag, raw, br, gz }
  const COMPRESS = /\.(html|js|css|json|webmanifest|svg|txt|ico)$/;
  function load(file) {
    const st = fs.statSync(file);
    const tag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    let entry = packed.get(file);
    if (!entry || entry.tag !== tag) {
      const raw = fs.readFileSync(file);
      entry = { tag, raw };
      if (COMPRESS.test(file) && raw.length > 1024) {
        entry.br = zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 10 } });
        entry.gz = zlib.gzipSync(raw, { level: 9 });
      }
      packed.set(file, entry);
    }
    return entry;
  }

  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || !path.extname(rel)) rel = '/index.html'; // app routes live in the #hash
    const file = path.normalize(path.join(WEB, rel));
    if (!file.startsWith(WEB + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return;
    }
    const entry = load(file);
    const headers = {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': rel.startsWith('/fonts/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      ETag: entry.tag,
      Vary: 'Accept-Encoding',
      ...(rel === '/sw.js' ? { 'Service-Worker-Allowed': '/' } : {}),
    };
    if (req.headers['if-none-match'] === entry.tag) { res.writeHead(304, headers); res.end(); return; }
    const accept = String(req.headers['accept-encoding'] || '');
    let body = entry.raw;
    if (entry.br && /\bbr\b/.test(accept)) { body = entry.br; headers['Content-Encoding'] = 'br'; }
    else if (entry.gz && /\bgzip\b/.test(accept)) { body = entry.gz; headers['Content-Encoding'] = 'gzip'; }
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  server.on('close', () => { hub.close(); db.close(); });
  return { server, db, config };
}

// Run directly: `npm start`
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const config = loadConfig();
  const { server, db } = createServer(config);
  server.listen(config.port, config.host, () => {
    console.log(`\n  Padala is running at http://localhost:${config.port}\n  Data folder: ${config.dataDir}`);
    console.log(config.backups ? `  Daily backups: ${config.backupDir}\n` : '  Daily backups are off (BACKUPS=off)\n');
  });
  if (config.backups) scheduleBackups({ db, dataDir: config.dataDir, backupDir: config.backupDir });
  const stop = () => { server.close(() => process.exit(0)); server.closeAllConnections(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
