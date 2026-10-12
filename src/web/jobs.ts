/**
 * The website app: search tech jobs by pay (the pitch is $300k+), sign up to see every match, save searches as alerts.
 * Same look as the homepage: it reuses its styles, fonts and colour ring.
 */
import { esc, STYLES } from './site.js';

export interface Viewer {
  email: string;
}

export interface JobsPageInfo {
  /** Open postings whose stated pay reaches $300k, or null while it is unknown. */
  highPayCount: number | null;
  boards: number;
  freeResults: number;
  emailAlerts: boolean;
}

export const HIGH_PAY = 300_000;

const ICON = `data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 16 16%27%3E%3Ccircle cx=%278%27 cy=%278%27 r=%277%27 fill=%27none%27 stroke=%27%236db300%27 stroke-width=%271.6%27/%3E%3Ccircle cx=%278%27 cy=%278%27 r=%274%27 fill=%27none%27 stroke=%27%236db300%27 stroke-width=%271.6%27/%3E%3Ccircle cx=%278%27 cy=%278%27 r=%271.6%27 fill=%27%236db300%27/%3E%3C/svg%3E`;

const fmt = (n: number) => n.toLocaleString('en-US');

function appPage(title: string, main: string, opts: { viewer: Viewer | null; description?: string; script?: string; active?: 'jobs' | 'alerts' }): string {
  const v = opts.viewer;
  const nav = (href: string, label: string, key?: string) =>
    `<a class="nav__link${opts.active === key ? ' is-on' : ''}" href="${href}"${opts.active === key ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(opts.description ?? 'Search tech jobs paying $300k+ straight from 1,500+ company job boards, and get an email when new ones are posted.')}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(opts.description ?? 'Tech jobs paying $300k+, straight from company job boards.')}">
<link rel="icon" href="${ICON}">
<link rel="preload" href="/fonts/atkinson-hyperlegible-next.woff2" as="font" type="font/woff2" crossorigin>
<script>document.documentElement.classList.add('js')</script>
<style>${STYLES}${APP_STYLES}</style>
</head>
<body class="app">
<header class="nav nav--app">
  <a class="brand" href="/"><span class="mark" aria-hidden="true"></span>Watchtower</a>
  ${nav('/jobs', 'Search', 'jobs')}
  ${v ? nav('/alerts', 'Alerts', 'alerts') : `<a class="nav__link nav__wide" href="/">For agents</a>`}
  <span class="nav__gap"></span>
  ${
    v
      ? `<form method="post" action="/web/signout" class="nav__out"><button class="nav__link nav__btn" type="submit" title="Signed in as ${esc(v.email)}">Sign out</button></form>`
      : `<a class="nav__link" href="/signin">Sign in</a><a class="btn btn--cta" href="/signup">Sign up free</a>`
  }
</header>
<main>
${main}
</main>
<footer class="foot">
  <div class="wrap foot__in">
    <div>
      <span class="brand"><span class="mark" aria-hidden="true"></span>Watchtower</span>
      <p class="foot__tag">Tech jobs straight from company job boards.</p>
    </div>
    <nav aria-label="Footer">
      <a href="/jobs">Search jobs</a>
      <a href="/companies">Companies</a>
      <a href="/">For AI agents</a>
      <a href="/docs">API docs</a>
      <a href="/privacy">Privacy</a>
      <a href="/terms">Terms</a>
    </nav>
  </div>
</footer>
${opts.script ? `<script>${opts.script}</script>` : ''}
</body>
</html>`;
}

const SUGGESTIONS = ['Staff software engineer', 'Machine learning engineer', 'Engineering manager', 'iOS engineer', 'Product manager', 'Remote', 'San Francisco', 'New York', 'Seattle'];

export function jobsPage(info: JobsPageInfo, viewer: Viewer | null): string {
  const count = info.highPayCount;
  return appPage(
    'Tech jobs paying $300k+ · Watchtower',
    `<section class="jhero">
  <div class="jhero__panel" aria-hidden="true"><div class="ring"><i></i><i></i></div></div>
  <div class="jhero__in">
    <div class="hero__badge"><span class="mark" aria-hidden="true"></span>${fmt(info.boards)} company job board${info.boards === 1 ? '' : 's'} <span>· checked every few hours</span></div>
    <h1 class="jh1">Find the tech jobs paying <span class="pay">$300k+</span></h1>
    <p class="jsub">Every role comes straight from the company's own job board, with the pay range it posts. No recruiters, no reposts, no guessing what it pays.</p>
    <form class="sbar" id="sbar" role="search">
      <label class="sbar__field">
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="9" cy="9" r="6"/><path d="m14 14 4 4" stroke-linecap="round"/></svg>
        <span class="sr">Role, skill, company or city</span>
        <input id="q" name="q" type="search" autocomplete="off" maxlength="300" placeholder="Try “staff iOS engineer in New York”">
      </label>
      <div class="sbar__opts">
        <button type="button" class="tog" id="t-pay" aria-pressed="true"><i aria-hidden="true"></i>$300k+ only</button>
        <button type="button" class="tog" id="t-remote" aria-pressed="false"><i aria-hidden="true"></i>Remote</button>
        <button class="btn btn--cta sbar__go" type="submit">Search</button>
      </div>
    </form>
    <div class="sugg" aria-label="Suggestions">${SUGGESTIONS.map((s) => `<button type="button" class="sugg__b" data-q="${esc(s)}">${esc(s)}</button>`).join('')}</div>
    ${count ? `<p class="jstat"><b>${fmt(count)}</b> open tech roles post pay that reaches $300k or more right now</p>` : ''}
  </div>
</section>

<section class="res wrap" id="results" aria-live="polite">
  <div class="res__head">
    <div><h2 class="res__title" id="r-title">Tech jobs paying $300k+</h2><div class="res__chips" id="r-chips"></div></div>
    <div class="res__act" id="r-act"></div>
  </div>
  <div id="r-list" class="list"><div class="sk"></div><div class="sk"></div><div class="sk"></div></div>
  <div id="r-more"></div>
</section>

${
  viewer
    ? ''
    : `<section class="why wrap">
  <h2>Why <span class="serif">$300k</span> is closer than it looks</h2>
  <div class="why__grid">
    <div class="why__c"><b>Pay is posted now</b><p>California, New York, Washington, Colorado and more require a pay range on every posting. Watchtower reads it, so you can filter on it.</p></div>
    <div class="why__c"><b>Straight from the source</b><p>Greenhouse, Lever, Ashby, Workday, Apple, Google, Amazon, Microsoft and ${fmt(Math.max(info.boards - 8, 0))} more boards, read directly. No aggregator lag, no expired reposts.</p></div>
    <div class="why__c"><b>First to apply</b><p>Save a search and get one email a day with only the new matches. Early applicants get read.</p></div>
  </div>
  <p class="why__cta"><a class="btn btn--cta btn--big" href="/signup">Create a free account</a><span class="muted">Free. No credit card, no spam.</span></p>
</section>`
}`,
    { viewer, active: 'jobs', script: jobsScript(info, !!viewer) },
  );
}

function jobsScript(info: JobsPageInfo, signedIn: boolean): string {
  return `
(function () {
  var SIGNED_IN = ${signedIn ? 'true' : 'false'};
  var FREE = ${info.freeResults};
  var EMAIL_ALERTS = ${info.emailAlerts ? 'true' : 'false'};
  var $ = function (id) { return document.getElementById(id); };
  var q = $('q'), pay = $('t-pay'), remote = $('t-remote');
  var list = $('r-list'), more = $('r-more'), title = $('r-title'), chips = $('r-chips'), act = $('r-act');
  var state = { offset: 0, busy: false, seq: 0 };

  function h(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function on(b) { return b.getAttribute('aria-pressed') === 'true'; }
  function k(n) { return n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M' : Math.round(n / 1000) + 'k'; }
  function payText(s) {
    if (!s) return '';
    var lo = s.annual_min || s.min, hi = s.annual_max || s.max;
    var sym = !s.currency || s.currency === 'USD' ? '$' : s.currency + ' ';
    if (lo && hi && lo !== hi) return sym + k(lo) + '–' + k(hi);
    return (hi || lo) ? sym + k(hi || lo) : '';
  }
  // The headline figure is the top of the posted range: what the role can pay.
  function top(s) {
    var lo = s.annual_min || s.min, hi = s.annual_max || s.max;
    var sym = !s.currency || s.currency === 'USD' ? '$' : s.currency + ' ';
    return hi && lo && hi !== lo ? 'Up to ' + sym + k(hi) : sym + k(hi || lo);
  }
  function ago(iso) {
    if (!iso) return '';
    var d = (Date.now() - new Date(iso).getTime()) / 864e5;
    if (!(d >= 0)) return '';
    if (d < 1) return 'today';
    if (d < 2) return 'yesterday';
    if (d < 30) return Math.floor(d) + 'd ago';
    return Math.floor(d / 30) + 'mo ago';
  }
  var PALETTE = ['#24a148', '#6b4fd8', '#2f7d6d', '#c2553a', '#1769e0', '#857655', '#d4870b', '#4d7fb8', '#b2457b', '#3c7a2e'];
  function color(name) { var x = 0; for (var i = 0; i < name.length; i++) x = (x * 31 + name.charCodeAt(i)) >>> 0; return PALETTE[x % PALETTE.length]; }
  var SEN = { intern: 'Intern', entry: 'Entry', mid: 'Mid', senior: 'Senior', staff: 'Staff', principal: 'Principal', manager: 'Manager', director: 'Director' };

  function card(j, i) {
    var co = j.company || '';
    var p = payText(j.salary);
    var tags = [];
    if (j.remote) tags.push('<span class="tag tag--remote">Remote</span>');
    if (j.seniority && SEN[j.seniority]) tags.push('<span class="tag">' + SEN[j.seniority] + '</span>');
    if (j.experience_years != null) tags.push('<span class="tag">' + j.experience_years + '+ yrs</span>');
    var when = ago(j.posted_at);
    return '<article class="jc" style="--i:' + (i % 20) + '">' +
      '<span class="jc__logo" style="background:' + color(co || j.title) + '">' + h((co || j.title).trim().charAt(0).toUpperCase()) + '</span>' +
      '<div class="jc__main"><h3 class="jc__t">' + (j.url ? '<a href="' + h(j.url) + '" target="_blank" rel="noopener">' + h(j.title) + '</a>' : h(j.title)) + '</h3>' +
      '<p class="jc__m">' + [co && '<b>' + h(co) + '</b>', j.location && h(j.location), when && '<span class="jc__when">' + when + '</span>'].filter(Boolean).join('<i>·</i>') + '</p>' +
      (tags.length ? '<div class="jc__tags">' + tags.join('') + '</div>' : '') + '</div>' +
      '<div class="jc__side">' + (p ? '<span class="jc__pay">' + top(j.salary) + '<small>' + p + ' posted</small></span>' : '<span class="jc__pay jc__pay--none">Pay not posted</span>') +
      (j.url ? '<a class="btn btn--soft jc__go" href="' + h(j.url) + '" target="_blank" rel="noopener">Apply <span aria-hidden="true">↗</span></a>' : '') + '</div></article>';
  }

  function params() {
    var o = {};
    var t = q.value.trim();
    if (t) o.q = t;
    if (on(pay)) o.pay = '1';
    if (on(remote)) o.remote = '1';
    return o;
  }
  function syncUrl() {
    var p = new URLSearchParams(params());
    if (!on(pay)) p.set('pay', '0');
    var s = p.toString();
    history.replaceState(null, '', s ? '?' + s : location.pathname);
  }
  function nextUrl() { return encodeURIComponent(location.pathname + location.search); }

  function chipRow(r) {
    var f = r.filters || {}, out = [];
    if (q.value.trim()) (f.keywords || []).forEach(function (x) { out.push(x); });
    (f.all_keywords || []).forEach(function (x) { out.push(x); });
    (f.locations || []).forEach(function (x) { out.push('📍 ' + x); });
    (f.seniority || []).forEach(function (x) { out.push(SEN[x] || x); });
    if (f.remote_only) out.push('Remote');
    if (f.min_salary) out.push('$' + k(f.min_salary) + '+');
    if (f.max_experience_years != null) out.push('≤ ' + f.max_experience_years + ' yrs');
    return out.map(function (x) { return '<span class="fchip">' + h(x) + '</span>'; }).join('');
  }

  function lockPanel(total) {
    var hidden = Math.max(total - FREE, 0);
    var fake = '';
    for (var i = 0; i < 3; i++) fake += '<div class="jc jc--ghost" aria-hidden="true"><span class="jc__logo"></span><div class="jc__main"><i></i><i></i></div><div class="jc__side"><i></i></div></div>';
    return '<div class="lock">' + fake +
      '<div class="lock__panel"><span class="lock__icon" aria-hidden="true">🔒</span>' +
      '<h3><b>' + hidden.toLocaleString('en-US') + ' more</b> ' + (hidden === 1 ? 'job matches' : 'jobs match') + ' this search</h3>' +
      '<p>Create a free account to see every one, and get an email the day new matches are posted.</p>' +
      '<div class="lock__btns"><a class="btn btn--cta btn--big" href="/signup?next=' + nextUrl() + '">Sign up free</a><a class="btn btn--soft btn--big" href="/signin?next=' + nextUrl() + '">Sign in</a></div></div></div>';
  }

  function render(r, append) {
    var heading = q.value.trim() ? '“' + h(q.value.trim()) + '”' : (on(pay) ? 'Tech jobs paying $300k+' : 'Tech jobs');
    title.innerHTML = heading + ' <span class="res__n">' + r.total.toLocaleString('en-US') + (r.total === 1 ? ' job' : ' jobs') + '</span>';
    chips.innerHTML = chipRow(r);
    act.innerHTML = SIGNED_IN && r.total >= 0
      ? '<button class="btn btn--cta" id="save" type="button">🔔 ' + (EMAIL_ALERTS ? 'Email me new matches' : 'Save as alert') + '</button>'
      : (r.total > 0 ? '<a class="btn btn--soft" href="/signup?next=' + nextUrl() + '">🔔 Get alerts</a>' : '');
    var html = r.jobs.map(card).join('');
    if (append) list.insertAdjacentHTML('beforeend', html); else list.innerHTML = html || empty();
    if (r.locked) more.innerHTML = lockPanel(r.total);
    else if (r.next_offset != null) more.innerHTML = '<div class="more"><button class="btn btn--soft btn--big" id="more" type="button">Show more</button></div>';
    else more.innerHTML = r.total ? '<p class="end">That is every open match. Save the search to hear about new ones.</p>' : '';
    state.offset = r.next_offset;
  }
  function empty() {
    return '<div class="empty"><h3>No open roles match yet</h3><p>' + (on(pay) ? 'Try turning off “$300k+ only”, or a broader title. ' : 'Try a broader title or another city. ') +
      'New postings arrive every few hours' + (SIGNED_IN ? ': save this search and Watchtower will tell you.' : '.') + '</p></div>';
  }
  function fail(msg) { list.innerHTML = '<div class="empty"><h3>Search did not run</h3><p>' + h(msg) + '</p></div>'; more.innerHTML = ''; }

  function run(append) {
    if (state.busy && append) return;
    var body = { query: q.value.trim() || undefined, pay300: on(pay), remote: on(remote), offset: append ? state.offset : 0 };
    var seq = ++state.seq;
    state.busy = true;
    if (!append) { list.classList.add('is-loading'); }
    else { var b = $('more'); if (b) { b.disabled = true; b.textContent = 'Loading…'; } }
    syncUrl();
    fetch('/web/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (res) { return res.json().then(function (j) { return { ok: res.ok, j: j }; }); })
      .then(function (x) {
        if (seq !== state.seq) return;
        if (!x.ok) return fail(x.j.message || 'Something went wrong. Try again.');
        render(x.j, append);
      })
      .catch(function () { if (seq === state.seq) fail('Check your connection and try again.'); })
      .then(function () { state.busy = false; list.classList.remove('is-loading'); });
  }

  function save(btn) {
    btn.disabled = true; btn.textContent = 'Saving…';
    fetch('/web/alerts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q.value.trim() || undefined, pay300: on(pay), remote: on(remote) }) })
      .then(function (res) { return res.json().then(function (j) { return { ok: res.ok, j: j }; }); })
      .then(function (x) {
        if (!x.ok) { btn.disabled = false; btn.textContent = x.j.message || 'Could not save'; return; }
        btn.outerHTML = '<a class="btn btn--soft" href="/alerts">✓ Saved · view alerts</a>';
      })
      .catch(function () { btn.disabled = false; btn.textContent = 'Try again'; });
  }

  document.getElementById('sbar').addEventListener('submit', function (e) { e.preventDefault(); run(false); q.blur(); });
  [pay, remote].forEach(function (b) { b.addEventListener('click', function () { b.setAttribute('aria-pressed', on(b) ? 'false' : 'true'); run(false); }); });
  document.querySelector('.sugg').addEventListener('click', function (e) {
    var b = e.target.closest('[data-q]'); if (!b) return;
    q.value = b.dataset.q; run(false);
    document.getElementById('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  document.addEventListener('click', function (e) {
    if (e.target.closest('#more')) run(true);
    var s = e.target.closest('#save'); if (s) save(s);
  });

  var u = new URLSearchParams(location.search);
  if (u.get('q')) q.value = u.get('q');
  if (u.get('pay') === '0') pay.setAttribute('aria-pressed', 'false');
  if (u.get('remote') === '1') remote.setAttribute('aria-pressed', 'true');
  run(false);
})();`;
}

export function authPage(mode: 'signin' | 'signup', next: string, viewer: Viewer | null): string {
  const up = mode === 'signup';
  return appPage(
    up ? 'Create your account · Watchtower' : 'Sign in · Watchtower',
    `<section class="auth">
  <div class="jhero__panel" aria-hidden="true"><div class="ring"><i></i><i></i></div></div>
  <div class="auth__card">
    <span class="mark auth__mark" aria-hidden="true"></span>
    <h1 class="auth__h">${up ? 'See every <span class="pay">$300k+</span> job' : 'Welcome back'}</h1>
    <p class="auth__sub">${up ? 'Free account. Full results, saved searches, and an email when new matches are posted.' : 'Sign in to see full results and your alerts.'}</p>
    <form id="auth" class="auth__form" novalidate>
      <label>Email<input name="email" type="email" autocomplete="email" required autofocus maxlength="254"></label>
      <label>Password<input name="password" type="password" autocomplete="${up ? 'new-password' : 'current-password'}" required minlength="${up ? 8 : 1}" maxlength="200">${up ? '<small>At least 8 characters</small>' : ''}</label>
      <p class="auth__err" id="err" role="alert"></p>
      <button class="btn btn--cta btn--big auth__go" type="submit">${up ? 'Create free account' : 'Sign in'}</button>
    </form>
    <p class="auth__alt">${up ? `Already have an account? <a href="/signin?next=${esc(encodeURIComponent(next))}">Sign in</a>` : `New here? <a href="/signup?next=${esc(encodeURIComponent(next))}">Create a free account</a>`}</p>
    ${up ? '<p class="auth__fine">By signing up you agree to the <a href="/terms">terms</a> and <a href="/privacy">privacy policy</a>.</p>' : ''}
  </div>
</section>`,
    {
      viewer,
      script: `
(function () {
  var f = document.getElementById('auth'), err = document.getElementById('err'), go = f.querySelector('.auth__go');
  var label = go.textContent;
  f.addEventListener('submit', function (e) {
    e.preventDefault();
    err.textContent = '';
    if (!f.email.value.trim() || !f.password.value) { err.textContent = 'Enter your email and password.'; return; }
    go.disabled = true; go.textContent = '${up ? 'Creating account…' : 'Signing in…'}';
    fetch('/web/${mode}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: f.email.value, password: f.password.value }) })
      .then(function (res) { return res.json().then(function (j) { return { ok: res.ok, j: j }; }); })
      .then(function (x) {
        if (x.ok) { location.href = ${JSON.stringify(next).replace(/</g, '\\u003c')}; return; }
        err.textContent = x.j.message || 'Something went wrong.'; go.disabled = false; go.textContent = label;
      })
      .catch(function () { err.textContent = 'Check your connection and try again.'; go.disabled = false; go.textContent = label; });
  });
})();`,
    },
  );
}

export interface AlertRow {
  id: string;
  label: string | null;
  query: string | null;
  filters: { min_salary?: number | null; remote_only?: boolean; locations?: string[]; keywords?: string[]; all_keywords?: string[]; seniority?: string[] };
  pending_changes: number;
  created_at: Date;
}

export function alertsPage(viewer: Viewer & { emailAlerts: boolean }, alerts: AlertRow[], emailEnabled: boolean): string {
  const searchUrl = (a: AlertRow) => {
    const p = new URLSearchParams();
    if (a.query) p.set('q', a.query);
    p.set('pay', a.filters.min_salary && a.filters.min_salary >= HIGH_PAY ? '1' : '0');
    if (a.filters.remote_only) p.set('remote', '1');
    return `/jobs?${p}`;
  };
  const rows = alerts
    .map((a) => {
      const chips = [
        // A search saved with nothing typed carries the long list of tech roles; its label already says so.
        ...(a.query ? [...(a.filters.keywords ?? []), ...(a.filters.all_keywords ?? [])] : []),
        ...(a.filters.locations ?? []).map((l) => `📍 ${l}`),
        ...(a.filters.remote_only ? ['Remote'] : []),
        ...(a.filters.min_salary ? [`$${Math.round(a.filters.min_salary / 1000)}k+`] : []),
      ];
      return `<article class="al" data-id="${esc(a.id)}">
  <div class="al__main">
    <h3>${esc(a.label || a.query || 'Saved search')}${a.pending_changes ? ` <span class="al__new">${fmt(a.pending_changes)} new</span>` : ''}</h3>
    <div class="res__chips">${chips.map((c) => `<span class="fchip">${esc(c)}</span>`).join('')}</div>
    ${a.pending_changes ? '' : `<p class="al__quiet">No new jobs yet · saved ${esc(new Date(a.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))} · boards are checked every few hours</p>`}
  </div>
  <div class="al__act">
    ${a.pending_changes ? `<button class="btn btn--cta" data-new="${esc(a.id)}" type="button">See new jobs</button>` : ''}
    <a class="btn btn--soft" href="${esc(searchUrl(a))}">All matches</a>
    <button class="btn btn--soft al__del" data-del="${esc(a.id)}" type="button" aria-label="Delete alert">Delete</button>
  </div>
  <div class="al__jobs list" hidden></div>
</article>`;
    })
    .join('');
  return appPage(
    'Your alerts · Watchtower',
    `<section class="wrap alerts">
  <div class="alerts__head">
    <div><h1 class="jh1 jh1--sm">Your alerts</h1><p class="muted">Signed in as ${esc(viewer.email)}</p></div>
    <a class="btn btn--cta btn--big" href="/jobs">+ New search</a>
  </div>
  ${
    emailEnabled
      ? `<label class="emailtog"><input type="checkbox" id="emailtog"${viewer.emailAlerts ? ' checked' : ''}><span class="sw" aria-hidden="true"></span><span><b>Daily email</b><small>One email a day with new matches, only when there are some.</small></span></label>`
      : ''
  }
  ${
    alerts.length
      ? `<div class="als">${rows}</div>`
      : `<div class="empty empty--big"><h3>No saved searches yet</h3><p>Search for a role, then press <b>🔔 ${emailEnabled ? 'Email me new matches' : 'Save as alert'}</b>. Watchtower checks every board every few hours and shows new matches here${emailEnabled ? ' and in your inbox' : ''}.</p><p><a class="btn btn--cta btn--big" href="/jobs">Find $300k+ jobs</a></p></div>`
  }
  <details class="danger"><summary>Delete account</summary><p>Removes your email, password and saved searches right away. This cannot be undone.</p><button class="btn btn--soft" id="delacct" type="button">Delete my account</button></details>
</section>`,
    {
      viewer,
      active: 'alerts',
      script: `
(function () {
  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.message || 'failed'); return j; }); });
  }
  function h(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function k(n) { return Math.round(n / 1000) + 'k'; }
  function pay(s) { if (!s) return ''; var lo = s.annual_min || s.min, hi = s.annual_max || s.max; return lo && hi && lo !== hi ? '$' + k(lo) + '–' + k(hi) : (hi || lo ? '$' + k(hi || lo) : ''); }
  document.addEventListener('click', function (e) {
    var n = e.target.closest('[data-new]');
    if (n) {
      var box = n.closest('.al').querySelector('.al__jobs');
      n.disabled = true; n.textContent = 'Loading…';
      post('/web/alerts/' + n.dataset.new + '/new').then(function (r) {
        box.hidden = false;
        box.innerHTML = r.jobs.length ? r.jobs.map(function (j) {
          var p = pay(j.salary);
          return '<article class="jc"><div class="jc__main"><h3 class="jc__t">' + (j.url ? '<a href="' + h(j.url) + '" target="_blank" rel="noopener">' + h(j.title) + '</a>' : h(j.title)) + '</h3><p class="jc__m">' + [j.company && '<b>' + h(j.company) + '</b>', j.location && h(j.location)].filter(Boolean).join('<i>·</i>') + '</p></div><div class="jc__side">' + (p ? '<span class="jc__pay">' + p + '</span>' : '') + (j.url ? '<a class="btn btn--soft jc__go" href="' + h(j.url) + '" target="_blank" rel="noopener">Apply ↗</a>' : '') + '</div></article>';
        }).join('') : '<p class="muted">Those postings have since closed.</p>';
        n.remove();
        var badge = box.closest('.al').querySelector('.al__new'); if (badge) badge.remove();
      }).catch(function (err) { n.disabled = false; n.textContent = err.message; });
    }
    var d = e.target.closest('[data-del]');
    if (d) {
      if (d.dataset.armed !== '1') { d.dataset.armed = '1'; d.textContent = 'Confirm delete'; return; }
      d.disabled = true;
      post('/web/alerts/' + d.dataset.del + '/delete').then(function () { d.closest('.al').remove(); if (!document.querySelector('.al')) location.reload(); })
        .catch(function (err) { d.disabled = false; d.textContent = err.message; });
    }
    var x = e.target.closest('#delacct');
    if (x) {
      if (x.dataset.armed !== '1') { x.dataset.armed = '1'; x.textContent = 'Click again to delete permanently'; return; }
      x.disabled = true;
      post('/web/account/delete').then(function () { location.href = '/jobs'; }).catch(function (err) { x.disabled = false; x.textContent = err.message; });
    }
  });
  var t = document.getElementById('emailtog');
  if (t) t.addEventListener('change', function () { post('/web/account/email', { on: t.checked }).catch(function () { t.checked = !t.checked; }); });
})();`,
    },
  );
}

const APP_STYLES = `
  .sr { position:absolute; width:1px; height:1px; overflow:hidden; clip-path: inset(50%); white-space:nowrap; }
  .nav--app { width: min(720px, calc(100% - 32px)); }
  .nav__link.is-on { background: var(--chip); color: var(--fg); }
  .nav__out { margin: 0; display: contents; }
  .nav__btn { border: 0; background: none; font: 14px var(--sans); cursor: pointer; }
  .app main { min-height: calc(100vh - 220px); min-height: calc(100svh - 220px); }
  .nav--app .btn--cta { margin-left: 4px; }
  @media (max-width: 520px) { .nav--app .nav__link { padding: 6px 7px; } .nav--app .brand { margin-right: 4px; font-size: 0; gap: 0; } }
  .pay { position: relative; white-space: nowrap; color: var(--accent-text); font-family: var(--serif); font-weight: 500; letter-spacing: -.02em; }
  .pay::after { content: ""; position: absolute; left: -2%; right: -2%; bottom: .04em; height: .16em; border-radius: 99px; background: var(--accent); opacity: .55; z-index: -1; }
  .btn--big { height: 46px; padding: 0 22px; font-size: 16px; border-radius: 12px; }

  /* hero with the search bar */
  .jhero, .auth { overflow-x: clip; }
  .jhero { position: relative; padding: 96px 32px 64px; min-height: 620px; display:flex; align-items:center; justify-content:center; }
  @media (max-width: 720px) { .jhero { padding: 76px 12px 40px; min-height: 0; } }
  .jhero__panel { position:absolute; inset: 32px 32px 0; border-radius: 32px; background: var(--stage); outline: 1px solid var(--stage-line); outline-offset: -1px; overflow: hidden; }
  @media (max-width: 720px) { .jhero__panel { inset: 12px 12px 0; border-radius: 22px; } }
  .jhero__panel .ring { --ring-o: .7; }
  .jhero__in { position: relative; isolation: isolate; width: min(760px, 100%); display:flex; flex-direction:column; align-items:center; gap: 20px; text-align:center; padding: 24px 16px; }
  .jhero__in::before { content: ""; position: absolute; inset: -40px -10%; z-index: -1; pointer-events: none; --clear: color-mix(in srgb, var(--fg) 4%, var(--bg));
    background: radial-gradient(closest-side, var(--clear) 55%, color-mix(in srgb, var(--clear) 70%, transparent) 75%, transparent); }
  .jh1 { font-size: clamp(38px, 5.4vw, 68px); line-height: 1.02; letter-spacing: -.045em; max-width: 12em; position: relative; z-index: 0; }
  .jh1--sm { font-size: clamp(32px, 4vw, 48px); }
  .jsub { margin: 0; max-width: 34em; color: var(--muted); font-size: 17px; line-height: 1.45; }
  .jstat { margin: 4px 0 0; font-size: 14px; color: var(--muted); }
  .jstat b { color: var(--fg); font-variant-numeric: tabular-nums; }

  .sbar { width: 100%; display:flex; flex-direction:column; gap: 8px; background: var(--panel); border-radius: 18px; padding: 8px; box-shadow: var(--shadow), 0 24px 48px -24px rgb(28 28 26/.25); margin-top: 6px; }
  @media (min-width: 720px) { .sbar { flex-direction: row; align-items:center; } }
  .sbar__field { flex: 1; display:flex; align-items:center; gap: 10px; padding: 0 12px; color: var(--faint); min-width: 0; }
  .sbar__field input { flex:1; min-width: 0; height: 48px; border: 0; outline: none; background: none; font: 18px var(--sans); color: var(--fg); letter-spacing: -.01em; }
  .sbar__field input::placeholder { color: var(--ghost); }
  .sbar__field:focus-within { color: var(--accent-text); }
  .sbar__opts { display:flex; align-items:center; gap: 6px; flex-wrap: wrap; }
  .sbar__go { height: 44px; padding: 0 22px; font-size: 16px; border-radius: 12px; margin-left: auto; }
  @media (max-width: 719px) { .sbar__go { flex: 1 0 100%; } }
  .tog { display:inline-flex; align-items:center; gap: 7px; height: 36px; padding: 0 12px; border: 0; border-radius: 10px; background: var(--chip); color: var(--muted); font: 500 14px var(--sans); cursor: pointer; transition: background .2s, color .2s; }
  .tog i { width: 14px; height: 14px; border-radius: 4px; box-shadow: inset 0 0 0 1.5px var(--ghost); transition: background .2s, box-shadow .2s; }
  .tog[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent-text); }
  .tog[aria-pressed="true"] i { background: var(--mark); box-shadow: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'%3E%3Cpath d='M3.5 7.2 6 9.5l4.5-5' fill='none' stroke='white' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); }
  .sugg { display:flex; flex-wrap: wrap; justify-content:center; gap: 6px; max-width: 680px; }
  .sugg__b { border: 0; background: var(--panel); box-shadow: var(--shadow); color: var(--nav); font: 13.5px var(--sans); padding: 6px 12px; border-radius: 999px; cursor: pointer; transition: translate .2s cubic-bezier(.3,1.6,.5,1), color .2s; }
  .sugg__b:hover { translate: 0 -2px; color: var(--fg); }

  /* results */
  .res { padding-top: 48px; max-width: 960px; scroll-margin-top: 72px; }
  .res__head { display:flex; flex-wrap: wrap; align-items:flex-end; justify-content: space-between; gap: 12px 20px; margin-bottom: 16px; }
  .res__title { font-size: clamp(24px, 2.6vw, 32px); letter-spacing: -.03em; line-height: 1.15; overflow-wrap: anywhere; }
  .res__n { font: 14px var(--mono); color: var(--faint); letter-spacing: 0; margin-left: 6px; white-space: nowrap; }
  .res__chips { display:flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .res__chips:empty { display: none; }
  .fchip { font-size: 12.5px; padding: 3px 9px; border-radius: 999px; background: var(--chip); color: var(--muted); }
  .res__act .btn { height: 40px; padding: 0 16px; border-radius: 10px; font-size: 14.5px; }
  .list { display:grid; gap: 8px; transition: opacity .2s; }
  .list.is-loading { opacity: .45; pointer-events: none; }
  .sk { height: 92px; border-radius: 16px; background: linear-gradient(90deg, var(--stage) 30%, var(--chip) 50%, var(--stage) 70%) 0 0/300% 100%; animation: shimmer 1.4s linear infinite; }
  @keyframes shimmer { to { background-position: -100% 0; } }

  .jc { display:grid; grid-template-columns: auto 1fr; gap: 4px 14px; align-items: start; background: var(--panel); border-radius: 16px; padding: 16px 18px; box-shadow: var(--shadow); animation: jc-in .45s cubic-bezier(.2,.8,.2,1) both; animation-delay: calc(var(--i, 0) * 40ms); }
  @media (min-width: 720px) { .jc { grid-template-columns: auto 1fr auto; align-items: center; } }
  @keyframes jc-in { from { opacity: 0; translate: 0 14px; } }
  .jc__logo { width: 44px; height: 44px; border-radius: 12px; display:grid; place-items:center; color:#fff; font: 400 22px var(--serif); flex: none; }
  .jc__main { min-width: 0; }
  .jc__t { font-size: 17px; font-weight: 500; letter-spacing: -.01em; line-height: 1.3; }
  .jc__t a { text-decoration: none; }
  .jc__t a:hover { text-decoration: underline; text-decoration-color: var(--line); }
  .jc__m { margin: 3px 0 0; font-size: 14px; color: var(--muted); }
  .jc__m b { font-weight: 500; color: var(--fg); }
  .jc__m i { font-style: normal; margin: 0 6px; color: var(--ghost); }
  .jc__when { color: var(--faint); }
  .jc__tags { display:flex; flex-wrap:wrap; gap: 5px; margin-top: 8px; }
  .tag { font-size: 12px; padding: 2px 8px; border-radius: 6px; background: var(--chip); color: var(--muted); }
  .tag--remote { background: color-mix(in srgb, #1769e0 12%, transparent); color: #1d5fbf; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .tag--remote { color: #8db8f2; } }
  .jc__side { grid-column: 1 / -1; display:flex; align-items:center; justify-content: space-between; gap: 12px; margin-top: 8px; }
  @media (min-width: 720px) { .jc__side { grid-column: auto; flex-direction: column; align-items: flex-end; margin-top: 0; gap: 8px; } }
  .jc__pay { font-size: 17px; font-weight: 600; color: var(--accent-text); font-variant-numeric: tabular-nums; letter-spacing: -.01em; text-align: right; white-space: nowrap; }
  .jc__pay small { display:block; font: 11px var(--sans); color: var(--faint); font-weight: 400; letter-spacing: 0; margin-top: 1px; }
  .jc__pay--none { font: 13px var(--sans); color: var(--faint); font-weight: 400; }
  .jc__go { height: 34px; border-radius: 9px; }

  .lock { position: relative; margin-top: 8px; display:grid; gap: 8px; }
  .jc--ghost { filter: blur(5px); opacity: .6; pointer-events: none; user-select: none; animation: none; }
  .jc--ghost .jc__logo { background: var(--chip); }
  .jc--ghost .jc__main i, .jc--ghost .jc__side i { display:block; height: 12px; border-radius: 6px; background: var(--chip); width: 70%; margin: 6px 0; }
  .jc--ghost .jc__main i + i { width: 45%; }
  .jc--ghost .jc__side i { width: 80px; height: 18px; }
  .lock__panel { position: absolute; inset: -12px 0 auto; margin: 0 auto; width: min(520px, calc(100% - 16px)); text-align: center; background: var(--glass); backdrop-filter: blur(16px) saturate(1.4); -webkit-backdrop-filter: blur(16px) saturate(1.4);
    border-radius: 22px; box-shadow: var(--shadow), 0 30px 60px -30px rgb(28 28 26/.35); padding: 24px 22px 22px; }
  .lock__icon { font-size: 22px; }
  .lock__panel h3 { font-size: 22px; letter-spacing: -.02em; margin-top: 6px; }
  .lock__panel h3 b { font-weight: 600; color: var(--accent-text); }
  .lock__panel p { margin: 8px auto 18px; color: var(--muted); font-size: 15px; max-width: 34em; }
  .lock__btns { display:flex; flex-wrap: wrap; justify-content:center; gap: 8px; }
  .more { display:flex; justify-content:center; margin-top: 18px; }
  .end { text-align:center; color: var(--faint); font-size: 14px; margin-top: 22px; }
  .empty { text-align:center; background: var(--stage); border-radius: 22px; padding: 40px 20px; }
  .empty h3 { font: 400 26px/1.15 var(--serif); }
  .empty p { color: var(--muted); font-size: 15px; margin: 10px auto 0; max-width: 40em; }
  .empty--big { padding: 56px 20px; margin-top: 24px; }
  .empty--big p .btn { margin-top: 14px; }

  .why { padding-top: 96px; max-width: 960px; text-align: center; }
  .why__grid { display:grid; gap: 12px; margin-top: 32px; text-align: left; grid-template-columns: 1fr; }
  @media (min-width: 760px) { .why__grid { grid-template-columns: repeat(3, 1fr); } }
  .why__c { background: var(--stage); border-radius: 20px; padding: 20px 22px; }
  .why__c b { font: 400 24px/1.15 var(--serif); }
  .why__c p { margin: 8px 0 0; color: var(--muted); font-size: 14.5px; }
  .why__cta { display:flex; flex-direction: column; align-items:center; gap: 10px; margin-top: 32px; font-size: 13px; }

  /* sign in / sign up */
  .auth { position: relative; min-height: 100vh; min-height: 100svh; display:flex; align-items:center; justify-content:center; padding: 96px 16px 48px; }
  .auth .jhero__panel { inset: 32px; }
  @media (max-width: 720px) { .auth .jhero__panel { inset: 12px; } }
  .auth__card { position: relative; width: min(420px, 100%); background: var(--panel); border-radius: 24px; box-shadow: var(--shadow), 0 30px 60px -30px rgb(28 28 26/.3); padding: 30px 26px 24px; text-align: center; }
  .auth__mark { display:inline-block; width: 28px; height: 28px; background: radial-gradient(circle, var(--mark) 0 4px, transparent 4.5px), radial-gradient(circle, transparent 0 7.5px, var(--mark) 8px 10.5px, transparent 11px), radial-gradient(circle, transparent 0 12px, var(--mark) 12.5px); }
  .auth__h { font-size: clamp(28px, 3.2vw, 34px); letter-spacing: -.035em; line-height: 1.1; margin: 14px auto 0; max-width: none; }
  .auth__sub { color: var(--muted); font-size: 15px; margin: 10px 0 22px; }
  .auth__form { display:grid; gap: 14px; text-align: left; }
  .auth__form label { display:grid; gap: 6px; font-size: 13.5px; font-weight: 500; color: var(--nav); }
  .auth__form input { height: 46px; border: 0; border-radius: 11px; padding: 0 14px; font: 16px var(--sans); color: var(--fg); background: var(--well); outline: none; box-shadow: inset 0 0 0 1px var(--line-faint); transition: box-shadow .15s; }
  .auth__form input:focus { box-shadow: inset 0 0 0 2px var(--accent-text); }
  .auth__form small { font-weight: 400; color: var(--faint); font-size: 12px; }
  .auth__err { margin: 0; min-height: 1.2em; color: #c2553a; font-size: 14px; }
  .auth__err:empty { min-height: 0; }
  .auth__go { width: 100%; }
  .auth__go:disabled { opacity: .7; cursor: default; }
  .auth__alt { margin: 18px 0 0; font-size: 14px; color: var(--muted); }
  .auth__alt a, .auth__fine a { color: var(--accent-text); }
  .auth__fine { margin: 10px 0 0; font-size: 12px; color: var(--faint); }

  /* alerts */
  .alerts { padding-top: 112px; max-width: 960px; }
  .alerts__head { display:flex; flex-wrap: wrap; align-items:flex-end; justify-content: space-between; gap: 16px; }
  .alerts__head .muted { margin: 8px 0 0; font-size: 14px; }
  .emailtog { display:flex; align-items:center; gap: 14px; margin-top: 28px; background: var(--stage); border-radius: 16px; padding: 14px 18px; cursor: pointer; }
  .emailtog input { position:absolute; opacity: 0; pointer-events: none; }
  .emailtog b { display:block; font-weight: 500; }
  .emailtog small { color: var(--muted); font-size: 13px; }
  .sw { flex: none; width: 42px; height: 26px; border-radius: 99px; background: var(--line); position: relative; transition: background .2s; }
  .sw::after { content: ""; position:absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgb(0 0 0/.25); transition: translate .2s cubic-bezier(.3,1.4,.5,1); }
  .emailtog input:checked + .sw { background: var(--cta-flat); }
  .emailtog input:checked + .sw::after { translate: 16px 0; }
  .emailtog input:focus-visible + .sw { outline: 2px solid var(--accent-text); outline-offset: 2px; }
  .als { display:grid; gap: 10px; margin-top: 20px; }
  .al { display:grid; grid-template-columns: 1fr; gap: 12px; background: var(--panel); border-radius: 18px; padding: 18px 20px; box-shadow: var(--shadow); }
  @media (min-width: 720px) { .al { grid-template-columns: 1fr auto; align-items: center; } }
  .al h3 { font-size: 18px; font-weight: 500; letter-spacing: -.01em; overflow-wrap: anywhere; }
  .al__new { display:inline-block; vertical-align: 2px; margin-left: 6px; font: 600 12px var(--sans); color: #fff; background: var(--cta-flat); padding: 2px 8px; border-radius: 99px; }
  .al__quiet { margin: 8px 0 0; font-size: 13px; color: var(--faint); }
  .al__act { display:flex; flex-wrap: wrap; gap: 6px; }
  .al__act .btn { height: 36px; border-radius: 9px; }
  .al__jobs { grid-column: 1 / -1; }
  .al__jobs .jc { box-shadow: none; background: var(--stage); }
  .danger { margin-top: 56px; }
  .danger p { margin-top: 4px; }
`;
