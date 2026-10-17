// Accessibility audit run inside the page by the browser test (no extra packages).
// Checks the WCAG basics that matter most on every screen:
//  - text contrast (4.5:1 for normal text, 3:1 for large text)
//  - every image has alt text (empty alt for decoration is fine)
//  - every button, link and form field has a name a screen reader can read
//  - no duplicate ids, the page has a language and exactly one main heading level 1
// Returns a list of problems (strings).
(() => {
  const problems = [];
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05;
  };
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
  const lum = ({ r, g, b }) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const blend = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
  const background = (el) => {
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const st = getComputedStyle(n);
      if (st.backgroundImage && st.backgroundImage !== 'none' && !/gradient/.test(st.backgroundImage)) return null; // text over an image: skip
      const c = parse(st.backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let out = { r: 255, g: 255, b: 255, a: 1 };
    if (document.documentElement.dataset.theme === 'dark') out = parse(getComputedStyle(document.body).backgroundColor) || out;
    for (const l of layers.reverse()) out = blend(l, out);
    return out;
  };
  const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('svg, .splash, .dala, [aria-hidden="true"], .sr-only, .skeleton') || !visible(el)) continue;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim());
    if (!own) continue;
    const st = getComputedStyle(el);
    let fg = parse(st.color);
    if (!fg) continue;
    const bg = background(el);
    if (!bg) continue;
    const op = [...(function* up(n) { for (; n; n = n.parentElement) yield Number(getComputedStyle(n).opacity); })(el)].reduce((a, b) => a * b, 1);
    fg = blend({ ...fg, a: fg.a * op }, bg);
    const l1 = lum(fg); const l2 = lum(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const size = parseFloat(st.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(st.fontWeight) >= 700);
    const disabled = el.closest('button:disabled, [aria-disabled="true"], input:disabled, .is-disabled');
    const need = large ? 3 : 4.5;
    if (ratio < need && !disabled) {
      const text = el.textContent.trim().replace(/\s+/g, ' ').slice(0, 40);
      const key = `${text}|${ratio.toFixed(1)}`;
      if (!seen.has(key)) { seen.add(key); problems.push(`contrast ${ratio.toFixed(2)}:1 (needs ${need}) "${text}"`); }
    }
  }
  for (const img of document.querySelectorAll('img')) if (!img.hasAttribute('alt')) problems.push(`image without alt: ${img.src.split('/').pop()}`);
  const named = (el) => (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title') || el.textContent.trim() || el.querySelector('img[alt]:not([alt=""])'));
  for (const el of document.querySelectorAll('button, a[href], [role="button"]')) {
    if (!visible(el) || el.closest('.dala')) continue;
    if (!named(el)) problems.push(`unnamed ${el.tagName.toLowerCase()}: ${el.outerHTML.slice(0, 80)}`);
  }
  for (const el of document.querySelectorAll('input:not([type=hidden]), textarea, select')) {
    if (!visible(el) && el.type !== 'radio' && el.type !== 'checkbox') continue;
    const ok = el.getAttribute('aria-label') || el.labels?.length || el.closest('label') || el.getAttribute('title');
    if (!ok) problems.push(`field without a label: ${el.outerHTML.slice(0, 80)}`);
  }
  const ids = {};
  for (const el of document.querySelectorAll('[id]')) ids[el.id] = (ids[el.id] || 0) + 1;
  for (const [id, n] of Object.entries(ids)) if (n > 1) problems.push(`duplicate id: ${id}`);
  if (!document.documentElement.lang) problems.push('the page has no language');
  const h1 = [...document.querySelectorAll('h1')].filter(visible).length;
  if (h1 !== 1) problems.push(`${h1} visible h1 headings`);
  return problems;
})();
