/**
 * Where a tracked aircraft or vessel is going. With a known destination
 * (flight route from adsbdb, with airport coordinates) the path ahead is the
 * great circle to it and the ETA comes from ground speed; without one it is
 * dead reckoning on course and speed.
 */
const R_KM = 6371.0088;
const RAD = Math.PI / 180;

export function distanceKm(aLat, aLon, bLat, bLon) {
  const h =
    Math.sin(((bLat - aLat) * RAD) / 2) ** 2 +
    Math.cos(aLat * RAD) *
      Math.cos(bLat * RAD) *
      Math.sin(((bLon - aLon) * RAD) / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Points along the great circle from a to b (inclusive), `n` segments. */
export function greatCircle(aLat, aLon, bLat, bLon, n = 48) {
  const φ1 = aLat * RAD;
  const λ1 = aLon * RAD;
  const φ2 = bLat * RAD;
  const λ2 = bLon * RAD;
  const d = distanceKm(aLat, aLon, bLat, bLon) / R_KM;
  if (d < 1e-9) return [{ lat: aLat, lon: aLon }];
  const out = [];
  for (let i = 0; i <= n; i += 1) {
    const f = i / n;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
    const z = A * Math.sin(φ1) + B * Math.sin(φ2);
    out.push({
      lat: Math.atan2(z, Math.hypot(x, y)) / RAD,
      lon: Math.atan2(y, x) / RAD,
    });
  }
  return out;
}

/** Ground speed in knots from a flight or vessel record. */
export function speedKts(record) {
  if (Number.isFinite(record?.speedKts)) return record.speedKts;
  if (Number.isFinite(record?.speedMps)) return record.speedMps * 1.943844;
  if (Number.isFinite(record?.velocity)) return record.velocity * 1.943844;
  return null;
}

export function formatDuration(min) {
  if (!Number.isFinite(min)) return '—';
  if (min < 60) return `${Math.max(1, Math.round(min))} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${String(Math.round(min % 60)).padStart(2, '0')} min`;
}

/**
 * @param {{lat:number, lon:number}} record
 * @param {{origin?:{code:string,name?:string,lat?:number,lon?:number},
 *          destination?:{code:string,name?:string,lat?:number,lon?:number}}|null} route
 */
export function aheadPlan(record, route, { nowMs = Date.now() } = {}) {
  if (!Number.isFinite(record?.lat) || !Number.isFinite(record?.lon))
    return null;
  const kts = speedKts(record);
  const dest = route?.destination;
  if (dest && Number.isFinite(dest.lat) && Number.isFinite(dest.lon)) {
    const km = distanceKm(record.lat, record.lon, dest.lat, dest.lon);
    const etaMin = kts > 30 ? km / ((kts * 1.852) / 60) : null;
    return {
      mode: 'route',
      from: route.origin?.code || null,
      to: dest.code || null,
      toName: dest.name || null,
      distanceKm: Math.round(km),
      etaMin: etaMin == null ? null : Math.round(etaMin),
      etaUtc:
        etaMin == null
          ? null
          : new Date(nowMs + etaMin * 60_000).toISOString().slice(11, 16),
      path: greatCircle(
        record.lat,
        record.lon,
        dest.lat,
        dest.lon,
        Math.min(96, Math.max(8, Math.round(km / 50))),
      ),
    };
  }
  return {
    mode: 'dead-reckoning',
    from: route?.origin?.code || null,
    to: dest?.code || null,
  };
}
