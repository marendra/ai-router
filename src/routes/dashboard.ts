/**
 * /dashboard — token-gated usage dashboard served by the Worker itself.
 *  - Login posts the router key; "save login" sets an HMAC-signed cookie for 30 days.
 *  - The page fetches /v1/usage (cookie-authenticated) for the last 7 days and renders
 *    per-provider token charts (pure inline SVG, zero external dependencies) plus a
 *    data table filled from the same numbers.
 */
import { resolveSecret, type Env } from "../config/env";
import {
  clearSessionCookieHeader,
  createSessionValue,
  hasDashboardSession,
  sessionCookieHeader,
} from "../auth/session";
import { timingSafeEqual } from "../utils/security";

function page(title: string, body: string): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         background: #0b1020; color: #e7ecf5; min-height: 100vh; }
  a { color: #7aa2ff; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 24px 16px 48px; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px;
           margin-bottom: 20px; }
  h1 { font-size: 20px; margin: 0; }
  .sub { color: #8fa1bf; font-size: 13px; margin-top: 4px; }
  .card { background: #121a30; border: 1px solid #223054; border-radius: 12px; padding: 16px;
          margin-bottom: 16px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(460px, 1fr)); gap: 16px; }
  .card h2 { font-size: 15px; margin: 0 0 4px; }
  .meta { color: #8fa1bf; font-size: 12px; margin-bottom: 8px; }
  .legend { display: flex; gap: 16px; font-size: 12px; color: #aebad0; margin-bottom: 6px; }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 5px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #223054; }
  th { color: #8fa1bf; font-weight: 600; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr.total td { border-top: 2px solid #33477a; font-weight: 600; border-bottom: none; }
  .banner { background: #3a1d24; border: 1px solid #7a2b3a; color: #ffb3c0; padding: 10px 12px;
            border-radius: 8px; margin-bottom: 14px; font-size: 14px; }
  input[type=password], input[type=text] { width: 100%; padding: 10px 12px; border-radius: 8px;
    border: 1px solid #2c3c68; background: #0d1428; color: #e7ecf5; font-size: 15px; }
  label.check { display: flex; gap: 8px; align-items: center; font-size: 13px; color: #aebad0;
                margin: 12px 0 14px; }
  button { background: #2f5fe0; color: white; border: 0; border-radius: 8px; padding: 10px 18px;
           font-size: 15px; cursor: pointer; }
  button:hover { background: #3d6cf0; }
  .center { max-width: 420px; margin: 8vh auto 0; }
  .logout { font-size: 13px; }
</style>
</head>
<body><div class="wrap">${body}</div>
<script>
${title === "Gruuvix AI Router — Usage" ? DASHBOARD_JS : ""}
</script>
</body></html>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store", "x-robots-tag": "noindex" } },
  );
}

function loginPage(error: boolean): Response {
  return page(
    "Gruuvix AI Router — Sign in",
    `<div class="center"><div class="card">
      <h1 style="font-size:18px; margin:0 0 6px;">Gruuvix AI Router</h1>
      <p class="sub" style="margin:0 0 16px;">Enter the router API key to open the usage dashboard.</p>
      ${error ? '<div class="banner">Invalid API key. Try again.</div>' : ""}
      <form method="POST" action="/dashboard/login">
        <input type="password" name="token" placeholder="API key (GRUVIX_AI_ROUTER_KEY)" autofocus required>
        <label class="check"><input type="checkbox" name="save" checked> Keep me logged in for 30 days</label>
        <button type="submit">Sign in</button>
      </form>
    </div></div>`,
  );
}

const DASHBOARD_JS = `
(function () {
  function iso(d) { return d.toISOString().slice(0, 10); }
  var to = new Date();
  var from = new Date(Date.now() - 6 * 86400000);
  var banner = document.getElementById('banner');
  fetch('/v1/usage?from=' + iso(from) + '&to=' + iso(to) + '&tz=7', { credentials: 'same-origin' })
    .then(function (r) {
      if (r.status === 401) { location.href = '/dashboard'; throw new Error('session expired'); }
      if (!r.ok) { throw new Error('usage API returned HTTP ' + r.status); }
      return r.json();
    })
    .then(function (data) { render(data); })
    .catch(function (e) {
      if (banner && e.message !== 'session expired') {
        banner.style.display = 'block';
        banner.textContent = 'Could not load usage: ' + e.message;
      }
    });

  function fmt(n) { return Number(n || 0).toLocaleString('en-US'); }
  function wib(ts) {
    // West Indonesia Time (UTC+7)
    return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jakarta', year: 'numeric',
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false }).format(new Date(Number(ts)));
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function render(data) {
    var days = [];
    for (var i = 6; i >= 0; i--) days.push(iso(new Date(Date.now() - i * 86400000)));
    var byProvider = {};
    (data.daily || []).forEach(function (row) {
      if (!byProvider[row.provider]) byProvider[row.provider] = {};
      byProvider[row.provider][row.day] = row;
    });

    var charts = document.getElementById('charts');
    charts.innerHTML = '';
    Object.keys(byProvider).sort().forEach(function (p) {
      charts.appendChild(providerCard(p, byProvider[p], days));
    });
    if (!Object.keys(byProvider).length) {
      charts.innerHTML = '<div class="card">No usage recorded in the last 7 days.</div>';
    }

    var box = document.getElementById('databox');
    var rows = ['<table><thead><tr><th>Day (WIB)</th><th>Provider</th>' +
      '<th class="num">Calls</th><th class="num">Failures</th>' +
      '<th class="num">Tokens in</th><th class="num">Tokens out</th></tr></thead><tbody>'];
    var grand = { calls: 0, fails: 0, tin: 0, tout: 0 };
    var sorted = (data.daily || []).slice().sort(function (a, b) {
      return a.day === b.day ? (a.provider < b.provider ? -1 : 1) : (a.day < b.day ? 1 : -1);
    });
    sorted.forEach(function (r) {
      grand.calls += Number(r.calls || 0);
      grand.fails += Number(r.failures || 0);
      grand.tin += Number(r.tokens_in || 0);
      grand.tout += Number(r.tokens_out || 0);
      rows.push('<tr><td>' + esc(r.day) + '</td><td>' + esc(r.provider) + '</td>' +
        '<td class="num">' + fmt(r.calls) + '</td>' +
        '<td class="num"' + (Number(r.failures) > 0 ? ' style="color:#ff9aa8;"' : '') + '>' +
        fmt(r.failures) + '</td>' +
        '<td class="num">' + fmt(r.tokens_in) +
        '</td><td class="num">' + fmt(r.tokens_out) + '</td></tr>');
    });
    rows.push('<tr class="total"><td colspan="2">Total (7 days)</td>' +
      '<td class="num">' + fmt(grand.calls) + '</td><td class="num">' + fmt(grand.fails) +
      '</td><td class="num">' + fmt(grand.tin) +
      '</td><td class="num">' + fmt(grand.tout) + '</td></tr></tbody></table>');

    rows.push('<p class="meta" style="margin:12px 0 6px;">Per-provider summary (range):</p>');
    rows.push('<table><thead><tr><th>Provider</th><th class="num">Calls</th>' +
      '<th class="num">OK</th><th class="num">Failures</th>' +
      '<th class="num">Tokens in</th><th class="num">Tokens out</th>' +
      '<th class="num">Avg ms</th><th class="num">Max ms</th></tr></thead><tbody>');
    (data.providers || []).forEach(function (p) {
      rows.push('<tr><td>' + esc(p.provider) + '</td><td class="num">' + fmt(p.calls) +
        '</td><td class="num">' + fmt(p.ok_calls) + '</td>' +
        '<td class="num"' + (Number(p.failures) > 0 ? ' style="color:#ff9aa8;"' : '') + '>' +
        fmt(p.failures) + '</td>' +
        '<td class="num">' + fmt(p.tokens_in) +
        '</td><td class="num">' + fmt(p.tokens_out) + '</td><td class="num">' + fmt(p.avg_ms) +
        '</td><td class="num">' + fmt(p.max_ms) + '</td></tr>');
    });
    rows.push('</tbody></table>');

    rows.push('<p class="meta" style="margin:12px 0 6px;">Failures by cause (range):</p>');
    rows.push('<table><thead><tr><th>Provider</th><th>Failure class</th>' +
      '<th class="num">HTTP status</th><th class="num">Count</th></tr></thead><tbody>');
    var classes = data.failureClasses || [];
    if (!classes.length) rows.push('<tr><td colspan="4" class="meta">None 🎉</td></tr>');
    classes.forEach(function (f) {
      rows.push('<tr><td>' + esc(f.provider) + '</td><td>' + esc(f.failure_class) + '</td>' +
        '<td class="num">' + (f.status === null ? '—' : f.status) + '</td>' +
        '<td class="num">' + fmt(f.count) + '</td></tr>');
    });
    rows.push('</tbody></table>');
    box.innerHTML = rows.join('');

    // Recent failures feed (newest first).
    var failBox = document.getElementById('faillist');
    var recents = data.recentFailures || [];
    if (!recents.length) {
      failBox.innerHTML = 'No failures in the last 7 days 🎉';
    } else {
      var frows = ['<table><thead><tr><th>When (WIB)</th><th>Provider</th>' +
        '<th>Failure class</th><th class="num">HTTP status</th>' +
        '<th class="num">Latency ms</th></tr></thead><tbody>'];
      recents.forEach(function (f) {
        frows.push('<tr><td>' + wib(f.ts) + '</td><td>' + esc(f.provider) + '</td>' +
          '<td>' + esc(f.failure_class || 'unknown') + '</td>' +
          '<td class="num">' + (f.status === null ? '—' : f.status) + '</td>' +
          '<td class="num">' + fmt(f.latency_ms) + '</td></tr>');
      });
      frows.push('</tbody></table>');
      failBox.innerHTML = frows.join('');
      failBox.className = '';
    }
  }

  function providerCard(name, perDay, days) {
    var card = document.createElement('div');
    card.className = 'card';
    var tin = days.map(function (d) { return Number((perDay[d] || {}).tokens_in || 0); });
    var tout = days.map(function (d) { return Number((perDay[d] || {}).tokens_out || 0); });
    var calls = days.map(function (d) { return Number((perDay[d] || {}).calls || 0); });
    var fails = days.map(function (d) { return Number((perDay[d] || {}).failures || 0); });
    var max = Math.max.apply(null, tin.concat(tout).concat([1]));
    var W = 700, H = 210, plot = 160, base = 170;
    var groupW = (W - 20) / days.length;
    var barW = Math.min(34, groupW / 3);
    var svg = ['<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;">'];
    days.forEach(function (d, i) {
      var cx = 10 + groupW * i + (groupW - barW * 2 - 6) / 2;
      var hIn = Math.round((tin[i] / max) * plot);
      var hOut = Math.round((tout[i] / max) * plot);
      svg.push('<rect x="' + cx + '" y="' + (base - hIn) + '" width="' + barW +
        '" height="' + hIn + '" rx="3" fill="#4f7dff"><title>' + d + ' — in: ' +
        fmt(tin[i]) + ' (calls: ' + fmt(calls[i]) + ')</title></rect>');
      svg.push('<rect x="' + (cx + barW + 6) + '" y="' + (base - hOut) + '" width="' + barW +
        '" height="' + hOut + '" rx="3" fill="#35c98e"><title>' + d + ' — out: ' +
        fmt(tout[i]) + '</title></rect>');
      svg.push('<text x="' + (cx + barW + 3) + '" y="' + (base + 16) +
        '" fill="#8fa1bf" font-size="11" text-anchor="middle">' + d.slice(5) + '</text>');
    });
    svg.push('<line x1="8" y1="' + base + '" x2="' + (W - 8) + '" y2="' + base +
      '" stroke="#223054" stroke-width="1"/>');
    svg.push('</svg>');

    // Failures per day — own scale (counts are tiny next to token volumes).
    var maxFail = Math.max.apply(null, fails.concat([1]));
    var FH = 92, fBase = 62, fPlot = 48;
    var fsvg = ['<svg viewBox="0 0 ' + W + ' ' + FH + '" style="width:100%;height:auto;">'];
    days.forEach(function (d, i) {
      var cx = 10 + groupW * i + (groupW - barW) / 2;
      var hF = Math.round((fails[i] / maxFail) * fPlot);
      if (hF > 0) {
        fsvg.push('<rect x="' + cx + '" y="' + (fBase - hF) + '" width="' + barW +
          '" height="' + hF + '" rx="3" fill="#e05a6d"><title>' + d + ' — failures: ' +
          fmt(fails[i]) + ' of ' + fmt(calls[i]) + ' attempts</title></rect>');
      }
      fsvg.push('<text x="' + (cx + barW / 2) + '" y="' + (fBase + 16) +
        '" fill="#8fa1bf" font-size="11" text-anchor="middle">' + d.slice(5) + '</text>');
    });
    fsvg.push('<line x1="8" y1="' + fBase + '" x2="' + (W - 8) + '" y2="' + fBase +
      '" stroke="#223054" stroke-width="1"/>');
    fsvg.push('</svg>');

    var totalIn = tin.reduce(function (a, b) { return a + b; }, 0);
    var totalOut = tout.reduce(function (a, b) { return a + b; }, 0);
    var totalFails = fails.reduce(function (a, b) { return a + b; }, 0);
    card.innerHTML =
      '<h2>' + esc(name) + '</h2>' +
      '<div class="meta">7-day totals — in: ' + fmt(totalIn) + ' &middot; out: ' + fmt(totalOut) +
      ' &middot; calls: ' + fmt(calls.reduce(function (a, b) { return a + b; }, 0)) +
      ' &middot; <span style="color:' + (totalFails > 0 ? '#ff9aa8' : '#35c98e') + ';">failures: ' +
      fmt(totalFails) + '</span></div>' +
      '<div class="legend"><span><span class="dot" style="background:#4f7dff"></span>tokens in</span>' +
      '<span><span class="dot" style="background:#35c98e"></span>tokens out</span>' +
      '<span><span class="dot" style="background:#e05a6d"></span>failures / day</span></div>' +
      svg.join('') +
      '<div class="meta" style="margin-top:8px;">Failures per day</div>' +
      fsvg.join('');
    return card;
  }
})();
`;

function dashboardPage(rangeLabel: string): Response {
  return page(
    "Gruuvix AI Router — Usage",
    `<header>
      <div>
        <h1>Gruuvix AI Router — Provider Token Usage</h1>
        <div class="sub">${rangeLabel}</div>
      </div>
      <a class="logout" href="/dashboard/logout">Log out</a>
    </header>
    <div id="banner" class="banner" style="display:none;"></div>
    <div id="charts" class="grid"></div>
    <div class="card" id="failcard">
      <h2>Recent failures</h2>
      <div class="meta">Failed provider attempts (already absorbed by failover where possible). Last 20 in range.</div>
      <div id="faillist" class="meta">Loading…</div>
    </div>
    <div class="card" id="databox"><p class="meta">Loading usage data…</p></div>`,
  );
}

// ---------------------------------------------------------------- handlers

export async function handleDashboardGet(req: Request, env: Env, url: URL): Promise<Response> {
  const key = await resolveSecret(env, "GRUVIX_AI_ROUTER_KEY");
  if (!key) return loginPage(false);
  if (await hasDashboardSession(req, key)) {
    return dashboardPage("Tokens per provider — last 7 days (WIB)");
  }
  return loginPage(url.searchParams.get("e") === "1");}

export async function handleDashboardLogin(req: Request, env: Env): Promise<Response> {
  let token = "";
  let save = false;
  try {
    const form = await req.formData();
    token = String(form.get("token") ?? "");
    save = String(form.get("save") ?? "") !== "";
  } catch {
    return redirect("/dashboard?e=1");
  }
  const key = await resolveSecret(env, "GRUVIX_AI_ROUTER_KEY");
  if (!key || !token || !timingSafeEqual(token, key)) {
    return redirect("/dashboard?e=1");
  }
  const session = await createSessionValue(key, save);
  return new Response(null, {
    status: 303,
    headers: { Location: "/dashboard", "Set-Cookie": sessionCookieHeader(session.value, session.maxAge) },
  });
}

export function handleDashboardLogout(): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: "/dashboard", "Set-Cookie": clearSessionCookieHeader() },
  });
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location } });
}
