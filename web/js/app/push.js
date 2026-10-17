// Notifications when the app is closed (Web Push).
import { getLang } from '../i18n.js';
import { icon, toast } from '../ui.js';
import { isStandalone, isIOS } from './install.js';
import { partners } from './keys.js';
import { screenSettings } from './settings.js';
import { current } from './shell.js';
import { api, S } from './state.js';

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const b64ToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

/** Subscribe this device (after the person allowed notifications) and tell the server where to send them. */
export async function subscribePush() {
  if (!pushSupported() || Notification.permission !== 'granted' || !S.me) return false;
  try {
    const { publicKey } = await api.get('/api/push/key');
    if (!publicKey) return false;
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    // a subscription made for another server key can't be used: replace it
    const key = sub?.options?.applicationServerKey && new Uint8Array(sub.options.applicationServerKey);
    if (sub && key && btoa(String.fromCharCode(...key)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== publicKey) { await sub.unsubscribe(); sub = null; }
    sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
    await api.post('/api/push/subscribe', { ...sub.toJSON(), lang: getLang() });
    return true;
  } catch { return false; }
}

export async function unsubscribePush() {
  if (!pushSupported()) return;
  try {
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    if (!sub) return;
    await api.post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe();
  } catch { /* nothing to undo */ }
}

async function turnOnNotifications() {
  if (!pushSupported()) {
    toast(isIOS() && !isStandalone() ? 'On iPhone, add Padala to your Home Screen first, then turn on notifications from there.' : 'This browser can’t show notifications.', { error: true });
    return false;
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    toast(permission === 'denied' ? 'Notifications are blocked. Allow them in your browser’s site settings.' : 'Notifications stay off.', { error: permission === 'denied' });
    return false;
  }
  const ok = await subscribePush();
  toast(ok ? 'Notifications are on. You’ll hear about new files even when Padala is closed.' : 'Notifications are on while Padala is open. (This browser couldn’t sign up for closed-app notifications.)');
  return ok;
}

export function notifyBanner() {
  if (!pushSupported() || Notification.permission !== 'default' || !partners().length) return '';
  try { if (localStorage.getItem('padala.notifyHidden')) return ''; } catch { /* ignore */ }
  return `<div class="notice">${icon.bell({ size: 18 })}<span class="grow"><b>Get notified when files arrive</b><span>Even when Padala is closed, like a message app.</span></span>
    <button class="btn btn--sm btn--primary" data-notify-on>Turn on</button><button class="icon-btn icon-btn--ghost icon-btn--sm" data-notify-hide aria-label="Not now">${icon.x({ size: 15 })}</button></div>`;
}
document.addEventListener('click', async (e) => {
  if (e.target.closest('[data-notify-on]')) {
    e.preventDefault();
    await turnOnNotifications();
    e.target.closest('.notice')?.remove();
    if (current.name === 'settings') screenSettings();
  }
  if (e.target.closest('[data-notify-hide]')) {
    try { localStorage.setItem('padala.notifyHidden', '1'); } catch { /* ignore */ }
    e.target.closest('.notice')?.remove();
  }
});
