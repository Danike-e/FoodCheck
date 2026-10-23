/**
 * FoodCheck service worker.
 *
 *  - App shell (HTML, CSS, JS, icons, Leaflet): stale-while-revalidate, so the
 *    app opens instantly and offline, and picks up updates on the next visit.
 *  - API calls (postcodes.io, FSA, local proxy): network-first with a cached
 *    fallback, so recent searches still work without a connection. Capped at
 *    RUNTIME_MAX_ENTRIES so the cache can't grow without limit.
 *  - Map tiles: left to the browser's HTTP cache (OSM tile usage policy).
 *
 * Bump VERSION whenever shell files change.
 */

const VERSION = 'v12';
const SHELL_CACHE = `foodcheck-shell-${VERSION}`;
const RUNTIME_CACHE = `foodcheck-runtime-${VERSION}`;
const RUNTIME_MAX_ENTRIES = 60;

const SHELL = [
  './',
  './index.html',
  './privacy.html',
  './terms.html',
  './accessibility.html',
  './history.html',
  './about.html',
  './css/fonts.css',
  './css/styles.css',
  './js/app.js',
  './js/api.js',
  './js/ratings.js',
  './js/settings.js',
  './js/pager.js',
  './js/history.js',
  './js/history-page.js',
  './js/about-demo.js',
  './js/back-to-top.js',
  './js/section-nav.js',
  './js/theme-init.js',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/leaflet.js',
  './vendor/fonts/dm-sans-latin-opsz-normal.woff2',
  './vendor/fonts/source-serif-4-latin-opsz-normal.woff2',
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

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (isApi(url)) {
    event.respondWith(networkFirst(request));
  } else if (url.origin === self.location.origin) {
    // The app page (with any ?query) is served from the cached index.html;
    // other pages (privacy, terms, …) are cached under their own URL.
    const isAppPage = request.mode === 'navigate' && /\/(index\.html)?$/.test(url.pathname);
    const key = isAppPage ? './index.html' : request;
    event.respondWith(staleWhileRevalidate(request, key));
  }
});

async function networkFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) {
      await cache.put(request, response.clone());
      trimCache(cache);
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

/** Drop the oldest entries beyond the cap (keys() is in insertion order). */
async function trimCache(cache) {
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - RUNTIME_MAX_ENTRIES)).map((k) => cache.delete(k)));
}

async function staleWhileRevalidate(request, key) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(key, { ignoreSearch: request.mode === 'navigate' });
  // (ignoreSearch: a ?query on a page never changes the file served)
  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(key, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached || network;
}
