/**
 * Local time at a point on the globe: IANA zone from coordinates (tz-lookup,
 * loaded on first use) and a short zone label such as "EDT" or "GMT+4".
 */

let tzLookupPromise = null;

export function loadTzLookup() {
  tzLookupPromise ??= import('tz-lookup').then((m) => m.default || m);
  return tzLookupPromise;
}

/** Zone id for a point, or null over open ocean edge cases / bad input. */
export function zoneFor(tzLookup, lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90)
    return null;
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  try {
    return tzLookup(lat, wrapped) || null;
  } catch {
    return null;
  }
}

/**
 * Format a moment in a zone.
 * @returns {{zone: string, abbr: string, time: string, date: string, offset: string}|null}
 */
export function formatZoneTime(zone, at = new Date(), locale = 'en-US') {
  if (!zone) return null;
  try {
    const parts = new Intl.DateTimeFormat(locale, {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
      weekday: 'short',
      day: '2-digit',
      month: 'short',
    }).formatToParts(at);
    const get = (type) => parts.find((p) => p.type === type)?.value || '';
    const offset =
      new Intl.DateTimeFormat(locale, {
        timeZone: zone,
        timeZoneName: 'shortOffset',
      })
        .formatToParts(at)
        .find((p) => p.type === 'timeZoneName')?.value || '';
    return {
      zone,
      abbr: get('timeZoneName'),
      time: `${get('hour')}:${get('minute')}:${get('second')}`,
      date: `${get('weekday')} ${get('day')} ${get('month')}`,
      offset,
    };
  } catch {
    return null;
  }
}
