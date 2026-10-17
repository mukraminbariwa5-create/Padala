// npm run share
// Starts Padala and gives it a temporary https address (a free Cloudflare "quick tunnel"),
// so phones and other computers can open it, even on mobile data. Shows a QR code to scan.
// The address changes every time you run this. Press Ctrl+C to stop both.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { qrTerminal } from '../web/js/qr.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8080);
const TOOLS = path.join(ROOT, '.tools');
const isWin = process.platform === 'win32';
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const say = (s = '') => console.log(s);

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '0.0.0.0');
  });
}

function onPath(cmd) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  const names = isWin ? [`${cmd}.exe`, cmd] : [cmd];
  for (const d of dirs) for (const n of names) { const p = path.join(d, n); if (fs.existsSync(p)) return p; }
  return null;
}

async function findCloudflared() {
  const local = path.join(TOOLS, isWin ? 'cloudflared.exe' : 'cloudflared');
  const known = [
    onPath('cloudflared'), local,
    isWin && 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    isWin && 'C:\\Program Files\\cloudflared\\cloudflared.exe',
    !isWin && '/opt/homebrew/bin/cloudflared', !isWin && '/usr/local/bin/cloudflared',
  ].filter(Boolean);
  const found = known.find((p) => fs.existsSync(p));
  if (found) return found;

  const arch = os.arch() === 'arm64' ? 'arm64' : os.arch() === 'x64' ? 'amd64' : '386';
  const file = isWin ? `cloudflared-windows-${arch === 'arm64' ? 'amd64' : arch}.exe` : process.platform === 'linux' ? `cloudflared-linux-${arch}` : null;
  if (!file) {
    say('Padala needs the free "cloudflared" tool for this. On a Mac, install it with:  brew install cloudflared');
    process.exit(1);
  }
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${file}`;
  say(`First time only: downloading Cloudflare's free tunnel tool (cloudflared) from its official GitHub page…`);
  say(dim(url));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}). Install it yourself: winget install Cloudflare.cloudflared`);
  const total = Number(res.headers.get('content-length')) || 0;
  fs.mkdirSync(TOOLS, { recursive: true });
  const tmp = `${local}.part`;
  const out = fs.createWriteStream(tmp);
  let got = 0;
  let shown = -1;
  for await (const chunk of res.body) {
    out.write(chunk);
    got += chunk.length;
    const pct = total ? Math.floor((got / total) * 100) : 0;
    if (pct !== shown && pct % 10 === 0) { shown = pct; process.stdout.write(`  ${pct}%`); }
  }
  await new Promise((r) => out.end(r));
  fs.renameSync(tmp, local);
  if (!isWin) fs.chmodSync(local, 0o755);
  say('\n  Done.');
  return local;
}

function startTunnel(bin) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; reject(new Error('The tunnel didn’t start within 60 seconds. Check your internet and try again.')); } }, 60000);
    const look = (buf) => {
      const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !done) { done = true; clearTimeout(timer); resolve({ child, url: m[0] }); }
    };
    child.stdout.on('data', look);
    child.stderr.on('data', look);
    child.on('exit', (code) => { if (!done) { done = true; clearTimeout(timer); reject(new Error(`The tunnel tool stopped (code ${code}).`)); } });
  });
}

async function waitReachable(url) {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${url}/api/health`); if (r.ok) return true; } catch { /* DNS not ready yet */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

async function main() {
  say(bold('\n  Padala · sharing with your phone\n'));
  if (!(await portFree(PORT))) {
    say(`Padala is already running in another window (port ${PORT} is busy).`);
    say('Stop it there with Ctrl+C, then run  npm run share  again.');
    process.exit(1);
  }
  const bin = await findCloudflared();
  say('Opening a secure https address…');
  const { child: tunnel, url } = await startTunnel(bin);
  const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, PORT: String(PORT), PUBLIC_URL: url, TRUST_PROXY: '1' },
  });
  const stop = () => { tunnel.kill(); server.kill(); };
  process.on('SIGINT', () => { stop(); say('\nStopped. The https address no longer works.'); process.exit(0); });
  process.on('SIGTERM', () => { stop(); process.exit(0); });
  server.on('exit', (code) => { tunnel.kill(); if (code) say(`Padala stopped (code ${code}).`); process.exit(code || 0); });
  tunnel.on('exit', () => { say('\nThe tunnel closed. Run  npm run share  again for a new address.'); server.kill(); });

  say('Waiting for the address to come online (can take up to a minute)…');
  const ok = await waitReachable(url);
  say('');
  say(qrTerminal(url));
  say('');
  say(`  ${bold('Scan this with your phone’s camera, or open:')}`);
  say(`  ${green(bold(url))}`);
  say('');
  say(`  On this laptop keep using  ${bold(`http://localhost:${PORT}`)}`);
  say('  Invite links you create now use the phone address above.');
  say(dim('  This address changes every time. Keep this window open; press Ctrl+C to stop.'));
  if (!ok) say('\n  (The address is still warming up. If your phone can’t open it yet, wait a minute and retry.)');
  say('');
}

main().catch((err) => { console.error(`\n${err.message}`); process.exit(1); });
