// Language: English (the app's own text) or Filipino.
//
// The screens are written in English. When Filipino is chosen, every piece of text the app shows is
// swapped for its Filipino version as it appears on the page (before it is painted, so there is no flash
// of English). That way no screen, message, button or error can be missed because someone forgot to wrap
// a string, and new text shows up in the list of missing translations (see collect mode below).
//
//   - Plain text is looked up whole ("Send files" → "Magpadala ng files").
//   - Sentences with names or links inside ("Reminder sent to <b>Camiela</b> in the <a>chat</a>.") are
//     looked up as a pattern with placeholders ("Reminder sent to {0} in the {1}.") so the Filipino word
//     order can differ; the name and the link are moved into place, untouched.
//   - Text with numbers ("3 files", "5 min ago") goes through a short list of patterns.
//   - Anything inside translate="no" (names, messages, file names, codes) is never touched.
//
// Collect mode (localStorage padala.i18nCollect = 1) records every English text the app shows, which
// is how the test suite checks that each one has a translation.

const KEY = 'padala.lang';
export const LANGS = { en: 'English', fil: 'Filipino' };

export function getLang() {
  try { return localStorage.getItem(KEY) === 'fil' ? 'fil' : 'en'; } catch { return 'en'; }
}

/** Switch language. The page reloads (quietly: no opening animation on reload) so everything redraws. */
export function setLang(lang) {
  try { localStorage.setItem(KEY, lang === 'fil' ? 'fil' : 'en'); } catch { /* storage off */ }
  location.reload();
}

/** The locale for dates and times. */
export const locale = () => (getLang() === 'fil' ? 'fil-PH' : undefined);

let words = null;     // exact text → Filipino
let patterns = [];    // [RegExp, replacement] for text with numbers or names
let collect = null;   // Set of every English text seen (collect mode)
let missing = null;   // report text with no translation (tests)
const note = (key) => { if (!collect.has(key)) { collect.add(key); window.__i18nReport?.(key); } };
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const HAS_WORD = /[A-Za-z]{2}/;

/** Translate one English text (already trimmed). Returns null when there's no translation. */
function find(key) {
  if (!words) return null;
  const hit = words[key];
  if (hit !== undefined) return hit;
  for (const [re, rep] of patterns) {
    const m = key.match(re);
    if (m) return typeof rep === 'function' ? rep(m, part) : key.replace(re, rep);
  }
  return null;
}
/** For patterns: translate a part of a sentence (a status, a time…), or leave it as it is. */
const part = (text) => find(norm(String(text))) ?? text;
function lookup(key, report = true) {
  if (!words) return null;
  const out = find(key);
  if (missing && report && (out == null || (out === key && words?.[key] === undefined))) missing(key);
  return out;
}

/** Translate a string for places outside the page (titles, confirm boxes, notifications, clipboard). */
export function tr(text) {
  if (text == null) return text;
  const key = norm(String(text));
  if (collect && HAS_WORD.test(key)) note(key);
  return lookup(key) ?? text;
}

// ---------------------------------------------------------------- the page
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE', 'svg', 'SVG', 'NOSCRIPT']);
const ATTRS = ['placeholder', 'aria-label', 'title', 'alt', 'data-tip'];
const doneText = new WeakMap(); // text node → the text we put there (so we don't translate it twice)
const doneEl = new WeakMap();   // element → the pattern we built it from

const hasWords = (n) => HAS_WORD.test(n.textContent);
const skipped = (el) => !!el.closest?.('[translate="no"], [contenteditable="true"]');

function textNode(node) {
  const raw = node.nodeValue;
  if (!raw || !HAS_WORD.test(raw) || doneText.get(node) === raw) return;
  const key = norm(raw);
  if (collect) { note(key); return; }
  const out = lookup(key);
  if (out == null) return;
  const next = raw.match(/^\s*/)[0] + out + raw.match(/\s*$/)[0];
  doneText.set(node, next);
  node.nodeValue = next;
}

/**
 * An element holding text mixed with other elements, e.g. `Reminder sent to <b>Ana</b> in the <a>chat</a>.`
 * Icons at the very start or end stay where they are; the rest becomes "Reminder sent to {0} in the {1}."
 */
function mixed(el) {
  const kids = [...el.childNodes].filter((n) => n.nodeType !== 8);
  if (kids.length < 2 || kids.length > 24) return false;
  let a = 0;
  let b = kids.length - 1;
  const bare = (n) => n.nodeType === 1 && !hasWords(n) && !/\d/.test(n.textContent);
  const blank = (n) => n.nodeType === 3 && !n.nodeValue.trim();
  while (a <= b && (bare(kids[a]) || blank(kids[a]))) a++;
  while (b >= a && (bare(kids[b]) || blank(kids[b]))) b--;
  const mid = kids.slice(a, b + 1);
  if (!mid.some((n) => n.nodeType === 1) || !mid.some((n) => n.nodeType === 3 && HAS_WORD.test(n.nodeValue))) return false;
  const els = [];
  let key = '';
  for (const n of mid) {
    if (n.nodeType === 3) key += n.nodeValue;
    else { key += `{${els.length}}`; els.push(n); }
  }
  key = norm(key);
  if (doneEl.get(el) === key) return true;
  if (collect) { note(key); return true; }
  const out = lookup(key, false);
  if (out == null) { missing?.(key); return false; }
  // rebuild: the translated words, with the same elements moved into their new places
  const frag = document.createDocumentFragment();
  const lead = mid[0].nodeType === 3 ? mid[0].nodeValue.match(/^\s*/)[0] : '';
  const trail = mid[mid.length - 1].nodeType === 3 ? mid[mid.length - 1].nodeValue.match(/\s*$/)[0] : '';
  const used = new Set();
  out.split(/(\{\d+\})/).forEach((part, i, all) => {
    const ph = part.match(/^\{(\d+)\}$/);
    if (ph) { const n = els[+ph[1]]; if (n && !used.has(n)) { used.add(n); frag.append(n); } return; }
    let text = part;
    if (i === 0) text = lead + text;
    if (i === all.length - 1) text += trail;
    if (text) { const t = document.createTextNode(text); doneText.set(t, text); frag.append(t); }
  });
  for (const n of els) if (!used.has(n)) frag.append(n); // never lose a name or link
  const after = mid[mid.length - 1].nextSibling;
  for (const n of mid) if (n.parentNode === el) n.remove();
  el.insertBefore(frag, after);
  // remember the result's own pattern, so seeing it again doesn't translate it twice
  let again = '';
  let k = 0;
  for (const n of el.childNodes) {
    if (n.nodeType === 3) again += n.nodeValue;
    else if (n.nodeType === 1 && els.includes(n)) again += `{${k++}}`;
  }
  doneEl.set(el, norm(again)); // the element now holds the Filipino pattern
  return true;
}

function attrs(el) {
  for (const name of ATTRS) {
    const v = el.getAttribute(name);
    if (!v || !HAS_WORD.test(v)) continue;
    const key = norm(v);
    if (collect) { note(key); continue; }
    const out = lookup(key);
    if (out != null && out !== v) el.setAttribute(name, out);
  }
}

function element(el) {
  if (SKIP.has(el.tagName)) return;
  attrs(el);
  if (el.tagName === 'INPUT' && (el.type === 'button' || el.type === 'submit') && el.value) {
    const out = lookup(norm(el.value));
    if (out != null) el.value = out;
  }
  if (mixed(el)) return;
  for (const n of el.childNodes) if (n.nodeType === 3) textNode(n);
}

/** Translate everything under `root` (an element or a text node). */
function walk(root) {
  if (root.nodeType === 3) { const p = root.parentElement; if (p && !skipped(p) && !SKIP.has(p.tagName)) element(p); return; }
  if (root.nodeType !== 1 || skipped(root)) return;
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => (SKIP.has(n.tagName) || n.getAttribute('translate') === 'no' || n.getAttribute('contenteditable') === 'true'
      ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const list = [root];
  while (tw.nextNode()) list.push(tw.currentNode);
  for (const el of list) element(el);
}

/** Translate a piece of HTML that isn't on the page (e.g. text that gets copied). */
export function trHtml(html) {
  if (!words) return html;
  const box = document.createElement('div');
  box.innerHTML = html;
  walk(box);
  return box.innerHTML;
}

/** Start translating the page (when Filipino is chosen, or in collect mode). */
export async function startI18n() {
  const lang = getLang();
  document.documentElement.lang = lang === 'fil' ? 'fil' : 'en';
  try { if (localStorage.getItem('padala.i18nCollect')) collect = window.__i18nSeen = new Set(); } catch { /* ignore */ }
  try { if (localStorage.getItem('padala.i18nMissing') && window.__i18nMissing) missing = (k) => window.__i18nMissing(k); } catch { /* ignore */ }
  if (lang !== 'fil' && !collect) return;
  if (lang === 'fil') {
    try {
      const dict = await import('./lang/fil.js');
      words = dict.words;
      patterns = dict.patterns;
    } catch { return; } // missing file: stay in English rather than break the app
  }
  walk(document.body);
  document.title = tr(document.title);
  const obs = new MutationObserver((records) => {
    const seen = new Set();
    for (const r of records) {
      if (r.type === 'childList') { for (const n of r.addedNodes) if (!seen.has(n)) { seen.add(n); walk(n); } }
      else if (r.type === 'characterData') { const p = r.target.parentElement; if (p && !seen.has(p)) { seen.add(p); walk(r.target); } }
      else if (r.type === 'attributes' && r.target.isConnected && !skipped(r.target)) attrs(r.target);
    }
    obs.takeRecords(); // our own changes: nothing more to do
  });
  obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  // the tab title
  const titleEl = document.querySelector('title');
  if (titleEl) {
    new MutationObserver(() => {
      const t = find(norm(document.title));
      if (t != null && t !== document.title) document.title = t;
    }).observe(titleEl, { childList: true, characterData: true, subtree: true });
  }
}
