/**
 * Loads the telecom graph once per session: bundled TeleGeography cables and
 * landing points, the nations list, and PeeringDB exchanges when reachable.
 */
import { createBundledCableSource } from '../layers/submarineCables/bundledSource.js';
import {
  buildTelecomGraph,
  countryConnectivity,
} from '../intel/telecomGraph.js';
import { loadNations } from './nationProfile.js';

let graphPromise = null;
let ixpPromise = null;

export function loadTelecomGraph() {
  graphPromise ??= (async () => {
    const [{ cables, landingPoints }, nations] = await Promise.all([
      createBundledCableSource().fetch(),
      loadNations(),
    ]);
    return {
      graph: buildTelecomGraph(cables, landingPoints, { nations }),
      nations,
    };
  })().catch((error) => {
    graphPromise = null;
    throw error;
  });
  return graphPromise;
}

function loadIxps(fetchImpl) {
  ixpPromise ??= fetchImpl('/api/infra-context/ixps', {
    credentials: 'same-origin',
  })
    .then((r) => (r.ok ? r.json() : { features: [] }))
    .then((b) => b.features || [])
    .catch(() => {
      ixpPromise = null;
      return [];
    });
  return ixpPromise;
}

export async function telecomProfile(
  a2,
  { fetchImpl = (...a) => fetch(...a) } = {},
) {
  const [{ graph, nations }, ixps] = await Promise.all([
    loadTelecomGraph(),
    loadIxps(fetchImpl),
  ]);
  const nameOf = (c) => nations.find((n) => n.a2 === c)?.n || c;
  const profile = countryConnectivity(graph, a2, { ixps, nameOf });
  const centroid = (c) => nations.find((n) => n.a2 === c)?.ll || null;
  return { ...profile, centroid };
}
