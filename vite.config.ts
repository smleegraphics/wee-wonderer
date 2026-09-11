import { defineConfig } from 'vite';

export default defineConfig({
  // Force a single three.js instance: 'three/webgpu' bundles its own copy of the
  // core, so importing both it and 'three' loads two instances — and the
  // WebGPURenderer then can't see lights/materials created by the other one.
  // Alias exact 'three' → 'three/webgpu' (which re-exports all of core) so
  // everything, including three/addons, shares one instance.
  resolve: {
    alias: [{ find: /^three$/, replacement: 'three/webgpu' }],
  },
  server: { host: true },
  assetsInclude: ['**/*.ply', '**/*.splat', '**/*.glb'],
});
