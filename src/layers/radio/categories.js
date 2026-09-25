import { MUSIC_GENRES, CATEGORY_MATCHERS } from './policy.js';

/** Bands offered as chips, in dial order. */
export const RADIO_BANDS = Object.freeze([
  ['fm', 'FM'],
  ['am', 'AM'],
  ['dab', 'DAB'],
  ['sw', 'Shortwave'],
  ['web', 'Web only'],
]);

const FM_FREQ = /(?:^|[^\d.])(8[7-9]|9\d|10[0-8])[.,]\d{1,2}(?![\d])/;
const AM_FREQ =
  /(?:^|[^\d.])(5[3-9]\d|[6-9]\d\d|1[0-6]\d\d|17[0-9]\d)\s*(?:am|khz)\b/i;

/**
 * Band from a station's name and normalized tags: an FM dial frequency
 * (87.5–108), an AM frequency written with AM/kHz, DAB or shortwave tags;
 * anything else streams online only.
 */
export function radioStationBand(station, tags = []) {
  const name = String(station?.name ?? '');
  const has = (needle) =>
    tags.some((tag) => tag === needle || tag.split(' ').includes(needle));
  if (has('dab') || /\bdab\+?\b/i.test(name)) return 'dab';
  if (has('shortwave') || has('sw') || /\bshortwave\b/i.test(name)) return 'sw';
  if (FM_FREQ.test(name) || has('fm')) return 'fm';
  if (AM_FREQ.test(name) || has('am')) return 'am';
  return 'web';
}

export function createCategories({
  state: layerState,
  services,
  parts,
  source,
}) {
  /** Normalize one directory tag to a stable, lower-case display token. */

  function normalizeRadioTag(value) {
    return String(value ?? '')
      .trim()
      .toLocaleLowerCase()
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .slice(0, 80);
  }

  function stationTags(station) {
    if (Array.isArray(station?.tags))
      return station.tags.map(normalizeRadioTag).filter(Boolean);
    return String(station?.tags ?? '')
      .split(',')
      .map(normalizeRadioTag)
      .filter(Boolean);
  }

  function hasTag(station, needles) {
    const tags = stationTags(station);
    return needles.some((needle) =>
      tags.some((tag) => tag === needle || tag.includes(needle)),
    );
  }

  function detectedGenres(station) {
    return MUSIC_GENRES.filter(([genre]) => hasTag(station, [genre])).map(
      ([genre]) => genre,
    );
  }

  /** Broadcast band a station airs on, read from its name and tags. */

  function stationBand(station) {
    return radioStationBand(station, stationTags(station));
  }

  /** Return whether a station belongs in a station-tag category. */

  function stationMatchesRadioCategory(station, categoryId) {
    if (categoryId === 'all') return true;
    if (categoryId.startsWith('band:'))
      return stationBand(station) === categoryId.slice('band:'.length);
    if (categoryId.startsWith('genre:')) {
      return detectedGenres(station).includes(
        categoryId.slice('genre:'.length),
      );
    }
    if (categoryId === 'music') {
      return (
        detectedGenres(station).length > 0 ||
        hasTag(station, ['music', 'hits', 'songs'])
      );
    }
    if (categoryId === 'other') {
      return (
        !Object.entries(CATEGORY_MATCHERS).some(([id]) =>
          stationMatchesRadioCategory(station, id),
        ) && !stationMatchesRadioCategory(station, 'music')
      );
    }
    return hasTag(station, CATEGORY_MATCHERS[categoryId] || []);
  }

  /** Build canonical and detected-genre categories from station-level tags. */

  function buildRadioCategories(stations) {
    const rows = Array.isArray(stations) ? stations : [];
    const categories = [
      { id: 'all', label: 'All' },
      ...RADIO_BANDS.filter(([band]) =>
        rows.some((station) => stationBand(station) === band),
      ).map(([band, label]) => ({ id: `band:${band}`, label })),
      { id: 'news', label: 'News' },
      { id: 'talk', label: 'Talk' },
      { id: 'weather', label: 'Weather / Emergency' },
      { id: 'public-safety', label: 'Public Safety' },
      { id: 'aviation-marine', label: 'Aviation / Marine' },
      { id: 'traffic-transit', label: 'Traffic / Transit' },
      { id: 'music', label: 'Music' },
    ];

    for (const [genre, label] of MUSIC_GENRES) {
      const id = `genre:${genre}`;
      if (rows.some((station) => stationMatchesRadioCategory(station, id))) {
        categories.push({ id, label });
      }
    }
    categories.push({ id: 'other', label: 'Other' });
    return categories.map((category) => ({
      ...category,
      color: parts.model.radioCategoryColor(category.id),
      count: rows.filter((station) =>
        stationMatchesRadioCategory(station, category.id),
      ).length,
    }));
  }

  /** Filter stations without changing the active stream or selection. */

  function filterRadioStations(stations, categoryId = 'all') {
    return (Array.isArray(stations) ? stations : []).filter((station) =>
      stationMatchesRadioCategory(station, categoryId),
    );
  }

  /** Return whether Radio Browser metadata identifies a station as English-language. */

  function isEnglishRadioStation(station) {
    const languages = Array.isArray(station?.languages)
      ? station.languages
      : [];
    return languages.some((language) => {
      const normalized = normalizeRadioTag(language);
      return (
        normalized === 'en' ||
        normalized === 'eng' ||
        normalized.startsWith('english')
      );
    });
  }
  return {
    stationBand,
    normalizeRadioTag,
    stationTags,
    hasTag,
    detectedGenres,
    stationMatchesRadioCategory,
    buildRadioCategories,
    filterRadioStations,
    isEnglishRadioStation,
  };
}
