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

// The floor search (ransacFloorNormal). Each try is a plane through three points; the try
// can only find the floor if all three are on it. Drawn from anywhere in the room, that
// is (floor share)³: with the floor 7% of a scan's splats (an AI-generated living room),
// 500 tries missed it for 5 seeds in 20 and settled on a plane 24-31° off it. So the
// second and third points come from near the first (within NEAR of it): a try then finds
// a surface about as often as its first point lands on it, and the tries needed follow
// from the smallest floor the search must not miss.
const PLANE_BAND = 0.012;    // radii: how far from a plane a point still counts as on it
const NEAR = 0.1;            // radii: where a try's other two points come from. About 8 bands wide, so three points span enough of the surface to fix its tilt
const FLOOR_SHARE_MIN = 0.02; // the smallest floor, as a share of the sample, the search is sized for
const MISS_ODDS = 1e-6;      // the chance it may miss a floor that small
const TRIES = Math.ceil(Math.log(MISS_ODDS) / Math.log(1 - FLOOR_SHARE_MIN)); // 684
const REFITS_MAX = 20;       // refits of the found plane, at most (it settles in a few)
const SETTLED = THREE.MathUtils.degToRad(0.01); // a refit that turns the plane less than this: done
const CANDIDATES = 8;        // the tries' best planes kept to refit and compare
const SPREAD_MIN = Math.sin(THREE.MathUtils.degToRad(13)) ** 2; // a try's two edges must open at least this wide (as sin²) to tilt a plane
const SAME_PLANE = THREE.MathUtils.degToRad(3); // two tries this close in tilt (and within a band in height) found one plane

/** RANSAC: up-normal of the largest near-horizontal plane (within `maxTiltDeg` of +Y), refitted
 *  to all of its points. */
function ransacFloorNormal(P: THREE.Vector3[], r: number, rng: () => number, maxTiltDeg = 35): THREE.Vector3 {
  const thresh = r * PLANE_BAND, near = r * NEAR;
  const minCos = Math.cos(THREE.MathUtils.degToRad(maxTiltDeg));
  // the points by cell of a grid `near` wide, to draw a point's neighbours from
  const cells = new Map<number, number[]>(), cellOf = (x: number, y: number, z: number) => ((Math.floor(x / near) + 512) * 1024 + Math.floor(y / near) + 512) * 1024 + Math.floor(z / near) + 512;
  P.forEach((p, i) => { const k = cellOf(p.x, p.y, p.z), c = cells.get(k); if (c) c.push(i); else cells.set(k, [i]); });
  /** A point from the cells round `a`, further from it than a third of `near` and nearer than
   *  `near` (far enough to tilt a plane, not just its own splat's noise); null after a few misses. */
  const neighbour = (a: THREE.Vector3): THREE.Vector3 | null => {
    for (let t = 0; t < 32; t++) {
      const c = cells.get(cellOf(a.x + (((rng() * 3) | 0) - 1) * near, a.y + (((rng() * 3) | 0) - 1) * near, a.z + (((rng() * 3) | 0) - 1) * near));
      if (!c) continue;
      const q = P[c[(rng() * c.length) | 0]], d = q.distanceTo(a);
      if (d > near / 3 && d < near) return q;
    }
    return null;
  };
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), nrm = new THREE.Vector3();
  // The tries' best few planes, each a different one. Which wins is decided only after each is
  // refitted and counted over the whole sample: counted on a thinned sample before refitting,
  // near-ties (a soft blanket's many nearly flat patches) flipped with any change to the input.
  const found: { n: THREE.Vector3; off: number; count: number }[] = [];
  const step = Math.max(1, Math.floor(P.length / 8000));
  for (let iter = 0; iter < TRIES; iter++) {
    const a = P[(rng() * P.length) | 0], b = neighbour(a), c = b && neighbour(a);
    if (!b || !c) continue;
    e1.subVectors(b, a); e2.subVectors(c, a); nrm.crossVectors(e1, e2);
    if (nrm.lengthSq() < (near * near / 9) ** 2 * SPREAD_MIN) continue; // (the three nearly in a line: no tilt to read)
    nrm.normalize();
    if (nrm.y < 0) nrm.negate();
    if (nrm.y < minCos) continue;
    const d = nrm.dot(a);
    let count = 0;
    for (let i = 0; i < P.length; i += step) if (Math.abs(nrm.dot(P[i]) - d) < thresh) count++;
    const same = found.find((f) => f.n.angleTo(nrm) < SAME_PLANE && Math.abs(f.off - d) < thresh);
    if (same) { if (count > same.count) { same.n.copy(nrm); same.off = d; same.count = count; } continue; }
    if (found.length < CANDIDATES) found.push({ n: nrm.clone(), off: d, count });
    else { const least = found.reduce((m, f) => (f.count < m.count ? f : m)); if (count > least.count) { least.n.copy(nrm); least.off = d; least.count = count; } }
  }
  if (!found.length) return new THREE.Vector3(0, 1, 0); // no try was near-horizontal: the file's own up
  let best = found[0], bestCount = -1;
  for (const f of found) {
    refitPlane(P, f, thresh);
    let count = 0;
    for (const q of P) if (Math.abs(f.n.dot(q) - f.off) < thresh) count++;
    if (count > bestCount) { bestCount = count; best = f; }
  }
  return best.n;
}

/** Three points close together fix a plane's tilt only to a few degrees: refit it to all of its
 *  points (least squares, in the plane's own frame), until it stops moving. The band moves with
 *  the plane, so a start a degree or two off, which cuts across a big surface (Kitchen's table),
 *  takes a few passes to take all of it in: two left Kitchen 0.45° from level. */
function refitPlane(P: THREE.Vector3[], plane: { n: THREE.Vector3; off: number }, thresh: number): void {
  const best = plane.n, u = new THREE.Vector3(), v = new THREE.Vector3(), was = new THREE.Vector3();
  let off = plane.off;
  for (let pass = 0; pass < REFITS_MAX; pass++) {
    was.copy(best);
    u.set(1, 0, 0).cross(best); if (u.lengthSq() < 1e-6) u.set(0, 0, 1).cross(best); u.normalize(); v.crossVectors(best, u);
    let suu = 0, suv = 0, svv = 0, su = 0, sv = 0, sw = 0, suw = 0, svw = 0, n = 0;
    for (const p of P) {
      const w = best.dot(p) - off;
      if (Math.abs(w) >= thresh) continue;
      const pu = u.dot(p), pv = v.dot(p);
      suu += pu * pu; suv += pu * pv; svv += pv * pv; su += pu; sv += pv; sw += w; suw += pu * w; svw += pv * w; n++;
    }
    if (n < 3) break;
    // w = α u + β v + γ, by the normal equations
    const M = [[suu, suv, su], [suv, svv, sv], [su, sv, n]], rhs = [suw, svw, sw];
    const det3 = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const D = det3(M); if (Math.abs(D) < 1e-18) break;
    const col = (k: number) => M.map((row, i) => row.map((x, j) => (j === k ? rhs[i] : x)));
    const alpha = det3(col(0)) / D, beta = det3(col(1)) / D, gamma = det3(col(2)) / D;
    // the fitted plane, best·p = off + α u·p + β v·p + γ, as a unit normal and its offset
    const len = Math.hypot(1, alpha, beta);
    best.addScaledVector(u, -alpha).addScaledVector(v, -beta).divideScalar(len);
    off = (off + gamma) / len;
    if (best.angleTo(was) < SETTLED) break;
  }
  plane.off = off;
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
  /** how far the floor was from the file's (rough-flipped) up, in degrees: what the levelling corrected */
  tiltDeg: number;
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

  return { center: fit.center, quaternion, floorOffsetY: -floorY, radius: fit.radius, tiltDeg: THREE.MathUtils.radToDeg(normal.angleTo(UP)) };
}
