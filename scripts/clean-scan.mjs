// Offline scan cleanup: strip floaters from a 3DGS .ply so scans render clean.
//
//   node scripts/clean-scan.mjs public/livingroom.ply [out.ply] [--opts]
//
// Floaters in Gaussian-splat scans are low-opacity, oversized, and spatially
// isolated; real surfaces are opaque and densely packed. We drop a splat when it
// fails on opacity, on size, OR sits in a sparse voxel (little accumulated
// opacity nearby). The voxel occupancy grid built here is also the seed for the
// collision voxelization — same load -> filter -> spatial-bin pass, two payoffs.
//
// Frame-independent (no auto-leveling needed): all criteria are on opacity,
// scale, and local density, so this runs on any 3DGS .ply as-is.
//
// Tunables (all optional): --alphaMin=0.10 --scaleCapMul=8 --minMass=0.8
//   --grid=160  (voxels across the scene's 2*radius extent)
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const src = args.find((a) => !a.startsWith('--'));
const outArg = args.filter((a) => !a.startsWith('--'))[1];
if (!src) { console.error('usage: node scripts/clean-scan.mjs <in.ply> [out.ply] [--opts]'); process.exit(1); }
const opt = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : def;
};
const ALPHA_MIN = opt('alphaMin', 0.10);   // drop splats below this rendered opacity
const SCALE_CAP_MUL = opt('scaleCapMul', 8); // drop blobs > this x median size
const MIN_MASS = opt('minMass', 0.8);      // min accumulated opacity in a voxel to keep it
const GRID = opt('grid', 160);             // voxel resolution across 2*radius
const out = outArg ?? src.replace(/\.ply$/, '-clean.ply');

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

// --- parse the ASCII header, then treat the rest as packed float records ---
const buf = readFileSync(src);
const headerEnd = buf.indexOf('end_header\n') + 'end_header\n'.length;
const header = buf.toString('latin1', 0, headerEnd);
const lines = header.split('\n');
let count = 0;
const propOffsets = {}; // name -> byte offset within a record
let stride = 0;
for (const ln of lines) {
  const v = ln.match(/^element vertex (\d+)/);
  if (v) count = Number(v[1]);
  const p = ln.match(/^property (\w+) (\w+)/);
  if (p) {
    const bytes = { float: 4, double: 8, uchar: 1, int: 4, uint: 4, short: 2, ushort: 2 }[p[1]] ?? 4;
    propOffsets[p[2]] = stride;
    stride += bytes;
  }
}
const need = ['x', 'y', 'z', 'opacity', 'scale_0', 'scale_1', 'scale_2'];
for (const n of need) if (!(n in propOffsets)) { console.error(`missing property ${n}`); process.exit(1); }
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const off = (i, name) => headerEnd + i * stride + propOffsets[name];
const fx = (i, name) => dv.getFloat32(off(i, name), true);

console.log(`${src}: ${count.toLocaleString()} splats, stride ${stride}B`);

// --- pass 1: robust center/radius + per-splat size, gather scale stats ---
const sampleStride = Math.max(1, Math.floor(count / 40000));
const xs = [], ys = [], zs = [];
for (let i = 0; i < count; i += sampleStride) { xs.push(fx(i, 'x')); ys.push(fx(i, 'y')); zs.push(fx(i, 'z')); }
const median = (a) => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
const cx = median(xs.slice()), cy = median(ys.slice()), cz = median(zs.slice());
const dists = [];
for (let i = 0; i < count; i += sampleStride) dists.push(Math.hypot(fx(i, 'x') - cx, fx(i, 'y') - cy, fx(i, 'z') - cz));
dists.sort((p, q) => p - q);
const radius = dists[Math.floor(dists.length * 0.9)] || 1;

// median splat size (exp of largest log-scale axis) from a sample
const sizeSample = [];
for (let i = 0; i < count; i += sampleStride)
  sizeSample.push(Math.exp(Math.max(fx(i, 'scale_0'), fx(i, 'scale_1'), fx(i, 'scale_2'))));
const medSize = median(sizeSample.slice());
const scaleCap = medSize * SCALE_CAP_MUL;
const voxel = (2 * radius) / GRID;
console.log(`  center=(${cx.toFixed(2)},${cy.toFixed(2)},${cz.toFixed(2)}) radius=${radius.toFixed(2)} voxel=${voxel.toFixed(4)} medSize=${medSize.toFixed(4)} scaleCap=${scaleCap.toFixed(4)}`);

// --- pass 2: accumulate opacity mass per voxel (opacity/size pre-filtered) ---
const key = (x, y, z) => {
  const vx = Math.floor((x - cx) / voxel), vy = Math.floor((y - cy) / voxel), vz = Math.floor((z - cz) / voxel);
  // pack into one number: components fit well within 2^20 for reasonable grids
  return (vx + 524288) * 1099511627776 + (vy + 524288) * 1048576 + (vz + 524288);
};
const mass = new Map();
const alpha = new Float32Array(count);
const sizeOf = new Float32Array(count);
for (let i = 0; i < count; i++) {
  const a = sigmoid(fx(i, 'opacity'));
  alpha[i] = a;
  const s = Math.exp(Math.max(fx(i, 'scale_0'), fx(i, 'scale_1'), fx(i, 'scale_2')));
  sizeOf[i] = s;
  if (a < ALPHA_MIN || s > scaleCap) continue; // don't let floaters vote for their own voxel
  const k = key(fx(i, 'x'), fx(i, 'y'), fx(i, 'z'));
  mass.set(k, (mass.get(k) ?? 0) + a);
}

// --- pass 3: keep splats that pass opacity + size + local-density ---
const keep = new Uint8Array(count);
let kept = 0;
for (let i = 0; i < count; i++) {
  if (alpha[i] < ALPHA_MIN || sizeOf[i] > scaleCap) continue;
  const k = key(fx(i, 'x'), fx(i, 'y'), fx(i, 'z'));
  if ((mass.get(k) ?? 0) < MIN_MASS) continue;
  keep[i] = 1; kept++;
}
const pct = ((kept / count) * 100).toFixed(1);
console.log(`  kept ${kept.toLocaleString()} / ${count.toLocaleString()} (${pct}%)  occupied voxels: ${mass.size.toLocaleString()}`);

// --- write cleaned .ply (same header, updated vertex count) ---
const newHeader = header.replace(/element vertex \d+/, `element vertex ${kept}`);
const headBuf = Buffer.from(newHeader, 'latin1');
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
