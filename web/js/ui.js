// Small UI helpers: escaping, icons, toasts, dialogs, dates.
import { locale } from './i18n.js';

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const svg = (d, { size = 20, stroke = 'currentColor', width = 2 } = {}) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

// Icons: Lucide (https://lucide.dev, ISC license): one consistent set on a 24px grid with 2px strokes.
export const icon = {
  back: (o) => svg('<path d="m15 18-6-6 6-6"/>', o),
  plus: (o) => svg('<path d="M5 12h14"/> <path d="M12 5v14"/>', o),
  send: (o) => svg('<path d="M5 12h14"/> <path d="m12 5 7 7-7 7"/>', o),
  up: (o) => svg('<path d="m5 12 7-7 7 7"/> <path d="M12 19V5"/>', o),
  check: (o) => svg('<path d="M20 6 9 17l-5-5"/>', o),
  folder: (o) => svg('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>', o),
  file: (o) => svg('<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/> <path d="M14 2v5a1 1 0 0 0 1 1h5"/>', o),
  wifi: (o) => svg('<path d="M12 20h.01"/> <path d="M8.5 16.429a5 5 0 0 1 7 0"/> <path d="M5 12.859a10 10 0 0 1 5.17-2.69"/> <path d="M19 12.859a10 10 0 0 0-2.007-1.523"/> <path d="M2 8.82a15 15 0 0 1 4.177-2.643"/> <path d="M22 8.82a15 15 0 0 0-11.288-3.764"/> <path d="m2 2 20 20"/>', o),
  lock: (o) => svg('<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/> <path d="M7 11V7a5 5 0 0 1 10 0v4"/>', o),
  key: (o) => svg('<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/> <circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>', o),
  users: (o) => svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/> <path d="M16 3.128a4 4 0 0 1 0 7.744"/> <path d="M22 21v-2a4 4 0 0 0-3-3.87"/> <circle cx="9" cy="7" r="4"/>', o),
  download: (o) => svg('<path d="M12 15V3"/> <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/> <path d="m7 10 5 5 5-5"/>', o),
  refresh: (o) => svg('<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/> <path d="M21 3v5h-5"/> <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/> <path d="M8 16H3v5"/>', o),
  bolt: (o) => svg('<path d="M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z"/>', o),
  copy: (o) => svg('<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/> <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>', o),
  share: (o) => svg('<path d="M12 2v13"/> <path d="m16 6-4-4-4 4"/> <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>', o),
  chevron: (o) => svg('<path d="m6 9 6 6 6-6"/>', o),
  alert: (o) => svg('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/> <path d="M12 9v4"/> <path d="M12 17h.01"/>', o),
  bell: (o) => svg('<path d="M10.268 21a2 2 0 0 0 3.464 0"/> <path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>', o),
  logout: (o) => svg('<path d="m16 17 5-5-5-5"/> <path d="M21 12H9"/> <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>', o),
  x: (o) => svg('<path d="M18 6 6 18"/> <path d="m6 6 12 12"/>', o),
  user: (o) => svg('<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/> <circle cx="12" cy="7" r="4"/>', o),
  at: (o) => svg('<circle cx="12" cy="12" r="4"/> <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>', o),
  eye: (o) => svg('<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/> <circle cx="12" cy="12" r="3"/>', o),
  eyeOff: (o) => svg('<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/> <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/> <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/> <path d="m2 2 20 20"/>', o),
  link: (o) => svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/> <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>', o),
  tag: (o) => svg('<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/> <circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>', o),
  image: (o) => svg('<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/> <circle cx="9" cy="9" r="2"/> <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>', o),
  play: (o) => svg('<path d="M9 9.003a1 1 0 0 1 1.517-.859l4.997 2.997a1 1 0 0 1 0 1.718l-4.997 2.997A1 1 0 0 1 9 14.996z"/> <circle cx="12" cy="12" r="10"/>', o),
  code: (o) => svg('<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/> <path d="M14 2v5a1 1 0 0 0 1 1h5"/> <path d="M10 12.5 8 15l2 2.5"/> <path d="m14 12.5 2 2.5-2 2.5"/>', o),
  more: (o) => svg('<circle cx="12" cy="12" r="1"/> <circle cx="19" cy="12" r="1"/> <circle cx="5" cy="12" r="1"/>', o),
  trash: (o) => svg('<path d="M10 11v6"/> <path d="M14 11v6"/> <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/> <path d="M3 6h18"/> <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>', o),
  pencil: (o) => svg('<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/> <path d="m15 5 4 4"/>', o),
  search: (o) => svg('<path d="m21 21-4.34-4.34"/> <circle cx="11" cy="11" r="8"/>', o),
  chat: (o) => svg('<path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"/>', o),
  home: (o) => svg('<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/> <path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', o),
  gear: (o) => svg('<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/> <circle cx="12" cy="12" r="3"/>', o),
  folders: (o) => svg('<path d="M20 5a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h2.5a1.5 1.5 0 0 1 1.2.6l.6.8a1.5 1.5 0 0 0 1.2.6z"/> <path d="M3 8.268a2 2 0 0 0-1 1.738V19a2 2 0 0 0 2 2h11a2 2 0 0 0 1.732-1"/>', o),
  phone: (o) => svg('<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/> <path d="M12 18h.01"/>', o),
  clock: (o) => svg('<circle cx="12" cy="12" r="10"/> <path d="M12 6v6l4 2"/>', o),
  inbox: (o) => svg('<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/> <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>', o),
  coins: (o) => svg('<rect width="20" height="12" x="2" y="6" rx="2"/> <circle cx="12" cy="12" r="2"/> <path d="M6 12h.01M18 12h.01"/>', o),
  sparkle: (o) => svg('<path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/> <path d="M20 2v4"/> <path d="M22 4h-4"/> <circle cx="4" cy="20" r="2"/>', o),
  shield: (o) => svg('<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/> <path d="m9 12 2 2 4-4"/>', o),
  globe: (o) => svg('<circle cx="12" cy="12" r="10"/> <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/> <path d="M2 12h20"/>', o),
  palette: (o) => svg('<path d="M12 2v2"/> <path d="M14.837 16.385a6 6 0 1 1-7.223-7.222c.624-.147.97.66.715 1.248a4 4 0 0 0 5.26 5.259c.589-.255 1.396.09 1.248.715"/> <path d="M16 12a4 4 0 0 0-4-4"/> <path d="m19 5-1.256 1.256"/> <path d="M20 12h2"/>', o),
  list: (o) => svg('<path d="M3 5h.01"/> <path d="M3 12h.01"/> <path d="M3 19h.01"/> <path d="M8 5h13"/> <path d="M8 12h13"/> <path d="M8 19h13"/>', o),
  grid: (o) => svg('<rect width="7" height="7" x="3" y="3" rx="1"/> <rect width="7" height="7" x="14" y="3" rx="1"/> <rect width="7" height="7" x="14" y="14" rx="1"/> <rect width="7" height="7" x="3" y="14" rx="1"/>', o),
  panel: (o) => svg('<rect width="18" height="18" x="3" y="3" rx="2"/> <path d="M15 3v18"/>', o),
  sort: (o) => svg('<path d="m7 15 5 5 5-5"/> <path d="m7 9 5-5 5 5"/>', o),
  arrowDown: (o) => svg('<path d="M12 5v14"/> <path d="m19 12-7 7-7-7"/>', o),
  arrowUpSm: (o) => svg('<path d="m5 12 7-7 7 7"/> <path d="M12 19V5"/>', o),
  hardDrive: (o) => svg('<path d="M10 16h.01"/> <path d="M2.212 11.577a2 2 0 0 0-.212.896V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.527a2 2 0 0 0-.212-.896L18.55 5.11A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/> <path d="M21.946 12.013H2.054"/> <path d="M6 16h.01"/>', o),
  userPlus: (o) => svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/> <circle cx="9" cy="7" r="4"/> <line x1="19" x2="19" y1="8" y2="14"/> <line x1="22" x2="16" y1="11" y2="11"/>', o),
};

/**
 * A modern text field: icon, label, hint, live check mark, and extras for passwords.
 * opts: { id, name, label, type, icon, value, placeholder, hint, prefix, required, maxlength, minlength,
 *         autocomplete, validate ('username'|'name'|'password'), strength, mono, autofocus }
 */
export function field(o) {
  const type = o.type || 'text';
  const isPw = type === 'password';
  const attrs = [
    `id="${o.id}"`, `name="${o.name || o.id}"`, `type="${type}"`,
    o.value !== undefined ? `value="${esc(o.value)}"` : '',
    o.placeholder ? `placeholder="${esc(o.placeholder)}"` : '',
    o.required === false ? '' : 'required',
    o.maxlength ? `maxlength="${o.maxlength}"` : '', o.minlength ? `minlength="${o.minlength}"` : '',
    `autocomplete="${o.autocomplete || 'off'}"`, o.validate ? `data-validate="${o.validate}"` : '',
    o.strength ? 'data-strength' : '', o.mono ? 'class="mono"' : '', o.autofocus ? 'data-autofocus' : '',
    type === 'text' && o.validate === 'username' ? 'autocapitalize="none" spellcheck="false"' : '',
    o.hint ? `aria-describedby="${o.id}-hint"` : '',
  ].filter(Boolean).join(' ');
  return `<div class="fx">
    <label for="${o.id}">${esc(o.label)}${o.optional ? ' <span class="fx-opt">optional</span>' : ''}</label>
    <div class="fx-box">
      ${o.icon ? `<span class="fx-ic">${icon[o.icon]({ size: 18 })}</span>` : '<span class="fx-pad"></span>'}
      ${o.prefix ? `<span class="fx-prefix">${esc(o.prefix)}</span>` : ''}
      <input ${attrs}>
      ${o.validate && !isPw ? `<span class="fx-ok" aria-hidden="true">${icon.check({ size: 16, width: 2.6 })}</span>` : ''}
      ${isPw ? `<button type="button" class="fx-eye" data-eye aria-label="Show password">${icon.eye({ size: 18 })}</button>` : ''}
    </div>
    ${o.strength ? '<div class="strength" data-meter aria-hidden="true"><i></i><i></i><i></i><i></i></div>' : ''}
    ${o.hint ? `<span class="fx-hint" id="${o.id}-hint">${o.hint}</span>` : ''}
    ${isPw ? '<span class="fx-caps" hidden>Caps Lock is on</span>' : ''}
  </div>`;
}

const RULES = {
  username: (v) => /^[a-z0-9._-]{3,32}$/i.test(v),
  name: (v) => v.trim().length >= 1,
  password: (v) => v.length >= 8,
  key: (v) => /^[A-Za-z0-9_-]{43}$/.test(v.trim()),
};

function strengthOf(v) {
  if (!v) return 0;
  let s = 0;
  if (v.length >= 8) s++;
  if (v.length >= 12) s++;
  if (/[a-z]/.test(v) && /[A-Z]/.test(v)) s++;
  if (/\d/.test(v) && /[^A-Za-z0-9]/.test(v)) s++;
  return Math.max(1, s);
}
const STRENGTH = ['', 'Too weak', 'Okay', 'Good', 'Strong'];

/** Wire up every field on the page once: show/hide, caps lock, live validation, strength. */
export function enhanceFields() {
  if (enhanceFields.done) return;
  enhanceFields.done = true;
  document.addEventListener('click', (e) => {
    const eye = e.target.closest('[data-eye]');
    if (!eye) return;
    const input = eye.parentElement.querySelector('input');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    eye.innerHTML = show ? icon.eyeOff({ size: 18 }) : icon.eye({ size: 18 });
    eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    input.focus();
  });
  document.addEventListener('input', (e) => {
    const input = e.target;
    const fx = input.closest?.('.fx');
    if (!fx) return;
    fx.classList.remove('is-invalid');
    fx.querySelector('.fx-err')?.remove();
    const rule = RULES[input.dataset.validate];
    if (rule) fx.classList.toggle('is-valid', rule(input.value));
    if (input.hasAttribute('data-strength')) {
      const level = input.value ? strengthOf(input.value) : 0;
      const meter = fx.querySelector('[data-meter]');
      meter.dataset.level = String(level);
      const hint = fx.querySelector('.fx-hint');
      if (hint) hint.textContent = level ? `Password strength: ${STRENGTH[level]}` : 'At least 8 characters.';
    }
  });
  const caps = (e) => {
    const fx = e.target.closest?.('.fx');
    const note = fx?.querySelector('.fx-caps');
    if (note && e.getModifierState) note.hidden = !e.getModifierState('CapsLock');
  };
  document.addEventListener('keydown', caps);
  document.addEventListener('keyup', caps);
}

/** Mark a field as wrong with a message under it (and shake it a little). */
export function fieldError(form, name, message) {
  const input = form.querySelector(`[name="${name}"]`);
  const fx = input?.closest('.fx');
  if (!fx) return false;
  fx.classList.remove('is-invalid');
  void fx.offsetWidth;
  fx.classList.add('is-invalid');
  let err = fx.querySelector('.fx-err');
  if (!err) { err = document.createElement('span'); err.className = 'fx-err'; err.setAttribute('role', 'alert'); fx.append(err); }
  err.textContent = message;
  input.focus();
  return true;
}

/** Show a spinner on a button while something runs. */
export async function withLoading(btn, fn) {
  btn.classList.add('is-loading');
  btn.disabled = true;
  try { return await fn(); } finally { btn.classList.remove('is-loading'); btn.disabled = false; }
}

export const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

export function timeOf(ts) {
  return new Date(ts).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });
}

export function dayOf(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(locale(), { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

export function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return dayOf(ts);
}

export function duration(sec) {
  if (!isFinite(sec) || sec < 0) return '…';
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s`;
  const m = Math.floor(sec / 60);
  return m < 60 ? `${m} min ${Math.round(sec % 60)} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function toastHost() {
  let host = document.querySelector('.toasts');
  if (!host) {
    host = document.createElement('div');
    host.className = 'toasts';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.append(host);
  }
  return host;
}

export function toast(html, { error = false, ms = 4200 } = {}) {
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' toast--error' : '');
  el.innerHTML = html;
  toastHost().append(el);
  setTimeout(() => el.remove(), ms);
  return el;
}

/** A modal dialog with a form. Resolves with the FormData on submit, or null when cancelled. */
export function dialog(inner, { onOpen } = {}) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.innerHTML = `<form method="dialog">${inner}</form>`;
    document.body.append(d);
    const form = d.querySelector('form');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const data = new FormData(form);
      d.close();
      resolve(data);
    });
    d.addEventListener('click', (e) => { if (e.target.closest('[data-cancel]')) { d.close(); resolve(null); } });
    d.addEventListener('cancel', () => resolve(null));
    d.addEventListener('close', () => setTimeout(() => d.remove(), 0));
    d.showModal();
    (d.querySelector('[data-autofocus]') || d.querySelector('input:not([type=radio])'))?.focus();
    onOpen?.(d);
  });
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied.');
  } catch {
    toast('Could not copy automatically. Select the text and copy it.', { error: true });
  }
}
