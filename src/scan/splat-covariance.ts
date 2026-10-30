// A splat's shape in world space, and its inverse: the one place this is worked out, for the
// voxelizer (collision/voxelize-core.ts), the gap fill (fill-scan-core.ts) and what the camera
// sees past the splats (splat-sight.ts). Each adds its own floor to the result: what a splat
// seen edge-on should still count for differs between them. Plain arrays only: it runs in
// workers too.

/** Splat `i`'s covariance (6 a splat: xx, xy, xz, yy, yz, zz) in the space `m` takes it to,
 *  A Σ Aᵀ with A the linear part of `m` (a column-major 4×4's elements, as THREE.Matrix4
 *  keeps them), written to `out` in the same order. */
export function worldCovariance(cov: ArrayLike<number>, i: number, m: ArrayLike<number>, out: Float64Array): Float64Array {
  const a = cov[i * 6], b = cov[i * 6 + 1], c = cov[i * 6 + 2], d = cov[i * 6 + 3], e = cov[i * 6 + 4], f = cov[i * 6 + 5];
  const L0 = m[0], L1 = m[4], L2 = m[8], L3 = m[1], L4 = m[5], L5 = m[9], L6 = m[2], L7 = m[6], L8 = m[10]; // A's rows
  // each entry is rowᵀ · Σ · row' for the symmetric Σ [a,b,c; b,d,e; c,e,f]
  out[0] = a * L0 * L0 + d * L1 * L1 + f * L2 * L2 + 2 * (b * L0 * L1 + c * L0 * L2 + e * L1 * L2);
  out[3] = a * L3 * L3 + d * L4 * L4 + f * L5 * L5 + 2 * (b * L3 * L4 + c * L3 * L5 + e * L4 * L5);
  out[5] = a * L6 * L6 + d * L7 * L7 + f * L8 * L8 + 2 * (b * L6 * L7 + c * L6 * L8 + e * L7 * L8);
  out[1] = a * L0 * L3 + d * L1 * L4 + f * L2 * L5 + b * (L0 * L4 + L1 * L3) + c * (L0 * L5 + L2 * L3) + e * (L1 * L5 + L2 * L4);
  out[2] = a * L0 * L6 + d * L1 * L7 + f * L2 * L8 + b * (L0 * L7 + L1 * L6) + c * (L0 * L8 + L2 * L6) + e * (L1 * L8 + L2 * L7);
  out[4] = a * L3 * L6 + d * L4 * L7 + f * L5 * L8 + b * (L3 * L7 + L4 * L6) + c * (L3 * L8 + L5 * L6) + e * (L4 * L8 + L5 * L7);
  return out;
}

/** The inverse of the symmetric 3×3 `w` (xx, xy, xz, yy, yz, zz) into `out`, same order.
 *  Returns the determinant: where it is not above 0, `out` means nothing. */
export function invertSymmetric(w: ArrayLike<number>, out: Float64Array): number {
  const xx = w[0], xy = w[1], xz = w[2], yy = w[3], yz = w[4], zz = w[5];
  const c00 = yy * zz - yz * yz, c01 = xz * yz - xy * zz, c02 = xy * yz - xz * yy;
  const det = xx * c00 + xy * c01 + xz * c02;
  const id = 1 / det;
  out[0] = c00 * id; out[1] = c01 * id; out[2] = c02 * id;
  out[3] = (xx * zz - xz * xz) * id; out[4] = (xy * xz - xx * yz) * id; out[5] = (xx * yy - xy * xy) * id;
  return det;
}
