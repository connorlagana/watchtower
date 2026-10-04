/**
 * The operator's /stats page: users, usage and visits, rendered on the server as HTML with inline SVG charts.
 * Colors follow a validated categorical palette (slots 1-3, light and dark steps).
 */
import type { Stats } from '../services/usage.js';

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

const fmt = (n: number) => n.toLocaleString('en-US');
const dayLabel = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** A round axis maximum with integer steps: 1, 2 or 5 times a power of ten. */
function niceStep(max: number): number {
  const raw = Math.max(1, max / 4);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return Math.max(1, (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow);
}

interface Series {
  name: string;
  /** CSS variable holding the series color. */
  color: string;
  values: number[];
}

/** Column path with a 4px rounded top and a square base. */
function column(x: number, y: number, w: number, h: number, rounded: boolean): string {
  const r = rounded ? Math.min(4, h, w / 2) : 0;
  return `M${x},${y + h}V${y + r}${r ? `Q${x},${y} ${x + r},${y}` : ''}H${x + w - r}${r ? `Q${x + w},${y} ${x + w},${y + r}` : ''}V${y + h}Z`;
}

/** Stacked (or single-series) daily columns. The tooltip and table carry exact values. */
function barChart(days: string[], series: Series[], unit: string): string {
  const W = 720, H = 190, left = 40, right = 4, top = 10, bottom = 24;
  const plotW = W - left - right, plotH = H - top - bottom, base = top + plotH;
  const totals = days.map((_, i) => series.reduce((sum, s) => sum + s.values[i]!, 0));
  const step = niceStep(Math.max(...totals));
  const yMax = Math.max(step, Math.ceil(Math.max(...totals) / step) * step);
  const scale = plotH / yMax;
  const band = plotW / days.length;
  const barW = Math.min(24, band * 0.7);

  const grid: string[] = [];
  for (let v = 0; v <= yMax; v += step) {
    const y = base - v * scale;
    grid.push(`<line x1="${left}" x2="${W - right}" y1="${y}" y2="${y}" class="${v === 0 ? 'axis' : 'grid'}"/>`);
    grid.push(`<text x="${left - 6}" y="${y + 4}" text-anchor="end" class="tick">${fmt(v)}</text>`);
  }

  const marks: string[] = [];
  const hits: string[] = [];
  const last = days.length - 1;
  days.forEach((day, i) => {
    const x = left + i * band + (band - barW) / 2;
    const topIndex = series.map((s) => s.values[i]!).reduce((t, v, j) => (v > 0 ? j : t), -1);
    let y = base;
    series.forEach((s, j) => {
      const v = s.values[i]!;
      if (v <= 0) return;
      const h = Math.max(1, v * scale - (j < topIndex ? 2 : 0));
      y -= h;
      marks.push(`<path d="${column(x, y, barW, h, j === topIndex)}" fill="var(${s.color})"/>`);
      y -= 2; // surface gap between stacked segments
    });
    const lines = [`${dayLabel(day)}${i === last ? ' (today)' : ''}`, ...(series.length > 1 ? series.map((s) => `${s.name}: ${fmt(s.values[i]!)}`) : []), `${fmt(totals[i]!)} ${unit}`];
    hits.push(`<rect x="${left + i * band}" y="${top}" width="${band}" height="${plotH}" class="hit" tabindex="0" data-tip="${esc(lines.join('\n'))}"/>`);
    if ((last - i) % 7 === 0) marks.push(`<text x="${left + i * band + band / 2}" y="${H - 6}" text-anchor="middle" class="tick">${dayLabel(day)}</text>`);
  });

  const legend =
    series.length > 1
      ? `<div class="legend">${series.map((s) => `<span><i style="background:var(${s.color})"></i>${esc(s.name)}</span>`).join('')}</div>`
      : '';
  const table = `<details><summary>Table</summary><table class="data"><thead><tr><th>Day (UTC)</th>${series.length > 1 ? series.map((s) => `<th class="num">${esc(s.name)}</th>`).join('') : ''}<th class="num">Total</th></tr></thead><tbody>${days
    .map((d, i) => `<tr><td>${d}</td>${series.length > 1 ? series.map((s) => `<td class="num">${fmt(s.values[i]!)}</td>`).join('') : ''}<td class="num">${fmt(totals[i]!)}</td></tr>`)
    .reverse()
    .join('')}</tbody></table></details>`;
  return `${legend}<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(unit)} per day, last 30 days">${grid.join('')}${marks.join('')}${hits.join('')}</svg>${table}`;
}

function tile(value: string, label: string, note?: string): string {
  return `<div class="tile"><div class="value">${value}</div><div class="label">${esc(label)}</div>${note ? `<div class="note">${esc(note)}</div>` : ''}</div>`;
}

function table(head: string[], rows: (string | number)[][], empty: string): string {
  if (!rows.length) return `<p class="muted">${esc(empty)}</p>`;
  return `<table class="data"><thead><tr>${head.map((h, i) => `<th${i ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c, i) => (i ? `<td class="num">${typeof c === 'number' ? fmt(c) : esc(c)}</td>` : `<td>${esc(String(c))}</td>`)).join('')}</tr>`)
    .join('')}</tbody></table>`;
}

export function statsPage(s: Stats): string {
  const k = s.kpis;
  const pct = s.retention.cohort ? `${Math.round((100 * s.retention.returned) / s.retention.cohort)}%` : '–';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Watchtower stats</title>
<style>
  :root { color-scheme: light; --bg:#fbfaf7; --fg:#1d1d1b; --muted:#65635c; --line:#e3e0d8; --tile:#ffffff;
    --grid:#e1e0d9; --axis:#c3c2b7; --s1:#2a78d6; --s2:#eb6834; --s3:#1baf7a; }
  @media (prefers-color-scheme: dark) { :root { color-scheme: dark; --bg:#141412; --fg:#ecebe6; --muted:#a19f97; --line:#2c2b27; --tile:#1a1a19;
    --grid:#2c2c2a; --axis:#383835; --s1:#3987e5; --s2:#d95926; --s3:#199e70; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 900px; margin: 0 auto; padding: 40px 16px 80px; }
  h1 { font-size: 1.6rem; margin: 0 0 4px; letter-spacing: -0.01em; }
  h2 { font-size: 1.05rem; margin: 36px 0 2px; }
  .muted, .sub { color: var(--muted); }
  .sub { margin: 0 0 10px; font-size: 14px; }
  .tiles { display:grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; margin-top: 20px; }
  .tile { background:var(--tile); border:1px solid var(--line); border-radius:8px; padding:12px 14px; }
  .tile .value { font-size: 1.7rem; font-weight: 650; font-variant-numeric: tabular-nums; line-height:1.2; }
  .tile .label { font-size: 13.5px; }
  .tile .note { font-size: 12.5px; color: var(--muted); }
  svg { width: 100%; height: auto; display:block; overflow: visible; }
  svg .grid { stroke: var(--grid); stroke-width: 1; }
  svg .axis { stroke: var(--axis); stroke-width: 1; }
  svg .tick { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
  svg .hit { fill: transparent; outline: none; }
  svg .hit:hover, svg .hit:focus-visible { fill: var(--fg); fill-opacity: .05; }
  .legend { display:flex; flex-wrap:wrap; gap: 4px 16px; font-size: 13px; color: var(--muted); margin: 4px 0 6px; }
  .legend i { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:6px; vertical-align:-1px; }
  details { margin-top: 6px; font-size: 13.5px; }
  summary { cursor: pointer; color: var(--muted); }
  table.data { border-collapse: collapse; width: 100%; font-size: 14px; margin-top: 6px; }
  table.data th { text-align:left; font-weight:600; color:var(--muted); border-bottom:1px solid var(--line); padding:6px 8px 6px 0; }
  table.data td { border-bottom:1px solid var(--line); padding:6px 8px 6px 0; }
  table.data .num { text-align:right; font-variant-numeric: tabular-nums; }
  .cols { display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 0 28px; }
  #tip { position: fixed; pointer-events: none; display:none; white-space: pre; background: var(--fg); color: var(--bg);
    font-size: 12.5px; line-height: 1.45; padding: 6px 9px; border-radius: 6px; z-index: 10; font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
<main>
  <h1>Watchtower stats</h1>
  <p class="sub">A user is one anonymous client token. Days are UTC. Generated ${esc(s.generatedAt.toISOString().replace('T', ' ').slice(0, 16))} UTC.</p>

  <div class="tiles">
    ${tile(fmt(k.activeToday), 'Active users today', 'used a tool today')}
    ${tile(fmt(k.active7d), 'Active users, 7 days')}
    ${tile(fmt(k.active30d), 'Active users, 30 days')}
    ${tile(fmt(k.clientsWithWatches), 'Users with live watches', `${fmt(k.liveWatches)} live watches`)}
    ${tile(fmt(k.newToday), 'New users today', `${fmt(k.clientsTotal)} users all time`)}
    ${tile(fmt(k.callsToday), 'Tool calls today')}
    ${tile(fmt(k.peopleViewsToday), 'Page views today', 'people in a browser')}
    ${tile(pct, 'Came back', `${fmt(s.retention.returned)} of ${fmt(s.retention.cohort)} new users in 30 days used it on a later day`)}
  </div>

  <h2>Daily active users</h2>
  <p class="sub">Distinct users who called any tool, over MCP or REST.</p>
  ${barChart(s.days, [{ name: 'Active users', color: '--s1', values: s.dailyActive }], 'active users')}

  <h2>New users</h2>
  <p class="sub">Client tokens created each day.</p>
  ${barChart(s.days, [{ name: 'New users', color: '--s1', values: s.dailyNew }], 'new users')}

  <h2>Tool calls</h2>
  <p class="sub">Every call to watch_jobs, get_changes, list_watches and the rest.</p>
  ${barChart(s.days, [{ name: 'Tool calls', color: '--s1', values: s.dailyCalls }], 'tool calls')}

  <h2>Page views</h2>
  <p class="sub">The homepage, llms.txt, robots.txt, the privacy page and the .well-known files, by who asked.</p>
  ${barChart(
    s.days,
    [
      { name: 'People', color: '--s1', values: s.dailyViews.browser },
      { name: 'AI assistants', color: '--s2', values: s.dailyViews.ai },
      { name: 'Other bots', color: '--s3', values: s.dailyViews.other },
    ],
    'page views',
  )}

  <h2>Tools</h2>
  <p class="sub">Last 30 days.</p>
  ${table(['Tool', 'Via', 'Today', '7 days', '30 days', 'Users'], s.tools.map((t) => [t.tool, t.via.toUpperCase(), t.today, t.d7, t.d30, t.clients30]), 'No tool calls yet.')}

  <div class="cols">
    <section>
      <h2>Where users come from</h2>
      <p class="sub">By the ?ref= tag of the link they installed.</p>
      ${table(['Source', 'New, 30 days', 'Active, 7 days'], s.sources.map((r) => [r.source, r.new30, r.active7]), 'No users in the last 30 days.')}
    </section>
    <section>
      <h2>Agent apps</h2>
      <p class="sub">MCP connections by the name the app reports.</p>
      ${table(['App', '7 days', '30 days'], s.mcpClients.map((r) => [r.client, r.d7, r.d30]), 'No MCP connections yet.')}
    </section>
  </div>

  <h2>Pages, last 7 days</h2>
  ${table(['Path', 'People', 'AI assistants', 'Other bots'], s.pages.map((p) => [p.path, p.browser, p.ai, p.other]), 'No page views yet.')}
</main>
<div id="tip" role="tooltip"></div>
<script>
  const tip = document.getElementById('tip');
  const show = (el, x, y) => {
    tip.textContent = el.dataset.tip;
    tip.style.display = 'block';
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.min(window.innerWidth - w - 8, Math.max(8, x - w / 2)) + 'px';
    tip.style.top = Math.max(8, y - h - 12) + 'px';
  };
  document.addEventListener('pointermove', (e) => {
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (el) show(el, e.clientX, e.clientY); else tip.style.display = 'none';
  });
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (!el) return;
    const r = el.getBoundingClientRect();
    show(el, r.left + r.width / 2, r.top + 20);
  });
  document.addEventListener('focusout', () => { tip.style.display = 'none'; });
</script>
</body>
</html>`;
}
