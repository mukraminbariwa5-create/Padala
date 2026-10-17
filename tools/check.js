// Code checks with no extra packages (run: npm run check).
//  - every JavaScript file parses (node --check)
//  - no unused imports, no imports of names a module doesn't export
//  - no stray debugging (console.log, debugger) in the app or server code
//  - no trailing whitespace, files end with a newline
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return ['node_modules', 'data', 'backups', '.tools', '.git'].includes(e.name) ? [] : walk(p);
  return [p];
});
const files = ['server', 'web/js', 'tools', 'tests'].flatMap((d) => walk(path.join(root, d))).filter((f) => f.endsWith('.js'));
const problems = [];
const report = (file, line, msg) => problems.push(`${path.relative(root, file)}:${line}  ${msg}`);

/** The source with comments and the text of strings blanked out (template ${…} expressions kept). */
export function codeOnly(src) {
  let out = '';
  let i = 0;
  let prev = '';
  const stack = [];
  let depth = 0;
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  const regexOk = () => prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev) || /\breturn$/.test(out.trimEnd());
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') { const j = src.indexOf('\n', i); const e = j < 0 ? src.length : j; out += blank(src.slice(i, e)); i = e; continue; }
    if (c === '/' && next === '*') { const j = src.indexOf('*/', i + 2); const e = j < 0 ? src.length : j + 2; out += blank(src.slice(i, e)); i = e; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += c + blank(src.slice(i + 1, j)) + c; i = j + 1; prev = 'x'; continue;
    }
    if (c === '/' && regexOk()) {
      let j = i + 1; let cls = false;
      while (j < src.length && (src[j] !== '/' || cls) && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false;
        j++;
      }
      out += '/' + blank(src.slice(i + 1, j)) + '/'; i = j + 1; prev = 'x'; continue;
    }
    if (c === '`' || (c === '}' && stack.length && stack[stack.length - 1] === depth)) {
      if (c === '}') stack.pop();
      let j = i + 1; let buf = c;
      while (j < src.length) {
        if (src[j] === '\\') { buf += '  '; j += 2; continue; }
        if (src[j] === '`') { buf += '`'; j++; break; }
        if (src[j] === '$' && src[j + 1] === '{') { buf += '${'; j += 2; stack.push(depth); break; }
        buf += src[j] === '\n' ? '\n' : ' '; j++;
      }
      out += buf; i = j; prev = buf.endsWith('`') ? 'x' : '{'; continue;
    }
    if (c === '{') depth++;
    if (c === '}') depth--;
    out += c;
    if (!/\s/.test(c)) prev = /\w/.test(c) ? 'x' : c;
    i++;
  }
  return out;
}

const exportsOf = new Map();
const exported = (file) => {
  if (!exportsOf.has(file)) {
    const code = codeOnly(fs.readFileSync(file, 'utf8'));
    const names = new Set();
    for (const m of code.matchAll(/^export (?:async )?(?:function\*? |const |let |class )(\w+)/gm)) names.add(m[1]);
    for (const m of code.matchAll(/^export \{([^}]*)\}/gm)) m[1].split(',').forEach((n) => names.add(n.trim().split(/\s+as\s+/).pop()));
    exportsOf.set(file, names);
  }
  return exportsOf.get(file);
};

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); } catch (err) { report(file, 1, `does not parse: ${String(err.stderr).split('\n').find((l) => /Error/.test(l))}`); continue; }
  const code = codeOnly(src);
  const lines = src.split('\n');
  lines.forEach((l, n) => { if (/[ \t]+$/.test(l)) report(file, n + 1, 'trailing whitespace'); });
  if (!src.endsWith('\n')) report(file, lines.length, 'no newline at the end of the file');
  const isApp = !/[\\/](tests|tools)[\\/]/.test(file);
  if (isApp) {
    codeOnly(src).split('\n').forEach((l, n) => {
      if (/\bdebugger\b/.test(l)) report(file, n + 1, 'debugger statement');
      if (/console\.log\(/.test(l) && !/server[\\/]|tools[\\/]/.test(file)) report(file, n + 1, 'console.log left in app code');
    });
  }
  const body = code.replace(/^import [\s\S]*?from '[^']*';$/gm, (m) => m.replace(/[^\n]/g, ' '));
  for (const m of src.matchAll(/^import \{([^}]*)\} from '(\.[^']+)';$/gm)) {
    const line = src.slice(0, m.index).split('\n').length;
    const target = path.resolve(path.dirname(file), m[2]);
    const names = m[1].split(',').map((n) => n.trim()).filter(Boolean);
    for (const raw of names) {
      const local = raw.split(/\s+as\s+/).pop();
      if (!new RegExp(`(?<![\\w$.])${local.replace('$', '\\$')}(?![\\w$])`).test(body)) report(file, line, `unused import: ${local}`);
      if (fs.existsSync(target) && !exported(target).has(raw.split(/\s+as\s+/)[0])) report(file, line, `${raw} is not exported by ${m[2]}`);
    }
  }
}

// index.html preloads every app module (so they download in parallel): keep that list complete
{
  const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
  const listed = new Set([...html.matchAll(/rel="modulepreload" href="([^"]+)"/g)].map((m) => m[1]));
  const skip = new Set(['web/js/app.js', 'web/js/theme.js']); // the entry point and the plain <head> script
  const modules = walk(path.join(root, 'web/js'))
    .map((f) => path.relative(root, f).split(path.sep).join('/'))
    .filter((f) => f.endsWith('.js') && !skip.has(f) && !f.startsWith('web/js/lang/'))
    .map((f) => path.join(root, f));
  for (const f of modules) {
    const url = '/' + path.relative(path.join(root, 'web'), f).split(path.sep).join('/');
    if (!listed.has(url)) report(path.join(root, 'web/index.html'), 1, `missing <link rel="modulepreload" href="${url}">`);
  }
  const sw = fs.readFileSync(path.join(root, 'web/sw.js'), 'utf8');
  for (const f of modules) {
    const url = '/' + path.relative(path.join(root, 'web'), f).split(path.sep).join('/');
    if (!sw.includes(`'${url}'`)) report(path.join(root, 'web/sw.js'), 1, `the offline cache is missing ${url}`);
  }
}

if (problems.length) {
  console.log(problems.join('\n'));
  console.log(`\n${problems.length} problem${problems.length === 1 ? '' : 's'} in ${files.length} files`);
  process.exit(1);
}
console.log(`All good: ${files.length} files checked.`);
