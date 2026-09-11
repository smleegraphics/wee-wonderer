// Auto-level a Gaussian-splat scan: find the floor plane (largest near-horizontal
// surface, via RANSAC — robust to floaters/furniture/stairs), align its normal to
// +Y, and drop the floor to y=0. General: no per-scan constants. Used by the app
// at load and by the room inspector.

import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);

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
function ransacFloorNormal(P: THREE.Vector3[], r: number, maxTiltDeg = 35): THREE.Vector3 {
  const thresh = r * 0.012;
  const minCos = Math.cos(THREE.MathUtils.degToRad(maxTiltDeg));
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), nrm = new THREE.Vector3();
  let best = new THREE.Vector3(0, 1, 0), bestInliers = -1;
  const step = Math.max(1, Math.floor(P.length / 8000));
  for (let iter = 0; iter < 500; iter++) {
    const a = P[(Math.random() * P.length) | 0], b = P[(Math.random() * P.length) | 0], c = P[(Math.random() * P.length) | 0];
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

  const normal = ransacFloorNormal(S, fit.radius);
  const fix = new THREE.Quaternion().setFromUnitVectors(normal, UP);
  const quaternion = fix.clone().multiply(rough);

  const ys = S.map((p) => p.clone().applyQuaternion(fix).y).sort((a, b) => a - b);
  const floorY = ys[Math.floor(ys.length * 0.06)]; // low percentile = floor height

  return { center: fit.center, quaternion, floorOffsetY: -floorY, radius: fit.radius };
}
