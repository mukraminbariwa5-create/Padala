// The service worker's notification code, run in a small stand-in for the browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function loadWorker({ windows = [] } = {}) {
  const listeners = {};
  const shown = [];
  const opened = [];
  const self = {
    location: { origin: 'https://padala.test' },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    registration: { showNotification: async (title, opts) => { shown.push({ title, ...opts }); } },
    clients: { matchAll: async () => windows, openWindow: async (url) => { opened.push(url); }, claim: async () => {} },
    skipWaiting: () => {},
  };
  vm.runInNewContext(fs.readFileSync(new URL('../web/sw.js', import.meta.url), 'utf8'), { self, caches: {}, fetch: () => {}, URL, location: self.location });
  const fire = async (type, event) => {
    let done;
    listeners[type]({ ...event, waitUntil: (p) => { done = p; } });
    await done;
  };
  return { fire, shown, opened };
}

const push = (d) => ({ data: { json: () => d, text: () => JSON.stringify(d) } });
const notice = { title: 'Mukramin sent new files', body: 'booktrack-v2 · version 3', url: '/#/p/1/v/3', tag: 'project-1' };

test('push: shown when Padala is closed or in the background, with the Padala icon', async () => {
  const w = loadWorker({ windows: [{ url: 'https://padala.test/', focused: false, visibilityState: 'hidden' }] });
  await w.fire('push', push(notice));
  assert.equal(w.shown.length, 1);
  assert.equal(w.shown[0].title, 'Mukramin sent new files');
  assert.equal(w.shown[0].body, 'booktrack-v2 · version 3');
  assert.equal(w.shown[0].icon, '/icons/icon-192.png');
  assert.equal(w.shown[0].badge, '/icons/badge-96.png');
  assert.equal(w.shown[0].data.url, '/#/p/1/v/3');
});

test('push: not shown while Padala is open on screen (it shows new things live)', async () => {
  const w = loadWorker({ windows: [{ url: 'https://padala.test/#/', focused: true, visibilityState: 'visible' }] });
  await w.fire('push', push(notice));
  assert.equal(w.shown.length, 0);
});

test('tapping a notification opens the right project (in the open app, or a new window)', async () => {
  let navigated = null;
  const open = { url: 'https://padala.test/#/', focus: async () => {}, navigate: async (u) => { navigated = u; } };
  const w = loadWorker({ windows: [open] });
  await w.fire('notificationclick', { notification: { close: () => {}, data: { url: '/#/p/1/v/3' } } });
  assert.equal(navigated, 'https://padala.test/#/p/1/v/3');
  const none = loadWorker({ windows: [] });
  await none.fire('notificationclick', { notification: { close: () => {}, data: { url: '/#/p/2' } } });
  assert.deepEqual(none.opened, ['https://padala.test/#/p/2']);
});
