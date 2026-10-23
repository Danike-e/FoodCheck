#!/usr/bin/env node
/**
 * FoodCheck local dev server – no dependencies, Node 18+.
 * (Production runs on Vercel: static files from public/, proxy in api/fsa.js.)
 *
 *  - Serves the static site from ./public with the same security headers
 *    as production.
 *  - Serves /api/fsa/<Establishments|BusinessTypes>?… through the shared,
 *    validated proxy in lib/fsa-proxy.js, caching successes in memory for
 *    an hour.
 *
 * Usage: node server.js   (PORT env var to change the port, default 3000)
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleFsaRequest, buildUpstreamUrl } from './lib/fsa-proxy.js';
import { SECURITY_HEADERS } from './lib/security-headers.js';

const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1'; // local only unless you opt in

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const CACHE_MAX_ENTRIES = 200;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** upstream URL -> { expires, response } */
const cache = new Map();

async function proxyFsa(res, url) {
  const endpoint = url.pathname.slice('/api/fsa/'.length);
  const key = buildUpstreamUrl(endpoint, url.searchParams);
  const hit = key && cache.get(key);
  if (hit && hit.expires > Date.now()) {
    return send(res, hit.response.status, hit.response.body, { ...hit.response.headers, 'x-cache': 'HIT' });
  }

  const response = await handleFsaRequest(endpoint, url.searchParams);
  if (response.status === 200) {
    if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value); // drop oldest
    cache.set(key, { expires: Date.now() + CACHE_TTL_MS, response });
  }
  send(res, response.status, response.body, { ...response.headers, 'x-cache': 'MISS' });
}

async function serveStatic(res, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return notFound(res); // malformed %-encoding
  }
  if (pathname.includes('\0')) return notFound(res);
  if (pathname.endsWith('/')) pathname += 'index.html';

  // Resolve inside public/ only, and never serve dotfiles.
  const file = normalize(join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR) || file.slice(PUBLIC_DIR.length).split(sep).some((part) => part.startsWith('.'))) {
    return notFound(res);
  }

  let info;
  try {
    info = await stat(file);
  } catch {
    return notFound(res);
  }
  if (!info.isFile()) return notFound(res);

  const type = MIME[extname(file)];
  if (!type) return notFound(res); // only serve known file types
  const body = await readFile(file);
  const cacheControl = file.endsWith(`${sep}sw.js`) ? 'no-cache' : 'public, max-age=300';
  send(res, 200, body, { 'content-type': type, 'cache-control': cacheControl });
}

function notFound(res) {
  send(res, 404, 'Not found', { 'content-type': MIME['.txt'] });
}

function send(res, status, body, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(res.req.method === 'HEAD' ? undefined : body);
}

const server = createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'Method not allowed', { 'content-type': MIME['.txt'], allow: 'GET, HEAD' });
    }
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/fsa/')) return await proxyFsa(res, url);
    return await serveStatic(res, url);
  } catch (err) {
    // Never let one bad request take the server down.
    console.error('Request failed:', err);
    send(res, 500, 'Internal error', { 'content-type': MIME['.txt'] });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`FoodCheck running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});
