// Installing Padala as an app (home screen / desktop).
import { icon, toast, dialog } from '../ui.js';

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; refreshInstall(); });
window.addEventListener('appinstalled', () => { installPrompt = null; refreshInstall(); toast('Padala is on your home screen now. Open it from there next time.'); });
/** Padala running on this computer for its owner (the only place setup instructions make sense). */
export const isLocalHost = () => /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(location.hostname);
export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const canInstall = () => !isStandalone() && (!!installPrompt || isIOS());
function refreshInstall() {
  for (const el of document.querySelectorAll('[data-install-slot]')) el.innerHTML = installHtml(el.dataset.installSlot);
}
async function installApp() {
  if (installPrompt) {
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice.catch(() => ({}));
    if (outcome === 'accepted') installPrompt = null;
    refreshInstall();
    return;
  }
  if (isIOS()) {
    await dialog(`<h2>Add Padala to your Home Screen</h2>
      <ol class="howto">
        <li>Tap the <b>Share</b> button ${icon.share({ size: 15 })} at the bottom of Safari.</li>
        <li>Scroll down and tap <b>Add to Home Screen</b>.</li>
        <li>Tap <b>Add</b>. Padala appears with its own icon and opens full screen.</li>
      </ol>
      <div class="row" style="justify-content:flex-end"><button class="btn btn--primary">Got it</button></div>`);
  }
}
export function installHtml(where) {
  if (isStandalone()) {
    return where === 'settings' ? `<div class="set-row"><span class="grow"><b>Padala app</b><span>Installed. You’re using the app.</span></span><span class="pill pill--on">${icon.check({ size: 13, width: 3 })} Installed</span></div>` : '';
  }
  if (!canInstall()) return ''; // this browser can't install apps: nothing to offer
  if (where === 'home') {
    try { if (localStorage.getItem('padala.installHidden')) return ''; } catch { /* ignore */ }
    return `<div class="install-card">
      <img src="/icons/icon-96.png" alt="">
      <span class="grow"><b>Get the Padala app</b><span>Opens full screen with its own icon, like any app on your ${isIOS() ? 'iPhone' : 'phone or computer'}.</span></span>
      <button class="btn btn--primary btn--sm" data-install>Install</button>
      <button class="icon-btn icon-btn--ghost" data-install-hide aria-label="Not now">${icon.x({ size: 16 })}</button></div>`;
  }
  return `<div class="set-row"><span class="grow"><b>Install the app</b><span>Add Padala to your home screen. It opens full screen with its own icon.</span></span><button class="btn btn--sm btn--primary" data-install>Install</button></div>`;
}
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-install]')) { e.preventDefault(); installApp(); }
  if (e.target.closest('[data-install-hide]')) {
    try { localStorage.setItem('padala.installHidden', '1'); } catch { /* ignore */ }
    e.target.closest('.install-card')?.remove();
  }
});
