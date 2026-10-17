// The opening screen. The logo shows the moment the page opens (it's plain HTML in index.html), then
// Dala flies in and talks to the person:
//  - signed in:        "Welcome back, Mukramin!" (or "Good afternoon, Mukramin!" on the first open of the day)
//  - signed out:       a short onboarding, one step at a time (Next), ending with
//                      Create an account / I already have an account
//  - invite link:      "You've been invited to a team", then the join page
// Onboarding depends only on being signed out, never on data left on the device, so someone who
// reinstalls the app (or never finished signing up) always sees it again.
// Refreshing the page never replays it. Respects reduced motion and the Settings switch.
import { esc } from './ui.js';

const KEY = 'padala.intro';
const DAY = 'padala.introDay';
const TEMPLATE = document.getElementById('splash')?.outerHTML || '';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage off */ } },
};

export function introEnabled() { return store.get(KEY) !== 'off'; }
export function setIntroEnabled(on) { store.set(KEY, on ? 'on' : 'off'); }

function timeGreeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Hi' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/**
 * Play the opening. `who` is a promise for the signed-in person (or null when signed out).
 * `invite` is true when the app was opened from an invite link. Resolves when the app should appear.
 */
export function runIntro({ who = Promise.resolve(null), replay = false, invite = false } = {}) {
  let el = document.getElementById('splash');
  if (!el && replay && TEMPLATE) {
    document.body.insertAdjacentHTML('afterbegin', TEMPLATE);
    el = document.getElementById('splash');
  }
  if (!el) return Promise.resolve();

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const reload = performance.getEntriesByType?.('navigation')?.[0]?.type === 'reload';
  if (!replay && (reload || !introEnabled())) { el.remove(); return Promise.resolve(); }

  return new Promise((resolve) => {
    let finished = false;
    let skipWait = null; // tapping the screen moves on to Dala's next line
    const finish = () => {
      if (finished) return;
      finished = true;
      el.classList.add('is-leaving');
      document.body.classList.add('app-entering');
      setTimeout(() => { el.remove(); document.body.classList.remove('app-entering'); }, 900);
      resolve();
    };
    if (reduced) { el.classList.add('is-on'); setTimeout(finish, 250); return; }

    const img = el.querySelector('.splash-dala img');
    const bubble = el.querySelector('.splash-bubble');
    const actions = el.querySelector('.splash-actions');
    const dots = el.querySelector('.splash-dots');
    const pause = (ms) => new Promise((r) => {
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); skipWait = null; r(); }
      skipWait = done;
    });
    const say = async (pose, html, ms) => {
      if (finished) return;
      img.src = `/img/dala/${pose}.webp`;
      el.classList.remove('is-talking');
      await wait(60);
      bubble.innerHTML = html;
      el.classList.add('is-talking');
      if (ms) await pause(ms);
    };
    const leave = async () => {
      if (finished) return;
      img.src = '/img/dala/run.webp';
      el.classList.add('is-exit');
      await wait(650);
      finish();
    };
    el.addEventListener('click', () => skipWait?.());
    el.classList.add('is-on', 'is-full');

    (async () => {
      await wait(1800);   // let the logo and name play out
      el.classList.add('is-dala');
      await wait(1100);   // Dala flies in
      img.src = '/img/dala/hello.webp';
      el.classList.add('is-landed');
      // who's here? (usually known by now; don't hold the animation for a slow network)
      const me = await Promise.race([who.catch(() => null), wait(700).then(() => undefined)]);
      const today = new Date().toDateString();
      const firstToday = store.get(DAY) !== today;
      store.set(DAY, today);

      if (me?.name) {
        const first = esc(me.name.split(' ')[0]);
        await say('hello', `${firstToday ? timeGreeting() : 'Welcome back'}, <b>${first}</b>!`, 2300);
        return leave();
      }
      if (invite) {
        await say('hello', 'Hello! I’m <b>Dala</b>. You’ve been invited to a team!', 2600);
        return leave();
      }
      // Signed out: onboarding, one step at a time. The person reads, then taps Next (or anywhere).
      el.classList.add('is-onboarding');
      el.removeAttribute('aria-hidden');
      dots.hidden = false;
      actions.hidden = false;
      const btn = (name) => actions.querySelector(`[data-splash="${name}"]`);
      const showButtons = (...names) => {
        for (const b of actions.querySelectorAll('[data-splash]')) b.hidden = !names.includes(b.dataset.splash);
        actions.classList.remove('in');
        requestAnimationFrame(() => requestAnimationFrame(() => actions.classList.add('in')));
      };
      const step = (n) => dots.querySelectorAll('i').forEach((d, i) => d.classList.toggle('on', i === n));
      let pick = null;
      const next = () => new Promise((r) => { pick = r; });
      actions.addEventListener('click', (e) => {
        const b = e.target.closest('[data-splash]');
        if (!b) return;
        e.stopPropagation();
        pick?.(b.dataset.splash);
      });
      el.addEventListener('click', () => { if (!btn('next').hidden) pick?.('next'); }); // tap anywhere = Next

      const steps = [
        ['hello', 'Hello! I’m <b>Dala</b>, your friendly assistant.'],
        ['point', 'I carry your project folders to your team, locked so only your team can open them.'],
        ['working', 'Send an update and only the files you changed travel. Even on weak signal.'],
      ];
      dots.innerHTML = '<i></i>'.repeat(steps.length);
      for (let i = 0; i < steps.length; i++) {
        step(i);
        await say(...steps[i], 0);
        showButtons('next');
        await next();
      }
      dots.hidden = true;
      await say('thumbs', 'Ready? Let’s get you set up.', 0);
      showButtons('signup', 'signin');
      let choice;
      do { choice = await next(); } while (choice === 'next');
      location.hash = choice === 'signup' ? '#/signup' : '#/signin';
      actions.classList.remove('in');
      await say('cheer', choice === 'signup' ? 'Yay! Let’s make your account.' : 'Welcome back! Sign in below.', 1400);
      return leave();
    })();
  });
}
