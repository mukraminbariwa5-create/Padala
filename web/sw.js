// Service worker: lets Padala install like an app and open without signal.
// Network first (always the newest version), falling back to the saved copy when offline.
// API calls are never cached: they carry private, encrypted data.
const CACHE = 'padala-shell-v23';
const SHELL = [
  '/', '/css/app.css', '/manifest.webmanifest', '/icons/icon-32.png', '/icons/icon-64.png', '/icons/icon-192.png',
  '/js/app.js', '/js/app/auth.js', '/js/app/chat.js', '/js/app/home.js', '/js/app/install.js', '/js/app/keys.js', '/js/app/live.js', '/js/app/progress.js', '/js/app/push.js', '/js/app/receive.js', '/js/app/send.js', '/js/app/settings.js', '/js/app/shell.js', '/js/app/state.js', '/js/app/team.js', '/js/app/touch.js', '/js/api.js', '/js/crypto.js', '/js/transfer.js', '/js/sync.js', '/js/zip.js', '/js/folders.js', '/js/ui.js', '/js/dala.js', '/js/preview.js', '/js/checkup.js', '/js/splash.js', '/js/qr.js', '/js/keyring.js', '/js/theme.js', '/js/i18n.js', '/js/lang/fil.js', '/fonts/Inter.woff2', '/fonts/JetBrainsMono-Medium.woff2', '/fonts/JetBrainsMono-Bold.woff2',
  ...['neutral', 'hello', 'point', 'run', 'working', 'laptop', 'cheer', 'surprised', 'sad', 'sleep', 'wave'].map((p) => `/img/dala/${p}.webp`),
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Share to Padala (Android): files shared from the gallery or a file manager arrive here. They're kept on
// the device for a moment and handed to the Send screen; nothing is uploaded until the person sends them.
const shareDb = () => new Promise((resolve, reject) => {
  const req = indexedDB.open('padala-share', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('shared');
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
async function keepShared(files, title) {
  const db = await shareDb();
  await new Promise((resolve, reject) => {
    const t = db.transaction('shared', 'readwrite');
    t.objectStore('shared').put({ files, title: title || '', at: Date.now() }, 'latest');
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
  db.close();
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.pathname === '/share-target') {
    e.respondWith((async () => {
      try {
        const form = await e.request.formData();
        const files = form.getAll('files').filter((f) => typeof f === 'object' && f && 'size' in f);
        if (files.length) await keepShared(files, form.get('title') || form.get('text'));
        return Response.redirect(files.length ? '/#/send?shared' : '/#/send', 303);
      } catch { return Response.redirect('/#/send', 303); }
    })());
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(url.pathname === '/index.html' ? '/' : e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('/'))),
  );
});

// Notifications when the app is closed (Web Push). The server sends a short notice only; message text and
// files stay end-to-end encrypted. When Padala is already on screen, it shows new things live instead.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (windows.some((w) => w.focused && w.visibilityState === 'visible')) return;
    await self.registration.showNotification(d.title || 'Padala', {
      body: d.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      tag: d.tag || 'padala',
      renotify: true,
      data: { url: d.url || '/' },
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
    if (open) { await open.focus(); return open.navigate ? open.navigate(target) : null; }
    return self.clients.openWindow(target);
  })());
});
