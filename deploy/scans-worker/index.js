// Serves the example scans from the R2 bucket bound as SCANS (wrangler.toml).
// Read-only: GET and HEAD of one object by name; nothing can be listed or written.
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const allowed = env.ALLOWED_ORIGINS.split(',').map((o) => o.trim());
    const cors = origin && allowed.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : { Vary: 'Origin' };
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD', ...cors } });

    const key = decodeURIComponent(new URL(request.url).pathname.slice(1));
    if (!key || key.includes('/')) return new Response('Not found', { status: 404, headers: cors });
    const object = request.method === 'HEAD' ? await env.SCANS.head(key) : await env.SCANS.get(key);
    if (!object) return new Response('Not found', { status: 404, headers: cors });

    const headers = new Headers(cors);
    object.writeHttpMetadata(headers); // Content-Type and Cache-Control, set at upload (scripts/upload-scans.mjs)
    headers.set('ETag', object.httpEtag);
    headers.set('Content-Length', String(object.size)); // the app's load progress is measured against it
    return new Response(request.method === 'HEAD' ? null : object.body, { headers });
  },
};
