// The delivery scene and progress shared by sending and receiving.
import { setupText } from '../checkup.js';
import { react, dalaAway, pose, parcelSvg } from '../dala.js';
import { formatBytes } from '../sync.js';
import { esc, icon, initials, duration, copyText } from '../ui.js';
import { layout, keyBanner } from './shell.js';
import { S } from './state.js';

export function stepsHtml(active) {
  const names = ['Choose', 'Check', 'Send'];
  return `<ol class="wizard" aria-label="Steps">${names.map((n, i) => `<li class="${i < active ? 'done' : i === active ? 'now' : ''}" ${i === active ? 'aria-current="step"' : ''}>
    <span>${i < active ? icon.check({ size: 12, width: 3 }) : i + 1}</span>${n}</li>`).join('')}</ol>`;
}

/**
 * The delivery scene: Dala flies the package along the route from one person to the other.
 * Its position follows the real progress, it waits under a cloud when the signal drops,
 * and hands the package over when it arrives.
 */
export function progressHtml({ title, from, to, toNote = '', count = 0, sending = true }) {
  const road = 'M30 130 Q250 -50 470 130';
  return `
    <div class="stack" style="gap:4px"><h1 style="font-size:28px">${esc(title)}</h1>
      <span class="muted" style="font-size:14px">${icon.lock({ size: 13 })} Encrypted · keep this page open until it’s done</span></div>
    <div class="trip" data-trip data-sending="${sending ? 1 : 0}" style="--t:.1">
      <svg class="trip-road" viewBox="0 0 500 190" preserveAspectRatio="none" aria-hidden="true">
        <path class="road-base" d="${road}" pathLength="100"/>
        <path class="road-done" data-road d="${road}" pathLength="100" style="stroke-dashoffset:90"/>
      </svg>
      <div class="trip-end trip-end--from"><span class="avatar avatar--lg">${esc(initials(from))}</span><b>${esc(from)}</b></div>
      <div class="trip-end trip-end--to" data-to><span class="avatar avatar--lg">${esc(initials(to))}<span class="trip-check">${icon.check({ size: 14, width: 3 })}</span></span><b>${esc(to)}</b>${toNote ? `<span class="trip-note">${toNote}</span>` : ''}</div>
      <div class="courier" data-courier>
        <span class="courier-say" data-say>${sending ? `On my way to ${esc(to)}!` : 'Bringing it to you…'}</span>
        <span class="courier-bits" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
        <img src="${pose('run')}" alt="" data-courier-img>
        <span class="courier-parcel" aria-hidden="true">${parcelSvg()}${count ? `<i>${count > 99 ? '99+' : count}</i>` : ''}</span>
        <span class="courier-cloud" aria-hidden="true">${icon.wifi({ size: 18 })}</span>
      </div>
    </div>
    <div class="stack" style="align-items:center;gap:6px;padding:0 0 8px">
      <span class="percent" data-pct>0<small>%</small></span>
      <span class="muted" data-line style="font-size:14px;text-align:center">Starting…</span>
    </div>
    <div class="card stack" style="gap:12px">
      <div class="pieces" data-pieces></div>
      <div data-note></div>
    </div>`;
}

/** Wait for Dala to hand the package over before moving on. */
export const arrival = () => new Promise((r) => setTimeout(r, matchMedia('(prefers-reduced-motion: reduce)').matches ? 200 : 1700));

export function makeProgressUpdater(root) {
  let frame = 0;
  let latest = null;
  let cells = 0;
  let cellEls = [];
  let wasWaiting = false;
  let sadTimer = 0;
  let said = '';
  const trip = root.querySelector('[data-trip]');
  const courierImg = root.querySelector('[data-courier-img]');
  const sayEl = root.querySelector('[data-say]');
  const sending = trip?.dataset.sending === '1';
  const to = root.querySelector('[data-to] b')?.textContent || '';
  dalaAway(true); // the Dala in the scene does the talking now
  const courier = (name) => { if (courierImg && !courierImg.src.endsWith(`/${name}.webp`)) courierImg.src = pose(name); };
  const speak = (text) => {
    if (!sayEl || text === said) return;
    said = text;
    sayEl.textContent = text;
    sayEl.classList.remove('in');
    void sayEl.offsetWidth;
    sayEl.classList.add('in');
  };
  const paint = () => {
    frame = 0;
    const s = latest;
    const want = Math.min(78, Math.max(1, s.pieces));
    if (want !== cells) {
      cells = want;
      root.querySelector('[data-pieces]').innerHTML = '<i></i>'.repeat(cells);
      cellEls = [...root.querySelectorAll('[data-pieces] i')];
    }
    const pct = s.bytes ? Math.min(100, Math.floor((s.bytesDone / s.bytes) * 100)) : (s.phase === 'done' ? 100 : 0);
    root.querySelector('[data-pct]').innerHTML = `${pct}<small>%</small>`;
    const secs = (Date.now() - s.startedAt) / 1000;
    const speed = s.bytesDone / Math.max(secs, 0.5);
    const left = speed > 0 ? (s.bytes - s.bytesDone) / speed : Infinity;
    const line = s.waiting ? 'Paused: no internet connection'
      : s.phase === 'finishing' ? 'Almost done…'
      : s.phase === 'done' ? 'Done!'
      : s.bytes === 0 ? 'Almost done…'
      : `${formatBytes(s.bytesDone)} of ${formatBytes(s.bytes)} · about ${duration(left)} left`;
    root.querySelector('[data-line]').textContent = line;
    const doneCells = s.pieces ? Math.floor((s.piecesDone / s.pieces) * cells) : (s.phase === 'done' ? cells : 0);
    cellEls.forEach((c, i) => { c.className = i < doneCells ? 'done' : i === doneCells && s.phase !== 'done' ? 'now' : ''; });
    if (trip) {
      const done = s.phase === 'done';
      const t = done ? 0.9 : 0.1 + 0.78 * (pct / 100);
      trip.style.setProperty('--t', t.toFixed(4));
      root.querySelector('[data-road]').style.strokeDashoffset = String(100 - t * 100);
      trip.classList.toggle('is-waiting', !!s.waiting);
      trip.classList.toggle('is-done', done);
      if (done) { clearTimeout(sadTimer); courier('cheer'); speak(sending ? 'Delivered!' : 'Here you go!'); }
      else if (s.waiting) speak('No signal… I’ll wait here.');
      else if (s.resumes && wasWaiting) speak('Back on the road!');
      else if (said === 'Back on the road!') { /* let it show for a moment */ }
      else if (s.phase === 'finishing' || pct >= 75) speak('Almost there…');
      else if (pct >= 40) speak('Halfway there!');
      else speak(sending ? `On my way to ${to}!` : 'Bringing it to you…');
      const stop = root.querySelector('[data-cancel-transfer]');
      if (stop) stop.hidden = done;
    }
    if (s.waiting !== wasWaiting) {
      wasWaiting = s.waiting;
      react(s.waiting ? 'offline' : 'online');
      clearTimeout(sadTimer);
      if (s.waiting) { courier('surprised'); sadTimer = setTimeout(() => courier('sad'), 5000); } else courier('run');
      if (!s.waiting) setTimeout(() => { if (said === 'Back on the road!') { said = ''; if (!frame) frame = requestAnimationFrame(paint); } }, 2500);
    }
    root.querySelector('[data-note]').innerHTML = s.waiting
      ? `<div class="banner banner--warn">${icon.wifi({ size: 16, stroke: 'var(--pd-warn)' })}<span><b>Your internet connection dropped.</b> Don’t worry: Padala will continue by itself when the signal comes back. Nothing is lost.</span></div>`
      : s.resumes
        ? `<div class="banner">${icon.wifi({ size: 16, stroke: 'var(--pd-warn)' })}<span>The signal dropped ${s.resumes} time${s.resumes > 1 ? 's' : ''}. Padala continued where it stopped.</span></div>`
        : '<span class="hint">Files travel in small parts, so a weak signal can’t break the transfer.</span>';
  };
  return (s) => { latest = s; if (!frame) frame = requestAnimationFrame(paint); };
}

export async function keepAwake() {
  try { return await navigator.wakeLock?.request('screen'); } catch { return null; }
}

export function successHtml({ title, text, primary, secondary, extra = '' }) {
  dalaAway(true);
  return `<div class="empty" style="flex:1;justify-content:center;gap:14px">
    <img class="done-art" src="${pose('cheer')}" alt="Dala celebrating">
    <h1 style="font-size:28px;color:var(--pd-text)">${title}</h1><p style="max-width:400px;font-size:15px">${text}</p></div>
    ${extra}${primary}${secondary || ''}`;
}

/** Dala's setup notes: how to open the project, with copy buttons (and a plain version for the client). */
export function guideHtml(guide, { open = true, sub = '' } = {}) {
  return `<details class="card guide" data-guide ${open ? 'open' : ''}>
    <summary><img src="${pose('point')}" alt=""><span class="grow stack" style="gap:2px"><b>How to open it</b>
      <span class="muted" style="font-size:13px">${sub || 'Setup guide'} · ${esc(guide.title)}</span></span>${icon.chevron({ size: 18 })}</summary>
    <ol class="guide-steps">${guide.steps.map((st, i) => `<li><b>${esc(st.title)}</b><span>${st.text}</span>
      ${st.code ? `<span class="code-line"><code>${esc(st.code)}</code><button class="btn btn--sm" data-copy-step="${i}">Copy</button>${st.link ? `<a class="btn btn--sm" href="${esc(st.link)}" target="_blank" rel="noopener">Open</a>` : ''}</span>`
        : st.link ? `<span class="code-line"><code>${esc(st.link)}</code><a class="btn btn--sm" href="${esc(st.link)}" target="_blank" rel="noopener">Open</a></span>` : ''}</li>`).join('')}</ol>
    <div class="row" style="flex-wrap:wrap;gap:8px"><button class="btn btn--sm" data-copy-guide>${icon.chat({ size: 14 })} Copy the steps for the client</button>
      <span class="hint">Paste them in Messenger when you hand the project over.</span></div>
  </details>`;
}

export function wireGuide(root, guide, name) {
  root.querySelectorAll('[data-copy-step]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); copyText(guide.steps[Number(b.dataset.copyStep)].code); }));
  root.querySelector('[data-copy-guide]')?.addEventListener('click', () => copyText(setupText(guide, name)));
}

/** Files can't be opened or sent until this device has the team key: say how to unlock, right here. */
export function lockedScreen(back, label) {
  layout(`<div class="screen">
    <div class="topbar"><a class="icon-btn icon-btn--ghost" href="${back}" aria-label="Back" style="margin-left:-10px">${icon.back({ size: 22 })}</a><span class="label grow">${esc(label)}</span></div>
    <div class="empty" style="padding-top:8px"><img class="art art--md" src="${pose('hush')}" alt=""><h2 style="color:var(--pd-text)">Locked on this device</h2>
      <p style="max-width:380px">Everything in ${esc(S.team.name)} is encrypted with the team’s secret key, and this device doesn’t have it yet.</p></div>
    ${keyBanner()}
  </div>`);
}
