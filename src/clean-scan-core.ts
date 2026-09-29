// In-browser scan cleanup — strip floaters from a raw 3DGS .ply so uploaded scans
// render clean. This is a three-free port of scripts/clean-scan.mjs (which runs
// the same logic offline in Node); it works on the RAW .ply bytes (stored logit
// opacity / log scale), so it's byte-for-byte the same filter, and runs in a
// Web Worker (see clean-scan.worker.ts).
//
// A splat is dropped when it fails on ANY of:
//   1. opacity — rendered alpha < alphaMin
//   2. size    — largest axis > scaleCapMul x median splat size
//   3. density — accumulated opacity mass in its voxel < minMass
//   4. bounds  — outside the auto-leveled room box (crop; disable with crop:false)

export interface CleanOptions {
  alphaMin?: number;    // rendered-opacity floor (default 0.35)
  scaleCapMul?: number; // drop splats larger than this x median size (default 4)
  minMass?: number;     // min accumulated opacity in a voxel to keep (default 4)
  grid?: number;        // density-grid resolution across 2*radius (default 160)
  ceil?: number;        // ceiling crop percentile (default 0.98)
  wall?: number;        // horizontal crop percentile (default 0.99)
  margin?: number;      // slack on cropped faces, fraction of span (default 0.08)
  floorMargin?: number; // keep splats to this x radius below the floor (default 0.03)
  crop?: boolean;       // auto-level + bounds-crop (default true)
}

export interface CleanResult {
  buffer: ArrayBuffer; // the cleaned .ply
  kept: number;
  total: number;
  tiltDeg: number;     // floor tilt corrected (0 if crop disabled)
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const median = (a: number[]) => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))];

function indexOfBytes(bytes: Uint8Array, str: string): number {
  const m = new TextEncoder().encode(str);
  outer: for (let i = 0; i + m.length <= bytes.length; i++) {
    for (let j = 0; j < m.length; j++) if (bytes[i + j] !== m[j]) continue outer;
    return i;
  }
  return -1;
}

/** Clean a raw 3DGS .ply. Throws a descriptive Error if the file isn't a
 *  readable uncompressed 3DGS .ply (e.g. a compressed/packed one). */
export function cleanScan(input: ArrayBuffer, opts: CleanOptions = {}): CleanResult {
  const ALPHA_MIN = opts.alphaMin ?? 0.35;
  const SCALE_CAP_MUL = opts.scaleCapMul ?? 4;
  const MIN_MASS = opts.minMass ?? 4;
  const GRID = opts.grid ?? 160;
  const CEIL_PCT = opts.ceil ?? 0.98;
  const WALL_PCT = opts.wall ?? 0.99;
  const MARGIN = opts.margin ?? 0.08;
  const FLOOR_MARGIN = opts.floorMargin ?? 0.03;
  const DO_CROP = opts.crop ?? true;

  const bytes = new Uint8Array(input);
  const marker = 'end_header\n';
  const mi = indexOfBytes(bytes, marker);
  if (mi < 0) throw new Error('Not a PLY file (no end_header found).');
  const headerEnd = mi + marker.length;
  const header = new TextDecoder().decode(bytes.subarray(0, headerEnd));

  if (!/format\s+binary_little_endian/.test(header))
    throw new Error('Unsupported PLY: only binary little-endian is supported (this may be ASCII or big-endian).');

  let count = 0;
  const propOffsets: Record<string, number> = {};
  let stride = 0;
  for (const ln of header.split('\n')) {
    const v = ln.match(/^element vertex (\d+)/);
    if (v) count = Number(v[1]);
    const p = ln.match(/^property (\w+) (\w+)/);
    if (p) {
      const bytesFor: Record<string, number> = { float: 4, double: 8, uchar: 1, int: 4, uint: 4, short: 2, ushort: 2 };
      propOffsets[p[2]] = stride;
      stride += bytesFor[p[1]] ?? 4;
    }
  }
  for (const n of ['x', 'y', 'z', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'f_dc_0'])
    if (!(n in propOffsets))
      throw new Error(`Not an uncompressed 3DGS .ply (missing "${n}"). If this is a compressed/SuperSplat .ply, re-export it as uncompressed.`);
  if (count <= 0) throw new Error('PLY has no vertices.');

  const dv = new DataView(input, bytes.byteOffset, bytes.byteLength);
  const fx = (i: number, name: string) => dv.getFloat32(headerEnd + i * stride + propOffsets[name], true);

  // robust center / radius, per-splat opacity & size
  const sampleStride = Math.max(1, Math.floor(count / 40000));
  const xs: number[] = [], ys: number[] = [], zs: number[] = [];
  for (let i = 0; i < count; i += sampleStride) { xs.push(fx(i, 'x')); ys.push(fx(i, 'y')); zs.push(fx(i, 'z')); }
  const cx = median(xs.slice()), cy = median(ys.slice()), cz = median(zs.slice());
  const dsamp: number[] = [];
  for (let i = 0; i < count; i += sampleStride) dsamp.push(Math.hypot(fx(i, 'x') - cx, fx(i, 'y') - cy, fx(i, 'z') - cz));
  dsamp.sort((p, q) => p - q);
  const radius = pct(dsamp, 0.9) || 1;
  const sizeSample: number[] = [];
  for (let i = 0; i < count; i += sampleStride)
    sizeSample.push(Math.exp(Math.max(fx(i, 'scale_0'), fx(i, 'scale_1'), fx(i, 'scale_2'))));
  const scaleCap = median(sizeSample.slice()) * SCALE_CAP_MUL;

  const alpha = new Float32Array(count);
  const sizeOf = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    alpha[i] = sigmoid(fx(i, 'opacity'));
    sizeOf[i] = Math.exp(Math.max(fx(i, 'scale_0'), fx(i, 'scale_1'), fx(i, 'scale_2')));
  }
  const passOpacitySize = (i: number) => alpha[i] >= ALPHA_MIN && sizeOf[i] <= scaleCap;

  // auto-level: RANSAC floor normal in a rough-flipped, recentered frame
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const nrm = (a: number[]) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const flip = (p: number[]) => [p[0] - cx, -(p[1] - cy), -(p[2] - cz)];

  let leveled: ((i: number) => number[]) | null = null;
  let tiltDeg = 0;
  if (DO_CROP) {
    const S: number[][] = [];
    const st = Math.max(1, Math.floor(count / 60000));
    for (let i = 0; i < count; i += st) S.push(flip([fx(i, 'x'), fx(i, 'y'), fx(i, 'z')]));
    const thresh = radius * 0.012, minCos = Math.cos((35 * Math.PI) / 180);
    const step = Math.max(1, Math.floor(S.length / 8000));
    let best = [0, 1, 0], bestIn = -1;
    for (let iter = 0; iter < 500; iter++) {
      const a = S[(Math.random() * S.length) | 0], b = S[(Math.random() * S.length) | 0], c = S[(Math.random() * S.length) | 0];
      let n = cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
      if (n[0] * n[0] + n[1] * n[1] + n[2] * n[2] < 1e-12) continue;
      n = nrm(n);
      if (n[1] < 0) n = [-n[0], -n[1], -n[2]];
      if (n[1] < minCos) continue;
      const d = dot(n, a);
      let cnt = 0;
      for (let i = 0; i < S.length; i += step) if (Math.abs(dot(n, S[i]) - d) < thresh) cnt++;
      if (cnt > bestIn) { bestIn = cnt; best = n; }
    }
    const axis = nrm(cross(best, [0, 1, 0]));
    const ang = Math.acos(Math.max(-1, Math.min(1, dot(best, [0, 1, 0]))));
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const rodrigues = (v: number[]) => {
      if (!(ang > 1e-6)) return v;
      const kxv = cross(axis, v), kdv = dot(axis, v);
      return [
        v[0] * ca + kxv[0] * sa + axis[0] * kdv * (1 - ca),
        v[1] * ca + kxv[1] * sa + axis[1] * kdv * (1 - ca),
        v[2] * ca + kxv[2] * sa + axis[2] * kdv * (1 - ca),
      ];
    };
    const lys = S.map((p) => rodrigues(p)[1]).sort((a, b) => a - b);
    const floorY = pct(lys, 0.06);
    leveled = (i) => { const r = rodrigues(flip([fx(i, 'x'), fx(i, 'y'), fx(i, 'z')])); return [r[0], r[1] - floorY, r[2]]; };
    tiltDeg = (Math.acos(Math.max(-1, Math.min(1, best[1]))) * 180) / Math.PI;
  }

  // accumulate opacity mass per voxel (opacity/size pre-filtered)
  const voxel = (2 * radius) / GRID;
  const key = (x: number, y: number, z: number) => {
    const vx = Math.floor((x - cx) / voxel), vy = Math.floor((y - cy) / voxel), vz = Math.floor((z - cz) / voxel);
    return (vx + 524288) * 1099511627776 + (vy + 524288) * 1048576 + (vz + 524288);
  };
  const mass = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    if (!passOpacitySize(i)) continue;
    const k = key(fx(i, 'x'), fx(i, 'y'), fx(i, 'z'));
    mass.set(k, (mass.get(k) ?? 0) + alpha[i]);
  }
  const passDensity = (i: number) => (mass.get(key(fx(i, 'x'), fx(i, 'y'), fx(i, 'z'))) ?? 0) >= MIN_MASS;

  // crop box: robust extent of the leveled, density-passing splats
  let box: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number } | null = null;
  if (DO_CROP && leveled) {
    const lx: number[] = [], lz: number[] = [], lyTop: number[] = [];
    for (let i = 0; i < count; i++) {
      if (!passOpacitySize(i) || !passDensity(i)) continue;
      const p = leveled(i);
      lx.push(p[0]); lz.push(p[2]); lyTop.push(p[1]);
    }
    if (lx.length) {
      lx.sort((a, b) => a - b); lz.sort((a, b) => a - b); lyTop.sort((a, b) => a - b);
      const spanX = pct(lx, WALL_PCT) - pct(lx, 1 - WALL_PCT);
      const spanZ = pct(lz, WALL_PCT) - pct(lz, 1 - WALL_PCT);
      const ceil = pct(lyTop, CEIL_PCT);
      box = {
        minX: pct(lx, 1 - WALL_PCT) - MARGIN * spanX, maxX: pct(lx, WALL_PCT) + MARGIN * spanX,
        minZ: pct(lz, 1 - WALL_PCT) - MARGIN * spanZ, maxZ: pct(lz, WALL_PCT) + MARGIN * spanZ,
        minY: -FLOOR_MARGIN * radius, maxY: ceil + MARGIN * ceil,
      };
    }
  }
  const passBounds = (i: number) => {
    if (!box || !leveled) return true;
    const p = leveled(i);
    return p[0] >= box.minX && p[0] <= box.maxX && p[1] >= box.minY && p[1] <= box.maxY && p[2] >= box.minZ && p[2] <= box.maxZ;
  };

  // final decision
  const keep = new Uint8Array(count);
  let kept = 0;
  for (let i = 0; i < count; i++) {
    if (passOpacitySize(i) && passDensity(i) && passBounds(i)) { keep[i] = 1; kept++; }
  }

  // write the cleaned .ply
  const newHeader = header.replace(/element vertex \d+/, `element vertex ${kept}`);
  const headBytes = new TextEncoder().encode(newHeader);
  const out = new Uint8Array(headBytes.length + kept * stride);
  out.set(headBytes, 0);
  let w = headBytes.length;
  for (let i = 0; i < count; i++) {
    if (!keep[i]) continue;
    const base = headerEnd + i * stride;
    out.set(bytes.subarray(base, base + stride), w);
    w += stride;
  }
  return { buffer: out.buffer, kept, total: count, tiltDeg };
}
