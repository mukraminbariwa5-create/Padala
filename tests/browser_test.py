"""
Two-person browser test for Padala (optional; needs Python + Playwright).

  pip install playwright && playwright install chromium
  python tests/browser_test.py            # starts its own server on a temporary data folder

Covers: sign up, team + invite link, live chat, sending a folder (with a simulated signal drop),
updating a folder in place, sending only what changed, resolving a conflict, and the .zip download.
Folders are simulated in the page, so no real files are touched.
"""
import io, os, re, subprocess, sys, tempfile, time, zipfile, pathlib
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parent.parent
PORT = int(os.environ.get('PADALA_TEST_PORT', '8300'))
BASE = f'http://127.0.0.1:{PORT}'
SHOTS = pathlib.Path(os.environ.get('PADALA_SHOTS', ROOT / 'docs' / 'screenshots'))

NO_INTRO = "try { localStorage.setItem('padala.intro', 'off'); } catch (e) {}"

FAKE_FS = NO_INTRO + r"""
;(() => {
  const te = new TextEncoder();
  const mkDir = (name) => ({ kind: 'directory', name, children: new Map() });
  window.__fs = { send: mkDir('booktrack-v2'), recv: mkDir('booktrack-v2'), other: mkDir('fixoria-app') };
  window.__pick = 'send';
  class FileH {
    constructor(node) { this.kind = 'file'; this.name = node.name; this.node = node; }
    async getFile() { return new File([this.node.data], this.node.name); }
    async createWritable() {
      const node = this.node; const parts = [];
      return { write: async (d) => { parts.push(d); }, close: async () => { node.data = new Uint8Array(await new Blob(parts).arrayBuffer()); } };
    }
  }
  class DirH {
    constructor(node) { this.kind = 'directory'; this.name = node.name; this.node = node; }
    async *entries() { for (const [k, v] of this.node.children) yield [k, v.kind === 'directory' ? new DirH(v) : new FileH(v)]; }
    async getDirectoryHandle(n, o = {}) {
      let c = this.node.children.get(n);
      if (!c) { if (!o.create) throw new DOMException('missing', 'NotFoundError'); c = mkDir(n); this.node.children.set(n, c); }
      if (c.kind !== 'directory') throw new DOMException('not a folder', 'TypeMismatchError');
      return new DirH(c);
    }
    async getFileHandle(n, o = {}) {
      let c = this.node.children.get(n);
      if (!c) { if (!o.create) throw new DOMException('missing', 'NotFoundError'); c = { kind: 'file', name: n, data: new Uint8Array(0) }; this.node.children.set(n, c); }
      if (c.kind !== 'file') throw new DOMException('not a file', 'TypeMismatchError');
      return new FileH(c);
    }
    async removeEntry(n) { if (!this.node.children.delete(n)) throw new DOMException('missing', 'NotFoundError'); }
    async queryPermission() { return 'granted'; }
    async requestPermission() { return 'granted'; }
  }
  window.__put = (root, path, content) => {
    const parts = path.split('/'); let n = window.__fs[root];
    for (const p of parts.slice(0, -1)) { if (!n.children.has(p)) n.children.set(p, mkDir(p)); n = n.children.get(p); }
    const data = typeof content === 'string' ? te.encode(content) : new Uint8Array(content);
    n.children.set(parts.at(-1), { kind: 'file', name: parts.at(-1), data });
  };
  window.__del = (root, path) => {
    const parts = path.split('/'); let n = window.__fs[root];
    for (const p of parts.slice(0, -1)) n = n.children.get(p);
    n.children.delete(parts.at(-1));
  };
  window.__get = (root, path) => {
    let n = window.__fs[root];
    for (const p of path.split('/')) n = n && n.children && n.children.get(p);
    return n && n.kind === 'file' ? new TextDecoder().decode(n.data) : null;
  };
  window.__list = (root) => {
    const out = []; const walk = (n, pre) => { for (const [k, v] of n.children) v.kind === 'directory' ? walk(v, pre + k + '/') : out.push(pre + k); };
    walk(window.__fs[root], ''); return out.sort();
  };
  window.showDirectoryPicker = async (o) => new DirH(window.__fs[o && o.id === 'padala-send' ? window.__pick : 'recv']);
})();
"""

checks = []
def check(ok, label):
    checks.append((bool(ok), label))
    print(('  ✓ ' if ok else '  ✗ FAIL: ') + label)

def shot(page, name, full=False):
    SHOTS.mkdir(parents=True, exist_ok=True)
    page.evaluate("document.querySelectorAll('.toast').forEach((t) => t.remove())")
    page.wait_for_timeout(400)
    page.screenshot(path=str(SHOTS / f'{name}.png'), full_page=full)

def main():
    data_dir = tempfile.mkdtemp(prefix='padala-browser-')
    env = {**os.environ, 'PORT': str(PORT), 'DATA_DIR': data_dir, 'HOST': '127.0.0.1'}
    server = subprocess.Popen(['node', '--disable-warning=ExperimentalWarning', 'server/index.js'], cwd=ROOT, env=env,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        for _ in range(50):
            try:
                import urllib.request; urllib.request.urlopen(BASE + '/api/health'); break
            except Exception: time.sleep(0.1)
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            if COLLECT: collect_text(browser)
            run(browser)
            browser.close()
    finally:
        server.terminate()
        out = server.communicate(timeout=5)[0].decode()
        if 'Error' in out: print(out)
    failed = [l for ok, l in checks if not ok]
    print(f'\n{len(checks) - len(failed)} passed, {len(failed)} failed')
    sys.exit(1 if failed else 0)

COLLECT = os.environ.get('PADALA_I18N_COLLECT')  # a file: every English text the app showed during the run
LANG = os.environ.get('PADALA_TEST_LANG')        # 'fil': run in Filipino (text checks are skipped)

def collect_text(browser):
    seen = set()
    plain = browser.new_context
    def new_context(*a, **k):
        ctx = plain(*a, **k)
        ctx.add_init_script("try { localStorage.setItem('padala.i18nCollect', '1'); } catch (e) {}")
        ctx.expose_binding('__i18nReport', lambda _src, key: seen.add(key))
        return ctx
    browser.new_context = new_context
    import atexit, json
    atexit.register(lambda: pathlib.Path(COLLECT).write_text(json.dumps(sorted(seen), ensure_ascii=False, indent=0)))

def save_recovery(page, name=None):
    """After creating an account: the recovery code screen. Tick 'I saved it' and continue."""
    page.wait_for_selector('[data-code]', timeout=15000)
    code = page.locator('[data-code]').inner_text().replace('\n', '-').strip()
    if name: shot(page, name)
    page.check('[data-saved-it]'); page.click('[data-done]')
    return code

def run(browser):
    a_ctx = browser.new_context(viewport={'width': 1280, 'height': 820})
    b_ctx = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    for c in (a_ctx, b_ctx): c.add_init_script(FAKE_FS)
    a = a_ctx.new_page(); b = b_ctx.new_page()
    errors = []
    for p in (a, b): p.on('pageerror', lambda e: errors.append(str(e)))

    print('1. Accounts, team and invite')
    a.goto(BASE + '/#/signup')
    a.wait_for_selector('#f-name')
    shot(a, 'sign-up')
    a.click('form button[type=submit]')
    check(a.locator('.fx.is-invalid:has(#f-name) .fx-err').inner_text() == 'Please enter your name.', 'empty form shows the error right under the field')
    a.fill('#f-name', 'Mukramin Ansao'); a.fill('#f-user', 'mu')
    check(a.locator('.fx:has(#f-user)').get_attribute('class').find('is-valid') < 0, 'too-short username is not marked valid')
    a.fill('#f-user', 'mukramin')
    check('is-valid' in a.locator('.fx:has(#f-user)').get_attribute('class'), 'valid username gets a check mark')
    a.fill('#f-pass', 'abc')
    check(a.get_attribute('[data-meter]', 'data-level') == '1', 'weak password shows a weak meter')
    a.fill('#f-pass', 'Password123!')
    check(a.get_attribute('[data-meter]', 'data-level') == '4', 'strong password fills the meter')
    a.click('[data-eye]')
    check(a.get_attribute('#f-pass', 'type') == 'text', 'eye button shows the password')
    shot(a, 'sign-up-filled')
    a.fill('#f-pass', 'password123')
    a.click('form button:has-text("Create account")')
    mu_code = save_recovery(a, 'recovery-code')
    check(len(mu_code.replace('-', '')) == 24, 'a new account gets a recovery code to save')
    a.wait_for_selector('text=Start a new team')
    a.click('text=Start a new team')
    a.fill('#tn', 'Jolo Web Studio'); a.click('dialog >> text=Create team')
    a.wait_for_selector('text=Create invite link')
    a.click('[data-make-invite]')
    link = a.locator('[data-invite] .key-box').inner_text()
    check(re.search(r'#/join/[\w-]+/[\w-]{43}$', link), 'invite link carries token and team key after the #')

    b.goto(link.replace('http://localhost', BASE) if link.startswith('http://localhost') else link)
    b.wait_for_selector('text=Join Jolo Web Studio')
    shot(b, 'join-invite')
    b.fill('#f-name', 'Partner Jolo'); b.fill('#f-user', 'partner'); b.fill('#f-pass', 'password456')
    b.click('button:has-text("Create account")')
    save_recovery(b)
    b.click('[data-accept]')
    b.wait_for_selector('.home-head')
    check('/join/' not in b.url, 'team key removed from the address bar after joining')
    check(b.evaluate("Object.keys(JSON.parse(localStorage.getItem('padala.keys'))).length") == 1, 'partner device stored the team key')
    b.wait_for_selector('.dala-bubble:has-text("I’m Dala")', timeout=5000)
    check(True, 'Dala greets the new user')
    shot(b, 'mobile-welcome')

    print('2. Project and live chat')
    a.goto(BASE + '/#/')
    a.wait_for_selector('text=Partner Jolo online', timeout=5000)
    check(True, 'partner shows as online')
    a.click('.sidebar [data-new-project]')
    a.fill('#np-name', 'booktrack-v2'); a.click('dialog >> text=Create')
    a.wait_for_selector('[data-timeline]')
    a.fill('#msg', 'Sending the first version now. Import the .sql first.')
    a.keyboard.press('Enter')
    b.wait_for_selector('[data-home-list] .project-card:has-text("booktrack-v2")')
    shot(b, 'mobile-home-new-project', full=True)
    b.click('[data-home-list] .project-card:has-text("booktrack-v2")', timeout=5000)
    b.wait_for_selector('.bubble:has-text("Sending the first version now")')
    check(True, 'message decrypted on the partner’s phone')
    b.fill('#msg', 'Okay! Waiting for it.')
    b.click('.composer .send')
    a.wait_for_selector('.bubble:has-text("Okay! Waiting for it.")')
    check(True, 'reply arrives live without refreshing')

    print('3. Send v1 over a weak connection')
    files = {
        'index.php': '<?php require "includes/auth.php";',
        'includes/auth.php': '<?php // login v1',
        'config.php': "<?php $db = ['user' => 'root', 'pass' => ''];",
        'database/booktrack.sql': 'CREATE TABLE books (id INT);',
        'notes.txt': 'Client: BSIT capstone',
        'error_log': 'PHP Warning: something on my laptop',
        'old/legacy.php': '<?php // remove me later',
        '.git/config': '[core]',
    }
    for p, c in files.items(): a.evaluate('([p, c]) => __put("send", p, c)', [p, c])
    png = list(bytes.fromhex('89504e470d0a1a0a0000000d494844520000000200000002080600000072b60d240000001449444154789c634cfad4f59f8181818189010a002be002e1fbd71b040000000049454e44ae426082'))
    a.evaluate('(b) => __put("send", "assets/logo.png", b)', png)
    a.evaluate('() => __put("send", "assets/demo.bin", Array.from({length: 12582912}, (_, i) => (i * 31) % 256))')
    a.click('.head-send')
    a.wait_for_selector('text=Choose what to send')
    shot(a, 'send-choose')
    a.click('[data-drop]')
    a.wait_for_selector('h1:has-text("Ready to send")')
    check(a.locator('text=Left out automatically: .git/').count() == 1, '.git folder skipped automatically')
    check(a.locator('.card:has-text("First version") b:has-text("booktrack-v2")').count() == 1, 'same folder name goes to the same project')
    check(a.locator('.checkup .finding--good:has-text("Database included")').count() == 1, 'Dala notices the .sql file')
    check(a.locator('.checkup .finding--info:has-text("Log files")').count() == 1, 'Dala spots the error log')
    shot(a, 'send-ready')
    a.click('.checkup [data-leave="logs"]')
    a.wait_for_selector('.checkup .finding--out:has-text("Left out")')
    check(a.locator('.card:has-text("First version") .muted:has-text("8 files")').count() == 1, 'leaving the log out updates the file count')
    a.click('.checkup-guide summary')
    check(a.locator('.checkup-guide li:has-text("Put the folder in htdocs")').count() == 1, 'the sender can see the setup notes their partner gets')
    shot(a, 'send-checkup')
    a.fill('#note', 'First version. Import database/booktrack.sql in XAMPP first.')
    # slow the upload so the progress screen and the signal drop are visible
    a.route('**/api/teams/*/blobs/*/*', lambda route: (time.sleep(0.6), route.continue_()))
    a.click('[data-go]')
    a.wait_for_selector('.pieces i.done', timeout=10000)
    check(a.locator('.trip .courier img[src*="/run.webp"]').count() == 1, 'Dala carries the package while files are sending')
    check(a.locator('.trip-end--to:has-text("Online")').count() == 1, 'the scene shows the partner is online')
    shot(a, 'transfer-running')
    a.context.set_offline(True)
    a.wait_for_selector('text=Your internet connection dropped', timeout=10000)
    check(a.locator('.trip.is-waiting .courier img[src*="/surprised.webp"]').count() == 1, 'Dala stops under a cloud when the signal drops')
    time.sleep(0.8)
    shot(a, 'transfer-signal-lost')
    check(True, 'signal drop shows a waiting message instead of failing')
    time.sleep(2)
    a.context.set_offline(False)
    a.wait_for_selector('text=The signal dropped', timeout=20000)
    shot(a, 'transfer-resumed')
    a.wait_for_selector('.trip.is-done', timeout=30000)
    check(a.locator('.courier-say:has-text("Delivered!")').count() == 1, 'Dala hands the package over')
    time.sleep(0.9)
    shot(a, 'transfer-delivered')
    a.wait_for_selector('h1:has-text("Sent!")', timeout=30000)
    shot(a, 'send-done')
    a.click('text=Open the chat')
    a.wait_for_selector('.delivery:has-text("Version 1")')
    a.unroute('**/api/teams/*/blobs/*/*')
    check(True, 'v1 finished after the connection came back')

    print('4. Partner updates their folder')
    b.wait_for_selector('.new-files:has-text("sent you new files")', timeout=10000)
    b.wait_for_selector('.dala-bubble:has-text("sent you new files")', timeout=5000)
    check(b.locator('.dala-actions a:has-text("Get files")').count() == 1, 'Dala brings the files and offers a Get files button')
    shot(b, 'mobile-chat')
    b.click('.new-files >> text=Get files')
    b.wait_for_selector('[data-update]')
    check(b.locator('.guide[open] li:has-text("Put the folder in htdocs")').count() == 1 and b.locator('.guide li:has-text("Load the database")').count() == 1, 'setup notes explain how to open the project')
    shot(b, 'mobile-get-files', full=True)
    b.click('[data-update]')
    b.wait_for_selector('text=Your copy is up to date!', timeout=30000)
    check(b.locator('.guide:has-text("booktrack.sql")').count() == 1, 'after saving, the next steps are right there')
    shot(b, 'mobile-saved-next-steps', full=True)
    got = b.evaluate('() => __list("recv")')
    check(got == sorted(['.padala.json', 'assets/demo.bin', 'assets/logo.png', 'config.php', 'database/booktrack.sql', 'includes/auth.php', 'index.php', 'notes.txt', 'old/legacy.php']),
          f'folder has every file plus .padala.json ({len(got)} files)')
    check(b.evaluate('() => __get("recv", "config.php")') == files['config.php'], 'file contents match exactly')
    a.wait_for_selector('.delivery:has-text("Partner Jolo downloaded it")', timeout=10000)
    check(True, 'sender sees the download receipt live')

    print('5. Only what changed + a conflict')
    b.evaluate('() => { __put("recv", "config.php", "<?php $db = [\'user\' => \'root\', \'pass\' => \'client-secret\'];"); __put("recv", "notes.txt", "Client: BSIT capstone — paid half"); }')
    a.evaluate('''() => {
      __put("send", "includes/auth.php", "<?php // login v2: works when MySQL has a password");
      __put("send", "config.php", "<?php $db = ['user' => 'root', 'pass' => getenv('DB_PASS') ?: ''];");
      __put("send", "database/upgrade.sql", "ALTER TABLE books ADD cover VARCHAR(255);");
      __del("send", "old/legacy.php");
    }''')
    a.click('.head-send')
    a.click('[data-drop]')
    a.wait_for_selector('h1:has-text("You changed 4 files")')
    a.fill('#note', 'Fixed login when MySQL has a password')
    shot(a, 'send-only-changes')
    check("12.0 MB" not in a.locator(".big-number").inner_text() and "MB" not in a.locator(".big-number").inner_text(), "the big unchanged file is not sent again")
    a.click('[data-go]')
    a.wait_for_selector('h1:has-text("Sent!")', timeout=20000)
    a.click('text=Open the chat')
    a.wait_for_selector('.delivery:has-text("Version 2")')
    shot(a, 'desktop-chat')

    b.click('text=Back to the chat')
    b.wait_for_selector('.new-files:has-text("Version 2")', timeout=10000)
    b.click('.new-files >> text=Get files')
    b.wait_for_selector('[data-update]')
    shot(b, 'mobile-version', full=True)
    check(b.locator('[data-file-list] .file-row:has-text("config.php")').count() == 1, 'changed files are listed before downloading')
    b.click('[data-file-list] .file-row:has-text("config.php")')
    b.wait_for_selector('.viewer .code')
    check('getenv' in b.locator('.viewer .code').inner_text(), 'preview shows the new config.php code')
    shot(b, 'mobile-preview-code')
    b.keyboard.press('Escape')
    b.click('input[name=show][value=all] + span')
    b.click('[data-file-list] .file-row:has-text("logo.png")')
    b.wait_for_selector('.viewer img')
    b.wait_for_function("document.querySelector('.viewer img').complete")
    check(b.evaluate("document.querySelector('.viewer img').naturalWidth") == 2, 'image preview shows the picture')
    b.keyboard.press('Escape')
    check(b.locator('.viewer').count() == 0, 'Escape closes the preview')
    b.click('[data-update]')
    b.wait_for_selector('text=You also changed a file')
    shot(b, 'mobile-conflict')
    b.click('dialog label:has-text("Keep both")')
    b.click('dialog button:has-text("Continue")')
    b.wait_for_selector('text=Your copy is up to date!', timeout=20000)
    check(b.evaluate('() => __get("recv", "config.mine.php")').find('client-secret') > 0, 'partner’s edited config kept as config.mine.php')
    check('getenv' in b.evaluate('() => __get("recv", "config.php")'), 'new config.php written')
    check('v2' in b.evaluate('() => __get("recv", "includes/auth.php")'), 'changed file updated')
    check(b.evaluate('() => __get("recv", "old/legacy.php")') is None, 'removed file deleted')
    check('paid half' in b.evaluate('() => __get("recv", "notes.txt")'), 'partner’s own edit to an unchanged file is kept')
    shot(b, 'mobile-updated')

    print('6. Status and zip download')
    b.click('text=Back to the chat')
    b.wait_for_selector('[data-timeline] .delivery')
    check(b.locator('.new-files').count() == 0, '"new files" banner is gone once the latest version is downloaded')
    b.click('[data-status-btn]')
    b.click('[role=menuitemradio]:has-text("Given to client")')
    a.wait_for_selector('.system:has-text("marked the project as Given to client")', timeout=10000)
    check(True, 'status change reaches the sender live')
    b.goto(BASE + '/#/p/1/v/2')
    b.wait_for_selector('[data-zip]')
    with b.expect_download() as dl:
        b.click('[data-zip]')
    path = dl.value.path()
    z = zipfile.ZipFile(path)
    names = sorted(z.namelist())
    check('booktrack-v2/.padala.json' in names and 'booktrack-v2/includes/auth.php' in names, f'zip has the folder structure ({len(names)} entries)')
    check(z.testzip() is None, 'zip is valid')
    check(dl.value.suggested_filename == 'booktrack-v2-v2.zip', 'zip is named after the project and version')

    a.goto(BASE + '/#/team'); a.wait_for_selector('text=Members'); a.wait_for_selector('.meter--storage')
    check(a.locator('.storage-row:has-text("booktrack-v2")').count() == 1, 'team page shows storage used per project')
    a.locator('#storage').scroll_into_view_if_needed(); shot(a, 'desktop-team')
    b.goto(BASE + '/#/'); b.wait_for_selector('[data-home-list] .project-card'); shot(b, 'mobile-home')
    a.goto(BASE + '/#/'); a.wait_for_selector('.home-head'); shot(a, 'desktop-home')
    a.click('.sidebar [data-send-files]')
    a.wait_for_selector('text=Choose what to send')
    check(True, 'big Send files button leads straight to choosing the folder')

    print('7. A different folder becomes its own delivery')
    a.evaluate('() => { __put("other", "index.html", "<h1>Fixoria</h1>"); __put("other", "css/site.css", "body{}"); window.__pick = "other"; }')
    a.click('[data-drop]')
    a.wait_for_selector('h1:has-text("Ready to send")')
    check(a.locator('.card:has-text("New project")').count() == 1 and a.input_value('#pname') == 'fixoria-app', 'a new folder is sent as a new project named after the folder')
    shot(a, 'send-new-folder')
    a.click('[data-go]')
    a.wait_for_selector('h1:has-text("Sent!")', timeout=20000)
    a.click('text=Open the chat')
    a.wait_for_selector('.chat-head:has-text("fixoria-app")')
    check(a.locator('.delivery').count() == 1, 'the new project starts at its own first version')
    # from inside booktrack's chat, sending the fixoria folder asks first
    a.goto(BASE + '/#/p/1/send'); a.wait_for_selector('[data-drop]')
    a.click('[data-drop]')
    a.wait_for_selector('dialog >> text=This looks like a different folder')
    check(True, 'sending an unrelated folder into a project asks before calling it an update')
    shot(a, 'send-different-folder')
    a.click('dialog button:has-text("Continue")')
    a.wait_for_selector('h1:has-text("Nothing has changed")')
    check(True, 'choosing "separately" matches the existing fixoria-app project (same files, nothing to resend)')
    a.evaluate('() => { window.__pick = "send"; }')
    b.goto(BASE + '/#/'); b.wait_for_selector('[data-home-list] .project-card:has-text("fixoria-app")')
    check(True, 'the partner sees the new delivery as its own project')
    print('8. Delete a project, and a second team with someone else')
    a.goto(BASE + '/#/'); a.wait_for_selector('.sidebar .project-card:has-text("fixoria-app")')
    a.click('.sidebar .project-card:has-text("fixoria-app")')
    a.wait_for_selector('[data-proj-menu]'); a.click('[data-proj-menu]')
    a.click('[role=menuitem][data-act=delete]')
    a.wait_for_selector('dialog >> text=Delete “fixoria-app”?')
    shot(a, 'delete-project')
    a.click('dialog button:has-text("Delete project")')
    a.wait_for_selector('.home-head')
    check(a.locator('.sidebar .project-card:has-text("fixoria-app")').count() == 0, 'deleted project is gone for the sender')
    b.wait_for_selector('.toast:has-text("deleted")', timeout=5000)
    b.wait_for_function("!document.querySelector('[data-home-list]')?.innerText.includes('fixoria-app')", timeout=5000)
    check(True, 'the partner sees the project disappear live')
    # second team for a different person / topic
    a.click('.sidebar [data-switch-team]'); a.click('dialog [data-new-team]')
    a.fill('#tn', 'Thesis Clients'); a.click('dialog >> text=Create team')
    a.wait_for_selector('[data-make-invite]'); a.click('[data-make-invite]')
    thesis_link = a.locator('[data-invite] .key-box').inner_text()
    e_ctx = browser.new_context(viewport={'width': 390, 'height': 844}); e_ctx.add_init_script(FAKE_FS)
    e = e_ctx.new_page(); e.on('pageerror', lambda x: errors.append(str(x)))
    e.goto(thesis_link); e.wait_for_selector('#f-name')
    e.fill('#f-name', 'Ana Client'); e.fill('#f-user', 'ana'); e.fill('#f-pass', 'password000')
    e.click('form button[type=submit]'); save_recovery(e); e.click('[data-accept]'); e.wait_for_selector('.home-head')
    a.goto(BASE + '/#/send'); a.wait_for_selector('.team-chip')
    check(a.locator('.team-chip').count() == 2 and a.locator('.team-chip.is-on:has-text("Thesis Clients")').count() == 1, 'Send files asks which team when there are two')
    shot(a, 'send-choose-team')
    a.evaluate('() => { __fs.thesis = __fs.other; __fs.thesis.name = "thesis-site"; window.__pick = "thesis"; }')
    a.click('[data-drop]'); a.wait_for_selector('h1:has-text("Ready to send")')
    a.click('[data-go]'); a.wait_for_selector('h1:has-text("Sent!")', timeout=20000)
    e.wait_for_selector('[data-home-list] .project-card:has-text("thesis-site")', timeout=8000)
    check(True, 'the second person gets the files in their team')
    b.goto(BASE + '/#/'); b.wait_for_selector('[data-home-list]')
    check(b.locator('text=thesis-site').count() == 0, 'the first partner never sees the other team’s files')
    # messages from the other team show up as a notice with a Switch button
    a.goto(BASE + '/#/'); a.wait_for_selector('.sidebar [data-switch-team]')
    a.click('.sidebar [data-switch-team]'); a.click('dialog label:has-text("Jolo Web Studio")'); a.click('dialog button:has-text("Switch")')
    a.wait_for_selector('.sidebar .team-switch:has-text("Jolo Web Studio")')
    e.click('[data-home-list] .project-card:has-text("thesis-site")'); e.fill('#msg', 'Thank you! Received.'); e.click('.composer .send')
    a.wait_for_selector('.toast:has-text("Thesis Clients")', timeout=6000)
    check(a.locator('.sidebar .team-switch .badge').count() == 1, 'unread badge for the other team')
    shot(a, 'other-team-notice')
    # no "delete team": people leave, and the last one out removes it
    e.goto(BASE + '/#/team'); e.wait_for_selector('[data-leave-team]')
    check(e.locator('[data-delete-team]').count() == 0, 'there is no delete-team button, only Leave')
    e.click('[data-leave-team]'); e.wait_for_selector('dialog >> text=Leave “Thesis Clients”?')
    e.click('dialog button:has-text("Leave team")')
    e.wait_for_url('**/#/setup', timeout=6000)
    check(True, 'the partner leaves and is sent to start or join a team')
    a.wait_for_selector('.toast:has-text("left")', timeout=6000)
    check(True, 'the others are told who left')
    a.click('.sidebar [data-switch-team]'); a.click('dialog label:has-text("Thesis Clients")'); a.click('dialog button:has-text("Switch")')
    a.wait_for_selector('.sidebar .team-switch:has-text("Thesis Clients")')
    a.goto(BASE + '/#/team'); a.wait_for_selector('[data-leave-team]')
    check(a.locator('text=You’re the last one here').count() == 1, 'the last member is warned that leaving deletes the team')
    a.click('[data-leave-team]'); a.wait_for_selector('dialog >> text=Delete “Thesis Clients”?')
    shot(a, 'leave-last')
    a.click('dialog button:has-text("Leave and delete team")')
    a.wait_for_selector('.sidebar .team-switch:has-text("Jolo Web Studio")')
    check(a.locator('.toast:has-text("was deleted")').count() == 1, 'last one out: team deleted, moved to the other team')
    e_ctx.close()

    print('9. Invite from a browser without the team key')
    c_ctx = browser.new_context(viewport={'width': 1280, 'height': 820}); c_ctx.add_init_script(NO_INTRO)
    c = c_ctx.new_page(); c.on('pageerror', lambda e: errors.append(str(e)))
    c.goto(BASE + '/#/signup'); c.wait_for_selector('#f-name')
    c.fill('#f-name', 'Tester'); c.fill('#f-user', 'tester'); c.fill('#f-pass', 'password789')
    c.click('form button[type=submit]'); save_recovery(c); c.click('text=Start a new team')
    c.fill('#tn', 'Lost Key Team'); c.click('dialog >> text=Create team')
    c.wait_for_selector('[data-make-invite]')
    c.evaluate("localStorage.removeItem('padala.keys'); indexedDB.deleteDatabase('padala-keyring')")   # like opening Padala in another browser
    c.reload(); c.wait_for_selector('main h1')
    c.goto(BASE + '/#/team'); c.wait_for_selector('[data-make-invite]')
    c.click('[data-make-invite]')
    check(c.locator('text=can’t make invite links for this team').count() == 1, 'no broken invite link without the team key; explains why')
    check(c.locator('[data-invite] .key-box').count() == 0, 'no link shown')
    check(c.locator('[data-confirm-password="unlock"]').count() == 1, 'a locked device offers to unlock with the password')
    c.click('text=Start a new team instead')
    c.click('text=Start a new team'); c.fill('#tn', 'Fresh Team'); c.click('dialog >> text=Create team')
    c.wait_for_selector('[data-make-invite]'); c.click('[data-make-invite]')
    fresh = c.locator('[data-invite] .key-box').inner_text()
    check(re.search(r'#/join/[\w-]+/[\w-]{43}$', fresh), 'fresh team makes a complete invite link')
    d_ctx = browser.new_context(viewport={'width': 390, 'height': 844}); d_ctx.add_init_script(NO_INTRO)
    d = d_ctx.new_page()
    token, key = re.search(r'#/join/([\w-]+)/([\w-]+)$', fresh).groups()
    d.goto(BASE + f'/#/join/{token}/undefined'); d.wait_for_selector('main h1')
    check('can’t be used' in d.locator('main h1').inner_text() and 'secret key' in d.locator('main').inner_text(), 'a link made without the key explains what happened')
    d.goto(BASE + f'/#/join/{token}/{key}%20')    # a trailing space from copy-paste
    d.wait_for_selector('text=Join Fresh Team')
    check(True, 'link with a stray space still works')
    # back on the locked browser: the password unlocks the first team from its backup
    c.goto(BASE + '/#/'); c.wait_for_selector('.sidebar [data-switch-team]')
    c.click('.sidebar [data-switch-team]'); c.click('dialog label:has-text("Lost Key Team")'); c.click('dialog button:has-text("Switch")')
    c.wait_for_selector('[data-confirm-password="unlock"]')
    c.click('[data-confirm-password="unlock"]'); c.fill('#cp', 'password789'); c.click('dialog button:has-text("Continue")')
    c.wait_for_selector('.toast:has-text("unlocked")', timeout=10000)
    check(c.locator('[data-confirm-password="unlock"]').count() == 0, 'unlock with password restores the team key')
    c_ctx.close(); d_ctx.close()

    print('10. App feel: opening animation, pages, tab bar')
    a.goto(BASE + '/#/projects'); a.wait_for_selector('[data-proj-grid] .pt-row[href]')
    check(a.locator('.sidebar .nav-item.is-on:has-text("Projects")').count() == 1, 'sidebar highlights the current page')
    a.click('.chip:has-text("Paid")')
    check(a.locator('[data-proj-grid] .pt-row[href]').count() == 0, 'status filter works')
    a.click('.chip:has-text("All")')
    check(a.locator('[data-proj-grid] .pt-row[href]').count() >= 1, 'computers get a project table')
    shot(a, 'desktop-projects')
    a.click('[data-view="cards"]'); a.wait_for_selector('[data-proj-grid] .project-card')
    check(True, 'the table can switch to cards'); shot(a, 'desktop-projects-cards')
    a.click('[data-view="table"]'); a.wait_for_selector('[data-proj-grid] .pt-row[href]')
    a.goto(BASE + '/#/settings'); a.wait_for_selector('.profile')
    check(a.locator('[data-dala-toggle][role=switch]').count() == 1, 'settings has the Dala switch')
    shot(a, 'desktop-settings')
    f_ctx = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    f = f_ctx.new_page(); f.on('pageerror', lambda e: errors.append(str(e)))
    f.goto(BASE + '/#/signin')
    f.wait_for_selector('.splash.is-full')
    f.wait_for_selector('.splash.is-talking', timeout=6000)
    check('your friendly assistant' in f.locator('.splash-bubble').inner_text(), 'first time: Dala flies in and introduces itself')
    f.wait_for_selector('.splash-actions.in button:has-text("Next")')
    shot(f, 'mobile-intro')
    f.wait_for_timeout(4000)
    check('your friendly assistant' in f.locator('.splash-bubble').inner_text(), 'onboarding waits for the person: no automatic next step')
    f.click('.splash-actions button:has-text("Next")')
    f.wait_for_selector('.splash-bubble:has-text("project folders")', timeout=4000)
    shot(f, 'mobile-intro-2')
    f.click('.splash-actions button:has-text("Next")')
    f.wait_for_selector('.splash-bubble:has-text("only the files you changed")', timeout=4000)
    f.click('.splash-actions button:has-text("Next")')
    f.wait_for_selector('.splash-actions.in button:has-text("Create an account")', timeout=4000)
    check(f.locator('.splash-actions button:has-text("Create an account")').count() == 1, 'first time: Dala offers to create an account or sign in')
    shot(f, 'mobile-intro-choose')
    f.click('.splash-actions button:has-text("I already have an account")')
    f.wait_for_selector('#splash', state='detached', timeout=5000)
    f.wait_for_selector('#f-user')
    check('#/signin' in f.url, 'then the sign-in page slides in')
    f.fill('#f-user', 'mukramin'); f.fill('#f-pass', 'password123'); f.click('form button[type=submit]')
    f.wait_for_selector('.tabbar')
    check(f.locator('.tabbar .tab.is-on:has-text("Home")').count() == 1, 'phones get a bottom tab bar')
    f.click('.tabbar .tab:has-text("You")'); f.wait_for_selector('.profile')
    shot(f, 'mobile-settings', full=True)
    f.click('.tabbar .tab:has-text("Projects")'); f.wait_for_selector('[data-proj-grid]')
    shot(f, 'mobile-projects')
    # a brand-new phone: signing in restored the team key from the backup, so the files open
    f.goto(BASE + '/#/p/1/v/2'); f.wait_for_selector('[data-file-list] .file-row', timeout=10000)
    check(f.locator('text=Locked on this device').count() == 0, 'signing in on a new device unlocks the team automatically (key backup)')
    shot(f, 'mobile-new-device-unlocked', full=True)
    # a phone that lost its connection catches up by itself, no refresh needed
    b.goto(BASE + '/#/p/1'); b.wait_for_selector('[data-timeline]')
    b.context.set_offline(True); b.wait_for_timeout(1500)
    a.goto(BASE + '/#/p/1'); a.wait_for_selector('#msg')
    a.fill('#msg', 'Sent while your phone was offline'); a.keyboard.press('Enter')
    a.wait_for_selector('.bubble:has-text("Sent while your phone was offline")')
    b.context.set_offline(False)
    b.wait_for_selector('.bubble:has-text("Sent while your phone was offline")', timeout=20000)
    check(True, 'after reconnecting, missed messages appear without refreshing')
    g = f_ctx.new_page(); g.on('pageerror', lambda e: errors.append(str(e)))   # opening the app again
    g.goto(BASE + '/')
    t0 = time.time(); g.wait_for_selector('.splash.is-talking', timeout=8000)
    check(time.time() - t0 > 2.0, 'the intro plays at a calm pace (Dala speaks after the logo, not instantly)')
    check('Welcome back, Mukramin' in g.locator('.splash-bubble').inner_text(), 'opening the app again: Dala welcomes a signed-in person back by name')
    shot(g, 'mobile-intro-welcome-back')
    check(g.locator('.splash-skip').count() == 0, 'no Skip button: a short intro like a real app')
    g.wait_for_selector('#splash', state='detached', timeout=9000)
    g.wait_for_selector('.home-head')
    check(True, 'the intro finishes by itself (about 6 seconds)')
    g.reload()
    g.wait_for_selector('#splash', state='detached', timeout=1500)
    g.wait_for_selector('.home-head')
    check(g.locator('.splash-bubble').count() == 0, 'refreshing the page does not replay the intro')
    # signed out, not the first time: Dala says hello, then the sign-in page
    g.click('.tabbar .tab:has-text("You")'); g.wait_for_selector('[data-signout]'); g.click('[data-signout]'); g.wait_for_selector('#f-user')
    h = f_ctx.new_page(); h.on('pageerror', lambda e: errors.append(str(e)))
    h.goto(BASE + '/')
    h.wait_for_selector('.splash.is-talking', timeout=6000)
    h.wait_for_selector('.splash-actions.in button:has-text("Next")')
    check('your friendly assistant' in h.locator('.splash-bubble').inner_text(), 'signed out again: the onboarding shows again (it depends on being signed out, not on old data)')
    for _ in range(3): h.click('.splash-actions button:has-text("Next")'); h.wait_for_timeout(200)
    h.click('.splash-actions button:has-text("I already have an account")')
    h.wait_for_selector('#splash', state='detached', timeout=5000)
    h.wait_for_selector('#f-user')
    check(True, 'then the sign-in page appears')
    f_ctx.close()

    print('10a. Reply, delete, profile photo')
    a.goto(BASE + '/#/p/1'); a.wait_for_selector('.bubble:has-text("Okay! Waiting for it.")')
    a.click('.bubble:has-text("Okay! Waiting for it.")')
    a.click('.msg-menu [data-act="reply"]')
    a.wait_for_selector('[data-reply-bar]:not([hidden]):has-text("Replying to Partner Jolo")')
    a.fill('#msg', 'Great, sending it now!'); a.keyboard.press('Enter')
    a.wait_for_selector('.bubble:has(.reply-quote:has-text("Okay! Waiting for it.")):has-text("Great, sending it now!")')
    check(True, 'reply shows the quoted message above it')
    b.goto(BASE + '/#/p/1'); b.wait_for_selector('.bubble:has(.reply-quote):has-text("Great, sending it now!")', timeout=8000)
    check(True, 'the partner sees the reply live')
    a.fill('#msg', 'Oops, wrong chat'); a.keyboard.press('Enter')
    a.wait_for_selector('.bubble:has-text("Oops, wrong chat")')
    a.click('.bubble:has-text("Oops, wrong chat")'); a.click('.msg-menu [data-act="delete"]'); a.click('dialog button:has-text("Delete")')
    a.wait_for_selector('.bubble--deleted:has-text("You deleted this message")')
    b.wait_for_selector('.bubble--deleted:has-text("This message was deleted")', timeout=8000)
    check(b.locator('.bubble:has-text("Oops, wrong chat")').count() == 0, 'a deleted message disappears for everyone')
    shot(b, 'mobile-chat-reply-delete')
    a.goto(BASE + '/#/settings'); a.wait_for_selector('.profile')
    import struct, zlib
    def png(w, h, rgb):
        raw = b''.join(b'\x00' + bytes(rgb) * w for _ in range(h))
        chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
        return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
    with a.expect_file_chooser() as fc:
        a.click('.profile .linkish[data-photo]')
    fc.value.set_files(files=[{'name': 'me.png', 'mimeType': 'image/png', 'buffer': png(400, 300, (98, 180, 140))}])
    a.wait_for_selector('.profile .avatar.has-photo img', timeout=10000)
    check(a.locator('.me-card .avatar.has-photo').count() == 1, 'profile photo shows in the sidebar too')
    b.goto(BASE + '/#/team'); b.wait_for_selector('.list-row .avatar.has-photo', timeout=8000)
    check(True, 'teammates see the new photo')

    print('10b. Share to Padala (Android share menu)')
    b.goto(BASE + '/#/'); b.wait_for_selector('.home-head')
    b.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=10000)
    b.evaluate('''async () => {
      const fd = new FormData();
      fd.append('files', new File(['<h1>Shared from the gallery</h1>'], 'poster.html', { type: 'text/html' }));
      fd.append('files', new File([new Uint8Array(2048)], 'photo.jpg', { type: 'image/jpeg' }));
      await fetch('/share-target', { method: 'POST', body: fd });
    }''')
    b.goto(BASE + '/#/send?shared')
    b.wait_for_selector('h1:has-text("Ready to send")', timeout=15000)
    check(b.locator('.card:has-text("2 files")').count() >= 1, 'files shared from another app open in Send files')
    shot(b, 'mobile-shared-files')

    print('11. Forgot password: recovery code on a new phone, then change password')
    r_ctx = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True); r_ctx.add_init_script(NO_INTRO)
    r = r_ctx.new_page(); r.on('pageerror', lambda e: errors.append(str(e)))
    r.goto(BASE + '/#/signin'); r.wait_for_selector('.forgot-link'); r.click('.forgot-link')
    r.wait_for_selector('#fg-code')
    r.fill('#fg-user', 'mukramin'); r.fill('#fg-code', mu_code.lower().replace('-', ' ')); r.fill('#fg-pass', 'brand-new-pass')
    shot(r, 'mobile-forgot-password')
    r.click('form button:has-text("Reset password")')
    r.wait_for_selector('.home-head', timeout=15000)
    check(True, 'the recovery code resets a forgotten password')
    r.goto(BASE + '/#/p/1/v/2'); r.wait_for_selector('[data-file-list] .file-row', timeout=10000)
    check(r.locator('text=Locked on this device').count() == 0, 'after the reset, files still unlock (the recovery code opened the key backup)')
    r.goto(BASE + '/#/settings'); r.wait_for_selector('[data-change-password]')
    shot(r, 'mobile-settings-security', full=True)
    r.click('[data-change-password]'); r.fill('#cp-old', 'brand-new-pass'); r.fill('#cp-new', 'changed-again-1'); r.click('dialog button:has-text("Change password")')
    r.wait_for_selector('.toast:has-text("Password changed")', timeout=10000)
    r2 = r_ctx.browser.new_context(); r2.add_init_script(NO_INTRO); q = r2.new_page()
    q.goto(BASE + '/#/signin'); q.wait_for_selector('#f-user'); q.fill('#f-user', 'mukramin'); q.fill('#f-pass', 'changed-again-1'); q.click('form button[type=submit]')
    q.wait_for_selector('.home-head', timeout=15000)
    q.goto(BASE + '/#/p/1/v/2'); q.wait_for_selector('[data-file-list] .file-row', timeout=10000)
    check(q.locator('text=Locked on this device').count() == 0, 'after changing the password, a new device signs in with it and files unlock')
    r_ctx.close(); r2.close()

    print('12. Light mode')
    lt_ctx = browser.new_context(viewport={'width': 1280, 'height': 820}); lt_ctx.add_init_script(NO_INTRO + "; if (!localStorage.getItem('padala.theme')) localStorage.setItem('padala.theme', 'light')")
    lt = lt_ctx.new_page(); lt.on('pageerror', lambda e: errors.append(str(e)))
    lt.goto(BASE + '/#/signin'); lt.wait_for_selector('#f-user')
    check(lt.evaluate("document.documentElement.dataset.theme") == 'light', 'the light theme is applied before the page draws')
    shot(lt, 'light-sign-in')
    lt.fill('#f-user', 'mukramin'); lt.fill('#f-pass', 'changed-again-1'); lt.click('form button[type=submit]')
    lt.wait_for_selector('.home-head'); shot(lt, 'light-desktop-home')
    lt.goto(BASE + '/#/p/1'); lt.wait_for_selector('[data-timeline] .delivery'); shot(lt, 'light-desktop-chat')
    lt.goto(BASE + '/#/settings'); lt.wait_for_selector('input[name=theme][value=light]:checked')
    lt.click('input[name=theme][value=dark] + span')
    check(lt.evaluate("document.documentElement.dataset.theme") == 'dark', 'switching Appearance to Dark applies right away')
    lt.goto(BASE + '/#/'); lt.wait_for_selector('.home-head'); shot(lt, 'dark-desktop-home')
    lt.goto(BASE + '/#/p/1'); lt.wait_for_selector('[data-timeline] .delivery'); shot(lt, 'dark-desktop-chat')
    tb = lt_ctx.new_page(); tb.set_viewport_size({'width': 820, 'height': 1180})
    tb.goto(BASE + '/#/'); tb.wait_for_selector('.home-head'); shot(tb, 'dark-tablet-home'); tb.close()
    lt.goto(BASE + '/#/settings'); lt.wait_for_selector('input[name=theme][value=dark]:checked')
    lt.click('input[name=theme][value=light] + span'); shot(lt, 'light-desktop-settings')
    lm = lt_ctx.new_page(); lm.set_viewport_size({'width': 390, 'height': 844})
    lm.goto(BASE + '/#/'); lm.wait_for_selector('.tabbar'); shot(lm, 'light-mobile-home')
    lt_ctx.close()

    print('13. Filipino')
    miss = set()
    fl_ctx = browser.new_context(viewport={'width': 1280, 'height': 820})
    fl_ctx.add_init_script(NO_INTRO + "; if (!localStorage.getItem('padala.lang')) localStorage.setItem('padala.lang', 'fil'); localStorage.setItem('padala.i18nMissing', '1')")
    fl_ctx.expose_binding('__i18nMissing', lambda _src, key: miss.add(key))
    fl = fl_ctx.new_page(); fl.on('pageerror', lambda e: errors.append(str(e)))
    fl.goto(BASE + '/#/signin'); fl.wait_for_selector('#f-user')
    check(fl.evaluate("document.documentElement.lang") == 'fil', 'Filipino: the page says it is in Filipino')
    check(fl.locator('h1:has-text("Maligayang pagbabalik")').count() == 1 and fl.locator('text=Nakalimutan ang password?').count() == 1, 'Filipino: the sign-in page is translated')
    shot(fl, 'fil-sign-in')
    fl.fill('#f-user', 'mukramin'); fl.fill('#f-pass', 'wrong-password'); fl.click('form button[type=submit]')
    fl.wait_for_selector('.fx-err', timeout=10000)
    check('Hindi tugma' in fl.locator('.fx-err').inner_text(), 'Filipino: errors from the server are translated too')
    fl.fill('#f-pass', 'changed-again-1'); fl.click('form button[type=submit]')
    fl.wait_for_selector('.home-head')
    check('Magpadala ng files' in fl.locator('.sidebar [data-send-files]').inner_text() and 'Kailangan ng atensyon mo' in fl.locator('.home').inner_text(), 'Filipino: the home screen is translated')
    months = ['Enero', 'Pebrero', 'Marso', 'Abril', 'Mayo', 'Hunyo', 'Hulyo', 'Agosto', 'Setyembre', 'Oktubre', 'Nobyembre', 'Disyembre']
    check(any(mo in fl.locator('.home-head .label').inner_text() for mo in months), 'Filipino: dates use Filipino month names')
    shot(fl, 'fil-desktop-home')
    fl.goto(BASE + '/#/projects'); fl.wait_for_selector('[data-proj-grid]'); shot(fl, 'fil-desktop-projects')
    fl.goto(BASE + '/#/p/1'); fl.wait_for_selector('[data-timeline] .delivery'); fl.wait_for_timeout(300)
    check(fl.locator('[data-timeline]').inner_text().count('bersyon') + fl.locator('[data-timeline]').inner_text().count('Ipinadala') + fl.locator('[data-timeline]').inner_text().count('Nagpadala') > 0, 'Filipino: the chat timeline is translated')
    shot(fl, 'fil-desktop-chat')
    fl.goto(BASE + '/#/p/1/v/2'); fl.wait_for_selector('[data-file-list] .file-row'); shot(fl, 'fil-desktop-version')
    fl.goto(BASE + '/#/send'); fl.wait_for_selector('[data-drop]')
    check('Pumili ng folder' in fl.locator('[data-drop]').inner_text(), 'Filipino: the send screen is translated')
    shot(fl, 'fil-desktop-send')
    fl.goto(BASE + '/#/team'); fl.wait_for_selector('[data-storage] b'); shot(fl, 'fil-desktop-team')
    fl.goto(BASE + '/#/settings'); fl.wait_for_selector('input[name=lang][value=fil]:checked'); shot(fl, 'fil-desktop-settings')
    fm = fl_ctx.new_page(); fm.set_viewport_size({'width': 390, 'height': 844}); fm.on('pageerror', lambda e: errors.append(str(e)))
    fm.goto(BASE + '/#/'); fm.wait_for_selector('.tabbar'); shot(fm, 'fil-mobile-home')
    fm.goto(BASE + '/#/p/1'); fm.wait_for_selector('[data-timeline] .delivery'); shot(fm, 'fil-mobile-chat')
    fm.close()
    # back to English from Settings: the page reloads in English, with no opening animation
    fl.click('input[name=lang][value=en] + span')
    fl.wait_for_selector('html[lang=en] h1:has-text("Settings")', timeout=10000)
    check(fl.locator('#splash').count() == 0, 'switching language back to English reloads without the opening animation')
    real = sorted(k for k in miss if re.search(r'[a-z]{3}', k) and not re.search(r'@|\.(php|sql|html|png|js)\b|^[A-Z][a-z]+( [A-Z][a-z]+)*( \{\d\})*$', k))
    if real: print('   not translated:', *real, sep='\n     ')
    fl_ctx.close()

    print('14. Accessibility audit (contrast, names, labels) in light and dark')
    audit = (ROOT / 'tests' / 'audit.js').read_text()
    for theme in ('light', 'dark'):
        for size, vw in (('desktop', {'width': 1280, 'height': 820}), ('phone', {'width': 390, 'height': 844})):
            ac = browser.new_context(viewport=vw)
            ac.add_init_script(NO_INTRO + f"; localStorage.setItem('padala.theme', '{theme}'); localStorage.setItem('padala.dala', 'off')")
            ap = ac.new_page()
            ap.goto(BASE + '/#/signin'); ap.wait_for_selector('#f-user')
            found = {'sign-in': ap.evaluate(audit)}
            ap.fill('#f-user', 'mukramin'); ap.fill('#f-pass', 'changed-again-1'); ap.click('form button[type=submit]')
            ap.wait_for_selector('.home-head')
            for name, path, sel in (('home', '/#/', '.home-head'), ('projects', '/#/projects', '[data-proj-grid]'), ('chat', '/#/p/1', '[data-timeline] .delivery'),
                                    ('files', '/#/p/1/v/2', '[data-file-list] .file-row'), ('send', '/#/send', '[data-drop]'), ('team', '/#/team', '[data-storage] b'), ('settings', '/#/settings', '.profile')):
                ap.goto(BASE + path); ap.wait_for_selector(sel); ap.wait_for_timeout(450)
                found[name] = ap.evaluate(audit)
            bad = {k: v for k, v in found.items() if v}
            check(not bad, f'{theme} {size}: no accessibility problems' + (''.join(f'\n       {k}: ' + '; '.join(v[:6]) for k, v in bad.items()) if bad else ''))
            ac.close()

    check(not errors, 'no JavaScript errors' + (f': {errors}' if errors else ''))

if __name__ == '__main__':
    main()
