/** Pure helpers for the place dossier (OpenStreetMap named places). */

export const OSM_RADIUS_M = 150;

/** Named OSM features near a point, kind and website — no addresses of people. */
export function osmPlaceQuery(lat, lon, r = OSM_RADIUS_M) {
  return `[out:json][timeout:15];nwr["name"](around:${r},${lat},${lon});out tags center 30;`;
}

export function normalizeOsmPlaces(json) {
  const kindKeys = [
    'tourism',
    'historic',
    'amenity',
    'building',
    'shop',
    'leisure',
    'man_made',
    'office',
    'railway',
    'bridge',
    'highway',
  ];
  const out = [];
  for (const e of json?.elements || []) {
    const t = e.tags || {};
    if (!t.name) continue;
    const key = kindKeys.find((k) => t[k]);
    if (
      t.building &&
      ['house', 'residential', 'detached', 'apartments'].includes(t.building) &&
      !t.tourism &&
      !t.historic
    )
      continue; // private homes stay out of the dossier
    out.push({
      name: t.name,
      kind: key
        ? `${key === 'building' ? '' : `${key} · `}${t[key]}`.replace(/_/g, ' ')
        : 'place',
      website: t.website || t['contact:website'] || null,
      wikipedia: t.wikipedia || null,
      wikidata: t.wikidata || null,
      levels: t['building:levels'] || null,
      height: t.height || null,
      start: t.start_date || null,
    });
  }
  const seen = new Set();
  return out
    .filter((p) => (seen.has(p.name) ? false : seen.add(p.name)))
    .slice(0, 20);
}
