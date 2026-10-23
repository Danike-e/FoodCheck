/**
 * Security tests – run with `npm test` (no network access needed).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { buildUpstreamUrl, handleFsaRequest, FSA_ORIGIN } from '../lib/fsa-proxy.js';
import { SECURITY_HEADERS } from '../lib/security-headers.js';

const q = (s) => new URLSearchParams(s);
const VALID = 'latitude=51.50101&longitude=-0.141563&maxDistanceLimit=1&sortOptionKey=distance&pageSize=100&pageNumber=1';

/* ---------- Proxy request validation ---------- */

test('builds a canonical upstream URL for valid requests', () => {
  const url = buildUpstreamUrl('establishments', q(`${VALID}&ratingKey=4&ratingOperatorKey=GreaterThanOrEqual&businessTypeId=1`));
  assert.ok(url.startsWith(`${FSA_ORIGIN}/Establishments?`));
  assert.match(url, /latitude=51\.50101/);
  assert.equal(buildUpstreamUrl('BusinessTypes', q('')), `${FSA_ORIGIN}/BusinessTypes`);
  // Same params in a different order -> same URL (one cache entry)
  assert.equal(
    buildUpstreamUrl('Establishments', q('maxDistanceLimit=1&latitude=51.5&longitude=-0.14')),
    buildUpstreamUrl('Establishments', q('longitude=-0.14&latitude=51.5&maxDistanceLimit=1')),
  );
});

test('only allow-listed endpoints are reachable', () => {
  for (const endpoint of ['Authorities', '../Establishments', 'Establishments/1', 'https://evil.example', '', '%2e%2e', 'Regions']) {
    assert.equal(buildUpstreamUrl(endpoint, q(VALID)), null, endpoint);
  }
});

test('rejects unknown, duplicated, malformed or out-of-range parameters', () => {
  const bad = [
    `${VALID}&foo=bar`,                                         // unknown param
    `${VALID}&latitude=51.6`,                                   // duplicate
    VALID.replace('pageSize=100', 'pageSize=5000'),             // amplification
    VALID.replace('pageNumber=1', 'pageNumber=0'),
    VALID.replace('pageNumber=1', 'pageNumber=999'),
    VALID.replace('maxDistanceLimit=1', 'maxDistanceLimit=50'),
    VALID.replace('latitude=51.50101', 'latitude=40.7'),        // outside UK
    VALID.replace('latitude=51.50101', 'latitude=1e1'),
    VALID.replace('latitude=51.50101', 'latitude=51.5;drop'),
    VALID.replace('sortOptionKey=distance', 'sortOptionKey=rating'),
    `${VALID}&ratingKey=fhrs_5_en-gb`,
    `${VALID}&ratingOperatorKey=Contains`,
    `${VALID}&businessTypeId=1 OR 1=1`,
    `${VALID}&businessTypeId=-1`,
    'latitude=51.5&longitude=-0.14',                            // missing required
  ];
  for (const query of bad) assert.equal(buildUpstreamUrl('Establishments', q(query)), null, query);
  assert.equal(buildUpstreamUrl('BusinessTypes', q('pageSize=1')), null);
});

/* ---------- Proxy response handling ---------- */

const fakeFetch = (body, init = {}) => async (url, opts) => {
  fakeFetch.calls.push({ url, opts });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' }, ...init });
};
fakeFetch.calls = [];

test('relays valid JSON with CDN caching and required FSA headers', async () => {
  const res = await handleFsaRequest('Establishments', q(VALID), { fetchImpl: fakeFetch('{"establishments":[]}') });
  assert.equal(res.status, 200);
  assert.match(res.headers['cache-control'], /s-maxage=3600/);
  const { url, opts } = fakeFetch.calls.at(-1);
  assert.ok(url.startsWith(FSA_ORIGIN));
  assert.equal(opts.headers['x-api-version'], '2');
  assert.equal(opts.redirect, 'error');
});

test('never calls upstream for invalid requests', async () => {
  const before = fakeFetch.calls.length;
  const res = await handleFsaRequest('Establishments', q('latitude=0'), { fetchImpl: fakeFetch('{}') });
  assert.equal(res.status, 400);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(fakeFetch.calls.length, before);
});

test('upstream errors, non-JSON and oversized bodies become generic 502s', async () => {
  const cases = [
    fakeFetch('secret stack trace', { status: 500 }),
    fakeFetch('<html>not json</html>'),
    fakeFetch(`{"x":"${'a'.repeat(2.5 * 1024 * 1024)}"}`),
    async () => { throw new Error('ECONNRESET internal-host:443'); },
  ];
  for (const fetchImpl of cases) {
    const res = await handleFsaRequest('Establishments', q(VALID), { fetchImpl });
    assert.equal(res.status, 502);
    assert.doesNotMatch(res.body, /secret|internal-host|html/);
    assert.equal(res.headers['cache-control'], 'no-store');
  }
});

/* ---------- Production config ---------- */

test('vercel.json sends exactly the shared security headers on every route', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.equal(config.outputDirectory, 'public', 'only public/ may be served statically');
  const global = config.headers.find((h) => h.source === '/(.*)');
  const actual = Object.fromEntries(global.headers.map((h) => [h.key, h.value]));
  assert.deepEqual(actual, SECURITY_HEADERS);
});

test('CSP blocks inline script, plugins, framing and foreign hosts', () => {
  const csp = SECURITY_HEADERS['Content-Security-Policy'];
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /base-uri 'self'/);
});

/* ---------- Local server hardening ---------- */

test('local server: headers, traversal, malformed input, methods', async (t) => {
  const port = 3900 + Math.floor(Math.random() * 90);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port) },
    stdio: 'pipe',
  });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => d.toString().includes('running') && resolve());
    child.on('exit', reject);
  });
  const base = `http://127.0.0.1:${port}`;
  const get = (path, init) => fetch(base + path, init);

  const home = await get('/');
  assert.equal(home.status, 200);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    assert.equal(home.headers.get(key), value, key);
  }

  // Nothing outside public/ and no dotfiles
  for (const path of ['/server.js', '/package.json', '/lib/fsa-proxy.js', '/..%2fserver.js', '/%2e%2e/package.json', '/.git/config', '/%2egit/config', '/js/..%2f..%2fserver.js']) {
    assert.equal((await get(path)).status, 404, path);
  }

  // Malformed encoding / null bytes don't crash the process
  assert.equal((await get('/%E0%A4%A')).status, 404);
  assert.equal((await get('/index.html%00.js')).status, 404);
  assert.equal((await get('/')).status, 200, 'server still alive');

  assert.equal((await get('/', { method: 'POST' })).status, 405);
  assert.equal((await get('/api/fsa/Authorities')).status, 400);
  assert.equal((await get('/api/fsa/Establishments?latitude=51.5&longitude=-0.1&maxDistanceLimit=1&pageSize=9999')).status, 400);
});
