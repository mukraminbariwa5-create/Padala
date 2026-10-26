// Padala web app: start-up. The screens live in ./app/ (one module per screen or concern).
import { mountDala, skipWelcome, holdDala } from './dala.js';
import { startI18n } from './i18n.js';
import { runIntro } from './splash.js';
import { esc, enhanceFields } from './ui.js';
import { afterSignIn, showDemoNote } from './app/auth.js';
import { markRead } from './app/live.js';
import { subscribePush } from './app/push.js';
import { current, route, showError, skeletonHtml, authLayout, layout } from './app/shell.js';
import { api, S } from './app/state.js';
import { enablePullToRefresh } from './app/touch.js';

async function boot() {
  await startI18n();
  if (!window.isSecureContext || !globalThis.crypto?.subtle) {
    authLayout(`<span class="brand"><img src="/icons/icon-64.png" alt="">Padala</span><h1>Open Padala securely.<span class="muted">Encryption needs a secure connection.</span></h1>
      <p class="muted">Use <b>https://</b> or <b>http://localhost</b>. Browsers turn off encryption tools on plain http addresses like ${esc(location.host)}.</p>`);
    return;
  }
  mountDala();
  enhanceFields();
  layout(skeletonHtml('home', 'Opening Padala…'), { sidebar: false });
  // The opening animation plays while Padala signs in underneath; Dala greets by name when it can.
  api.get('/api/config').then((c) => { S.publicUrl = c.publicUrl; S.publicDemo = !!c.publicDemo; showDemoNote(); }).catch(() => {});
  const signedIn = afterSignIn().then(() => null, (err) => err);
  const intro = runIntro({ who: signedIn.then((err) => (err ? null : S.me)), invite: location.hash.startsWith('#/join/') });
  const err = await signedIn;
  if (S.me && document.querySelector('.splash.is-full')) skipWelcome(); // Dala already said hello
  holdDala(intro);
  if (err && err.status !== 401) { showError(err); window.addEventListener('hashchange', route); return; }
  window.addEventListener('hashchange', route);
  window.addEventListener('beforeunload', (e) => { if (S.busy) { e.preventDefault(); e.returnValue = ''; } });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && current.name === 'project') {
      const data = S.projectData.get(current.id);
      const last = data?.messages[data.messages.length - 1];
      if (last) markRead(current.id, last.id);
    }
  });
  route();
  enablePullToRefresh();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').then(() => subscribePush()).catch(() => {});
}

boot();
