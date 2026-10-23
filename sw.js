/**
 * FoodCheck service worker.
 *
 *  - App shell (HTML, CSS, JS, icons, Leaflet): stale-while-revalidate, so the
 *    app opens instantly and offline, and picks up updates on the next visit.
 *  - Fonts: cache-first (they never change).
 *  - API calls (postcodes.io, FSA, local proxy): network-first with a cached
 *    fallback, so the last searches still work without a connection.
 *  - Map tiles: left to the browser's HTTP cache (OSM tile usage policy).
 *
 * Bump VERSION whenever shell files change.
 */

const VERSION = 'v1';
const SHELL_CACHE = `foodcheck-shell-${VERSION}`;
const RUNTIME_CACHE = `foodcheck-runtime-${VERSION}`;

const SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/api.js',
  './js/ratings.js',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/leaflet.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('foodcheck-') && ![SHELL_CACHE, RUNTIME_CACHE].includes(k))
          .map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

const isApi = (url) =>
  url.hostname === 'api.postcodes.io'
  || url.hostname === 'api.ratings.food.gov.uk'
  || (url.origin === self.location.origin && url.pathname.includes('/api/fsa/'));

const isFont = (url) => url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (isApi(url)) {
    event.respondWith(networkFirst(request));
  } else if (isFont(url)) {
    event.respondWith(cacheFirst(request));
  } else if (url.origin === self.location.origin) {
    // Navigations (with any ?query) are served from the cached index.html.
    const key = request.mode === 'navigate' ? './index.html' : request;
    event.respondWith(staleWhileRevalidate(request, key));
  }
});

async function networkFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok || response.type === 'opaque') cache.put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(request, key) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(key, { ignoreSearch: request.mode === 'navigate' });
  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(key, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached || network;
}
