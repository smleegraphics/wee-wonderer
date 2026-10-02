// Auto-level a Gaussian-splat scan: find the floor plane (largest near-horizontal
// surface, via RANSAC — robust to floaters/furniture/stairs), align its normal to
// +Y, and drop the floor to y=0. General: no per-scan constants. Used by the app
// at load and by the room inspector.

import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);

/** Deterministic PRNG (mulberry32). Seeding RANSAC with a fixed value makes the
 *  whole orientation reproducible load-to-load — so collision builds are stable
 *  and before/after tests are comparable (no per-load RANSAC jitter). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Robust center (per-axis median) + radius (90th-percentile distance from center). */
export function robustFit(pos: THREE.BufferAttribute): { center: THREE.Vector3; radius: number } {
  const n = pos.count;
  const stride = Math.max(1, Math.floor(n / 40000));
  const xs: number[] = [], ys: number[] = [], zs: number[] = [];
  for (let i = 0; i < n; i += stride) { xs.push(pos.getX(i)); ys.push(pos.getY(i)); zs.push(pos.getZ(i)); }
  const med = (a: number[]) => { a.sort((p, r) => p - r); return a[a.length >> 1]; };
  const cx = med(xs), cy = med(ys), cz = med(zs);
  const d: number[] = [];
  for (let i = 0; i < n; i += stride) d.push(Math.hypot(pos.getX(i) - cx, pos.getY(i) - cy, pos.getZ(i) - cz));
  d.sort((p, r) => p - r);
  return { center: new THREE.Vector3(cx, cy, cz), radius: d[Math.floor(d.length * 0.9)] || 1 };
}

/** RANSAC: up-normal of the largest near-horizontal plane (within `maxTiltDeg` of +Y). */
function ransacFloorNormal(P: THREE.Vector3[], r: number, rng: () => number, maxTiltDeg = 35): THREE.Vector3 {
  const thresh = r * 0.012;
  const minCos = Math.cos(THREE.MathUtils.degToRad(maxTiltDeg));
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), nrm = new THREE.Vector3();
  let best = new THREE.Vector3(0, 1, 0), bestInliers = -1;
  const step = Math.max(1, Math.floor(P.length / 8000));
  for (let iter = 0; iter < 500; iter++) {
    const a = P[(rng() * P.length) | 0], b = P[(rng() * P.length) | 0], c = P[(rng() * P.length) | 0];
    e1.subVectors(b, a); e2.subVectors(c, a); nrm.crossVectors(e1, e2);
    if (nrm.lengthSq() < 1e-12) continue;
    nrm.normalize();
    if (nrm.y < 0) nrm.negate();
    if (nrm.y < minCos) continue;
    const d = nrm.dot(a);
    let cnt = 0;
    for (let i = 0; i < P.length; i += step) if (Math.abs(nrm.dot(P[i]) - d) < thresh) cnt++;
    if (cnt > bestInliers) { bestInliers = cnt; best.copy(nrm); }
  }
  return best.clone();
}

/**
 * Dominant yaw (rotation about +Y) that aligns the room's walls to the X/Z axes.
 * We take the angle in [0,90°) that minimizes the robust axis-aligned bounding-box
 * area of the leveled XZ footprint — a rectangular room snaps its walls flush to the
 * axes. Extent uses the 2nd–98th percentile so stray floaters can't skew it. Floor
 * leveling alone leaves yaw arbitrary (whatever the scan was captured at); aligning
 * it is what lets the axis-sliced panel hole-fill work on every scan, not just ones
 * that happened to be captured square-on. (The 90° ambiguity is irrelevant — both
 * axes get sliced — so the range is [0,90°).)
 */
function dominantYaw(xs: number[], zs: number[]): number {
  const n = xs.length;
  if (n < 16) return 0;
  const xr = new Float64Array(n), zr = new Float64Array(n);
  const robustExtent = (a: Float64Array) => {
    a.sort();
    return a[Math.floor(n * 0.98)] - a[Math.floor(n * 0.02)];
  };
  let bestTheta = 0, bestArea = Infinity;
  for (let deg = 0; deg < 90; deg++) {
    const th = THREE.MathUtils.degToRad(deg), c = Math.cos(th), s = Math.sin(th);
    for (let i = 0; i < n; i++) { xr[i] = xs[i] * c - zs[i] * s; zr[i] = xs[i] * s + zs[i] * c; }
    const area = robustExtent(xr) * robustExtent(zr); // sorts xr,zr in place (overwritten next iter)
    if (area < bestArea) { bestArea = area; bestTheta = th; }
  }
  return bestTheta;
}

export interface ScanOrientation {
  /** subtract from raw splat positions to recenter the scan at the room origin */
  center: THREE.Vector3;
  /** rotation to apply to the (recentered) scan so it's Y-up */
  quaternion: THREE.Quaternion;
  /** translate up by this so the floor sits at y=0 */
  floorOffsetY: number;
  radius: number;
}

/**
 * Compute a scan's leveling transform. `roughFlipXDeg` gives the floor a first
 * flip toward the ground (splat exports are commonly Y-flipped) so the RANSAC
 * horizontal constraint has something to lock onto; RANSAC then does the precise
 * leveling.
 */
export function orientScan(pos: THREE.BufferAttribute, roughFlipXDeg = 180): ScanOrientation {
  const fit = robustFit(pos);
  const rough = new THREE.Quaternion().setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(roughFlipXDeg), 0, 0));

  const S: THREE.Vector3[] = [];
  const st = Math.max(1, Math.floor(pos.count / 60000));
  for (let i = 0; i < pos.count; i += st)
    S.push(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).sub(fit.center).applyQuaternion(rough));

  const rng = mulberry32(0x9e3779b9); // fixed seed → deterministic orientation
  const normal = ransacFloorNormal(S, fit.radius, rng);
  const fix = new THREE.Quaternion().setFromUnitVectors(normal, UP);

  // level the sample, then find + apply the yaw that squares walls to the axes.
  // (yaw is about +Y so it leaves the floor height unchanged.)
  const lev = S.map((p) => p.clone().applyQuaternion(fix));
  const stepYaw = Math.max(1, Math.floor(lev.length / 8000));
  const xs: number[] = [], zs: number[] = [];
  for (let i = 0; i < lev.length; i += stepYaw) { xs.push(lev[i].x); zs.push(lev[i].z); }
  const yaw = dominantYaw(xs, zs);
  const yawQuat = new THREE.Quaternion().setFromAxisAngle(UP, -yaw);
  const quaternion = yawQuat.clone().multiply(fix).multiply(rough);

  const ys = lev.map((p) => p.y).sort((a, b) => a - b);
  const floorY = ys[Math.floor(ys.length * 0.06)]; // low percentile = floor height

  return { center: fit.center, quaternion, floorOffsetY: -floorY, radius: fit.radius };
}
