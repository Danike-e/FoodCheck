/**
 * Vercel Function: GET /api/fsa/<Establishments|BusinessTypes>?…
 * (vercel.json rewrites that path to /api/fsa?endpoint=<name>&…)
 *
 * Only a fallback – the browser calls the FSA API directly while it allows
 * CORS. Successful responses are cached on Vercel's CDN for an hour
 * (s-maxage=3600), so repeat searches never reach this function.
 */

import { handleFsaRequest } from '../lib/fsa-proxy.js';

export async function GET(request) {
  const url = new URL(request.url);
  const endpoint = url.searchParams.get('endpoint') ?? url.pathname.split('/').pop();
  url.searchParams.delete('endpoint');

  const { status, headers, body } = await handleFsaRequest(endpoint, url.searchParams);
  return new Response(body, { status, headers });
}
