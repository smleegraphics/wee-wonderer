import { defineConfig } from 'vite';

// splatlight is a local file: dependency and ships raw .wgsl imported via ?raw.
// Nothing special needed yet; kept explicit so the WebGPU/asset story has a home.
export default defineConfig({
  server: { host: true },
  assetsInclude: ['**/*.ply', '**/*.splat', '**/*.glb'],
});
