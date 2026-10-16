// Serves the example scans from the R2 bucket bound as SCANS (wrangler.toml).
// Read-only: GET and HEAD of one object by name; nothing can be listed or written.

/** ALLOWED_ORIGINS as matchers. An entry may hold `*`, which stands for letters, digits
 *  and hyphens and never a dot, so `https://wee-wonderer-*-me.vercel.app` matches this
 *  project's Vercel builds and no other domain. A missing list allows nothing. */
function originMatchers(list) {
  return (list ?? '').split(',').map((o) => o.trim()).filter(Boolean).map((o) =>
    new RegExp(`^${o.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[a-z0-9-]+')}$`));
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const cors = { Vary: 'Origin' };
    if (origin && originMatchers(env.ALLOWED_ORIGINS).some((m) => m.test(origin))) cors['Access-Control-Allow-Origin'] = origin;
    const notFound = () => new Response('Not found', { status: 404, headers: cors });
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD', ...cors } });

    let key;
    try { key = decodeURIComponent(new URL(request.url).pathname.slice(1)); } catch { return notFound(); } // a malformed % escape names no scan
    if (!key || key.includes('/')) return notFound(); // scans are flat (src/scan/scan-list.ts)

    // R2 answers the request's own conditions and range: a browser revalidating gets 304,
    // a range request gets just that range.
    const object = request.method === 'HEAD'
      ? await env.SCANS.head(key)
      : await env.SCANS.get(key, { onlyIf: request.headers, range: request.headers });
    if (!object) return notFound();

    const headers = new Headers(cors);
    object.writeHttpMetadata(headers); // Content-Type and Cache-Control, set at upload (scripts/upload-scans.mjs)
    headers.set('ETag', object.httpEtag);
    headers.set('Accept-Ranges', 'bytes');
    if (request.method === 'HEAD') {
      headers.set('Content-Length', String(object.size));
      return new Response(null, { headers });
    }
    if (!('body' in object)) return new Response(null, { status: 304, headers }); // a condition failed: the browser's copy is current
    if (object.range && request.headers.has('Range')) {
      // R2 gives the range it served as an offset and a length, a suffix range ("the last
      // n bytes") included; `suffix` is present but undefined, so it is not read here.
      const { offset = 0, length = object.size - offset } = object.range;
      headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
      headers.set('Content-Length', String(length));
      return new Response(object.body, { status: 206, headers });
    }
    headers.set('Content-Length', String(object.size)); // the app's load progress is measured against it
    return new Response(object.body, { headers });
  },
};
