/**
 * Intelligence product: one self-contained HTML document someone who was
 * not in the session can read and reconstruct what was seen and assessed.
 *
 *   cover            title, dissemination marking (top and bottom of every
 *                    page), DTG, prepared by, mission
 *   BLUF             bottom line up front
 *   situation        the summary and assessment
 *   map extract      the view at export time, with its caption
 *   findings         subject · location · time · confidence · source ·
 *                    assessment · alternative
 *   watch            the ranked picture at export time
 *   contact log      pins and tracked contacts
 *   event log        watch log entries in the period
 *   analyst actions  every console/tool action Shepherd took
 *   sources          layers and providers with their feed state
 *   confidence key   what the confidence words mean
 *
 * Pure: every string is escaped; images must be data: URLs. Print → PDF from
 * the browser gives the paper version.
 */

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const iso = (t) => {
  const d = new Date(t);
  return Number.isFinite(d.getTime())
    ? d.toISOString().replace(/\.\d+Z$/, 'Z')
    : '';
};

export function confidenceWord(c) {
  if (!Number.isFinite(c)) return 'not stated';
  if (c >= 0.8) return 'high';
  if (c >= 0.55) return 'moderate';
  if (c >= 0.3) return 'low';
  return 'very low';
}

const where = (loc) =>
  loc && Number.isFinite(loc.lat)
    ? `${loc.label ? `${esc(loc.label)} · ` : ''}${loc.lat.toFixed(4)}, ${loc.lon.toFixed(4)}`
    : esc(loc?.label || '—');

function table(headers, rows) {
  if (!rows.length) return '<p class="none">None recorded.</p>';
  return `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;
}

/**
 * @param {object} p
 * @returns {string} HTML document
 */
export function buildProduct(p = {}) {
  const marking = esc(p.marking || 'UNCLASSIFIED');
  const dtg = iso(p.at ?? Date.now());
  const title = esc(p.title || 'ADAM situation product');
  const paragraphs = (t) =>
    String(t || '')
      .split(/\n{2,}/)
      .filter(Boolean)
      .map((para) => `<p>${esc(para).replace(/\n/g, '<br>')}</p>`)
      .join('');
  const findings = (p.findings || []).map((f, i) => [
    esc(f.id || `F-${i + 1}`),
    `<strong>${esc(f.subject)}</strong>`,
    where(f.location),
    esc(f.time),
    `${esc(confidenceWord(f.confidence))}${Number.isFinite(f.confidence) ? ` (${f.confidence.toFixed(2)})` : ''}`,
    esc(f.source),
    `${esc(f.assessment)}${f.alternative ? `<div class="alt">Alternative: ${esc(f.alternative)}</div>` : ''}`,
  ]);
  const watch = (p.watch || []).map((w) => [
    esc(w.score),
    esc(w.title),
    esc(w.label),
    Number.isFinite(w.lat) ? `${w.lat.toFixed(3)}, ${w.lon.toFixed(3)}` : '—',
    esc(w.why),
  ]);
  const contacts = (p.contacts || []).map((c) => [
    esc(c.kind),
    esc(c.label),
    Number.isFinite(c.lat) ? `${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}` : '—',
    esc(c.note || ''),
  ]);
  const events = (p.events || []).map((e) => [
    esc(iso(e.at)),
    esc(e.severity),
    esc(e.title),
    esc(e.detail),
  ]);
  const actions = (p.actions || []).map((a) => [
    esc(iso(a.at)),
    esc(a.tool),
    `<code>${esc(a.args)}</code>`,
    a.ok ? 'ok' : 'failed',
  ]);
  const sources = (p.sources || []).map((s) => [
    esc(s.name || s.id),
    esc(s.source || ''),
    esc(s.feedState || ''),
    esc(s.count ?? ''),
    esc(s.ageLabel || ''),
  ]);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
:root{--ink:#0d1517;--dim:#455a64;--line:#cfd8dc;--accent:#00838f}
*{box-sizing:border-box}body{margin:0;font:13px/1.5 "IBM Plex Sans","Segoe UI",Arial,sans-serif;color:var(--ink);background:#fff}
.mark{position:sticky;top:0;text-align:center;font:600 12px "IBM Plex Mono",monospace;letter-spacing:2px;padding:4px;background:#fff;border-bottom:2px solid var(--ink)}
.mark.bottom{position:static;border-top:2px solid var(--ink);border-bottom:0;margin-top:32px}
main{max-width:980px;margin:0 auto;padding:24px}
.cover{border:2px solid var(--ink);padding:28px;margin:12px 0 28px}
.cover h1{margin:6px 0 10px;font-size:26px}
.meta{font:12px "IBM Plex Mono",monospace;color:var(--dim)}
h2{font-size:15px;letter-spacing:1.5px;text-transform:uppercase;border-bottom:1px solid var(--line);padding-bottom:4px;margin-top:28px}
.bluf{border-left:4px solid var(--accent);padding:8px 14px;background:#f1f8f9;font-size:14px}
table{width:100%;border-collapse:collapse;font-size:12px}th,td{border:1px solid var(--line);padding:5px 7px;vertical-align:top;text-align:left}
th{background:#eceff1;font-weight:600}code{font-size:11px;word-break:break-all}.alt{color:var(--dim);margin-top:4px;font-style:italic}
figure{margin:0}figure img{width:100%;border:1px solid var(--line)}figcaption{font:11px "IBM Plex Mono",monospace;color:var(--dim);margin-top:4px}
.none{color:var(--dim);font-style:italic}.key td:first-child{font-weight:600;width:110px}
@media print{.mark{position:static}h2{break-after:avoid}table,figure{break-inside:avoid}}
</style></head><body>
<div class="mark">${marking}</div>
<main>
<section class="cover">
<div class="meta">ADAM · #HOUSEOFASHER · INTELLIGENCE PRODUCT</div>
<h1>${title}</h1>
<div class="meta">DTG ${esc(dtg)}${p.preparedBy ? ` · PREPARED BY ${esc(p.preparedBy)}` : ''}${p.period ? ` · PERIOD ${esc(p.period)}` : ''}</div>
${p.mission ? `<p><strong>Mission:</strong> ${esc(p.mission)}</p>` : ''}
</section>
<h2>Bottom line up front</h2>
<div class="bluf">${paragraphs(p.bluf || 'Not stated.')}</div>
<h2>Situation and assessment</h2>
${paragraphs(p.assessment) || '<p class="none">No narrative assessment was written.</p>'}
${p.situation ? `<div class="meta">${paragraphs(p.situation)}</div>` : ''}
<h2>Map extract</h2>
${
  typeof p.mapImage === 'string' && p.mapImage.startsWith('data:image/')
    ? `<figure><img alt="Map extract at ${esc(dtg)}" src="${esc(p.mapImage)}"><figcaption>${esc(p.mapCaption || `View at ${dtg}`)}</figcaption></figure>`
    : '<p class="none">No map extract.</p>'
}
<h2>Findings</h2>
${table(['ID', 'Subject', 'Location', 'Time', 'Confidence', 'Source', 'Assessment'], findings)}
<h2>Watch at time of export</h2>
${table(['Score', 'Item', 'Detail', 'Position', 'Why it ranks'], watch)}
<h2>Contact log</h2>
${table(['Kind', 'Contact', 'Position', 'Note'], contacts)}
<h2>Event log</h2>
${table(['UTC', 'Severity', 'Event', 'Detail'], events)}
<h2>Analyst actions</h2>
${table(['UTC', 'Action', 'Arguments', 'Result'], actions)}
<h2>Sources</h2>
${table(['Layer', 'Source', 'Feed state', 'Count', 'Age'], sources)}
<p class="meta">Data attributions: ${esc((p.attributions || []).join(' · ') || 'see the console’s Data attribution panel')}</p>
<h2>Confidence key</h2>
<table class="key"><tbody>
<tr><td>High (≥0.80)</td><td>Several independent sources agree; little room for another reading.</td></tr>
<tr><td>Moderate (0.55–0.79)</td><td>Credible and consistent, but a plausible alternative remains.</td></tr>
<tr><td>Low (0.30–0.54)</td><td>A lead: thin, single-source or inferred; needs confirmation.</td></tr>
<tr><td>Very low (&lt;0.30)</td><td>Speculative; recorded so it can be checked, not relied on.</td></tr>
</tbody></table>
<p class="meta">Behaviour findings, correlations, predictions and exposure radii are screening aids. Positions come from public broadcast data (ADS-B, AIS) and public sensors and may be delayed, spoofed or missing.</p>
</main>
<div class="mark bottom">${marking}</div>
</body></html>`;
}
