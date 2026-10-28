// Offline scan cleanup for a 3DGS .ply: keep the splats the app draws (the room, without the
// far-off spray past the walls, above the ceiling and below the floor).
//
//   node scripts/clean-scan.mjs scans/livingroom.ply [out.ply] [--opts]
//
// The file is read and cleaned by the app's own code (parseScanArrays in src/scan/parse-scan.ts,
// cleanMasks in src/scan/clean-scan-core.ts, which an imported scan goes through in the
// browser), loaded through Vite, so a file cleaned here and the same file imported draw the
// same splats. The levelling only decides which splats are inside the room: the output keeps
// the records, and their coordinates, as they were (the app levels at load).
//
// It keeps what is drawn: an import builds its collision from the splats the floater filters
// also keep, but a file loaded by name builds its collision from every splat in it. So a scan
// cleaned here and shipped would have worse collision (Kitchen's walkable-from-spawn 55% -> 27%):
// don't re-clean the shipped scans with it until the filters run at load
// (context/collision.md, "Scan cleanup").
//
// Options (the app's defaults unless given; clean-scan-core.ts says what each is):
//   --alphaMin= --scaleCapMul= --minMass= --grid=   the floater filters, which set the room box
//   --ceil= --wall= --margin= --floorMargin=        the room box
//   --noCrop                                        keep every splat (the file is copied as it is)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const NUMBERS = ['alphaMin', 'scaleCapMul', 'minMass', 'grid', 'ceil', 'wall', 'margin', 'floorMargin'], FLAGS = ['noCrop'];
const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const src = positional[0];
if (!src) { console.error('usage: node scripts/clean-scan.mjs <in.ply> [out.ply] [--opts]'); process.exit(1); }
const opts = {};
for (const a of args.filter((x) => x.startsWith('--'))) {
  const [name, value] = a.slice(2).split('=');
  if (FLAGS.includes(name) && value === undefined) { opts.crop = false; continue; }
  if (!NUMBERS.includes(name) || value === undefined || !Number.isFinite(Number(value))) {
    console.error(`unknown option ${a} (options: ${NUMBERS.map((n) => `--${n}=`).join(' ')} ${FLAGS.map((n) => `--${n}`).join(' ')})`);
    process.exit(1);
  }
  opts[name] = Number(value);
}
const out = positional[1] ?? src.replace(/\.ply$/, '-clean.ply');

// --- the records as they are in the file, to copy the kept ones out unchanged ---
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
console.log(`${src}: ${count.toLocaleString()} splats, stride ${stride}B`);

// --- which to keep: the app's own reading and cleanup ---
const vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom', logLevel: 'error' }); // (the repo, wherever it is run from)
const { parseScanArrays } = await vite.ssrLoadModule('/src/scan/parse-scan.ts');
const { cleanMasks } = await vite.ssrLoadModule('/src/scan/clean-scan-core.ts');
await vite.close();
const scan = await parseScanArrays(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
if (scan.centers.length !== count * 3) { console.error(`the reader made ${scan.centers.length / 3} splats of ${count} records`); process.exit(1); }
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
for (const i of [0, count >> 1, count - 1]) for (let k = 0; k < 3; k++) // (the records are copied by the reader's order: it must be the file's)
  if (dv.getFloat32(headerEnd + i * stride + propOffsets['xyz'[k]], true) !== scan.centers[i * 3 + k]) { console.error(`splat ${i}: the reader's order is not the file's`); process.exit(1); }
const { drawn, tiltDeg } = cleanMasks(scan, opts);
let kept = 0;
for (const d of drawn) kept += d;
console.log(`  levelled: floor tilt ${tiltDeg.toFixed(1)}° corrected`);
console.log(`  kept ${kept.toLocaleString()} / ${count.toLocaleString()} (${((kept / count) * 100).toFixed(1)}%)  [outside the room ${(count - kept).toLocaleString()}]`);

// --- write the kept records, as they were ---
const headBuf = Buffer.from(header.replace(/element vertex \d+/, `element vertex ${kept}`), 'latin1');
const outBuf = Buffer.allocUnsafe(headBuf.length + kept * stride);
headBuf.copy(outBuf, 0);
let w = headBuf.length;
for (let i = 0; i < count; i++) {
  if (!drawn[i]) continue;
  const base = headerEnd + i * stride;
  buf.copy(outBuf, w, base, base + stride);
  w += stride;
}
writeFileSync(out, outBuf);
console.log(`  wrote ${out} (${(outBuf.length / 1e6).toFixed(1)} MB)`);
