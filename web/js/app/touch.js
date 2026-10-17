// Phone gestures: pull to refresh, swipe a message to reply.
import { icon } from '../ui.js';
import { setReply } from './chat.js';
import { resync } from './live.js';
import { current, route, TAB_SCREENS } from './shell.js';
import { app } from './state.js';

/** Pull down at the top of Home, Projects, Team or Settings on a phone to check for anything new. */
export function enablePullToRefresh() {
  if (!matchMedia('(pointer: coarse)').matches) return;
  const ind = document.createElement('div');
  ind.className = 'ptr';
  ind.setAttribute('aria-hidden', 'true');
  ind.innerHTML = icon.refresh({ size: 18, width: 2.4 });
  document.body.append(ind);
  let startY = null;
  let pull = 0;
  const set = (px) => { pull = px; ind.style.setProperty('--pull', `${px}px`); ind.style.setProperty('--pull-o', String(Math.min(1, px / 60))); };
  window.addEventListener('touchstart', (e) => {
    startY = window.scrollY <= 0 && TAB_SCREENS.includes(current.name) && !document.querySelector('dialog[open]') && e.touches.length === 1 ? e.touches[0].clientY : null;
  }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (startY === null) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0 || window.scrollY > 0) { set(0); return; }
    set(Math.min(90, dy * 0.5));
  }, { passive: true });
  window.addEventListener('touchend', async () => {
    if (startY === null) return;
    startY = null;
    if (pull < 64) { set(0); return; }
    set(64);
    ind.classList.add('is-loading');
    try { await resync(); if (TAB_SCREENS.includes(current.name)) await route(); } finally {
      ind.classList.remove('is-loading');
      set(0);
    }
  });
}

/** Swipe a message to the right (on a phone) to reply to it, like in a chat app. */
export function enableSwipeToReply(projectId) {
  const tl = app.querySelector('[data-timeline]');
  if (!tl || !matchMedia('(pointer: coarse)').matches) return;
  let el = null; let x0 = 0; let y0 = 0; let dx = 0; let locked = null;
  tl.addEventListener('touchstart', (e) => {
    el = e.target.closest('.bubble[data-mid]:not(.bubble--deleted)');
    if (!el) return;
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; locked = null;
  }, { passive: true });
  tl.addEventListener('touchmove', (e) => {
    if (!el) return;
    const mx = e.touches[0].clientX - x0;
    const my = e.touches[0].clientY - y0;
    if (locked === null && (Math.abs(mx) > 8 || Math.abs(my) > 8)) locked = Math.abs(mx) > Math.abs(my) && mx > 0 ? 'x' : 'y';
    if (locked !== 'x') return;
    dx = Math.max(0, Math.min(72, mx * 0.6));
    el.classList.add('is-swiping');
    el.style.transform = `translateX(${dx}px)`;
  }, { passive: true });
  tl.addEventListener('touchend', () => {
    if (!el) return;
    const target = el;
    el = null;
    target.classList.remove('is-swiping');
    target.style.transform = '';
    if (locked === 'x' && dx >= 56) {
      navigator.vibrate?.(10);
      setReply(projectId, Number(target.dataset.mid)).then(() => app.querySelector('#msg')?.focus());
    }
  });
}
