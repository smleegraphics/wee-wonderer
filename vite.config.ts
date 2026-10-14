import { createReadStream, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { defineConfig, loadEnv, type Connect, type Plugin } from 'vite';

// The example scans are tens of MB each, so they are not in public/ (Vite copies all of
// it into every build) but in the gitignored scans/ folder. The dev and preview servers
// serve that folder at /scans/; a public build fetches them from VITE_SCAN_BASE instead
// (src/scans.ts, context/deploy.md).
const SCAN_DIR = resolve(__dirname, 'scans');

function serveScans(): Plugin {
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const path = decodeURIComponent((req.url ?? '').split('?')[0]);
    if (!path.startsWith('/scans/')) return next();
    const file = resolve(SCAN_DIR, path.slice('/scans/'.length));
    if (!file.startsWith(SCAN_DIR + sep)) { res.statusCode = 403; res.end(); return; }
    let size: number;
    try { const st = statSync(file); if (!st.isFile()) throw new Error(); size = st.size; }
    catch { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', size); // the load worker reports progress against it
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(file).pipe(res);
  };
  return {
    name: 'serve-scans',
    configureServer: (server) => { server.middlewares.use(middleware); },
    configurePreviewServer: (server) => { server.middlewares.use(middleware); },
  };
}

export default defineConfig(({ command, mode }) => {
  if (command === 'build' && !loadEnv(mode, __dirname).VITE_SCAN_BASE) {
    console.warn('\n[scans] VITE_SCAN_BASE is not set: this build fetches scans from /scans/, which only `vite preview` serves. Set it for a public build (context/deploy.md).\n');
  }
  return {
    // Force a single three.js instance: 'three/webgpu' bundles its own copy of the
    // core, so importing both it and 'three' loads two instances — and the
    // WebGPURenderer then can't see lights/materials created by the other one.
    // Alias exact 'three' → 'three/webgpu' (which re-exports all of core) so
    // everything, including three/addons, shares one instance.
    resolve: {
      alias: [{ find: /^three$/, replacement: 'three/webgpu' }],
    },
    plugins: [serveScans()],
    server: { host: true },
    assetsInclude: ['**/*.ply', '**/*.splat', '**/*.glb'],
  };
});
