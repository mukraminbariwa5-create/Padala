// The Team page: invite, members, storage, leave.
import { isValidKeyFormat } from '../crypto.js';
import { tr, locale } from '../i18n.js';
import { formatBytes } from '../sync.js';
import { esc, icon, initials, toast, dialog, copyText, field } from '../ui.js';
import { createTeam } from './auth.js';
import { storedKeys, isTeamOwner, afterTeamGone, avatarHtml } from './keys.js';
import { showQr } from './settings.js';
import { layout, projInitials, hueOf, keyBanner } from './shell.js';
import { api, app, S } from './state.js';

const KEEP_OPTIONS = [[null, 'Keep every version'], [10, 'Keep the last 10'], [5, 'Keep the last 5'], [3, 'Keep the last 3'], [1, 'Keep only the latest']];

async function loadStorage() {
  const box = app.querySelector('[data-storage]');
  if (!box) return;
  let st;
  try { st = await api.get(`/api/teams/${S.team.id}/storage`); } catch { box.innerHTML = '<span class="muted">Couldn’t load storage right now.</span>'; return; }
  const pct = st.limit ? Math.min(100, (st.used / st.limit) * 100) : 0;
  const versions = st.projects.reduce((n, p) => n + p.versions, 0);
  box.innerHTML = `
    <div class="row" style="justify-content:space-between;align-items:baseline"><b style="font-size:20px">${formatBytes(st.used)}</b><span class="muted" style="font-size:13px">of ${formatBytes(st.limit)} used</span></div>
    <div class="meter meter--storage ${pct > 85 ? 'is-high' : ''}"><i style="width:${Math.max(pct, st.used ? 1 : 0)}%"></i></div>
    <span class="muted" style="font-size:13px">${versions} version${versions === 1 ? '' : 's'} in ${st.projects.length} project${st.projects.length === 1 ? '' : 's'}. Files people already downloaded stay on their computers.</span>
    ${st.projects.length ? `<div class="storage-list">${st.projects.slice(0, 6).map((p) => `<a class="storage-row" href="#/p/${p.id}">
      <span class="proj-mark" style="--h:${hueOf(p.name)}">${esc(projInitials(p.name))}</span>
      <span class="grow stack" style="gap:0;min-width:0"><b>${esc(p.name)}</b><span class="faint" style="font-size:12.5px">${p.versions} version${p.versions === 1 ? '' : 's'}</span></span>
      <span class="muted" style="font-size:13px">${formatBytes(p.bytes)}</span></a>`).join('')}</div>` : ''}
    <label class="field" style="gap:4px"><span class="muted" style="font-size:13px;font-weight:600">Old versions</span>
      <select class="input select" data-keep aria-label="How many versions to keep">${KEEP_OPTIONS.map(([n, label]) => `<option value="${n ?? ''}" ${(st.keepVersions ?? null) === n ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
    <span class="hint">When a project gets a new version, older ones beyond this are cleared for the whole team to save space.</span>`;
  box.querySelector('[data-keep]').addEventListener('change', async (e) => {
    const value = e.target.value ? Number(e.target.value) : null;
    if (value) {
      const ok = await dialog(`<h2>${value === 1 ? 'Keep only the latest version?' : `Keep only the last ${value} versions?`}</h2>
        <p class="muted" style="font-size:14px">Older versions of every project in <b>${esc(S.team.name)}</b> are cleared now, for everyone in the team. Files already downloaded stay on people’s computers.</p>
        <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn btn--primary">Clear old versions</button></div>`);
      if (!ok) { loadStorage(); return; }
    }
    try {
      const r = await api.patch(`/api/teams/${S.team.id}`, { keepVersions: value });
      S.projectData.clear();
      toast(r.cleared?.removed ? `Cleared ${r.cleared.removed} old version${r.cleared.removed === 1 ? '' : 's'} and freed ${formatBytes(r.cleared.freedBytes)}.` : value ? 'Saved. Older versions will be cleared as new ones arrive.' : 'Saved. Every version is kept.');
      loadStorage();
    } catch (err) { toast(esc(err.message), { error: true }); loadStorage(); }
  });
}

export async function screenTeam() {
  const me = await api.get('/api/me');
  S.teams = me.teams;
  S.online = new Set(me.online);
  S.team = me.teams.find((t) => t.id === S.team.id) || me.teams[0];
  document.title = 'Team · Padala';
  layout(`<div class="screen screen--page">
    <header class="page-head"><div class="row" style="gap:16px;min-width:0"><span class="team-mark team-mark--lg">${esc(initials(S.team.name))}</span>
      <div class="stack" style="gap:2px;min-width:0"><span class="label">Team</span><h1 style="font-size:28px">${esc(S.team.name)}</h1></div></div>
      <div class="row" style="gap:8px">${S.teams.length > 1 ? `<button class="btn btn--sm" data-switch-team>${icon.users({ size: 14 })} Switch team</button>` : `<button class="btn btn--sm" data-new-team-btn>${icon.plus({ size: 14 })} New team</button>`}</div></header>
    ${keyBanner()}
    <div class="cols">
    <div class="col">
    <section class="stack"><span class="label">Invite your partner</span>
      <div class="card stack" style="gap:16px">
        <ol class="howto">
          <li>Click <b>Create invite link</b>.</li>
          <li>Send the link to your partner (Messenger, email…).</li>
          <li>They open it, create an account, and they’re in.</li>
        </ol>
        <div data-invite></div>
        <button class="btn btn--primary" data-make-invite>${icon.share({ size: 18 })} Create invite link</button>
        <p class="hint">Each link works once, for 7 days. It holds your team’s secret key, so only send it to the person joining.</p>
      </div>
    </section>
    <section class="stack"><span class="label">Members</span>
      <div class="card card--flush">${S.team.members.map((m) => `<div class="list-row">
        ${avatarHtml(m)}
        <div class="grow stack" style="gap:0"><b>${esc(m.name)}${m.id === S.me.id ? ' <span class="faint">(you)</span>' : ''}${m.role === 'owner' ? ' <span class="pill">Owner</span>' : ''}</b><span class="faint" style="font-size:12.5px">@${esc(m.username)}</span></div>
        <span class="row" style="gap:4px;font-size:12.5px;color:var(--pd-muted)"><span class="dot ${S.online.has(m.id) ? 'dot--on' : ''}"></span>${S.online.has(m.id) ? 'Online' : 'Offline'}</span></div>`).join('')}</div>
    </section>
    </div>
    <div class="col">
    <section class="stack" id="storage"><span class="label">Storage</span>
      <div class="card stack storage" style="gap:12px" data-storage><div class="skeleton" style="height:64px"></div></div>
    </section>
    <section class="stack"><span class="label">Settings</span>
      <div class="card stack" style="gap:16px">
        <div class="row"><span class="grow"><b>Team name</b><br><span class="muted" style="font-size:13px">${esc(S.team.name)}</span></span><button class="btn btn--sm" data-rename-team>${icon.pencil({ size: 14 })} Rename</button></div>
        <div class="row"><span class="grow"><b>Leave this team</b><br><span class="muted" style="font-size:13px">${S.team.members.length <= 1
          ? 'You’re the last one here, so leaving deletes the team with its projects and files.'
          : `Stop seeing its projects and files. The others stay.${isTeamOwner() ? ' Someone else becomes the owner.' : ''} When the last person leaves, the team is deleted.`}</span></span><button class="btn btn--sm btn--danger" data-leave-team>${icon.logout({ size: 14 })} Leave</button></div>
      </div>
    </section>
    </div>
    </div>
  </div>`);

  app.querySelector('[data-new-team-btn]')?.addEventListener('click', createTeam);
  loadStorage().then(() => { if (S.goStorage) { S.goStorage = false; app.querySelector('#storage')?.scrollIntoView({ behavior: 'smooth' }); } });
  app.querySelector('[data-rename-team]')?.addEventListener('click', async () => {
    const data = await dialog(`<h2>Rename team</h2>
      ${field({ id: 'rt', name: 'name', label: 'Team name', icon: 'users', value: S.team.name, maxlength: 60, validate: 'name', autofocus: true })}
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn btn--primary">Save</button></div>`);
    if (!data) return;
    try { await api.patch(`/api/teams/${S.team.id}`, { name: data.get('name') }); S.team.name = data.get('name'); screenTeam(); } catch (err) { toast(esc(err.message), { error: true }); }
  });
  app.querySelector('[data-leave-team]')?.addEventListener('click', async () => {
    const alone = S.team.members.length <= 1;
    const ok = await dialog(`<div class="danger-head">${icon.logout({ size: 22 })}</div>
      <h2>${alone ? `Delete “${esc(S.team.name)}”?` : `Leave “${esc(S.team.name)}”?`}</h2>
      <p class="muted" style="font-size:14.5px">${alone
        ? 'You’re the only one in this team, so leaving deletes it with all its projects and files. It can’t be undone.'
        : 'You’ll stop seeing its projects, files and chat. Everyone else keeps them, and anyone in the team can invite you back later.'}</p>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn btn--danger-solid">${alone ? 'Leave and delete team' : 'Leave team'}</button></div>`);
    if (!ok) return;
    try {
      const r = await api.post(`/api/teams/${S.team.id}/leave`);
      const leftName = S.team.name;
      await afterTeamGone(S.team.id);
      toast(r.deletedTeam ? `<b>${esc(leftName)}</b> was deleted.` : `You left <b>${esc(leftName)}</b>.`);
    } catch (err) { toast(esc(err.message), { error: true }); }
  });
  app.querySelector('[data-make-invite]').onclick = async (e) => {
    const key = storedKeys()[S.team.id];
    if (!S.keys || !isValidKeyFormat(key || '')) {
      app.querySelector('[data-invite]').innerHTML = `<div class="banner banner--warn">${icon.key({ size: 18, stroke: 'var(--pd-warn)' })}<span>
        <b>This browser can’t make invite links for this team.</b> The team’s secret key isn’t saved here (the team was probably created in another browser or window).
        Open Padala where you created the team, or start a fresh team below.</span></div>`;
      return;
    }
    try {
      const { token, expiresAt } = await api.post(`/api/teams/${S.team.id}/invites`);
      const link = `${S.publicUrl || location.origin}/#/join/${token}/${key}`;
      app.querySelector('[data-invite]').innerHTML = `<div class="stack"><div class="key-box">${esc(link)}</div>
        <div class="row" style="flex-wrap:wrap"><button class="btn btn--primary btn--sm" data-copy>${icon.copy({ size: 14 })} Copy link</button>
        ${navigator.share ? `<button class="btn btn--sm" data-share>${icon.share({ size: 14 })} Share</button>` : ''}
        <button class="btn btn--sm" data-qr>${icon.phone({ size: 14 })} Show QR code</button>
        <span class="hint">Works until ${esc(new Date(expiresAt).toLocaleDateString(locale(), { month: 'short', day: 'numeric' }))}</span></div>
        ${/^http:\/\/(localhost|127\.)/.test(link) ? `<div class="banner banner--warn">${icon.alert({ size: 16, stroke: 'var(--pd-warn)' })}<span>This link starts with <b>localhost</b>, so it only works on this computer. To invite a phone or someone far away, close Padala and start it with <b>npm run share</b>, then create a new link.</span></div>` : ''}</div>`;
      app.querySelector('[data-qr]').onclick = () => showQr(link, { title: 'Scan to join', text: `Open your phone’s camera and point it at the code. It opens the invite to <b>${esc(S.team.name)}</b>.` });
      app.querySelector('[data-copy]').onclick = () => copyText(link);
      app.querySelector('[data-share]')?.addEventListener('click', () => navigator.share({ title: tr(`Join ${S.team.name} on Padala`), url: link }).catch(() => {}));
      e.target.textContent = 'Create another link';
      e.target.classList.remove('btn--primary');
    } catch (err) { toast(esc(err.message), { error: true }); }
  };
}
