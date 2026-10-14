import { createReadStream, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, loadEnv, type Connect, type Plugin, type ResolvedConfig } from 'vite';
import { SCAN_DIR } from './src/scan-list';

// The example scans are tens of MB each, so they are not in public/ (Vite copies all of
// it into every build) but in the gitignored scans/ folder. The dev and preview servers
// serve that folder at <base>scans/; a public build fetches them from VITE_SCAN_BASE
// instead (src/scans.ts, context/deploy.md).
const scanDir = resolve(__dirname, SCAN_DIR);

function serveScans(): Plugin {
  const middleware = (config: ResolvedConfig): Connect.NextHandleFunction => {
    const prefix = `${config.base}${SCAN_DIR}/`;
    return (req, res, next) => {
      const path = (req.url ?? '').split('?')[0];
      if (!path.startsWith(prefix)) return next();
      const notFound = () => { res.statusCode = 404; res.end(); };
      let name: string;
      try { name = decodeURIComponent(path.slice(prefix.length)); } catch { return notFound(); } // a malformed % escape names no file
      // Scans are flat, as on the scan host (deploy/scans-worker): a name with a separator,
      // or one that is a dot path, is refused rather than resolved.
      if (!name || /[\\/]/.test(name) || name === '.' || name === '..') return notFound();
      const file = resolve(scanDir, name);
      let size: number;
      try { const st = statSync(file); if (!st.isFile()) return notFound(); size = st.size; } catch { return notFound(); }
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', size); // the load worker reports progress against it
      if (req.method === 'HEAD') { res.end(); return; }
      createReadStream(file).on('error', () => res.destroy()).pipe(res);
    };
  };
  return {
    name: 'serve-scans',
    configureServer: (server) => { server.middlewares.use(middleware(server.config)); },
    configurePreviewServer: (server) => { server.middlewares.use(middleware(server.config)); },
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
