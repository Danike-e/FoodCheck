#!/usr/bin/env node
/**
 * FoodCheck local server – no dependencies, Node 18+.
 *
 *  - Serves the static site from this folder.
 *  - Proxies /api/fsa/<Establishments|BusinessTypes>?… to the Food Standards
 *    Agency API, adding the required headers and caching responses in memory
 *    for an hour. The front end only uses this if calling the FSA API directly
 *    from the browser fails (e.g. CORS).
 *
 * Usage: node server.js   (PORT env var to change the port, default 3000)
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const FSA_API = 'https://api.ratings.food.gov.uk';
const FSA_ALLOWED = new Set(['establishments', 'businesstypes']);
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const CACHE_MAX_ENTRIES = 500;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

/** url -> { expires, status, body } */
const cache = new Map();

async function proxyFsa(req, res, url) {
  const endpoint = url.pathname.replace(/^\/api\/fsa\//, '');
  if (!FSA_ALLOWED.has(endpoint.toLowerCase())) {
    return send(res, 404, JSON.stringify({ error: 'Unknown endpoint' }), MIME['.json']);
  }

  const target = `${FSA_API}/${endpoint}${url.search}`;
  const hit = cache.get(target);
  if (hit && hit.expires > Date.now()) {
    return send(res, hit.status, hit.body, MIME['.json'], { 'x-cache': 'HIT' });
  }

  try {
    const upstream = await fetch(target, {
      headers: { 'x-api-version': '2', accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    const body = await upstream.text();
    if (upstream.ok) {
      if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value); // drop oldest
      cache.set(target, { expires: Date.now() + CACHE_TTL_MS, status: upstream.status, body });
    }
    send(res, upstream.status, body, MIME['.json'], { 'x-cache': 'MISS' });
  } catch (err) {
    console.error('FSA proxy error:', err.message);
    send(res, 502, JSON.stringify({ error: 'Upstream request failed' }), MIME['.json']);
  }
}

async function serveStatic(res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';

  // Resolve inside ROOT only, and never serve dotfiles or server code.
  const file = normalize(join(ROOT, pathname));
  if (!file.startsWith(ROOT) || file.split(sep).some((part) => part.startsWith('.')) || file.endsWith(`${sep}server.js`)) {
    return send(res, 404, 'Not found', MIME['.txt']);
  }

  try {
    const info = await stat(file);
    if (!info.isFile()) return send(res, 404, 'Not found', MIME['.txt']);
    const body = await readFile(file);
    const type = MIME[extname(file)] || 'application/octet-stream';
    // The service worker must always be revalidated so updates roll out.
    const cacheControl = file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=300';
    send(res, 200, body, type, { 'cache-control': cacheControl });
  } catch {
    send(res, 404, 'Not found', MIME['.txt']);
  }
}

function send(res, status, body, type, headers = {}) {
  res.writeHead(status, {
    'content-type': type,
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method not allowed', MIME['.txt']);
  }
  if (url.pathname.startsWith('/api/fsa/')) return proxyFsa(req, res, url);
  return serveStatic(res, url);
});

server.listen(PORT, () => {
  console.log(`FoodCheck running at http://localhost:${PORT}`);
});
