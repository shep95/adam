/**
 * The ADAM context layers: power grid, pipelines, border crossings, bridges
 * and chokepoints, internet exchange points, maritime zones (ports,
 * anchorages, traffic separation schemes), FIR boundaries and US special-use
 * airspace. Live OSM/PeeringDB/FAA data comes through /api/infra-context;
 * FIRs and chokepoints are bundled.
 */

import { createContextOverlayLayer } from './index.js';
import { MARITIME_CHOKEPOINTS } from './chokepoints.js';

const firsUrl = new URL(
  '../../data/local_data/airspace_firs/firs.json',
  import.meta.url,
).href;

async function getJson(url, signal, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(url, { signal });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok)
    throw new Error(body?.error || `Context source HTTP ${response.status}`);
  return body;
}

function boxParams(box) {
  return new URLSearchParams(
    Object.entries(box).map(([key, value]) => [key, value.toFixed(4)]),
  );
}

function overpassLoader(kind) {
  return async ({ box, signal }) => {
    const params = boxParams(box);
    params.set('kind', kind);
    return getJson(`/api/infra-context/overpass?${params}`, signal);
  };
}

const osmLink = (feature) =>
  /^(node|way|relation)\/\d+$/.test(feature.id)
    ? {
        href: `https://www.openstreetmap.org/${feature.id}`,
        label: 'Open in OpenStreetMap',
      }
    : null;

const tag = (feature, key) => feature.tags?.[key] ?? null;

function kv(voltage) {
  const values = String(voltage || '')
    .split(';')
    .map(Number)
    .filter(Number.isFinite);
  return values.length ? `${Math.max(...values) / 1000} kV` : null;
}

const PIPELINE_COLORS = { oil: '#c9803a', gas: '#6fb8ff', water: '#3ad0c7' };

function pipelineSubstance(feature) {
  const substance = String(
    tag(feature, 'substance') || tag(feature, 'type') || '',
  ).toLowerCase();
  if (/oil|petroleum|fuel|crude/.test(substance)) return 'oil';
  if (/gas|lng|methane/.test(substance)) return 'gas';
  if (/water|sewage/.test(substance)) return 'water';
  return 'other';
}

const SUA_COLORS = {
  P: '#e16666',
  R: '#e16666',
  W: '#f5a623',
  A: '#f5a623',
  MOA: '#f5a623',
};

function suaTypeCode(feature) {
  const type = String(tag(feature, 'type') || '').toUpperCase();
  if (type.includes('MOA')) return 'MOA';
  return type.charAt(0);
}

let tfrCache = null;
async function loadTfrs(signal) {
  if (tfrCache && Date.now() - tfrCache.at < 10 * 60_000) return tfrCache.tfrs;
  const body = await getJson('/api/infra-context/tfrs', signal);
  tfrCache = {
    at: Date.now(),
    tfrs: Array.isArray(body?.tfrs) ? body.tfrs : [],
  };
  return tfrCache.tfrs;
}

/** Build the context layers. `fetchImpl` is injectable for tests. */
export function createContextLayers() {
  return [
    createContextOverlayLayer({
      id: 'infra-power-lines',
      name: 'Power Grid',
      icon: '⚡',
      source: 'OpenStreetMap',
      color: '#ffd23f',
      maxSpanDeg: 4,
      load: overpassLoader('power-lines'),
      describe: (f) => ({
        title:
          tag(f, 'name') ||
          (tag(f, 'power') === 'plant' ? 'Power plant' : 'Transmission line'),
        rows: [
          ['Voltage', kv(tag(f, 'voltage'))],
          ['Operator', tag(f, 'operator')],
          ['Source', tag(f, 'plant:source')],
          ['Output', tag(f, 'plant:output:electricity')],
          ['Ref', tag(f, 'ref')],
        ],
        link: osmLink(f),
      }),
    }),
    createContextOverlayLayer({
      id: 'infra-pipelines',
      name: 'Pipelines',
      icon: '═',
      source: 'OpenStreetMap',
      color: '#c9803a',
      maxSpanDeg: 6,
      load: overpassLoader('pipelines'),
      colorFor: (f) => PIPELINE_COLORS[pipelineSubstance(f)] || '#9aa4b2',
      describe: (f) => ({
        title:
          tag(f, 'name') || `${pipelineSubstance(f).toUpperCase()} pipeline`,
        rows: [
          ['Substance', tag(f, 'substance') || pipelineSubstance(f)],
          ['Operator', tag(f, 'operator')],
          ['Location', tag(f, 'location')],
          ['Diameter', tag(f, 'diameter')],
          ['Usage', tag(f, 'usage')],
        ],
        link: osmLink(f),
      }),
    }),
    createContextOverlayLayer({
      id: 'infra-border-crossings',
      name: 'Border Crossings',
      icon: '⊟',
      source: 'OpenStreetMap',
      color: '#e8eaed',
      maxSpanDeg: 25,
      pointSize: 7,
      load: overpassLoader('border-crossings'),
      describe: (f) => ({
        title: tag(f, 'name') || tag(f, 'name:en') || 'Border control',
        rows: [
          ['Operator', tag(f, 'operator')],
          ['Road', tag(f, 'highway')],
        ],
        link: osmLink(f),
      }),
    }),
    createContextOverlayLayer({
      id: 'infra-chokepoints',
      name: 'Bridges & Chokepoints',
      icon: '⋈',
      source: 'OpenStreetMap + ADAM',
      color: '#b48cff',
      maxSpanDeg: 3,
      viewportOptional: true,
      pointSize: 10,
      load: async ({ box, signal }) => {
        const chokepoints = MARITIME_CHOKEPOINTS.map((c) => ({
          id: `chokepoint/${c.id}`,
          geometry: 'point',
          coords: c.coords,
          tags: { name: c.name, kind: c.kind, width: c.width, note: c.note },
        }));
        if (!box) return { features: chokepoints };
        try {
          const bridges = await overpassLoader('bridges')({ box, signal });
          return {
            ...bridges,
            features: [...chokepoints, ...(bridges.features || [])],
          };
        } catch (error) {
          if (signal?.aborted) throw error;
          // Bundled chokepoints stay up when the bridge lookup is down.
          return { features: chokepoints, stale: true };
        }
      },
      colorFor: (f) => (f.id.startsWith('chokepoint/') ? '#f5a623' : '#b48cff'),
      describe: (f) =>
        f.id.startsWith('chokepoint/')
          ? {
              title: tag(f, 'name'),
              rows: [
                ['Type', tag(f, 'kind')],
                ['Width', tag(f, 'width')],
                ['Significance', tag(f, 'note')],
              ],
              note: 'Maritime chokepoint. Zoom in below 3° to load mapped bridges.',
            }
          : {
              title: tag(f, 'bridge:name') || tag(f, 'name') || 'Bridge',
              rows: [
                ['Carries', tag(f, 'highway') || tag(f, 'railway')],
                ['Ref', tag(f, 'ref')],
                ['Structure', tag(f, 'bridge')],
              ],
              link: osmLink(f),
            },
    }),
    createContextOverlayLayer({
      id: 'infra-ixps',
      name: 'Internet Exchanges',
      icon: '⌬',
      source: 'PeeringDB',
      color: '#00d4ff',
      mode: 'global',
      pointSize: 7,
      load: ({ signal }) => getJson('/api/infra-context/ixps', signal),
      describe: (f) => ({
        title: tag(f, 'name'),
        rows: [
          ['Full name', tag(f, 'name_long')],
          [
            'City',
            [tag(f, 'city'), tag(f, 'country')].filter(Boolean).join(', '),
          ],
          ['Networks', tag(f, 'networks')],
          ['Facilities', tag(f, 'facilities')],
        ],
        link: tag(f, 'website')
          ? { href: tag(f, 'website'), label: 'Exchange website' }
          : null,
        note: 'Position is the mean of the exchange’s listed facilities.',
      }),
    }),
    createContextOverlayLayer({
      id: 'maritime-zones',
      name: 'Ports & Shipping Lanes',
      icon: '⚓',
      source: 'OpenStreetMap / OpenSeaMap',
      color: '#3aa7ff',
      maxSpanDeg: 8,
      load: overpassLoader('maritime-zones'),
      colorFor: (f) => {
        const type = String(tag(f, 'seamark:type') || '');
        if (type.startsWith('separation') || type === 'inshore_traffic_zone')
          return '#f5a623';
        if (type.startsWith('anchor')) return '#7fe0a0';
        if (type === 'precautionary_area') return '#e16666';
        return '#3aa7ff';
      },
      describe: (f) => ({
        title:
          tag(f, 'seamark:name') ||
          tag(f, 'name') ||
          String(
            tag(f, 'seamark:type') || tag(f, 'landuse') || 'Maritime zone',
          ).replace(/_/g, ' '),
        rows: [
          ['Seamark', tag(f, 'seamark:type')?.replace(/_/g, ' ')],
          ['Land use', tag(f, 'landuse')],
          ['Operator', tag(f, 'operator')],
        ],
        link: osmLink(f),
        note: 'Traffic separation schemes (amber), anchorages (green) and port areas (blue) as mapped in OpenSeaMap.',
      }),
    }),
    createContextOverlayLayer({
      id: 'airspace-firs',
      name: 'Airspace FIRs',
      icon: '⬡',
      source: 'VAT-Spy Data Project (CC BY-SA 4.0)',
      color: '#8fa3ff',
      mode: 'global',
      lineWidth: 1,
      load: async ({ signal }) => {
        const body = await getJson(firsUrl, signal);
        const features = (
          Array.isArray(body?.features) ? body.features : []
        ).map((fir) => ({
          id: `fir/${fir.id}`,
          geometry: 'multiline',
          coords: fir.rings.map((ring) => [...ring, ring[0]]),
          tags: {
            icao: fir.id,
            name: fir.name,
            oceanic: fir.oceanic,
            region: fir.region,
          },
        }));
        return { features };
      },
      colorFor: (f) => (tag(f, 'oceanic') ? '#5b6bb0' : '#8fa3ff'),
      describe: (f) => ({
        title: tag(f, 'name') || tag(f, 'icao'),
        rows: [
          ['ICAO', tag(f, 'icao')],
          ['Oceanic', tag(f, 'oceanic') ? 'yes' : 'no'],
          ['Region', tag(f, 'region')],
        ],
        note: 'Flight Information Region boundary. Simulation-grade data; not for navigation.',
      }),
    }),
    createContextOverlayLayer({
      id: 'airspace-restricted',
      name: 'Restricted Airspace (US)',
      icon: '⛔',
      source: 'FAA special-use airspace + TFR list',
      color: '#e16666',
      maxSpanDeg: 20,
      lineWidth: 2,
      load: async ({ box, signal }) => {
        const [sua, tfrs] = await Promise.all([
          getJson(`/api/infra-context/airspace-sua?${boxParams(box)}`, signal),
          loadTfrs(signal).catch(() => null),
        ]);
        return { ...sua, tfrCount: Array.isArray(tfrs) ? tfrs.length : null };
      },
      colorFor: (f) => SUA_COLORS[suaTypeCode(f)] || '#f5a623',
      describe: (f) => ({
        title: tag(f, 'name') || 'Special-use airspace',
        rows: [
          ['Type', tag(f, 'type')],
          ['Floor', tag(f, 'lower')],
          ['Ceiling', tag(f, 'upper')],
          ['Times', tag(f, 'times')],
          ['Controlling', tag(f, 'agency')],
        ],
        note: 'Prohibited and restricted areas in red; MOAs, warning and alert areas in amber. Active TFRs are listed at tfr.faa.gov.',
        link: { href: 'https://tfr.faa.gov/', label: 'Active TFRs (FAA)' },
        loadMore: async () => {
          const tfrs = await loadTfrs();
          if (!tfrs?.length)
            return { note: 'No active TFR list is available right now.' };
          return {
            rows: [
              ['Type', tag(f, 'type')],
              ['Floor', tag(f, 'lower')],
              ['Ceiling', tag(f, 'upper')],
              ['Times', tag(f, 'times')],
              ['Active TFRs (US)', String(tfrs.length)],
              ...tfrs
                .slice(0, 6)
                .map((t) => [
                  t.notam,
                  `${t.type} · ${t.state} · ${t.description}`.slice(0, 120),
                ]),
            ],
          };
        },
      }),
    }),
  ];
}
