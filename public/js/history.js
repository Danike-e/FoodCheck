/**
 * Search history, kept only in this browser's localStorage.
 *
 * One entry per place searched (a postcode, or a rounded point), most recent
 * first. Searching the same place again moves it to the top and updates its
 * filters, so changing a filter doesn't flood the list. Entries are validated
 * when read, since storage can be edited by hand.
 */

const KEY = 'foodcheck:history';
const OFF_KEY = 'foodcheck:historyOff';
export const MAX_ENTRIES = 50;

const RADII = [1, 2, 5];
const RATINGS = ['', '0', '1', '2', '3', '4', '5', 'Pass', 'ImprovementRequired'];
const SOURCES = ['postcode', 'device', 'map'];

const storage = () => globalThis.localStorage;

/** Is saving history turned on? (On unless the user switched it off in Settings.) */
export function isHistoryEnabled() {
  try { return storage().getItem(OFF_KEY) !== '1'; } catch { return false; }
}

export function setHistoryEnabled(on) {
  try {
    if (on) storage().removeItem(OFF_KEY);
    else storage().setItem(OFF_KEY, '1');
  } catch { /* storage blocked */ }
}

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const coord = (v) => (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : null);

/** Return a clean entry, or null if it isn't one we could have written. */
function sanitise(e) {
  if (!e || typeof e !== 'object' || !SOURCES.includes(e.source)) return null;
  const entry = {
    source: e.source,
    postcode: str(e.postcode, 10).toUpperCase().replace(/[^A-Z0-9 ]/g, ''),
    area: str(e.area, 80),
    lat: coord(e.lat),
    lng: coord(e.lng),
    radius: RADII.includes(e.radius) ? e.radius : 1,
    rating: RATINGS.includes(e.rating) ? e.rating : '',
    businessType: /^\d{1,6}$/.test(e.businessType || '') ? e.businessType : '',
    businessTypeName: str(e.businessTypeName, 80),
    total: Number.isInteger(e.total) && e.total >= 0 ? e.total : null,
    at: Number.isFinite(e.at) ? e.at : 0,
  };
  if (entry.source === 'postcode' && !entry.postcode) return null;
  if (entry.source !== 'postcode' && (entry.lat === null || entry.lng === null)) return null;
  return entry;
}

/** Identity of a place: the postcode, or the rounded point. */
const placeKey = (e) => (e.source === 'postcode' ? `pc:${e.postcode.replace(/\s/g, '')}` : `ll:${e.lat},${e.lng}`);

export function getHistory() {
  try {
    const raw = JSON.parse(storage().getItem(KEY) || '[]');
    return Array.isArray(raw) ? raw.map(sanitise).filter(Boolean).slice(0, MAX_ENTRIES) : [];
  } catch {
    return [];
  }
}

function save(list) {
  try {
    storage().setItem(KEY, JSON.stringify(list.slice(0, MAX_ENTRIES)));
  } catch { /* storage full or blocked: history is best-effort */ }
}

/** Record a search (no-op when history is off). Returns the saved entry. */
export function addToHistory(raw) {
  if (!isHistoryEnabled()) return null;
  const entry = sanitise({ ...raw, at: raw.at ?? Date.now() });
  if (!entry) return null;
  const key = placeKey(entry);
  save([entry, ...getHistory().filter((e) => placeKey(e) !== key)]);
  return entry;
}

export function removeFromHistory(entry) {
  const key = placeKey(entry);
  save(getHistory().filter((e) => placeKey(e) !== key));
}

export function clearHistory() {
  try { storage().removeItem(KEY); } catch { /* ignore */ }
}

/** Main-page URL that re-runs this search. */
export function historyUrl(e) {
  const params = new URLSearchParams();
  if (e.source === 'postcode') params.set('pc', e.postcode.replace(/\s/g, ''));
  else {
    params.set('lat', String(e.lat));
    params.set('lng', String(e.lng));
  }
  if (e.radius !== 1) params.set('r', String(e.radius));
  if (e.rating) params.set('rating', e.rating);
  if (e.businessType) params.set('type', e.businessType);
  return `./?${params}`;
}

/** Short title and description for showing an entry. */
export function describeEntry(e) {
  const title = e.source === 'postcode'
    ? e.postcode
    : `${e.source === 'device' ? 'Your location' : 'Point on map'}${e.postcode ? ` near ${e.postcode}` : ''}`;
  const filters = [`${e.radius} ${e.radius === 1 ? 'mile' : 'miles'}`];
  if (e.rating) filters.push(/^\d$/.test(e.rating) ? (e.rating === '5' ? 'rated 5' : `rated ${e.rating}+`) : (e.rating === 'Pass' ? 'Pass only' : 'Improvement required'));
  if (e.businessTypeName) filters.push(e.businessTypeName);
  return { title, area: e.area, filters: filters.join(' · ') };
}
