// Fills the see-through parts of the ground the figurine can stand on with approximate
// splats (context/splat-fill.md).
//
// A sparse scan has stretches of floor or tabletop with few splats or none, so the
// backdrop shows through under the figurine's feet. Where it can stand is already known:
// the walkable cells collision derives (NavGrid). So for each walkable cell, look at the
// scan's splats at that cell's height from straight above, and where they let the
// backdrop through, lay flat splats just under them, coloured from the ground around.
// Nothing is filled where the figurine cannot go.
//
// Three-free: it runs in fill-scan.worker.ts. Everything is worked out in the leveled,
// scaled world (+Y up); `m` maps the scan's own coordinates into it.

import type { ParsedScan } from './load-scan.worker';

/** The walkable cells (NavGrid.toField): one per place the figurine can stand. */
export interface Walkable {
  positions: Float32Array; // x, y, z of each cell's centre: y is where its feet go
  platformId: Int32Array;  // which connected walkable surface each cell is part of
  step: number;            // the cells' spacing
}

export interface WalkableFillOptions {
  cell: number;    // spacing of the fill splats (world units); a walkable cell is examined at this resolution
  band: number;    // the splats within this height of a walkable cell are the ones that draw its ground
  drop: number;    // how far under those splats the fill lies
  patch: number;   // fill only level ground of at least this many walkable cells...
  level: number;   // ...where neighbouring cells count as level when their heights are within this
  under: number;   // fill a spot when the scan's ground there is less opaque than this (0..1)
}

/** Splats to add to a scan, in the scan's own coordinates and in the layout `createGaussianSplatGeometry` takes. */
export interface ScanFill {
  count: number;
  centers: Float32Array;     // 3 per splat
  covariances: Float32Array; // 6 per splat: xx, xy, xz, yy, yz, zz
  colors: Uint8ClampedArray; // RGBA per splat; A is the opacity
  cells: number;             // walkable cells looked at
  seeThrough: number;        // ...of which the scan left more than half see-through
}

const SIGMA = 0.65;            // a fill splat's radius (1σ) as a share of the fill's spacing: neighbours then blend into an even sheet
const FLAT = 0.1;              // its thickness (1σ), likewise: a disc, not a ball
const SHEET_MAX = 0.95;        // the most opaque the sheet is asked to be (a splat's own opacity must stay below 1)
const SH_ZERO = 0x80808080;     // a packed word of spherical-harmonic coefficients that are all zero (byte 128 each)
const FOOTPRINT_SIGMAS = 3;    // how far out a splat is counted when working out what it covers
const MAX_FOOTPRINT = 16;      // ...in fill spacings at most, so one huge splat cannot cost a whole grid
const COVERED = 0.5;           // a walkable cell this opaque or more has its ground drawn
const LIES_FLAT = 0.3;         // a splat lies flat, and so is ground, when it is thinner than this (up and down) as a share of its width
const NOT_FLAT = 0.05;         // how much one that does not counts toward the ground's colour and height: enough to go by where nothing lies flat
const LEVEL_PASSES = 2;        // times the fill's height is evened out between neighbouring cells, so the sheet does not step

// The sheet is thinnest midway between four splats. THINNEST lists every splat's weight
// there (its Gaussian falloff at that distance), nearest first, out to where it no longer counts.
const THINNEST: number[] = [];
for (let x = -3; x < 3; x++) for (let z = -3; z < 3; z++) { const w = Math.exp(-0.5 * ((x + 0.5) ** 2 + (z + 0.5) ** 2) / (SIGMA * SIGMA)); if (w > 1e-3) THINNEST.push(w); }
/** The opacity each fill splat needs for the sheet they make together to be `sheet` opaque at its thinnest. */
function splatOpacity(sheet: number): number {
  let lo = 0, hi = 1;
  for (let i = 0; i < 20; i++) {
    const a = (lo + hi) / 2;
    let through = 1;
    for (const w of THINNEST) through *= 1 - a * w;
    if (1 - through < sheet) lo = a; else hi = a;
  }
  return hi;
}

const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function fillWalkable(
  centers: ArrayLike<number>,
  covariances: ArrayLike<number>,
  colors: ArrayLike<number>,
  count: number,
  m: ArrayLike<number>, // column-major 4×4 (three's Matrix4.elements): rotation × uniform scale, and a translation
  walk: Walkable,
  opts: WalkableFillOptions,
): ScanFill {
  const walkable = walk.platformId.length, step = walk.step;
  if (walkable === 0) return { count: 0, centers: new Float32Array(0), covariances: new Float32Array(0), colors: new Uint8ClampedArray(0), cells: 0, seeThrough: 0 };

  // 1. The walkable cells, in columns.
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < walkable; i++) {
    const x = walk.positions[i * 3], z = walk.positions[i * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const nx = Math.round((maxX - minX) / step) + 1, nz = Math.round((maxZ - minZ) / step) + 1;
  const x0 = minX - 0.5 * step, z0 = minZ - 0.5 * step; // the corner of column (0, 0)
  const head = new Int32Array(nx * nz).fill(-1); // column → its first cell, or -1
  const next: number[] = [], cx: number[] = [], cz: number[] = [], cy: number[] = [], platform: number[] = [];
  for (let i = 0; i < walkable; i++) {
    const ix = Math.round((walk.positions[i * 3] - minX) / step), iz = Math.round((walk.positions[i * 3 + 2] - minZ) / step);
    cx.push(ix); cz.push(iz); cy.push(walk.positions[i * 3 + 1]); platform.push(walk.platformId[i]);
    next.push(head[ix * nz + iz]); head[ix * nz + iz] = i;
  }
  const cells = walkable;
  /** The cell of the same surface in the column next to `e`, or -1. */
  const beside = (e: number, dx: number, dz: number) => {
    const ix = cx[e] + dx, iz = cz[e] + dz;
    if (ix < 0 || ix >= nx || iz < 0 || iz >= nz) return -1;
    for (let o = head[ix * nz + iz]; o !== -1; o = next[o]) if (platform[o] === platform[e]) return o;
    return -1;
  };

  // 2. What each cell's ground looks like from straight above, at `sub` × `sub` spots: how
  // much of the backdrop the splats at its height let through, and their colour. Each
  // splat counts as the renderer draws it, opacity × its Gaussian falloff, composited
  // with the others. Also the colour and height of the ground among them.
  const sub = Math.max(1, Math.round(step / opts.cell)), spot = step / sub, spots = sub * sub;
  const through = new Float32Array(cells * spots).fill(1);
  const R = new Float32Array(cells * spots), G = new Float32Array(cells * spots), B = new Float32Array(cells * spots), W = new Float32Array(cells * spots);
  const heightSum = new Float64Array(cells), drawn = new Float64Array(cells);
  // the world covariance of splat i along world axes a and b (rows of the matrix's linear part)
  const wcov = (i: number, a: number, b: number) => {
    const a0 = m[a], a1 = m[4 + a], a2 = m[8 + a], b0 = m[b], b1 = m[4 + b], b2 = m[8 + b], c = i * 6;
    return covariances[c] * a0 * b0 + covariances[c + 3] * a1 * b1 + covariances[c + 5] * a2 * b2
      + covariances[c + 1] * (a0 * b1 + a1 * b0) + covariances[c + 2] * (a0 * b2 + a2 * b0) + covariances[c + 4] * (a1 * b2 + a2 * b1);
  };
  const inv2 = 1 / (spot * spot), MIN_VAR = 0.05; // (spots²) keeps a splat seen edge-on from having no footprint
  // Most of a scan is nowhere near the ground (walls, ceiling, furniture), so each splat is
  // first tried against the heights of the cells its footprint could reach at all.
  const far = Math.ceil(MAX_FOOTPRINT / sub);
  const [lowest, highest] = heightsWithin(head, next, cy, nx, nz, far);
  for (let i = 0; i < count; i++) {
    const px = centers[i * 3], py = centers[i * 3 + 1], pz = centers[i * 3 + 2];
    const fx = (m[0] * px + m[4] * py + m[8] * pz + m[12] - x0) / spot, fz = (m[2] * px + m[6] * py + m[10] * pz + m[14] - z0) / spot;
    if (fx < -MAX_FOOTPRINT || fz < -MAX_FOOTPRINT || fx > nx * sub + MAX_FOOTPRINT || fz > nz * sub + MAX_FOOTPRINT) continue;
    const y = m[1] * px + m[5] * py + m[9] * pz + m[13];
    const near = Math.min(nx - 1, Math.max(0, Math.floor(fx / sub))) * nz + Math.min(nz - 1, Math.max(0, Math.floor(fz / sub)));
    if (y < lowest[near] - opts.band || y > highest[near] + opts.band) continue;
    const op = colors[i * 4 + 3] / 255;
    const vxx = wcov(i, 0, 0), vzz = wcov(i, 2, 2), vxz = wcov(i, 0, 2);
    const sxx = vxx * inv2 + MIN_VAR, szz = vzz * inv2 + MIN_VAR, sxz = vxz * inv2;
    const det = sxx * szz - sxz * sxz;
    if (!(det > 1e-9)) continue;
    const ixx = szz / det, izz = sxx / det, ixz = -sxz / det;
    let ground = -1; // how much it counts as ground: worked out once it is known to be at some cell's height
    const rx = Math.min(MAX_FOOTPRINT, Math.ceil(FOOTPRINT_SIGMAS * Math.sqrt(sxx))), rz = Math.min(MAX_FOOTPRINT, Math.ceil(FOOTPRINT_SIGMAS * Math.sqrt(szz)));
    const X0 = Math.max(0, Math.floor(fx) - rx), X1 = Math.min(nx * sub - 1, Math.floor(fx) + rx);
    const Z0 = Math.max(0, Math.floor(fz) - rz), Z1 = Math.min(nz * sub - 1, Math.floor(fz) + rz);
    const r = colors[i * 4], g = colors[i * 4 + 1], b = colors[i * 4 + 2];
    // column by column, so that nothing is worked out for a column with no cell at this splat's height
    for (let ix = Math.floor(X0 / sub); ix <= Math.floor(X1 / sub); ix++)
      for (let iz = Math.floor(Z0 / sub); iz <= Math.floor(Z1 / sub); iz++)
        for (let e = head[ix * nz + iz]; e !== -1; e = next[e]) {
          if (Math.abs(cy[e] - y) > opts.band) continue;
          // Any splat at the cell's height hides the backdrop, but only one lying flat is
          // the ground: the side of a box standing on the floor is at the floor's height
          // too, and must not lend the fill beside it its colour or lift it off the floor.
          if (ground < 0) ground = Math.sqrt(wcov(i, 1, 1)) < LIES_FLAT * Math.sqrt(Math.sqrt(Math.max(0, vxx * vzz - vxz * vxz))) ? 1 : NOT_FLAT;
          for (let X = Math.max(X0, ix * sub); X <= Math.min(X1, ix * sub + sub - 1); X++) {
            const dx = X + 0.5 - fx;
            for (let Z = Math.max(Z0, iz * sub); Z <= Math.min(Z1, iz * sub + sub - 1); Z++) {
              const dz = Z + 0.5 - fz;
              const a = op * Math.exp(-0.5 * (ixx * dx * dx + izz * dz * dz + 2 * ixz * dx * dz));
              if (a < 1e-3) continue;
              const c = e * spots + (X - ix * sub) * sub + (Z - iz * sub), w = a * ground;
              through[c] *= 1 - a;
              R[c] += w * r; G[c] += w * g; B[c] += w * b; W[c] += w;
              heightSum[e] += w * y; drawn[e] += w;
            }
          }
        }
  }

  // 3. Where to lay the fill in each cell: just under the splats that draw its ground. A
  // walkable cell's own height will not do, since collision's surface lies up to half a
  // voxel off the splats it was made from. So each cell has an offset from its height to
  // its splats', and a cell with too few splats to say takes its neighbours'.
  const offset = new Float32Array(cells), sure = new Float32Array(cells); // sure: 0..1, how much of the cell has splats to go by
  let seeThrough = 0;
  for (let e = 0; e < cells; e++) {
    sure[e] = Math.min(1, drawn[e] / spots);
    offset[e] = drawn[e] > 0 ? heightSum[e] / drawn[e] - cy[e] : 0;
    let t = 0;
    for (let k = 0; k < spots; k++) t += through[e * spots + k];
    if (t / spots > 1 - COVERED) seeThrough++;
  }
  const known = Uint8Array.from(sure, (v) => (v > 0 ? 1 : 0)), was = new Float32Array(cells);
  for (let pass = 0, waiting = true; waiting || pass < LEVEL_PASSES; ) {
    was.set(offset);
    const knew = Uint8Array.from(known);
    let spread = false;
    waiting = false;
    for (let e = 0; e < cells; e++) {
      let sum = 0, n = 0;
      for (const [dx, dz] of NEIGHBOURS) { const o = beside(e, dx, dz); if (o !== -1 && knew[o]) { sum += was[o]; n++; } }
      if (n === 0) { if (!knew[e]) waiting = true; continue; }
      offset[e] = knew[e] ? sure[e] * was[e] + (1 - sure[e]) * (sum / n) : sum / n;
      if (!knew[e]) { known[e] = 1; spread = true; }
    }
    if (!spread) { if (waiting) break; pass++; } // (a surface with no splats at all keeps its cells' own heights)
  }

  // 4. A colour for every spot: its own where it has splats, otherwise spread in from the
  // rest of its surface. Each walkable surface is laid out flat for this, so that a
  // floor's colour does not run onto the table standing on it.
  const platforms = platform.reduce((most, p) => Math.max(most, p), -1) + 1;
  const box = new Int32Array(platforms * 4); // per surface: min column x, min z, max x, max z
  for (let p = 0; p < platforms; p++) { box[p * 4] = nx; box[p * 4 + 1] = nz; box[p * 4 + 2] = -1; box[p * 4 + 3] = -1; }
  for (let e = 0; e < cells; e++) {
    const p = platform[e] * 4;
    if (cx[e] < box[p]) box[p] = cx[e]; if (cz[e] < box[p + 1]) box[p + 1] = cz[e];
    if (cx[e] > box[p + 2]) box[p + 2] = cx[e]; if (cz[e] > box[p + 3]) box[p + 3] = cz[e];
  }
  const members: number[][] = Array.from({ length: platforms }, () => []);
  for (let e = 0; e < cells; e++) members[platform[e]].push(e);
  for (let p = 0; p < platforms; p++) {
    if (!members[p].length) continue;
    const bx = box[p * 4], bz = box[p * 4 + 1], gx = (box[p * 4 + 2] - bx + 1) * sub, gz = (box[p * 4 + 3] - bz + 1) * sub;
    const r = new Float32Array(gx * gz), g = new Float32Array(gx * gz), b = new Float32Array(gx * gz), w = new Float32Array(gx * gz);
    const at = (e: number, k: number) => ((cx[e] - bx) * sub + Math.floor(k / sub)) * gz + (cz[e] - bz) * sub + (k % sub);
    for (const e of members[p])
      for (let k = 0; k < spots; k++) {
        const c = e * spots + k, q = at(e, k);
        if (W[c] > 0) { r[q] = R[c] / W[c]; g[q] = G[c] / W[c]; b[q] = B[c] / W[c]; w[q] = Math.min(1, W[c]); }
      }
    pullPush(r, g, b, w, gx, gz);
    for (const e of members[p]) for (let k = 0; k < spots; k++) { const c = e * spots + k, q = at(e, k); R[c] = r[q]; G[c] = g[q]; B[c] = b[q]; }
  }

  // 5. The sheet: a fill splat at every spot that lets the backdrop through, on level
  // ground: cells joined to at least `patch` others, each at its neighbour's height to
  // within `level`. A flat sheet is only a fair guess at flat ground; on the top of
  // something rounded (the figurine can stand on an onion) it floats beside the curve.
  const group = new Int32Array(cells).fill(-1), size: number[] = [], queue = new Int32Array(cells);
  for (let s = 0; s < cells; s++) {
    if (group[s] !== -1) continue;
    let tail = 0;
    group[s] = size.length; queue[tail++] = s;
    for (let h = 0; h < tail; h++)
      for (const [dx, dz] of NEIGHBOURS) {
        const o = beside(queue[h], dx, dz);
        if (o !== -1 && group[o] === -1 && Math.abs(cy[o] - cy[queue[h]]) <= opts.level) { group[o] = size.length; queue[tail++] = o; }
      }
    size.push(tail);
  }
  const pick: number[] = [];
  for (let e = 0; e < cells; e++) {
    if (size[group[e]] < opts.patch) continue;
    // Not in the ring of cells along the ground's edge (corners included). Collision's
    // surface is about half a voxel fatter than the splats it was made from, so such a
    // cell straddles the real edge, where the splats thin out as they should: seen
    // from here that is the same as a thin patch, and filling it leaves a row of
    // fill splats hanging off the edge.
    let edge = false;
    for (let dx = -1; dx <= 1 && !edge; dx++) for (let dz = -1; dz <= 1; dz++) { const o = beside(e, dx, dz); if (o === -1 || group[o] !== group[e]) { edge = true; break; } }
    if (edge) continue;
    for (let c = e * spots; c < (e + 1) * spots; c++) if (1 - through[c] < opts.under) pick.push(c);
  }
  const n = pick.length;
  const out: ScanFill = { count: n, centers: new Float32Array(n * 3), covariances: new Float32Array(n * 6), colors: new Uint8ClampedArray(n * 4), cells: walkable, seeThrough };
  // Back into the scan's own coordinates. The matrix's linear part is k·R, so a world
  // offset d along a world axis is (d / k²) × that axis as the scan sees it (the
  // matrix's row for it), and a world variance s along it is s / k⁴ × that row's outer
  // product with itself.
  const k2 = m[0] * m[0] + m[1] * m[1] + m[2] * m[2];
  const flat = ((SIGMA * spot) ** 2) / (k2 * k2), thin = ((FLAT * spot) ** 2) / (k2 * k2); // the disc's variances: along the ground, and through it
  const cov = (a: number, b: number) => flat * (m[a * 4] * m[b * 4] + m[a * 4 + 2] * m[b * 4 + 2]) + thin * m[a * 4 + 1] * m[b * 4 + 1];
  const shape = [cov(0, 0), cov(0, 1), cov(0, 2), cov(1, 1), cov(1, 2), cov(2, 2)];
  const alpha = 255 * splatOpacity(SHEET_MAX);
  for (let j = 0; j < n; j++) {
    const c = pick[j], e = Math.floor(c / spots), k = c % spots;
    // the sheet lies under the ground's own splats, so from above they sort in front of it and keep what detail they have
    const dx = x0 + (cx[e] * sub + Math.floor(k / sub) + 0.5) * spot - m[12], dy = cy[e] + offset[e] - opts.drop - m[13], dz = z0 + (cz[e] * sub + (k % sub) + 0.5) * spot - m[14];
    for (let a = 0; a < 3; a++) out.centers[j * 3 + a] = (m[a * 4] * dx + m[a * 4 + 1] * dy + m[a * 4 + 2] * dz) / k2;
    out.covariances.set(shape, j * 6);
    out.colors.set([R[c], G[c], B[c], alpha], j * 4);
  }
  return out;
}

/** Per column, the lowest and highest cell in any column within `reach` columns of it (±Infinity where there is none). */
function heightsWithin(head: Int32Array, next: number[], cy: number[], nx: number, nz: number, reach: number): [Float32Array, Float32Array] {
  const low = new Float32Array(nx * nz).fill(Infinity), high = new Float32Array(nx * nz).fill(-Infinity);
  for (let c = 0; c < head.length; c++) for (let e = head[c]; e !== -1; e = next[e]) { if (cy[e] < low[c]) low[c] = cy[e]; if (cy[e] > high[c]) high[c] = cy[e]; }
  // spread along z, then along x: together, the square of columns within `reach`
  for (const [n, stride, lines, line] of [[nz, 1, nx, nz], [nx, nz, nz, 1]]) {
    const l = new Float32Array(n), h = new Float32Array(n);
    for (let k = 0; k < lines; k++) {
      for (let j = 0; j < n; j++) { l[j] = low[k * line + j * stride]; h[j] = high[k * line + j * stride]; }
      for (let j = 0; j < n; j++) {
        let a = Infinity, b = -Infinity;
        for (let q = Math.max(0, j - reach); q <= Math.min(n - 1, j + reach); q++) { if (l[q] < a) a = l[q]; if (h[q] > b) b = h[q]; }
        low[k * line + j * stride] = a; high[k * line + j * stride] = b;
      }
    }
  }
  return [low, high];
}

/** `scan` with `fill`'s splats after its own, in new arrays; `scan` itself if there are none to add.
 *  They go in the same arrays as the scan's splats so that the two are depth-sorted together. */
export function appendFill(scan: ParsedScan, fill: ScanFill): ParsedScan {
  if (fill.count === 0) return scan;
  const own = scan.centers.length / 3;
  const grown = <T extends Float32Array | Uint8ClampedArray | Uint32Array>(a: T, per: number): T => {
    const out = new (a.constructor as new (n: number) => T)(a.length + fill.count * per);
    out.set(a);
    return out;
  };
  const centers = grown(scan.centers, 3), covariances = grown(scan.covariances, 6), colors = grown(scan.colors, 4);
  centers.set(fill.centers, scan.centers.length);
  covariances.set(fill.covariances, scan.covariances.length);
  colors.set(fill.colors, scan.colors.length);
  const sphericalHarmonics: Record<string, Uint32Array> = {};
  for (const [name, words] of Object.entries(scan.sphericalHarmonics))
    sphericalHarmonics[name] = grown(words, words.length / own).fill(SH_ZERO, words.length); // a fill splat's colour is the same from every side
  return { centers, covariances, colors, sphericalHarmonics };
}

/** Fill the cells that have no colour (weight 0) from those that do, smoothly: average
 *  down to ever coarser grids, then come back up, taking the coarser colour wherever a
 *  cell lacks its own. */
function pullPush(R: Float32Array, G: Float32Array, B: Float32Array, W: Float32Array, nx: number, nz: number): void {
  if (nx <= 1 && nz <= 1) return;
  const hx = Math.ceil(nx / 2), hz = Math.ceil(nz / 2);
  const r = new Float32Array(hx * hz), g = new Float32Array(hx * hz), b = new Float32Array(hx * hz), w = new Float32Array(hx * hz);
  for (let x = 0; x < nx; x++)
    for (let z = 0; z < nz; z++) {
      const c = x * nz + z, h = (x >> 1) * hz + (z >> 1), wt = W[c];
      r[h] += wt * R[c]; g[h] += wt * G[c]; b[h] += wt * B[c]; w[h] += wt;
    }
  for (let h = 0; h < w.length; h++) if (w[h] > 0) { r[h] /= w[h]; g[h] /= w[h]; b[h] /= w[h]; w[h] = Math.min(1, w[h]); }
  pullPush(r, g, b, w, hx, hz);
  // back up, reading the coarser grid between its cell centres so the fill has no blocks
  for (let x = 0; x < nx; x++) {
    const fx = Math.min(hx - 1, Math.max(0, (x + 0.5) / 2 - 0.5)), x0 = Math.floor(fx), x1 = Math.min(hx - 1, x0 + 1), tx = fx - x0;
    for (let z = 0; z < nz; z++) {
      const c = x * nz + z, own = W[c];
      if (own >= 1) continue;
      const fz = Math.min(hz - 1, Math.max(0, (z + 0.5) / 2 - 0.5)), z0 = Math.floor(fz), z1 = Math.min(hz - 1, z0 + 1), tz = fz - z0;
      const a = x0 * hz + z0, bb = x0 * hz + z1, cc = x1 * hz + z0, d = x1 * hz + z1;
      const wa = (1 - tx) * (1 - tz), wb = (1 - tx) * tz, wc = tx * (1 - tz), wd = tx * tz;
      R[c] = own * R[c] + (1 - own) * (wa * r[a] + wb * r[bb] + wc * r[cc] + wd * r[d]);
      G[c] = own * G[c] + (1 - own) * (wa * g[a] + wb * g[bb] + wc * g[cc] + wd * g[d]);
      B[c] = own * B[c] + (1 - own) * (wa * b[a] + wb * b[bb] + wc * b[cc] + wd * b[d]);
      W[c] = 1;
    }
  }
}
