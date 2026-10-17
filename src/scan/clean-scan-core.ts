// In-browser scan cleanup: strip floaters from an imported scan so it renders clean.
// It works on the splats the scan's file was parsed into (ParsedScan), so any format
// parse-scan.ts reads is cleaned the same way. Runs in a Web Worker
// (clean-scan.worker.ts). scripts/clean-scan.mjs is the offline version for .ply files;
// the rules and their defaults are the same.
//
// A splat is dropped when it fails on ANY of:
//   1. opacity — rendered alpha < alphaMin
//   2. size    — largest axis > scaleCapMul x median splat size
//   3. density — accumulated opacity mass in its voxel < minMass
//   4. bounds  — outside the levelled room box (crop; disable with crop:false)

import * as THREE from 'three';
import { orientScan } from './orient-scan';
import type { ParsedScan } from './parse-scan';

export interface CleanOptions {
  alphaMin?: number;    // rendered-opacity floor (default 0.35)
  scaleCapMul?: number; // drop splats larger than this x median size (default 4)
  minMass?: number;     // min accumulated opacity in a voxel to keep (default 4)
  grid?: number;        // density-grid resolution across 2*radius (default 160)
  ceil?: number;        // ceiling crop percentile (default 0.98)
  wall?: number;        // horizontal crop percentile (default 0.99)
  margin?: number;      // slack on cropped faces, fraction of span (default 0.08)
  floorMargin?: number; // keep splats to this x radius below the floor (default 0.03)
  crop?: boolean;       // level + bounds-crop (default true)
}

export interface CleanResult {
  scan: ParsedScan; // the splats kept
  kept: number;
  total: number;
}

const median = (a: number[]) => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))];

/** The largest eigenvalue of the symmetric 3x3 matrix (xx, xy, xz, yy, yz, zz), in closed
 *  form. A splat's covariance is R·S²·Rᵀ, so this is its largest scale, squared. */
function largestEigenvalue(xx: number, xy: number, xz: number, yy: number, yz: number, zz: number): number {
  const off = xy * xy + xz * xz + yz * yz;
  const q = (xx + yy + zz) / 3;
  const p = Math.sqrt(((xx - q) ** 2 + (yy - q) ** 2 + (zz - q) ** 2 + 2 * off) / 6);
  if (p < 1e-30) return q; // a sphere: all three the same
  const a = (xx - q) / p, d = (yy - q) / p, f = (zz - q) / p, b = xy / p, c = xz / p, e = yz / p;
  const r = Math.max(-1, Math.min(1, (a * (d * f - e * e) - b * (b * f - e * c) + c * (b * e - d * c)) / 2));
  return q + 2 * p * Math.cos(Math.acos(r) / 3);
}

/** Clean a scan: the splats that pass every rule, in the same form. */
export function cleanScan(scan: ParsedScan, opts: CleanOptions = {}): CleanResult {
  const ALPHA_MIN = opts.alphaMin ?? 0.35;
  const SCALE_CAP_MUL = opts.scaleCapMul ?? 4;
  const MIN_MASS = opts.minMass ?? 4;
  const GRID = opts.grid ?? 160;
  const CEIL_PCT = opts.ceil ?? 0.98;
  const WALL_PCT = opts.wall ?? 0.99;
  const MARGIN = opts.margin ?? 0.08;
  const FLOOR_MARGIN = opts.floorMargin ?? 0.03;
  const DO_CROP = opts.crop ?? true;

  const { centers, covariances, colors } = scan;
  const count = centers.length / 3;
  if (count <= 0) throw new Error('The scan has no splats.');

  // levelled frame, centre and radius: the same seeded fit the room is placed with at load
  const o = orientScan(new THREE.BufferAttribute(centers, 3));
  const cx = o.center.x, cy = o.center.y, cz = o.center.z, radius = o.radius;

  // per-splat opacity and size
  const alpha = new Float32Array(count), sizeOf = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    alpha[i] = colors[i * 4 + 3] / 255;
    const c = i * 6;
    sizeOf[i] = Math.sqrt(Math.max(0, largestEigenvalue(covariances[c], covariances[c + 1], covariances[c + 2], covariances[c + 3], covariances[c + 4], covariances[c + 5])));
  }
  const sampleStride = Math.max(1, Math.floor(count / 40000));
  const sizeSample: number[] = [];
  for (let i = 0; i < count; i += sampleStride) sizeSample.push(sizeOf[i]);
  const scaleCap = median(sizeSample) * SCALE_CAP_MUL;
  const passOpacitySize = (i: number) => alpha[i] >= ALPHA_MIN && sizeOf[i] <= scaleCap;

  // accumulate opacity mass per voxel (opacity/size pre-filtered)
  const voxel = (2 * radius) / GRID;
  const key = (i: number) => {
    const vx = Math.floor((centers[i * 3] - cx) / voxel), vy = Math.floor((centers[i * 3 + 1] - cy) / voxel), vz = Math.floor((centers[i * 3 + 2] - cz) / voxel);
    return (vx + 524288) * 1099511627776 + (vy + 524288) * 1048576 + (vz + 524288);
  };
  const mass = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    if (!passOpacitySize(i)) continue;
    const k = key(i);
    mass.set(k, (mass.get(k) ?? 0) + alpha[i]);
  }
  const passDensity = (i: number) => (mass.get(key(i)) ?? 0) >= MIN_MASS;

  // crop box: robust extent of the levelled, density-passing splats
  let levelled: Float32Array | null = null;
  let box: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number } | null = null;
  if (DO_CROP) {
    levelled = new Float32Array(count * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      v.set(centers[i * 3] - cx, centers[i * 3 + 1] - cy, centers[i * 3 + 2] - cz).applyQuaternion(o.quaternion);
      levelled[i * 3] = v.x; levelled[i * 3 + 1] = v.y + o.floorOffsetY; levelled[i * 3 + 2] = v.z;
    }
    const lx: number[] = [], lz: number[] = [], ly: number[] = [];
    for (let i = 0; i < count; i++) {
      if (!passOpacitySize(i) || !passDensity(i)) continue;
      lx.push(levelled[i * 3]); ly.push(levelled[i * 3 + 1]); lz.push(levelled[i * 3 + 2]);
    }
    if (lx.length) {
      lx.sort((a, b) => a - b); lz.sort((a, b) => a - b); ly.sort((a, b) => a - b);
      const spanX = pct(lx, WALL_PCT) - pct(lx, 1 - WALL_PCT);
      const spanZ = pct(lz, WALL_PCT) - pct(lz, 1 - WALL_PCT);
      const ceil = pct(ly, CEIL_PCT);
      box = {
        minX: pct(lx, 1 - WALL_PCT) - MARGIN * spanX, maxX: pct(lx, WALL_PCT) + MARGIN * spanX,
        minZ: pct(lz, 1 - WALL_PCT) - MARGIN * spanZ, maxZ: pct(lz, WALL_PCT) + MARGIN * spanZ,
        minY: -FLOOR_MARGIN * radius, maxY: ceil + MARGIN * ceil,
      };
    }
  }
  const passBounds = (i: number) => {
    if (!box || !levelled) return true;
    const x = levelled[i * 3], y = levelled[i * 3 + 1], z = levelled[i * 3 + 2];
    return x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY && z >= box.minZ && z <= box.maxZ;
  };

  // final decision, then the kept splats copied out in order
  const keep: number[] = [];
  for (let i = 0; i < count; i++) if (passOpacitySize(i) && passDensity(i) && passBounds(i)) keep.push(i);
  const kept = keep.length;
  const pick = <T extends Float32Array | Uint8ClampedArray | Uint32Array>(src: T, per: number, make: (n: number) => T): T => {
    const out = make(kept * per);
    keep.forEach((i, k) => out.set(src.subarray(i * per, i * per + per), k * per));
    return out;
  };
  const sphericalHarmonics: Record<string, Uint32Array> = {};
  for (const [name, words] of Object.entries(scan.sphericalHarmonics)) sphericalHarmonics[name] = pick(words, words.length / count, (n) => new Uint32Array(n));
  return {
    scan: {
      centers: pick(centers, 3, (n) => new Float32Array(n)),
      covariances: pick(covariances, 6, (n) => new Float32Array(n)),
      colors: pick(colors, 4, (n) => new Uint8ClampedArray(n)),
      sphericalHarmonics,
    },
    kept, total: count,
  };
}
