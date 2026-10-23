/**
 * FSA API proxy core, shared by the Vercel function (api/fsa.js) and the
 * local dev server (server.js).
 *
 * It is deliberately NOT a general-purpose proxy:
 *  - only two upstream endpoints are reachable;
 *  - every query parameter is checked against an allow-list with strict
 *    types and ranges, and the upstream query is rebuilt from the parsed values
 *    (nothing from the client is forwarded verbatim);
 *  - responses are size-capped, must be JSON, and errors are generic.
 * That stops it being used to reach other hosts or paths, to pull huge pages,
 * or to fill caches with endless parameter variations.
 */

export const FSA_ORIGIN = 'https://api.ratings.food.gov.uk';
const UPSTREAM_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const JSON_TYPE = 'application/json; charset=utf-8';
const CACHE_OK = 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400';
const CACHE_NONE = 'no-store';

// Rough bounding box for the UK (incl. Northern Ireland and Shetland).
const UK_BOUNDS = { minLat: 49.5, maxLat: 61, minLng: -8.8, maxLng: 2.1 };

const RATING_KEYS = new Set(['0', '1', '2', '3', '4', '5', 'Pass', 'ImprovementRequired']);
const RATING_OPERATORS = new Set(['GreaterThanOrEqual', 'Equal', 'LessThanOrEqual']);

/** Parsers return the canonical string value, or throw. */
const parsers = {
  latitude: (v) => coordinate(v, UK_BOUNDS.minLat, UK_BOUNDS.maxLat),
  longitude: (v) => coordinate(v, UK_BOUNDS.minLng, UK_BOUNDS.maxLng),
  maxDistanceLimit: (v) => oneOf(v, new Set(['1', '2', '5'])),
  sortOptionKey: (v) => oneOf(v, new Set(['distance'])),
  pageSize: (v) => integer(v, 1, 100),
  pageNumber: (v) => integer(v, 1, 1000),
  ratingKey: (v) => oneOf(v, RATING_KEYS),
  ratingOperatorKey: (v) => oneOf(v, RATING_OPERATORS),
  businessTypeId: (v) => integer(v, 1, 999_999),
};

const ENDPOINTS = {
  establishments: {
    path: 'Establishments',
    required: ['latitude', 'longitude', 'maxDistanceLimit'],
    allowed: Object.keys(parsers),
  },
  businesstypes: {
    path: 'BusinessTypes',
    required: [],
    allowed: [],
  },
};

class InvalidRequest extends Error {}

function coordinate(value, min, max) {
  if (!/^-?\d{1,3}(\.\d{1,15})?$/.test(value)) throw new InvalidRequest();
  const n = Number(value);
  if (n < min || n > max) throw new InvalidRequest();
  return n.toFixed(5);
}

function integer(value, min, max) {
  if (!/^\d{1,7}$/.test(value)) throw new InvalidRequest();
  const n = Number(value);
  if (n < min || n > max) throw new InvalidRequest();
  return String(n);
}

function oneOf(value, allowed) {
  if (!allowed.has(value)) throw new InvalidRequest();
  return value;
}

/**
 * Validate an incoming request and build the exact upstream URL.
 * @param {string} endpoint  e.g. "Establishments" (case-insensitive)
 * @param {URLSearchParams} params
 * @returns {string|null} upstream URL, or null if the request is not allowed
 */
export function buildUpstreamUrl(endpoint, params) {
  const spec = ENDPOINTS[String(endpoint || '').toLowerCase()];
  if (!spec) return null;

  const clean = new URLSearchParams();
  try {
    for (const key of new Set(params.keys())) {
      const values = params.getAll(key);
      if (!spec.allowed.includes(key) || values.length !== 1) throw new InvalidRequest();
      clean.set(key, parsers[key](values[0]));
    }
    for (const key of spec.required) {
      if (!clean.has(key)) throw new InvalidRequest();
    }
  } catch (err) {
    if (err instanceof InvalidRequest) return null;
    throw err;
  }

  clean.sort(); // canonical order, so equivalent requests share cache entries
  const query = clean.toString();
  return `${FSA_ORIGIN}/${spec.path}${query ? `?${query}` : ''}`;
}

const json = (status, body, cacheControl = CACHE_NONE) => ({
  status,
  headers: { 'content-type': JSON_TYPE, 'cache-control': cacheControl },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

/**
 * Handle one proxy request.
 * @returns {Promise<{status: number, headers: Record<string,string>, body: string, upstreamUrl?: string}>}
 */
export async function handleFsaRequest(endpoint, params, { fetchImpl = fetch } = {}) {
  const upstreamUrl = buildUpstreamUrl(endpoint, params);
  if (!upstreamUrl) return json(400, { error: 'Invalid request' });

  try {
    const upstream = await fetchImpl(upstreamUrl, {
      headers: { 'x-api-version': '2', accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!upstream.ok) return json(502, { error: 'Upstream service error' });

    const declared = Number(upstream.headers.get('content-length') || 0);
    if (declared > MAX_BODY_BYTES) return json(502, { error: 'Upstream response too large' });

    const body = await upstream.text();
    if (body.length > MAX_BODY_BYTES) return json(502, { error: 'Upstream response too large' });
    JSON.parse(body); // only ever relay well-formed JSON

    return { ...json(200, body, CACHE_OK), upstreamUrl };
  } catch {
    return json(502, { error: 'Upstream request failed' });
  }
}
