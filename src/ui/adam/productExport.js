/**
 * Assemble and download the intelligence product (src/intel/product.js)
 * from the live console: findings, watch, contacts, event log, Shepherd's
 * action log, sources and a map extract.
 */
import { buildProduct } from '../../intel/product.js';
import { layerSnapshots } from '../../data/layerSnapshot.js';

export async function assembleProduct(
  {
    title = 'ADAM situation product',
    bluf = '',
    assessment = '',
    marking = 'UNCLASSIFIED',
    preparedBy = '',
    periodHours = 24,
  } = {},
  getConsole = () => globalThis.__godsEyeView || {},
) {
  const c = getConsole();
  const intel = c.intel;
  const now = Date.now();
  const since = now - periodHours * 3600_000;
  let mapImage = null;
  try {
    mapImage = await c.capture?.imageDataUrl?.();
  } catch {
    mapImage = null;
  }
  const carto = c.viewer?.camera?.positionCartographic;
  const deg = (r) => (r * 180) / Math.PI;
  const brief = intel?.brief?.({ format: 'markdown' });
  const pins = (intel?.getPins?.() || []).map((p) => ({
    kind: `pinned ${p.layerKey}`,
    label: p.label,
    lat: p.record?.lat ?? null,
    lon: p.record?.lon ?? null,
    note: p.record ? '' : 'not in current data',
  }));
  const last = intel?.getLastTracked?.();
  if (last)
    pins.unshift({
      kind: `tracked ${last.layerKey}`,
      label: last.label,
      lat: last.record?.lat ?? null,
      lon: last.record?.lon ?? null,
      note: '',
    });
  for (const p of c.shepherd?.overlay?.pinsList?.() || [])
    pins.push({ kind: 'analyst pin', label: p.label, lat: p.lat, lon: p.lon });
  const sources = layerSnapshots(c.dataManager?.getAll?.() || []).filter(
    (l) => l.enabled,
  );
  const html = buildProduct({
    title,
    marking,
    at: now,
    preparedBy,
    period: `${new Date(since).toISOString().slice(0, 16)}Z – ${new Date(now).toISOString().slice(0, 16)}Z`,
    mission: intel?.getMission?.()?.text || '',
    bluf: bluf || brief?.headline || '',
    assessment,
    situation: brief?.spoken || '',
    mapImage,
    mapCaption: carto
      ? `View centre ${deg(carto.latitude).toFixed(4)}, ${deg(carto.longitude).toFixed(4)} · camera ${Math.round(carto.height).toLocaleString('en-US')} m · ${new Date(now).toISOString().slice(0, 19)}Z`
      : '',
    findings: intel?.listFindings?.() || [],
    watch: intel?.triage?.({ limit: 12 }) || [],
    contacts: pins,
    events: (intel?.watchLog?.({ since, limit: 200 }) || []).slice().reverse(),
    actions: (c.shepherd?.agent?.actionLog?.() || []).filter(
      (a) => a.at >= since,
    ),
    sources,
    attributions: [
      'Imagery © Esri and contributors',
      'NASA GIBS / FIRMS',
      'OpenStreetMap contributors (ODbL)',
      'TeleGeography',
      'VAT-Spy',
      'world-countries (ODbL)',
    ],
  });
  return {
    html,
    name: `adam-product-${new Date(now).toISOString().slice(0, 16).replace(/[:T]/g, '')}.html`,
  };
}

export async function downloadProduct(options, doc = document) {
  const { html, name } = await assembleProduct(options);
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const a = doc.createElement('a');
  a.href = url;
  a.download = name;
  doc.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15_000);
  return { ok: true, file: name, bytes: html.length };
}
