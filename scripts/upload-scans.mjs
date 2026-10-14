// Upload the listed example scans (src/scan-list.ts) from scans/ to the scan host's R2
// bucket. Unlisted scans (local test scans such as Playroom) are never uploaded.
//
//   npm install --prefix deploy/scans-worker   # once: wrangler lives in the Worker's own package
//   node scripts/upload-scans.mjs              # to the real bucket (run wrangler login first)
//   node scripts/upload-scans.mjs --local      # to wrangler's local copy, for `wrangler dev`
//
// Scans are cached for a year as immutable, so a scan that changes must get a new file
// name (the collision cache is keyed by name too; context/deploy.md). This script holds
// to that: a scan already in the bucket is downloaded and compared byte for byte. The
// same bytes are skipped; different bytes under the same name stop the upload.

import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'vite';

const local = process.argv.includes('--local');
const config = 'deploy/scans-worker/wrangler.toml';
const wrangler = 'deploy/scans-worker/node_modules/.bin/wrangler';
if (!existsSync(wrangler)) {
  console.error('wrangler is not installed: npm install --prefix deploy/scans-worker');
  process.exit(1);
}
const bucket = readFileSync(config, 'utf8').match(/^bucket_name\s*=\s*"([^"]+)"/m)?.[1];
if (!bucket) throw new Error(`no bucket_name in ${config}`);
const where = local ? '--local' : '--remote';

// Read the list through Vite, so this is the same module the app imports. Nothing is
// served, so the watcher and hot reload stay off (scans/ holds hundreds of MB).
const vite = await createServer({ server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom', logLevel: 'error' });
const { LISTED_SCANS, SCAN_DIR } = await vite.ssrLoadModule('/src/scan-list.ts');
await vite.close();

const path = (file) => `${SCAN_DIR}/${file}`;
const missing = LISTED_SCANS.filter((s) => !existsSync(path(s.file)));
if (missing.length) {
  console.error(`missing from ${SCAN_DIR}/: ${missing.map((s) => s.file).join(', ')}`);
  process.exit(1);
}

/** SHA-256 of a stream's bytes. */
const digest = (stream) => new Promise((done, fail) => {
  const hash = createHash('sha256');
  stream.on('data', (chunk) => hash.update(chunk)).on('end', () => done(hash.digest('hex'))).on('error', fail);
});

/** The SHA-256 of the copy of `file` in the bucket, or null if there is none. */
function bucketDigest(file) {
  const child = spawn(wrangler, ['r2', 'object', 'get', `${bucket}/${file}`, '--pipe', '-c', config, where], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const hashed = digest(child.stdout);
  return new Promise((done, fail) => child.on('close', async (code) => {
    if (code === 0) return done(await hashed);
    if (/not found|does not exist|NoSuchKey/i.test(err)) return done(null);
    fail(new Error(`could not read ${bucket}/${file}: ${err.trim()}`));
  }));
}

for (const { file, label } of LISTED_SCANS) {
  const mb = (statSync(path(file)).size / 1e6).toFixed(0);
  const [mine, theirs] = await Promise.all([digest(createReadStream(path(file))), bucketDigest(file)]);
  if (theirs === mine) { console.log(`${label}: ${file} is already in ${bucket}, unchanged`); continue; }
  if (theirs !== null) {
    console.error(`${label}: ${file} in ${bucket} has different bytes. Visitors cache scans for a year, so a changed scan needs a new file name (context/deploy.md). Stopped.`);
    process.exit(1);
  }
  console.log(`${label}: ${file} (${mb} MB) → ${bucket}${local ? ' (local)' : ''}`);
  execFileSync(wrangler, [
    'r2', 'object', 'put', `${bucket}/${file}`,
    '--file', path(file),
    '--content-type', 'application/octet-stream',
    '--cache-control', 'public, max-age=31536000, immutable',
    '-c', config, where,
  ], { stdio: 'inherit' });
}
