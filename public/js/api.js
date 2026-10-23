/**
 * Thin wrappers around postcodes.io and the Food Standards Agency (FSA) API.
 *
 * The FSA API currently allows cross-origin requests, so we call it directly.
 * If that ever fails at the network level (e.g. CORS is tightened), we retry
 * through the optional local proxy in server.js at /api/fsa/… and keep using it.
 */

const POSTCODES_API = 'https://api.postcodes.io';
const FSA_API = 'https://api.ratings.food.gov.uk';
const FSA_PROXY = 'api/fsa';
const FSA_HEADERS = { 'x-api-version': '2', accept: 'application/json' };

/** Error with a user-facing message and a machine-readable kind. */
export class AppError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // 'invalid-postcode' | 'network' | 'api' | 'location'
  }
}

/** Uppercase, remove spaces. "sw1a1aa" -> "SW1A1AA". */
export function compactPostcode(input) {
  return String(input || '').toUpperCase().replace(/\s+/g, '');
}

/** Loose UK postcode shape check (postcodes.io is the real authority). */
export function looksLikePostcode(input) {
  return /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(compactPostcode(input));
}

/** Insert the space before the inward code. "SW1A1AA" -> "SW1A 1AA". */
export function formatPostcode(input) {
  const pc = compactPostcode(input);
  return pc.length > 3 ? `${pc.slice(0, -3)} ${pc.slice(-3)}` : pc;
}

async function getJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new AppError('network', navigator.onLine === false
      ? 'You appear to be offline. Check your connection and try again.'
      : 'We couldn’t reach the server. Please try again.');
  }
  return response;
}

/** Map a postcodes.io result onto the fields we use. */
function toPlace(result) {
  return {
    postcode: result.postcode,
    lat: result.latitude,
    lng: result.longitude,
    country: result.country,
    area: result.admin_district || result.region || '',
  };
}

/** Look up a postcode. Throws AppError('invalid-postcode') on 404. */
export async function lookupPostcode(input, { signal } = {}) {
  const pc = compactPostcode(input);
  const res = await getJson(`${POSTCODES_API}/postcodes/${encodeURIComponent(pc)}`, { signal });
  if (res.status === 404) {
    throw new AppError('invalid-postcode', `We couldn’t find “${formatPostcode(pc)}”. Check it and try again.`);
  }
  if (!res.ok) throw new AppError('api', 'The postcode service isn’t responding right now. Please try again shortly.');
  const { result } = await res.json();
  if (result.latitude == null || result.longitude == null) {
    throw new AppError('invalid-postcode', `“${result.postcode}” doesn’t have a location we can map.`);
  }
  return toPlace(result);
}

/** Find the nearest postcode to a coordinate (used by "Use my location"). Returns null if none. */
export async function reverseGeocode(lat, lng, { signal } = {}) {
  try {
    const res = await fetch(`${POSTCODES_API}/postcodes?lat=${lat}&lon=${lng}&limit=1&radius=2000`, { signal });
    if (!res.ok) return null;
    const { result } = await res.json();
    return result && result[0] ? toPlace(result[0]) : null;
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    return null;
  }
}

let useProxy = false;

/** GET an FSA endpoint, falling back to the local proxy if the direct call is blocked. */
async function fsaGet(path, params = {}, { signal } = {}) {
  const query = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== '' && v != null),
  ).toString();
  const suffix = `${path}${query ? `?${query}` : ''}`;

  const viaProxy = () => getJson(`${FSA_PROXY}/${suffix}`, { signal });

  let res;
  if (useProxy) {
    res = await viaProxy();
  } else {
    try {
      res = await getJson(`${FSA_API}/${suffix}`, { headers: FSA_HEADERS, signal });
    } catch (err) {
      if (err.kind !== 'network' || location.protocol === 'file:') throw err;
      res = await viaProxy();
      if (res.ok) useProxy = true;
    }
  }

  if (!res.ok) {
    throw new AppError('api', 'The Food Standards Agency service isn’t responding right now. Please try again shortly.');
  }
  return res.json();
}

/**
 * Fetch establishments near a point.
 * @param {object} q
 * @param {number} q.lat
 * @param {number} q.lng
 * @param {number} q.radius  miles
 * @param {string} [q.rating]  ratingKey, e.g. "4" or "Pass"
 * @param {string} [q.businessType]  businessTypeId
 * @param {number} [q.page]
 */
export async function fetchEstablishments({ lat, lng, radius, rating, businessType, page = 1 }, opts) {
  const data = await fsaGet('Establishments', {
    // 6 dp is ~10 cm: plenty, and keeps URLs (and cache keys) short.
    latitude: Number(lat).toFixed(6),
    longitude: Number(lng).toFixed(6),
    maxDistanceLimit: radius,
    sortOptionKey: 'distance',
    pageSize: 100,
    pageNumber: page,
    ratingKey: rating,
    // Numeric FHRS ratings mean "this or better"; FHIS values are exact matches.
    ratingOperatorKey: /^\d$/.test(rating || '') ? 'GreaterThanOrEqual' : '',
    businessTypeId: businessType,
  }, opts);

  return {
    establishments: data.establishments || [],
    total: data.meta?.totalCount ?? 0,
    totalPages: data.meta?.totalPages ?? 1,
    page: data.meta?.pageNumber ?? page,
  };
}

/** Business types for the filter, cached in localStorage for a week. */
export async function fetchBusinessTypes() {
  const KEY = 'foodcheck:businessTypes:v1';
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  try {
    const cached = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (cached && Date.now() - cached.savedAt < WEEK) return cached.types;
  } catch { /* storage unavailable – fetch instead */ }

  const data = await fsaGet('BusinessTypes');
  const types = (data.businessTypes || [])
    .filter((t) => t.BusinessTypeId > 0)
    .map((t) => ({ id: String(t.BusinessTypeId), name: t.BusinessTypeName }))
    .sort((a, b) => a.name.localeCompare(b.name));

  try {
    localStorage.setItem(KEY, JSON.stringify({ savedAt: Date.now(), types }));
  } catch { /* ignore */ }
  return types;
}
