// Dala, Padala's little helper robot.
// Lives in the corner, reacts to what's happening (choosing files, sending, signal drops, new files…),
// blinks, looks toward the pointer, dozes off when you're away, and says short, useful things.
import { esc } from './ui.js';

const POSES = [
  'neutral', 'happy', 'wink', 'surprised', 'sad', 'sleep', 'thumbs', 'point', 'love', 'confused', 'dizzy', 'glad',
  'laptop', 'working', 'run', 'ready', 'content', 'shy', 'cheer', 'teary', 'cool', 'hush', 'excited', 'winkpoint',
  'dash', 'heart', 'angry', 'alert', 'question', 'hello', 'wave',
];
const IDLE = ['glad', 'wink', 'thumbs', 'cool', 'hush', 'winkpoint'];
export const pose = (name) => `/img/dala/${name}.webp`;

const TIPS = [
  'Tip: after the first time, Padala only sends the files you changed.',
  'Tip: if the signal drops, I just wait and keep going. Nothing is lost.',
  'Tip: your files are locked with your team’s secret key before they leave this device.',
  'Tip: use the status under the project name to mark it “Given to client” or “Paid”.',
  'Tip: saved a project into a folder once? Next time it’s one click: Update my copy.',
  'Tip: you can drag a folder straight onto the Choose folder box.',
];

const state = {
  el: null, img: null, bubble: null, text: null,
  base: 'neutral', current: 'neutral', hold: null, holdUntil: 0,
  talkTimer: 0, blinkTimer: 0, idleTimer: 0, asleep: false, tip: 0, pokes: [],
  enabled: true, reduced: false,
};

function preload() {
  for (const p of POSES) { const i = new Image(); i.src = pose(p); }
}

export function mountDala() {
  if (state.el) return;
  state.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  try { state.enabled = localStorage.getItem('padala.dala') !== 'off'; } catch { /* storage off */ }
  const el = document.createElement('div');
  el.className = 'dala';
  el.innerHTML = `
    <div class="dala-bubble" role="status" aria-live="polite" hidden>
      <span class="dala-text"></span>
      <span class="dala-actions" hidden></span>
      <button class="dala-x" type="button" aria-label="Hide message">×</button>
    </div>
    <button class="dala-bot" type="button" aria-label="Dala, your Padala helper. Click for a tip.">
      <span class="dala-floor"></span><img alt="" src="${pose('neutral')}" draggable="false">
      <span class="dala-parcel" aria-hidden="true">${parcelSvg()}<i></i></span>
    </button>`;
  document.body.append(el);
  Object.assign(state, {
    el, img: el.querySelector('img'), bubble: el.querySelector('.dala-bubble'), text: el.querySelector('.dala-text'),
    actions: el.querySelector('.dala-actions'),
  });
  el.querySelector('.dala-x').onclick = () => { quiet(); flash('shy', 1400); };
  el.querySelector('.dala-bot').onclick = () => {
    wake();
    const now = Date.now();
    state.pokes = state.pokes.filter((t) => now - t < 6000).concat(now);
    if (state.pokes.length >= 6) { state.pokes = []; flash('angry', 2200); say('Hey! That tickles.', { ms: 3000 }); return; }
    state.tip = (state.tip + 1) % TIPS.length;
    react('poke');
  };
  // the other poses download later, when the page is idle (they aren't needed to start)
  setTimeout(() => (window.requestIdleCallback || setTimeout)(preload), 4000);
  setVisible(state.enabled);
  scheduleBlink();
  resetIdle();
  for (const ev of ['pointermove', 'keydown', 'pointerdown', 'scroll']) window.addEventListener(ev, onActivity, { passive: true });
  window.addEventListener('pointermove', lookAt, { passive: true });
}

export function dalaEnabled() { return state.enabled; }

/** The opening animation already greeted the person: don't say hello twice. */
export function skipWelcome() { seen.add('welcome'); }

/** Keep the corner Dala out of sight until the opening animation is over. */
export function holdDala(promise) {
  if (!state.el) return;
  state.el.classList.add('is-held');
  promise.finally(() => setTimeout(() => state.el.classList.remove('is-held'), 350));
}

export function setDalaEnabled(on) {
  state.enabled = on;
  try { localStorage.setItem('padala.dala', on ? 'on' : 'off'); } catch { /* ignore */ }
  setVisible(on);
}

function setVisible(on) {
  if (state.el) state.el.hidden = !on;
}

/** Hide Dala on screens that already show a big Dala (sign-in, success pages…). */
export function dalaAway(away) {
  if (state.el) state.el.classList.toggle('is-away', !!away);
}

function show(name, { bounce = true } = {}) {
  if (!state.img || state.current === name) return;
  state.current = name;
  state.img.src = pose(name);
  state.el.dataset.pose = name;
  if (bounce && !state.reduced) {
    state.el.classList.remove('pop');
    void state.el.offsetWidth;
    state.el.classList.add('pop');
  }
}

/** The pose Dala returns to between reactions (e.g. running while a transfer is going). */
export function dalaBase(name) {
  state.base = name;
  state.hold = null;
  state.holdUntil = 0;
  show(name);
}

/**
 * Say something. actions: [{ label, href? , onClick?, primary? }] become buttons in the bubble,
 * so Dala can offer the next step (Get files, Remind them…) instead of only talking.
 */
export function say(html, { ms = 6000, actions = [] } = {}) {
  if (!state.bubble || !state.enabled) return;
  clearTimeout(state.talkTimer);
  state.text.innerHTML = html;
  state.actions.hidden = !actions.length;
  state.actions.innerHTML = '';
  for (const a of actions) {
    const b = document.createElement(a.href ? 'a' : 'button');
    b.className = `dala-act${a.primary ? ' dala-act--main' : ''}`;
    b.textContent = a.label;
    if (a.href) b.href = a.href; else b.type = 'button';
    b.addEventListener('click', (e) => { if (!a.href) e.preventDefault(); quiet(); a.onClick?.(); });
    state.actions.append(b);
  }
  if (actions.length && ms) ms = Math.max(ms, 14000);
  state.bubble.hidden = false;
  state.el.classList.add('is-talking');
  state.bubble.classList.remove('in');
  void state.bubble.offsetWidth;
  state.bubble.classList.add('in');
  if (ms) state.talkTimer = setTimeout(quiet, ms);
}

export function quiet() {
  clearTimeout(state.talkTimer);
  state.el?.classList.remove('is-talking');
  if (state.bubble) state.bubble.hidden = true;
}

/** Show a pose for a while, then go back to the base pose. */
function flash(name, ms = 2600) {
  state.hold = name;
  state.holdUntil = Date.now() + ms;
  show(name);
  setTimeout(() => {
    if (state.hold === name && Date.now() >= state.holdUntil) { state.hold = null; show(state.base); }
  }, ms);
}

/** The little package Dala carries: a box with Padala's lock on it. */
export function parcelSvg() {
  return `<svg viewBox="0 0 48 44" width="100%" height="100%" aria-hidden="true">
    <path d="M24 2 45 11v22L24 42 3 33V11Z" fill="#11201a" stroke="#62f28a" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M3 11 24 20 45 11M24 20v22" fill="none" stroke="#62f28a" stroke-width="1.6" stroke-linejoin="round" opacity=".75"/>
    <path d="M13.5 6.5 34.5 15.5V22" fill="none" stroke="#62f28a" stroke-width="3" opacity=".35"/>
    <rect x="8.5" y="24.5" width="10" height="8" rx="1.8" fill="#62f28a"/>
    <path d="M10.8 24.5v-2.3a2.7 2.7 0 0 1 5.4 0v2.3" fill="none" stroke="#62f28a" stroke-width="1.7"/>
  </svg>`;
}

/**
 * Files just arrived for you: Dala dashes in from the edge of the screen carrying a package,
 * drops it, and offers to open it.
 */
export function deliver({ name = 'your partner', project = '', count = 0, href } = {}) {
  if (!state.el || !state.enabled) return;
  wake();
  const parcel = state.el.querySelector('.dala-parcel i');
  parcel.textContent = count ? String(count > 99 ? '99+' : count) : '';
  parcel.hidden = !count;
  state.el.classList.remove('is-delivering', 'is-dropped');
  void state.el.offsetWidth;
  if (!state.reduced) state.el.classList.add('is-delivering');
  dalaBase('dash');
  const land = () => {
    state.el.classList.add('is-dropped');
    state.el.classList.remove('is-delivering');
    dalaBase('neutral');
    flash('alert', 3800);
    say(`<b>${esc(name)}</b> sent you ${project ? `new files for <b>${esc(project)}</b>` : 'new files'}!`, {
      ms: 20000,
      actions: href ? [{ label: 'Get files', href, primary: true }, { label: 'Later' }] : [],
    });
    setTimeout(() => state.el?.classList.remove('is-dropped'), 20000);
  };
  if (state.reduced) land(); else setTimeout(land, 1150);
}

const seen = new Set();
/** Say something only the first time in this browser tab. */
const once = (key) => { if (seen.has(key)) return false; seen.add(key); return true; };

/**
 * Everything Dala reacts to. Screens call react('event', details).
 * Persistent states (sending, checking, offline) change the base pose; one-off moments flash a pose.
 */
export function react(event, d = {}) {
  if (!state.el) return;
  const who = esc(d.name || 'your partner');
  switch (event) {
    case 'welcome':
      if (!once('welcome')) { dalaBase('neutral'); break; }
      dalaBase('neutral'); flash('hello', 3200);
      say(`Hi ${esc(d.me || '')}! I’m <b>Dala</b>. Whenever a project is ready, tap <b>Send files</b> and I’ll carry it.`, { ms: 8000 });
      break;
    case 'invite-first':
      if (once('invite-first')) { flash('point', 4000); say('First, invite your partner. Create the link and send it on Messenger.', { ms: 7000 }); }
      break;
    case 'send-choose':
      dalaBase('point');
      if (once('send-choose')) say('Pick the <b>whole project folder</b>. I’ll check what’s inside first.', { ms: 7000 });
      break;
    case 'checking':
      dalaBase('laptop'); say('Checking your files…', { ms: 0 });
      break;
    case 'review':
      dalaBase('neutral'); quiet();
      if (d.nothing) { flash('confused', 4000); say('Hmm, nothing changed since last time. Did you save your edits?', { ms: 7000 }); }
      else if (d.changed) { flash('cool', 3500); say(`Only <b>${d.changed}</b> file${d.changed === 1 ? '' : 's'} changed. Less for me to carry!`, { ms: 6000 }); }
      else { flash('thumbs', 3500); say('All set. Add a message if you like, then press <b>Send</b>.', { ms: 6000 }); }
      break;
    case 'sending':
      dalaBase('run'); say(`On my way to ${who}!`, { ms: 4000 });
      break;
    case 'offline':
      dalaBase('surprised'); say('The signal is gone! Don’t worry, I’ll wait right here and continue.', { ms: 0 });
      setTimeout(() => { if (state.base === 'surprised') dalaBase('sad'); }, 6000);
      break;
    case 'online':
      dalaBase(d.receiving ? 'working' : 'run'); flash('excited', 1800); say('We’re back! Continuing where we stopped.', { ms: 4000 });
      break;
    case 'sent':
      dalaBase('neutral'); flash('cheer', 5000); say(`Delivered! ${who} will get a notification.`, { ms: 6000 });
      break;
    case 'new-files':
      deliver({ name: d.name, project: d.project, count: d.count, href: d.href });
      break;
    case 'checkup':
      dalaBase('neutral');
      if (d.warn) { flash('alert', 4000); say(`I looked through the folder and found <b>${d.warn}</b> thing${d.warn === 1 ? '' : 's'} to check before sending.`, { ms: 8000 }); }
      else if (d.info) { flash('point', 3500); say('I looked through the folder. A few optional things to tidy up, see below.', { ms: 7000 }); }
      break;
    case 'nudge':
      flash(d.pose || 'point', 3500); say(d.html, { ms: 16000, actions: d.actions || [] });
      break;
    case 'setup-notes':
      if (once('setup-notes')) { flash('winkpoint', 3000); say('I wrote <b>setup notes</b> for this project. Copy them for the client when you hand it over.', { ms: 8000 }); }
      break;
    case 'get-files':
      dalaBase('point');
      if (once('get-files')) { say('<b>Save to a folder</b> is easiest: next time, updates are one click.', { ms: 8000 }); }
      break;
    case 'receiving':
      dalaBase('working'); say('Bringing the files to you…', { ms: 4000 });
      break;
    case 'received':
      dalaBase('neutral'); flash('cheer', 5000); say('All saved! My setup notes below show how to open it.', { ms: 7000 });
      break;
    case 'conflict':
      flash('confused', 5000); say(`You and ${who} both changed something. You decide which to keep.`, { ms: 8000 });
      break;
    case 'message':
      flash('glad', 2400); say(`New message from ${who}.`, { ms: 4000 });
      break;
    case 'partner-online':
      if (state.base === 'neutral') { flash('hello', 2400); say(`${who} just came online.`, { ms: 4000 }); }
      break;
    case 'joined':
      flash('love', 4000); say(`${who} joined your team!`, { ms: 6000 });
      break;
    case 'error':
      dalaBase('neutral'); flash('dizzy', 3500); say(`Oops. ${esc(d.message || 'Something went wrong.')}`, { ms: 7000 });
      break;
    case 'preview':
      if (once('preview')) { flash('cool', 2600); say('Take a look! It’s unlocked only on this screen until you download it.', { ms: 5000 }); }
      break;
    case 'deleted':
      flash('sad', 3000); say('Deleted. Anything you already downloaded is still on your computer.', { ms: 6000 });
      break;
    case 'team-switched':
      flash('hello', 2400); say(`Now in <b>${who}</b>.`, { ms: 3500 });
      break;
    case 'calm':
      dalaBase('neutral'); quiet();
      break;
    case 'poke':
      flash('wink', 1800); say(TIPS[state.tip], { ms: 7000 });
      break;
    default:
      break;
  }
}

// ---------- idle life: blinking, looking at the pointer, dozing off ----------

function scheduleBlink() {
  clearTimeout(state.blinkTimer);
  state.blinkTimer = setTimeout(() => {
    const talking = state.bubble && !state.bubble.hidden;
    if (state.base === 'neutral' && state.current === 'neutral' && !state.asleep && !talking && !document.hidden) {
      flash(IDLE[Math.floor(Math.random() * IDLE.length)], 1500);
    }
    scheduleBlink();
  }, 12000 + Math.random() * 12000);
}

function resetIdle() {
  clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => {
    if (state.base !== 'neutral') return resetIdle(); // never doze during a transfer
    state.asleep = true;
    state.el.classList.add('asleep');
    show('sleep');
    quiet();
  }, 90000);
}

function wake() {
  if (!state.asleep) return;
  state.asleep = false;
  state.el.classList.remove('asleep');
  flash('happy', 1600);
}

function onActivity() {
  wake();
  resetIdle();
}

let lookFrame = 0;
function lookAt(e) {
  if (state.reduced || lookFrame) return;
  lookFrame = requestAnimationFrame(() => {
    lookFrame = 0;
    const r = state.el.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    const tilt = Math.max(-8, Math.min(8, dx / 60));
    const lean = Math.max(-4, Math.min(4, dy / 90));
    state.el.style.setProperty('--tilt', `${tilt}deg`);
    state.el.style.setProperty('--lean', `${lean}px`);
  });
}
