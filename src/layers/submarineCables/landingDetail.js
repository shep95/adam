/**
 * Landing-station detail for the submarine cable layer's context card.
 *
 * Offline: cables whose bundled geometry ends within a few kilometres of the
 * landing point. Online: TeleGeography's per-landing-point and per-cable
 * records (owners, ready-for-service date, length, planned/active) through
 * /api/infra-context/landing-point.
 */

const EARTH_R_KM = 6371;

function distanceKm(lon1, lat1, lon2, lat2) {
  const d2r = Math.PI / 180;
  const dLat = (lat2 - lat1) * d2r;
  const dLon = (lon2 - lon1) * d2r;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * d2r) * Math.cos(lat2 * d2r) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

function lineParts(geometry) {
  if (geometry?.type === 'LineString') return [geometry.coordinates];
  if (geometry?.type === 'MultiLineString') return geometry.coordinates;
  return [];
}

/**
 * Cable names whose segment endpoints fall within `radiusKm` of a point.
 *
 * @param {number} lon
 * @param {number} lat
 * @param {Array<object>} cableFeatures - GeoJSON cable features.
 * @param {number} [radiusKm]
 * @returns {Array<{id: string, name: string}>}
 */
export function cablesLandingNear(lon, lat, cableFeatures, radiusKm = 12) {
  const out = new Map();
  for (const feature of cableFeatures || []) {
    for (const part of lineParts(feature?.geometry)) {
      if (!Array.isArray(part) || part.length < 2) continue;
      const ends = [part[0], part[part.length - 1]];
      if (
        ends.some(
          (p) =>
            Number.isFinite(p?.[0]) &&
            Number.isFinite(p?.[1]) &&
            Math.abs(p[1] - lat) < 1 &&
            distanceKm(lon, lat, p[0], p[1]) <= radiusKm,
        )
      ) {
        const id = String(feature.properties?.id || feature.id || '');
        const name = String(feature.properties?.name || id);
        if (!out.has(id)) out.set(id, { id, name });
        break;
      }
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Context-card rows from TeleGeography cable detail. */
export function landingDetailRows(detail) {
  const rows = [];
  if (detail?.country) rows.push(['Country', detail.country]);
  const cables = Array.isArray(detail?.cables) ? detail.cables : [];
  rows.push(['Cables', String(cables.length)]);
  for (const cable of cables.slice(0, 10)) {
    const bits = [
      cable.planned ? 'PLANNED' : 'ACTIVE',
      cable.rfs && `RFS ${cable.rfs}`,
      cable.length,
      cable.capacity,
      cable.owners && `Owners: ${cable.owners}`,
    ].filter(Boolean);
    rows.push([cable.name || cable.id, bits.join(' · ')]);
  }
  if (cables.length > 10)
    rows.push(['More', `${cables.length - 10} more cables`]);
  return rows;
}

/** Fetch landing-point detail through the infra-context proxy. */
export async function loadLandingPointDetail(
  id,
  signal,
  fetchImpl = globalThis.fetch,
) {
  if (!/^[a-z0-9][a-z0-9-]{1,120}$/.test(String(id || ''))) return null;
  const response = await fetchImpl(
    `/api/infra-context/landing-point?id=${encodeURIComponent(id)}`,
    { signal },
  );
  if (!response.ok) throw new Error(`Landing point HTTP ${response.status}`);
  return response.json();
}
