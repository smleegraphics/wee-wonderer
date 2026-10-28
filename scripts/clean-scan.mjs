// Offline scan cleanup for a 3DGS .ply: drop the splats outside the room (the far-off spray
// past the walls, above the ceiling and below the floor), keeping everything inside it.
//
//   node scripts/clean-scan.mjs scans/livingroom.ply [out.ply] [--opts]
//
// The cleanup is the app's own (insideRoom in src/scan/clean-scan-core.ts, which an imported
// scan goes through in the browser), loaded through Vite, so a file cleaned here and the same
// file imported keep the same splats. It levels the scan as the app does at load, only to
// decide which splats are inside: the output keeps the records, and their coordinates, as
// they were (the app levels at load).
//
// It crops only: an import's collision is built from the splats the floater filters also keep,
// but a file loaded by name builds its collision from every splat in it. So a scan cleaned
// here and shipped would have worse collision (Kitchen's walkable-from-spawn 55% -> 27%):
// don't re-clean the shipped scans with it until the filters run at load
// (context/collision.md, "Scan cleanup").
//
// Tunables (all optional):
//   --ceil=0.98   ceiling = this percentile of levelled height
//   --wall=0.99   horizontal box = this percentile of levelled x/z
//   --margin=0.08 fraction of the box's size added as slack on every cropped face
//   --floorMargin=0.03  keep splats down to this x radius below the floor
//   --noCrop      keep every splat (the file is copied as it is)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const src = positional[0];
if (!src) { console.error('usage: node scripts/clean-scan.mjs <in.ply> [out.ply] [--opts]'); process.exit(1); }
const flag = (name) => args.includes(`--${name}`);
const opt = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : def;
};
const opts = { ceil: opt('ceil', 0.98), wall: opt('wall', 0.99), margin: opt('margin', 0.08), floorMargin: opt('floorMargin', 0.03), crop: !flag('noCrop') };
const out = positional[1] ?? src.replace(/\.ply$/, '-clean.ply');

// --- parse the ASCII header, then treat the rest as packed records ---
const buf = readFileSync(src);
const headerEnd = buf.indexOf('end_header\n') + 'end_header\n'.length;
const header = buf.toString('latin1', 0, headerEnd);
let count = 0;
const propOffsets = {};
let stride = 0;
for (const ln of header.split('\n')) {
  const v = ln.match(/^element vertex (\d+)/);
  if (v) count = Number(v[1]);
  const p = ln.match(/^property (\w+) (\w+)/);
  if (p) {
    const bytes = { float: 4, double: 8, uchar: 1, int: 4, uint: 4, short: 2, ushort: 2 }[p[1]] ?? 4;
    propOffsets[p[2]] = stride;
    stride += bytes;
  }
}
for (const n of ['x', 'y', 'z']) if (!(n in propOffsets)) { console.error(`missing property ${n}`); process.exit(1); }
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const centers = new Float32Array(count * 3);
for (let i = 0; i < count; i++) for (let k = 0; k < 3; k++) centers[i * 3 + k] = dv.getFloat32(headerEnd + i * stride + propOffsets['xyz'[k]], true);
console.log(`${src}: ${count.toLocaleString()} splats, stride ${stride}B`);

// --- which are inside the room: the app's own cleanup ---
const vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom', logLevel: 'error' }); // (the repo, wherever it is run from)
const { insideRoom } = await vite.ssrLoadModule('/src/scan/clean-scan-core.ts');
await vite.close();
const { keep, kept, tiltDeg } = insideRoom(centers, opts);
console.log(`  levelled: floor tilt ${tiltDeg.toFixed(1)}° corrected`);
console.log(`  kept ${kept.toLocaleString()} / ${count.toLocaleString()} (${((kept / count) * 100).toFixed(1)}%)  [outside the room ${(count - kept).toLocaleString()}]`);

// --- write the kept records, as they were ---
const headBuf = Buffer.from(header.replace(/element vertex \d+/, `element vertex ${kept}`), 'latin1');
const outBuf = Buffer.allocUnsafe(headBuf.length + kept * stride);
headBuf.copy(outBuf, 0);
let w = headBuf.length;
for (let i = 0; i < count; i++) {
  if (!keep[i]) continue;
  const base = headerEnd + i * stride;
  buf.copy(outBuf, w, base, base + stride);
  w += stride;
}
writeFileSync(out, outBuf);
console.log(`  wrote ${out} (${(outBuf.length / 1e6).toFixed(1)} MB)`);
