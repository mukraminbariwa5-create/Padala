// Sign in, create an account, reset a password, first team, and joining from an invite link.
import { generateTeamKey, importTeamKey, isValidKeyFormat } from '../crypto.js';
import { deriveBackupKey, deriveRecoveryKey, forgetBackupKey, lockAccountKey, unlockAccountKey } from '../keyring.js';
import { esc, icon, toast, dialog, field, fieldError, withLoading } from '../ui.js';
import { storeKey, activateTeam, syncKeys, setUpRecovery } from './keys.js';
import { stopEvents, connectEvents } from './live.js';
import { subscribePush, unsubscribePush } from './push.js';
import { current, route, skeletonHtml, authLayout, layout, loadOtherUnread } from './shell.js';
import { api, app, S } from './state.js';

export function screenForgot() {
  authLayout(`
      <a class="brand" href="#/"><img src="/icons/icon-64.png" alt="">Padala</a>
      <div class="stack" style="gap:4px"><h1>Reset your password</h1>
        <p class="muted" style="font-size:15px">Use the recovery code you saved when you created your account. Your files stay unlocked.</p></div>
      <form class="stack" novalidate>
        ${field({ id: 'fg-user', name: 'username', label: 'Username', icon: 'at', maxlength: 32, autocomplete: 'username', autofocus: true })}
        ${field({ id: 'fg-code', name: 'code', label: 'Recovery code', icon: 'key', maxlength: 40, autocomplete: 'off', mono: true })}
        ${field({ id: 'fg-pass', name: 'password', type: 'password', label: 'New password', icon: 'lock', minlength: 8, maxlength: 128, autocomplete: 'new-password', strength: true, hint: 'At least 8 characters.' })}
        <div class="form-error" role="alert" hidden></div>
        <button class="btn btn--primary btn--big btn--block" type="submit">Reset password</button>
      </form>
      <p class="hint">No recovery code? A password can’t be reset without it, because nobody else can unlock your files. You can create a new account and ask your team for a new invite.</p>
      <a class="linkish" href="#/signin" style="align-self:flex-start">${icon.back({ size: 14 })} Back to sign in</a>`);
  const form = app.querySelector('form');
  const errEl = form.querySelector('.form-error');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.hidden = true;
    const fd = Object.fromEntries(new FormData(form));
    if (!String(fd.username || '').trim()) return fieldError(form, 'username', 'Enter your username.');
    if (String(fd.code || '').replace(/[^a-z0-9]/gi, '').length < 20) return fieldError(form, 'code', 'Enter the whole recovery code.');
    if (String(fd.password || '').length < 8) return fieldError(form, 'password', 'Use at least 8 characters.');
    await withLoading(form.querySelector('button[type=submit]'), async () => {
      try {
        const start = await api.post('/api/recovery/start', { username: fd.username, code: fd.code });
        let amk = null;
        let amkPw;
        if (start.amkRc) {
          amk = await unlockAccountKey(await deriveRecoveryKey(fd.code, start.salt), start.amkRc);
          amkPw = await lockAccountKey(await deriveBackupKey(String(fd.password), start.salt), amk);
        }
        await api.post('/api/recovery/finish', { token: start.token, password: fd.password, amkPw });
        if (amk) S.backupKey = amk;
        await afterSignIn({ password: String(fd.password) });
        location.hash = '#/';
        route();
        toast('Password reset. Welcome back!');
      } catch (err) {
        if (/recovery code/i.test(err.message)) return fieldError(form, 'code', err.message);
        errEl.innerHTML = `${icon.alert({ size: 18 })}<span>${esc(err.message)}</span>`;
        errEl.hidden = false;
      }
    });
  });
}

/** On the public portfolio demo, say so on the sign-in screen: it's shared and gets erased. */
export function showDemoNote() {
  if (!S.publicDemo) return;
  const form = app.querySelector('.tabs + form');
  if (!form || app.querySelector('.demo-note')) return;
  form.insertAdjacentHTML('beforebegin', '<p class="hint demo-note" role="note" style="padding:10px 12px;border-radius:10px;background:var(--pd-surface-3, rgba(127,127,127,.12))"><b>Public demo.</b> Create a test account with any username to try Padala. Everything here is erased whenever the demo restarts, so don’t upload real files or reuse a real password.</p>');
}

export function screenAuth(mode, { invite } = {}) {
  const up = mode === 'signup';
  authLayout(`
      <a class="brand" href="#/"><img src="/icons/icon-64.png" alt="">Padala</a>
      <div class="stack" style="gap:4px">
        <h1>${invite ? `Join ${esc(invite.team.name)}` : up ? 'Create your account' : 'Welcome back'}</h1>
        <p class="muted" style="font-size:15px">${invite ? `${esc(invite.invitedBy)} invited you. Create an account (or sign in) to join.` : up ? 'It takes a minute. Then invite your partner and start sending.' : 'Sign in to see your projects and new files.'}</p>
      </div>
      <nav class="tabs" aria-label="Account" data-active="${up ? 0 : 1}">
        <a href="${invite ? '#' : '#/signup'}" data-mode="signup" ${up ? 'aria-current="page"' : ''}>Create account</a>
        <a href="${invite ? '#' : '#/signin'}" data-mode="signin" ${!up ? 'aria-current="page"' : ''}>Sign in</a>
      </nav>
      <form class="stack" novalidate>
        ${up ? field({ id: 'f-name', name: 'name', label: 'Full name', icon: 'user', maxlength: 60, autocomplete: 'name', validate: 'name', autofocus: true }) : ''}
        ${field({ id: 'f-user', name: 'username', label: 'Username', icon: 'at', maxlength: 32, autocomplete: 'username', validate: 'username', hint: up ? 'Letters, numbers, dots, dashes or underscores (3–32).' : '', autofocus: !up })}
        ${field({ id: 'f-pass', name: 'password', type: 'password', label: 'Password', icon: 'lock', minlength: 8, maxlength: 128, autocomplete: up ? 'new-password' : 'current-password', strength: up, hint: up ? 'At least 8 characters.' : '' })}
        ${up ? '' : '<a class="forgot-link" href="#/forgot">Forgot password?</a>'}
        <div class="form-error" role="alert" hidden></div>
        <button class="btn btn--primary btn--big btn--block" type="submit">${up ? 'Create account' : 'Sign in'} ${icon.send({ size: 18, width: 2.4 })}</button>
      </form>
      <p class="hint" style="display:flex;gap:8px;align-items:center">${icon.lock({ size: 14 })} Files and messages are encrypted on your device before they’re sent.</p>`);
  showDemoNote();
  const tabs = app.querySelector('.tabs');
  app.querySelectorAll('[data-mode]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    tabs.dataset.active = a.dataset.mode === 'signup' ? '0' : '1';
    setTimeout(() => { if (invite) screenAuth(a.dataset.mode, { invite }); else location.hash = `#/${a.dataset.mode}`; }, 160);
  }));
  const form = app.querySelector('form');
  const errEl = form.querySelector('.form-error');
  (form.querySelector('[data-autofocus]') || form.querySelector('input')).focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.hidden = true;
    const fd = Object.fromEntries(new FormData(form));
    // Check the obvious things here, next to the right field, before asking the server
    if (up && !String(fd.name || '').trim()) return fieldError(form, 'name', 'Please enter your name.');
    if (!/^[a-z0-9._-]{3,32}$/i.test(String(fd.username || '').trim())) return fieldError(form, 'username', up ? 'Use 3–32 letters, numbers, dots, dashes or underscores.' : 'Enter your username.');
    if (String(fd.password || '').length < (up ? 8 : 1)) return fieldError(form, 'password', up ? 'Use at least 8 characters.' : 'Enter your password.');
    await withLoading(form.querySelector('button[type=submit]'), async () => {
      try {
        await api.post(up ? '/api/signup' : '/api/login', fd);
        await afterSignIn({ password: String(fd.password) });
        if (up) await setUpRecovery({ password: String(fd.password), afterSignup: true });
        if (invite) screenJoin(current); else { location.hash = '#/'; route(); }
      } catch (err) {
        if (/taken|Username/.test(err.message)) return fieldError(form, 'username', err.message);
        if (/password|match/i.test(err.message) && !/Too many/.test(err.message)) {
          fieldError(form, 'password', err.message);
          return;
        }
        errEl.innerHTML = `${icon.alert({ size: 18 })}<span>${esc(err.message)}</span>`;
        errEl.hidden = false;
      }
    });
  });
}

export async function afterSignIn({ password } = {}) {
  const me = await api.get('/api/me');
  S.me = me.user;
  S.teams = me.teams;
  S.online = new Set(me.online);
  try { await syncKeys({ password }); } catch { /* backup is best effort */ }
  subscribePush();
  const saved = Number(localStorage.getItem('padala.team'));
  const team = me.teams.find((t) => t.id === saved) || me.teams[0];
  if (team) await activateTeam(team);
  connectEvents();
  loadOtherUnread();
}

export function screenSetup() {
  authLayout(`
      <a class="brand" href="#/"><img src="/icons/icon-64.png" alt="">Padala</a>
      <h1>Hi, ${esc(S.me.name.split(' ')[0])}.<span class="muted">Let’s set up your team.</span></h1>
      <p class="muted">A team is you and the people you build websites with. Everything you send is shared only inside it.</p>
      <button class="choice" data-create><strong>Start a new team</strong><span>You’ll get an invite link to send to your partner.</span></button>
      <button class="choice" data-paste><strong>I have an invite link</strong><span>Your partner already started a team.</span></button>
      <button class="btn" data-signout style="align-self:flex-start">${icon.logout({ size: 16 })} Sign out</button>
    `);
  app.querySelector('[data-create]').onclick = createTeam;
  app.querySelector('[data-signout]').onclick = signOut;
  app.querySelector('[data-paste]').onclick = joinByLink;
}

export async function joinByLink() {
  const data = await dialog(`<h2>Join a team with a link</h2>
    <p class="muted" style="font-size:14px">Paste the invite link someone sent you.</p>
    ${field({ id: 'il', name: 'link', label: 'Invite link', icon: 'link', placeholder: 'https://…/#/join/…', autofocus: true })}
    <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn btn--primary">Continue</button></div>`);
  if (!data) return;
  const m = String(data.get('link')).replace(/\s+/g, '').match(/#\/join\/[^/]+\/[A-Za-z0-9_%-]+/);
  if (!m) { toast('That doesn’t look like a Padala invite link.', { error: true }); return; }
  location.hash = m[0];
}

export async function createTeam() {
  const data = await dialog(`<h2>Name your team</h2>
    <p class="muted" style="font-size:14px">One team per person or topic you work with, like your web partner, or a group of thesis clients. Each team only sees its own files.</p>
    ${field({ id: 'tn', name: 'name', label: 'Team name', icon: 'users', maxlength: 60, validate: 'name', autofocus: true })}
    <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn btn--primary">Create team</button></div>`,
    { onOpen: (d) => d.querySelector('input').focus() });
  if (!data) return;
  try {
    const key = generateTeamKey();
    const keys = await importTeamKey(key);
    const { team } = await api.post('/api/teams', { name: data.get('name'), keyCheck: keys.check });
    storeKey(team.id, key);
    S.teams.push(team);
    syncKeys().catch(() => {});
    await activateTeam(team);
    location.hash = '#/team';
    route();
    toast('Team created. Now invite your partner.');
  } catch (err) { toast(esc(err.message), { error: true }); }
}

export async function signOut() {
  await unsubscribePush();
  if (S.me) await forgetBackupKey(S.me.id);
  S.backupKey = null;
  S.backupOn = false;
  await api.post('/api/logout').catch(() => {});
  stopEvents();
  Object.assign(S, { me: null, teams: [], team: null, keys: null, projects: [] });
  location.hash = '#/signin';
  route();
}

export async function screenJoin(r) {
  layout(skeletonHtml('page', 'Opening the invite…'), { sidebar: false });
  let invite;
  try { invite = await api.get(`/api/invites/${encodeURIComponent(r.token)}`); } catch (err) {
    authLayout(`<a class="brand" href="#/"><img src="/icons/icon-64.png" alt="">Padala</a><h1>Invite not found.<span class="muted">${esc(err.message)}</span></h1><a class="btn" href="#/">Go to Padala</a>`);
    return;
  }
  if (!isValidKeyFormat(r.key)) {
    const noKey = /^(undefined|null)?$/.test(r.key);
    authLayout(`<a class="brand" href="#/"><img src="/icons/icon-64.png" alt="">Padala</a>
      <div class="stack" style="gap:8px"><h1>This link can’t be used</h1>
      <p class="muted">${noKey
        ? `It was created on a device that doesn’t have your team’s secret key, so the key part is missing. Ask ${esc(invite.invitedBy)} to open Padala on the device where the team was created and make a new invite link.`
        : 'Part of the link is missing. Copy the whole invite link again with the <b>Copy link</b> button and paste it here.'}</p></div>
      <a class="btn" href="#/">Go to Padala</a>`);
    return;
  }
  if (!S.me) return screenAuth('signup', { invite });
  if ((invite.expired || invite.used) && !invite.alreadyMember) {
    authLayout(`<a class="brand" href="#/"><img src="/icons/icon-64.png" alt="">Padala</a><h1>This invite ${invite.used ? 'was already used' : 'has expired'}.<span class="muted">Ask ${esc(invite.invitedBy)} for a new link.</span></h1><a class="btn" href="#/">Go to Padala</a>`);
    return;
  }
  authLayout(`
      <a class="brand" href="#/"><img src="/icons/icon-64.png" alt="">Padala</a>
      <h1>Join ${esc(invite.team.name)}<span class="muted">${esc(invite.invitedBy)} invited you.</span></h1>
      <p class="muted">You’ll see the team’s projects, chat, and deliveries. The link also carries the team’s secret key, which stays on this device.</p>
      <p class="error" role="alert" hidden></p>
      <button class="btn btn--primary btn--big btn--block" data-accept>Join team</button>
    `);
  app.querySelector('[data-accept]').onclick = async (e) => {
    e.target.disabled = true;
    try {
      const { team } = await api.post(`/api/invites/${encodeURIComponent(r.token)}/accept`);
      const keys = await importTeamKey(r.key);
      if (keys.check !== team.keyCheck) throw new Error('The key in this link doesn’t match the team. Ask for a new invite link.');
      storeKey(team.id, r.key);
      await afterSignIn();
      await activateTeam(S.teams.find((t) => t.id === team.id) || team);
      history.replaceState(null, '', '#/'); // don't leave the key in the address bar / history
      route();
      toast(`You joined ${esc(team.name)}.`);
    } catch (err) {
      const el = app.querySelector('.error');
      el.textContent = err.message;
      el.hidden = false;
      e.target.disabled = false;
    }
  };
}
