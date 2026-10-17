// Settings, the profile photo, and QR codes.
import { react, dalaEnabled, setDalaEnabled } from '../dala.js';
import { getLang, setLang, LANGS } from '../i18n.js';
import { qrSvg } from '../qr.js';
import { runIntro, introEnabled, setIntroEnabled } from '../splash.js';
import { esc, icon, toast, dialog, copyText } from '../ui.js';
import { signOut } from './auth.js';
import { isLocalHost, isStandalone, isIOS, installHtml } from './install.js';
import { storedKeys, avatarHtml } from './keys.js';
import { pushSupported, subscribePush, unsubscribePush } from './push.js';
import { current, layout, refreshChrome } from './shell.js';
import { api, app, S } from './state.js';

export function showQr(text, { title, text: help }) {
  dialog(`<h2>${esc(title)}</h2>
    <p class="muted" style="font-size:14px">${help}</p>
    <div class="qr-box">${qrSvg(text, { size: 232 })}</div>
    <div class="key-box" style="font-size:12px">${esc(text)}</div>
    <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-copy-qr>${icon.copy({ size: 14 })} Copy</button><button class="btn btn--primary">Done</button></div>`,
  { onOpen: (box) => { box.querySelector('[data-copy-qr]').onclick = () => copyText(text); } });
}

/** Choose a photo, crop it to a square and shrink it on the device (256×256), then upload it. */
function pickProfilePhoto() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const img = await createImageBitmap(file);
      const side = Math.min(img.width, img.height);
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 256;
      const g = canvas.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 256, 256);
      let blob = await new Promise((r) => canvas.toBlob(r, 'image/webp', 0.86));
      if (!blob || blob.type !== 'image/webp') blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.88));
      const { avatarV } = await api.put('/api/me/avatar', new Uint8Array(await blob.arrayBuffer()));
      S.me.avatarV = avatarV;
      const mine = S.team?.members.find((m) => m.id === S.me.id);
      if (mine) mine.avatarV = avatarV;
      if (current.name === 'settings') screenSettings();
      refreshChrome();
      toast('Profile photo updated.');
    } catch { toast('That picture couldn’t be used. Try a JPG or PNG photo.', { error: true }); }
  };
  input.click();
}

/** On computers: a menu of sections on the left that jumps to them and follows the scroll. */
function wireSettingsNav() {
  const links = [...app.querySelectorAll('[data-set-link]')];
  if (!links.length) return;
  const mark = (id) => links.forEach((l) => { const on = l.dataset.setLink === id; l.classList.toggle('is-on', on); if (on) l.setAttribute('aria-current', 'true'); else l.removeAttribute('aria-current'); });
  links.forEach((l) => l.addEventListener('click', (e) => {
    e.preventDefault();
    const target = app.querySelector(`#set-${l.dataset.setLink}`);
    target?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    mark(l.dataset.setLink);
  }));
  const sections = links.map((l) => app.querySelector(`#set-${l.dataset.setLink}`)).filter(Boolean);
  const io = new IntersectionObserver((entries) => {
    const visible = entries.filter((en) => en.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (window.scrollY < 40) mark('profile');
    else if (visible) mark(visible.target.id.replace('set-', ''));
  }, { rootMargin: '-20% 0px -70% 0px' });
  sections.forEach((sec) => io.observe(sec));
}

export function screenSettings() {
  document.title = 'Settings · Padala';
  const notif = 'Notification' in window ? Notification.permission : 'unsupported';
  const row = (_, title, text, action = '') => `<div class="set-row"><span class="grow"><b>${title}</b><span>${text}</span></span>${action}</div>`;
  const nav = [['profile', 'Profile'], ['appearance', 'Appearance'], ['notifications', 'Notifications'], ['dala', 'Dala'], ['security', 'Security'], ['storage', 'Storage'], ['app', 'This app']];
  layout(`<div class="screen screen--page">
    <header class="page-head"><h1>Settings</h1></header>
    <div class="settings">
    <nav class="settings-nav" aria-label="Settings sections">${nav.map(([id, label], i) => `<a href="#set-${id}" data-set-link="${id}" class="${i === 0 ? 'is-on' : ''}">${label}</a>`).join('')}</nav>
    <div class="settings-body">
    <section class="profile card" id="set-profile">
      <button class="avatar-edit" data-photo aria-label="Change profile photo">${avatarHtml(S.me, 'avatar--xl')}<span class="avatar-cam">${icon.image({ size: 14 })}</span></button>
      <span class="grow stack" style="gap:2px;min-width:0"><b style="font-size:19px">${esc(S.me.name)}</b><span class="muted">@${esc(S.me.username)}</span>
        <span class="row" style="gap:4px;font-size:13px;color:var(--pd-muted)"><span class="dot dot--on"></span>Online · ${S.teams.length} team${S.teams.length === 1 ? '' : 's'}</span>
        <span class="row" style="gap:12px;margin-top:4px"><button class="linkish" data-photo>${S.me.avatarV ? 'Change photo' : 'Add a photo'}</button>${S.me.avatarV ? '<button class="linkish linkish--muted" data-photo-remove>Remove</button>' : ''}</span></span>
    </section>
    <section class="stack" id="set-appearance"><span class="label">Appearance</span>
      <div class="card card--flush set-list">
        ${row(null, 'Theme', 'Light or dark.', `<div class="seg seg--sm" role="radiogroup" aria-label="Appearance">${[['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => `<label><input type="radio" name="theme" value="${v}" ${(window.padalaTheme?.get() || 'light') === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>`)}
        ${row(null, 'Language', 'The language Padala uses on this device.', `<div class="seg seg--sm" role="radiogroup" aria-label="Language">${Object.entries(LANGS).map(([v, l]) => `<label translate="no"><input type="radio" name="lang" value="${v}" ${getLang() === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>`)}
      </div>
    </section>
    <section class="stack" id="set-notifications"><span class="label">Notifications</span>
      <div class="card card--flush set-list">
        ${row(null, 'Notifications', !pushSupported()
          ? (isIOS() && !isStandalone() ? 'On iPhone, add Padala to your Home Screen first, then turn them on there.' : 'This browser can’t show notifications.')
          : notif === 'granted' ? 'On. New files and messages pop up on this device, even when Padala is closed.'
          : notif === 'denied' ? 'Blocked. Allow them in your browser’s site settings, then come back here.'
          : 'Get a pop-up when files or messages arrive, even when Padala is closed.',
        notif === 'granted' ? `<button class="switch is-on" role="switch" aria-checked="true" data-notif-off aria-label="Notifications"><i></i></button>`
          : notif === 'default' && pushSupported() ? '<button class="btn btn--sm btn--primary" data-notify-on>Turn on</button>' : '')}
      </div>
    </section>
    <section class="stack" id="set-dala"><span class="label">Dala</span>
      <div class="card card--flush set-list">
        ${row(null, 'Dala, the helper robot', 'Carries your files, checks your folders and gives tips.', `<button class="switch ${dalaEnabled() ? 'is-on' : ''}" role="switch" aria-checked="${dalaEnabled()}" data-dala-toggle aria-label="Show Dala"><i></i></button>`)}
        ${row(null, 'Opening animation', 'Dala says hello when you open Padala. <button class="linkish" data-replay>Play it now</button>', `<button class="switch ${introEnabled() ? 'is-on' : ''}" role="switch" aria-checked="${introEnabled()}" data-intro-toggle aria-label="Opening animation"><i></i></button>`)}
      </div>
    </section>
    <section class="stack" id="set-security"><span class="label">Security</span>
      <div class="card card--flush set-list">
        ${row(null, 'Password', 'Change your password. Your files stay unlocked.', '<button class="btn btn--sm" data-change-password>Change</button>')}
        ${row(null, 'Recovery code', S.hasRecovery ? 'Set up. It lets you reset a forgotten password without losing your files.' : 'Not set up yet. Without it, a forgotten password means losing access to your files.', S.hasRecovery ? '<button class="btn btn--sm" data-setup-recovery>Renew</button>' : '<button class="btn btn--sm btn--primary" data-setup-recovery>Set up</button>')}
        ${row(null, 'Key backup', S.backupOn ? 'On. Sign in on a new phone or computer and your teams unlock automatically.' : 'Off on this device. Turn it on so your other devices unlock automatically.', S.backupOn ? `<span class="pill pill--on">${icon.check({ size: 13, width: 3 })} On</span>` : '<button class="btn btn--sm btn--primary" data-confirm-password="backup">Turn on</button>')}
        ${S.keys ? row(null, 'Team key for another device', `Sign in on the other device, then paste this key there. It unlocks <b>${esc(S.team.name)}</b>’s files.`, '<button class="btn btn--sm" data-show-key>Show key</button>') : row(null, 'Team key', 'This device doesn’t have the key for this team yet.', '<button class="btn btn--sm" data-confirm-password="unlock">Unlock</button>')}
        ${row(null, 'Encrypted on this device', 'Files and messages are locked before they leave. The server can’t read them.')}
      </div>
    </section>
    <section class="stack" id="set-storage"><span class="label">Storage</span>
      <div class="card card--flush set-list">
        ${row(null, `Storage for ${esc(S.team.name)}`, 'See how much space your files use, and clear old versions.', '<a class="btn btn--sm" href="#/team" data-go-storage>Manage</a>')}
      </div>
    </section>
    <section class="stack" id="set-app"><span class="label">This app</span>
      <div class="card card--flush set-list">
        <div data-install-slot="settings">${installHtml('settings')}</div>
        ${(S.publicUrl && !matchMedia('(pointer: coarse)').matches) || isLocalHost() ? row(null, 'Open on your phone', S.publicUrl ? `Scan a QR code to open <b>${esc(S.publicUrl.replace(/^https:\/\//, ''))}</b> on your phone.` : 'Start Padala with <b>npm run share</b> to get an https address your phone can open.', '<button class="btn btn--sm" data-open-phone>Show</button>') : ''}
        ${row(null, 'Padala', 'Send project folders to your team. Made by Mukramin Bariwa Ansao.')}
      </div>
    </section>
    <button class="btn btn--danger signout" data-signout>${icon.logout({ size: 16 })} Sign out</button>
    </div>
    </div>
  </div>`);
  wireSettingsNav();
  app.querySelector('[data-signout]').onclick = signOut;
  app.querySelectorAll('input[name=theme]').forEach((r) => r.addEventListener('change', () => window.padalaTheme?.set(r.value)));
  app.querySelectorAll('input[name=lang]').forEach((r) => r.addEventListener('change', () => { if (r.value !== getLang()) setLang(r.value); }));
  app.querySelectorAll('[data-photo]').forEach((b) => { b.onclick = () => pickProfilePhoto(); });
  app.querySelector('[data-photo-remove]')?.addEventListener('click', async () => {
    try { await api.del('/api/me/avatar'); S.me.avatarV = null; screenSettings(); toast('Photo removed.'); } catch (err) { toast(esc(err.message), { error: true }); }
  });
  app.querySelector('[data-dala-toggle]').onclick = (e) => {
    setDalaEnabled(!dalaEnabled());
    const b = e.currentTarget;
    b.classList.toggle('is-on', dalaEnabled());
    b.setAttribute('aria-checked', dalaEnabled());
    if (dalaEnabled()) react('poke');
  };
  app.querySelector('[data-intro-toggle]').onclick = (e) => {
    setIntroEnabled(!introEnabled());
    e.currentTarget.classList.toggle('is-on', introEnabled());
    e.currentTarget.setAttribute('aria-checked', introEnabled());
  };
  app.querySelector('[data-open-phone]')?.addEventListener('click', () => {
    if (S.publicUrl) { showQr(S.publicUrl, { title: 'Open Padala on your phone', text: 'Point your phone’s camera at the code, then sign in or join with an invite link.' }); return; }
    dialog(`<h2>Open Padala on your phone</h2>
      <p class="muted" style="font-size:14.5px">Phones need a secure <b>https</b> address, and right now Padala only runs at <b>localhost</b> on this computer.</p>
      <ol class="howto"><li>In the window where Padala is running, press <b>Ctrl+C</b> to stop it.</li>
        <li>Run <b>npm run share</b> in the padala folder.</li>
        <li>Scan the QR code it shows with your phone. It works on Wi-Fi or mobile data.</li></ol>
      <div class="row" style="justify-content:flex-end"><button class="btn btn--primary">Got it</button></div>`);
  });
  app.querySelector('[data-replay]').onclick = () => runIntro({ who: Promise.resolve(S.me), replay: true });
  app.querySelector('[data-notif-off]')?.addEventListener('click', async (e) => {
    const b = e.currentTarget;
    if (b.classList.contains('is-on')) {
      await unsubscribePush();
      b.classList.remove('is-on'); b.setAttribute('aria-checked', 'false');
      toast('Notifications are off on this device.');
    } else {
      await subscribePush();
      b.classList.add('is-on'); b.setAttribute('aria-checked', 'true');
      toast('Notifications are on.');
    }
  });
  app.querySelector('[data-show-key]')?.addEventListener('click', (e) => {
    const key = storedKeys()[S.team.id];
    const box = document.createElement('div');
    box.className = 'stack key-reveal';
    box.innerHTML = `<div class="key-box">${esc(key)}</div><div class="row"><button class="btn btn--sm" data-copy-key>${icon.copy({ size: 14 })} Copy</button><span class="hint">Keep it private. It unlocks your team’s files.</span></div>`;
    e.target.closest('.set-row').after(box);
    e.target.remove();
    box.querySelector('[data-copy-key]').onclick = () => copyText(key);
  });
}
