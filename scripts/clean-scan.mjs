// Offline scan cleanup: strip floaters from a 3DGS .ply so scans render clean.
//
//   node scripts/clean-scan.mjs scans/livingroom.ply [out.ply] [--opts]
//
// Floaters in Gaussian-splat scans are low-opacity, oversized, and spatially
// isolated; real surfaces are opaque and densely packed. A splat is dropped when
// it fails on ANY of:
//   1. opacity   (rendered alpha < --alphaMin)
//   2. size      (largest axis > --scaleCapMul x median splat size)
//   3. density   (accumulated opacity mass in its voxel < --minMass)
//   4. bounds    (outside the auto-leveled room box — floor/ceiling/walls)
//
// Steps 1-3 are frame-independent. Step 4 auto-levels the scan (same RANSAC
// floor fit the app uses at load) to get a floor-at-y=0 frame, then crops to the
// room's robust extent — this removes the far-background "spray" that density
// alone leaves behind. Leveling is computed only to DECIDE which splats to keep;
// the output .ply keeps original coordinates (the app auto-levels at load).
//
// The voxel occupancy grid AND the leveling transform built here are the seed
// for the planned collision voxelization — same load -> filter -> level -> bin
// pass feeds both clean rendering and the collision mesh.
//
// Tunables (all optional): --alphaMin=0.35 --scaleCapMul=4 --minMass=4 --grid=160
//   --ceil=0.98   ceiling = this percentile of leveled height among kept splats
//   --wall=0.99   horizontal box = this percentile of leveled x/z among kept splats
//   --margin=0.08 fraction of box size added as slack on every cropped face
//   --floorMargin=0.03  keep splats down to this x radius below the floor
//   --noCrop / --noLevel  disable step 4 (and leveling) entirely
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const src = positional[0];
if (!src) { console.error('usage: node scripts/clean-scan.mjs <in.ply> [out.ply] [--opts]'); process.exit(1); }
const flag = (name) => args.includes(`--${name}`);
const opt = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : def;
};
const ALPHA_MIN = opt('alphaMin', 0.35);
const SCALE_CAP_MUL = opt('scaleCapMul', 4);
const MIN_MASS = opt('minMass', 4);
const GRID = opt('grid', 160);
const CEIL_PCT = opt('ceil', 0.98);
const WALL_PCT = opt('wall', 0.99);
const MARGIN = opt('margin', 0.08);
const FLOOR_MARGIN = opt('floorMargin', 0.03);
const DO_CROP = !flag('noCrop') && !flag('noLevel');
const out = positional[1] ?? src.replace(/\.ply$/, '-clean.ply');

const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const median = (a) => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))];

// --- parse the ASCII header, then treat the rest as packed float records ---
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
for (const n of ['x', 'y', 'z', 'opacity', 'scale_0', 'scale_1', 'scale_2'])
  if (!(n in propOffsets)) { console.error(`missing property ${n}`); process.exit(1); }
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const fx = (i, name) => dv.getFloat32(headerEnd + i * stride + propOffsets[name], true);
console.log(`${src}: ${count.toLocaleString()} splats, stride ${stride}B`);

// --- robust center / radius, and per-splat opacity & size ---
const sampleStride = Math.max(1, Math.floor(count / 40000));
const xs = [], ys = [], zs = [];
for (let i = 0; i < count; i += sampleStride) { xs.push(fx(i, 'x')); ys.push(fx(i, 'y')); zs.push(fx(i, 'z')); }
const cx = median(xs.slice()), cy = median(ys.slice()), cz = median(zs.slice());
const dsamp = [];
for (let i = 0; i < count; i += sampleStride) dsamp.push(Math.hypot(fx(i, 'x') - cx, fx(i, 'y') - cy, fx(i, 'z') - cz));
dsamp.sort((p, q) => p - q);
const radius = pct(dsamp, 0.9) || 1;
const sizeSample = [];
for (let i = 0; i < count; i += sampleStride)
  sizeSample.push(Math.exp(Math.max(fx(i, 'scale_0'), fx(i, 'scale_1'), fx(i, 'scale_2'))));
const scaleCap = median(sizeSample.slice()) * SCALE_CAP_MUL;

const alpha = new Float32Array(count);
const sizeOf = new Float32Array(count);
for (let i = 0; i < count; i++) {
  alpha[i] = sigmoid(fx(i, 'opacity'));
  sizeOf[i] = Math.exp(Math.max(fx(i, 'scale_0'), fx(i, 'scale_1'), fx(i, 'scale_2')));
}
const passOpacitySize = (i) => alpha[i] >= ALPHA_MIN && sizeOf[i] <= scaleCap;

// --- auto-level: RANSAC floor normal in a rough-flipped, recentered frame ---
// (mirrors src/orient-scan.ts so the crop frame matches the app's load frame)
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const flip = (p) => [p[0] - cx, -(p[1] - cy), -(p[2] - cz)]; // rough 180° about X, recentered

let level = null; // { rot(axis,angle applied via rodrigues), floorY }  -> leveled(i)
if (DO_CROP) {
  const S = [];
  const st = Math.max(1, Math.floor(count / 60000));
  for (let i = 0; i < count; i += st) S.push(flip([fx(i, 'x'), fx(i, 'y'), fx(i, 'z')]));
  // RANSAC: largest near-horizontal plane's up-normal
  const thresh = radius * 0.012, minCos = Math.cos((35 * Math.PI) / 180);
  const step = Math.max(1, Math.floor(S.length / 8000));
  let best = [0, 1, 0], bestIn = -1;
  for (let iter = 0; iter < 500; iter++) {
    const a = S[(Math.random() * S.length) | 0], b = S[(Math.random() * S.length) | 0], c = S[(Math.random() * S.length) | 0];
    let n = cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
    const l2 = n[0] * n[0] + n[1] * n[1] + n[2] * n[2];
    if (l2 < 1e-12) continue;
    n = norm(n);
    if (n[1] < 0) n = [-n[0], -n[1], -n[2]];
    if (n[1] < minCos) continue;
    const d = dot(n, a);
    let cnt = 0;
    for (let i = 0; i < S.length; i += step) if (Math.abs(dot(n, S[i]) - d) < thresh) cnt++;
    if (cnt > bestIn) { bestIn = cnt; best = n; }
  }
  // rotation that sends the floor normal to +Y (Rodrigues about axis = normal x up)
  const up = [0, 1, 0];
  const axis = norm(cross(best, up));
  const ang = Math.acos(Math.max(-1, Math.min(1, dot(best, up))));
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const rodrigues = (v) => {
    if (!(ang > 1e-6)) return v;
    const kxv = cross(axis, v), kdv = dot(axis, v);
    return [
      v[0] * ca + kxv[0] * sa + axis[0] * kdv * (1 - ca),
      v[1] * ca + kxv[1] * sa + axis[1] * kdv * (1 - ca),
      v[2] * ca + kxv[2] * sa + axis[2] * kdv * (1 - ca),
    ];
  };
  // floor height = low percentile of leveled Y over a sample
  const lys = S.map((p) => rodrigues(p)[1]).sort((a, b) => a - b);
  const floorY = pct(lys, 0.06);
  level = {
    leveled: (i) => { const r = rodrigues(flip([fx(i, 'x'), fx(i, 'y'), fx(i, 'z')])); return [r[0], r[1] - floorY, r[2]]; },
    tiltDeg: (Math.acos(Math.max(-1, Math.min(1, best[1]))) * 180) / Math.PI,
  };
  console.log(`  leveled: floor tilt ${level.tiltDeg.toFixed(1)}° corrected, radius ${radius.toFixed(2)}`);
}

// --- accumulate opacity mass per voxel (opacity/size pre-filtered) ---
const voxel = (2 * radius) / GRID;
const key = (x, y, z) => {
  const vx = Math.floor((x - cx) / voxel), vy = Math.floor((y - cy) / voxel), vz = Math.floor((z - cz) / voxel);
  return (vx + 524288) * 1099511627776 + (vy + 524288) * 1048576 + (vz + 524288);
};
const mass = new Map();
for (let i = 0; i < count; i++) {
  if (!passOpacitySize(i)) continue;
  const k = key(fx(i, 'x'), fx(i, 'y'), fx(i, 'z'));
  mass.set(k, (mass.get(k) ?? 0) + alpha[i]);
}
const passDensity = (i) => (mass.get(key(fx(i, 'x'), fx(i, 'y'), fx(i, 'z'))) ?? 0) >= MIN_MASS;

// --- crop box: robust extent of the leveled, density-passing splats ---
let box = null;
if (DO_CROP) {
  const lx = [], lz = [], lyTop = [];
  for (let i = 0; i < count; i++) {
    if (!passOpacitySize(i) || !passDensity(i)) continue;
    const p = level.leveled(i);
    lx.push(p[0]); lz.push(p[2]); lyTop.push(p[1]);
  }
  lx.sort((a, b) => a - b); lz.sort((a, b) => a - b); lyTop.sort((a, b) => a - b);
  const spanX = pct(lx, WALL_PCT) - pct(lx, 1 - WALL_PCT);
  const spanZ = pct(lz, WALL_PCT) - pct(lz, 1 - WALL_PCT);
  const ceil = pct(lyTop, CEIL_PCT);
  box = {
    minX: pct(lx, 1 - WALL_PCT) - MARGIN * spanX, maxX: pct(lx, WALL_PCT) + MARGIN * spanX,
    minZ: pct(lz, 1 - WALL_PCT) - MARGIN * spanZ, maxZ: pct(lz, WALL_PCT) + MARGIN * spanZ,
    minY: -FLOOR_MARGIN * radius, maxY: ceil + MARGIN * ceil,
  };
  console.log(`  crop box (leveled): x[${box.minX.toFixed(2)},${box.maxX.toFixed(2)}] ` +
    `y[${box.minY.toFixed(2)},${box.maxY.toFixed(2)}] z[${box.minZ.toFixed(2)},${box.maxZ.toFixed(2)}]`);
}
const passBounds = (i) => {
  if (!box) return true;
  const p = level.leveled(i);
  return p[0] >= box.minX && p[0] <= box.maxX && p[1] >= box.minY && p[1] <= box.maxY && p[2] >= box.minZ && p[2] <= box.maxZ;
};

// --- final decision + write ---
const keep = new Uint8Array(count);
let kept = 0, cutDensity = 0, cutBounds = 0;
for (let i = 0; i < count; i++) {
  if (!passOpacitySize(i)) continue;
  if (!passDensity(i)) { cutDensity++; continue; }
  if (!passBounds(i)) { cutBounds++; continue; }
  keep[i] = 1; kept++;
}
console.log(`  kept ${kept.toLocaleString()} / ${count.toLocaleString()} (${((kept / count) * 100).toFixed(1)}%)  ` +
  `[density cut ${cutDensity.toLocaleString()}, bounds cut ${cutBounds.toLocaleString()}]`);

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
