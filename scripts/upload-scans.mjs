// Upload the listed example scans (src/scans.ts) from scans/ to the scan host's R2
// bucket. Unlisted scans (local test scans such as Playroom) are never uploaded.
//
//   node scripts/upload-scans.mjs           # to the real bucket (run `npx wrangler login` first)
//   node scripts/upload-scans.mjs --local   # to wrangler's local copy, for `wrangler dev`
//
// Scans are cached for a year as immutable: a scan that changes must get a new file
// name (the collision cache is keyed by name too). See context/deploy.md.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'vite';

const local = process.argv.includes('--local');
const config = 'deploy/scans-worker/wrangler.toml';
const bucket = readFileSync(config, 'utf8').match(/^bucket_name\s*=\s*"([^"]+)"/m)?.[1];
if (!bucket) throw new Error(`no bucket_name in ${config}`);

// Read the list through Vite, so this is the same module the app imports.
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
const { LISTED_SCANS } = await vite.ssrLoadModule('/src/scans.ts');
await vite.close();

const missing = LISTED_SCANS.filter((s) => !existsSync(`scans/${s.file}`));
if (missing.length) {
  console.error(`missing from scans/: ${missing.map((s) => s.file).join(', ')}`);
  process.exit(1);
}

for (const { file, label } of LISTED_SCANS) {
  const mb = (statSync(`scans/${file}`).size / 1e6).toFixed(0);
  console.log(`${label}: ${file} (${mb} MB) → ${bucket}${local ? ' (local)' : ''}`);
  execFileSync('npx', [
    'wrangler', 'r2', 'object', 'put', `${bucket}/${file}`,
    '--file', `scans/${file}`,
    '--content-type', 'application/octet-stream',
    '--cache-control', 'public, max-age=31536000, immutable',
    '-c', config,
    local ? '--local' : '--remote',
  ], { stdio: 'inherit' });
}
