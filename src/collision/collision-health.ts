// How sound a room's collision is as ground for a game, in numbers (context/collision.md).
// Measured by scripts/collisioncheck.mjs through window.__collisionHealth, which exists
// only under ?tel=1: this module is loaded on demand and is never part of normal play.
//
// Three-free. Distances and areas are in `unit`s (the grain collision's settings are
// counted in: GRAIN in main.ts), not in cells of whatever grid is in use, so the numbers
// compare across scans and across grid sizes.

export interface HealthInput {
  walk: { positions: Float32Array; platformId: Int32Array; platformCount: number; sampleStep: number }; // NavGrid.toField()
  mesh: { positions: ArrayLike<number>; index: ArrayLike<number> }; // the collision mesh, in the world; its last two triangles are the backstop plane
  splats: { centers: ArrayLike<number>; opacity: ArrayLike<number>; count: number; matrix: ArrayLike<number> }; // the scan's own splats, and their transform into the world
  spawn: [number, number, number]; // where the figurine starts
  unit: number; // the length (and its square, the area) the numbers are given in
  realCells: number; // a platform of at least this many cells is somewhere to be, not a scrap
  move: { jumpVel: number; gravity: number; runSpeed: number; climbOver: number }; // how the figurine moves, in world units: take-off speed, gravity (positive), speed in the air, and how far over a lip a climb steps
  /** Is there a face the figurine could climb from standing at (ax, ay, az) up to the surface at (bx, by, bz)? Asked of the collision mesh itself. */
  climbable: (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => boolean;
  /** Does a straight line from (ox, oy, oz) along the unit direction (dx, dy, dz) meet the collision mesh (backstop plane included)? */
  blocked: (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number) => boolean;
  eyeHeight: number; // how far above a walkable cell to look out from
  /** Would a climb start for a figurine standing at (x, y, z) and walking in the level unit direction (dx, dz)? The game's own test. */
  climbStarts: (x: number, y: number, z: number, dx: number, dz: number) => boolean;
}

export interface CollisionHealth {
  // --- where the figurine can stand
  cells: number;          // walkable area, in units² (cells, when the grid's cell is a unit)
  platforms: number;      // separate walkable surfaces
  realPlatforms: number;  // ...of at least `realCells` cells
  scrapShare: number;     // share of walkable cells on smaller ones. Small perches, nearly all high up on furniture: a description of the room, not a fault to drive down
  spawnShare: number;     // share of walkable cells on the surface the figurine starts on, reachable by walking alone (higher is better)
  jumpShare: number;      // ...reachable by walking, jumping and dropping (higher is better)
  reachShare: number;     // ...and by climbing, where the mesh has a face to climb (higher is better)
  reachBound: number;     // ...and by climbing wherever two surfaces meet, seen from above, face or no face: the most a better mesh could give
  islands: number;        // real platforms that even that does not get to: no change to the mesh's faces will join them
  climbSpots: number;     // walkable area (units²) from which a climb can be started, walking one of eight ways: how much there is to climb, as the game sees it (higher is more)
  // --- the shape of that surface
  holeShare: number;      // enclosed holes in it, as a share of its area with them filled (lower is better)
  edgeShare: number;      // share of its cells that are on an edge: raggedness (lower is better)
  solidity: number;       // its area as a share of the convex outline round it: 1 is a floor with no bays or missing stretches. Compare only between surfaces of the same extent: one that grows into a less regular shape scores lower
  roughness: number;      // mean slope between its neighbouring cells (rise over run): 0 is flat (lower is better)
  // --- the mesh
  triangles: number;      // without the backstop plane
  pieces: number;         // connected pieces of mesh
  smallPieces: number;    // ...of fewer than SMALL_PIECE triangles: floating bits
  looseShare: number;     // share of triangles in those (lower is better)
  bumpiness: number;      // how far the mesh is from flat within each unit-sized box, by area: 0 is flat everywhere, and real corners and curves count too, so compare a scan with itself (lower is smoother)
  // --- how well the mesh fits the scan
  offMedian: number;      // from the mesh to the nearest opaque splat, in units: median...
  offP90: number;         // ...and 90th percentile (lower is tighter)
  missedShare: number;    // share of opaque splats with no mesh within MISSED voxels: scan with no collision (lower is better)
  // --- how closed the room is
  openShare: number;      // share of sight lines, from places the figurine can stand, that meet no collision at all: gaps in walls and ceiling. Compare a scan with itself: an open-sided scan has many, and what matters is that a change opens no more (lower is better)
}

const OPAQUE = 0.15;        // splats fainter than this are not surface (as in the voxelizer's bounds)
const MISSED = 2;           // units
const SMALL_PIECE = 100;    // triangles: about a fist-sized blob at one voxel per triangle edge
const REACH = 3;            // how far, in units, a nearest neighbour is looked for: further counts as this far
const MESH_SAMPLES = 20000, SPLAT_SAMPLES = 50000;
const LOOKOUT_SPACING = 6, DIRECTIONS = 400;
const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function collisionHealth(input: HealthInput): CollisionHealth {
  return { ...standing(input), ...reach(input), ...climbing(input), ...meshPieces(input), ...fit(input), ...openness(input) };
}

/** The surface the figurine starts on: that of the cell nearest its feet (-1 if there are no cells). */
function startPlatform({ walk, spawn }: HealthInput): number {
  let start = -1, nearest = Infinity;
  for (let i = 0; i < walk.platformId.length; i++) {
    const d = (walk.positions[i * 3] - spawn[0]) ** 2 + (walk.positions[i * 3 + 1] - spawn[1]) ** 2 + (walk.positions[i * 3 + 2] - spawn[2]) ** 2;
    if (d < nearest) { nearest = d; start = walk.platformId[i]; }
  }
  return start;
}

function standing(input: HealthInput): Pick<CollisionHealth, 'cells' | 'platforms' | 'realPlatforms' | 'scrapShare' | 'spawnShare' | 'holeShare' | 'edgeShare' | 'solidity' | 'roughness'> {
  const { walk, realCells, unit } = input;
  const cells = walk.platformId.length, size = new Int32Array(walk.platformCount), area = cells * (walk.sampleStep / unit) ** 2;
  for (let i = 0; i < cells; i++) size[walk.platformId[i]]++;
  let real = 0, scrap = 0;
  for (const s of size) { if (s >= realCells) real++; else scrap += s; }
  const start = startPlatform(input);
  if (start < 0) return { cells: area, platforms: walk.platformCount, realPlatforms: real, scrapShare: 0, spawnShare: 0, holeShare: 0, edgeShare: 0, solidity: 0, roughness: 0 };
  // that surface as a grid of columns, with a border of empty ones round it
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < cells; i++) {
    if (walk.platformId[i] !== start) continue;
    const x = walk.positions[i * 3], z = walk.positions[i * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const step = walk.sampleStep, nx = Math.round((maxX - minX) / step) + 3, nz = Math.round((maxZ - minZ) / step) + 3;
  const has = new Uint8Array(nx * nz), height = new Float32Array(nx * nz);
  for (let i = 0; i < cells; i++) {
    if (walk.platformId[i] !== start) continue;
    const c = (Math.round((walk.positions[i * 3] - minX) / step) + 1) * nz + Math.round((walk.positions[i * 3 + 2] - minZ) / step) + 1;
    has[c] = 1; height[c] = walk.positions[i * 3 + 1];
  }
  // what is outside it: every empty column joined to the border. Empty columns that are not are holes.
  const outside = new Uint8Array(nx * nz), queue = new Int32Array(nx * nz);
  let tail = 0;
  outside[0] = 1; queue[tail++] = 0;
  for (let h = 0; h < tail; h++) {
    const x = Math.floor(queue[h] / nz), z = queue[h] % nz;
    for (const [dx, dz] of NEIGHBOURS) {
      const X = x + dx, Z = z + dz, c = X * nz + Z;
      if (X < 0 || X >= nx || Z < 0 || Z >= nz || has[c] || outside[c]) continue;
      outside[c] = 1; queue[tail++] = c;
    }
  }
  let own = 0, holes = 0, steps = 0, stepSum = 0;
  const rim: [number, number][] = []; // its edge cells, which are what a convex outline is drawn round
  for (let x = 0; x < nx; x++)
    for (let z = 0; z < nz; z++) {
      const c = x * nz + z;
      if (!has[c]) { if (!outside[c]) holes++; continue; }
      own++;
      if (NEIGHBOURS.some(([dx, dz]) => !has[(x + dx) * nz + z + dz])) rim.push([x, z]); // (the border keeps these in range)
      for (const o of [c + nz, c + 1]) if (has[o]) { steps++; stepSum += Math.abs(height[o] - height[c]); } // each pair of neighbours once
    }
  return {
    cells: area, platforms: walk.platformCount, realPlatforms: real, scrapShare: scrap / cells, spawnShare: size[start] / cells,
    holeShare: holes / (own + holes), edgeShare: rim.length / own, solidity: Math.min(1, own / hullArea(rim)),
    roughness: steps ? stepSum / steps / step : 0,
  };
}

/** How much of what is walkable the figurine can get to from where it starts.
 *
 *  A model of its movement, not the controller itself. From any cell it can reach a cell
 *  of another surface by jumping or dropping, if that cell is no higher than a jump rises
 *  and no further off than it travels at a run in the time the jump (or the fall) takes.
 *  That is measured against the game: a jump rises 0.24 and carries about 1.3 at a run
 *  (Playroom), against 0.26 and 1.29 by this arithmetic. Walls in the way of a jump are
 *  not considered. For climbing, a higher surface is reached from a cell within a climb's
 *  step over a lip of it, seen from above, if `climbable` finds a face between the two
 *  in the mesh (`reachShare`). Without that last test the same search gives the most
 *  that better faces could reach (`reachBound`), and what even that leaves out is out of
 *  reach for certain (`islands`). */
function reach(input: HealthInput): Pick<CollisionHealth, 'jumpShare' | 'reachShare' | 'reachBound' | 'islands'> {
  const { walk, move, realCells, climbable, unit } = input, cells = walk.platformId.length, start = startPlatform(input);
  if (start < 0) return { jumpShare: 0, reachShare: 0, reachBound: 0, islands: 0 };
  const step = walk.sampleStep, P = walk.positions;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity, minY = Infinity;
  for (let i = 0; i < cells; i++) {
    if (P[i * 3] < minX) minX = P[i * 3]; if (P[i * 3] > maxX) maxX = P[i * 3];
    if (P[i * 3 + 2] < minZ) minZ = P[i * 3 + 2]; if (P[i * 3 + 2] > maxZ) maxZ = P[i * 3 + 2];
    if (P[i * 3 + 1] < minY) minY = P[i * 3 + 1];
  }
  const nx = Math.round((maxX - minX) / step) + 1, nz = Math.round((maxZ - minZ) / step) + 1;
  const col = (i: number) => Math.round((P[i * 3] - minX) / step) * nz + Math.round((P[i * 3 + 2] - minZ) / step);
  const head = new Int32Array(nx * nz).fill(-1), next = new Int32Array(cells), members: number[][] = Array.from({ length: walk.platformCount }, () => []);
  for (let i = 0; i < cells; i++) { const c = col(i); next[i] = head[c]; head[c] = i; members[walk.platformId[i]].push(i); }
  const rise = (move.jumpVel * move.jumpVel) / (2 * move.gravity);
  /** How far a jump carries by the time it is `dy` above where it left (below, if negative). */
  const carry = (dy: number) => move.runSpeed * (move.jumpVel + Math.sqrt(Math.max(0, move.jumpVel * move.jumpVel - 2 * move.gravity * dy))) / move.gravity;

  const spread = (climbing: 'no' | 'faces' | 'anywhere'): Uint8Array => {
    const reached = new Uint8Array(walk.platformCount), queue = [start];
    reached[start] = 1;
    for (let h = 0; h < queue.length; h++)
      for (const a of members[queue[h]]) {
        const ya = P[a * 3 + 1], far = Math.max(carry(minY - ya), move.climbOver + unit), span = Math.ceil(far / step);
        const ax = Math.round((P[a * 3] - minX) / step), az = Math.round((P[a * 3 + 2] - minZ) / step);
        for (let x = Math.max(0, ax - span); x <= Math.min(nx - 1, ax + span); x++)
          for (let z = Math.max(0, az - span); z <= Math.min(nz - 1, az + span); z++)
            for (let b = head[x * nz + z]; b !== -1; b = next[b]) {
              const p = walk.platformId[b];
              if (reached[p]) continue;
              const dy = P[b * 3 + 1] - ya, away = Math.hypot(P[b * 3] - P[a * 3], P[b * 3 + 2] - P[a * 3 + 2]);
              const jump = dy <= rise && away <= carry(dy);
              const climb = !jump && climbing !== 'no' && dy > 0 && away <= move.climbOver + unit
                && (climbing === 'anywhere' || climbable(P[a * 3], ya, P[a * 3 + 2], P[b * 3], P[b * 3 + 1], P[b * 3 + 2]));
              if (jump || climb) { reached[p] = 1; queue.push(p); }
            }
      }
    return reached;
  };
  const share = (reached: Uint8Array) => { let n = 0; for (let i = 0; i < cells; i++) n += reached[walk.platformId[i]]; return n / cells; };
  const anywhere = spread('anywhere');
  let islands = 0;
  for (let p = 0; p < walk.platformCount; p++) if (!anywhere[p] && members[p].length >= realCells) islands++;
  return { jumpShare: share(spread('no')), reachShare: share(spread('faces')), reachBound: share(anywhere), islands };
}

/** The area of the convex outline round cells (each a unit square centred on its x, z). */
function hullArea(cells: [number, number][]): number {
  // every cell's four corners, then Andrew's monotone chain
  const pts = cells.flatMap(([x, z]) => [[x - 0.5, z - 0.5], [x + 0.5, z - 0.5], [x - 0.5, z + 0.5], [x + 0.5, z + 0.5]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const turn = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (from: number[][]) => { const h: number[][] = []; for (const p of from) { while (h.length >= 2 && turn(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop(); h.push(p); } h.pop(); return h; };
  const hull = [...half(pts), ...half(pts.reverse())];
  let twice = 0;
  for (let i = 0; i < hull.length; i++) { const a = hull[i], b = hull[(i + 1) % hull.length]; twice += a[0] * b[1] - a[1] * b[0]; }
  return Math.abs(twice) / 2;
}

function climbing({ walk, climbStarts, unit }: HealthInput): Pick<CollisionHealth, 'climbSpots'> {
  let spots = 0;
  for (let i = 0; i < walk.platformId.length; i++) {
    const x = walk.positions[i * 3], y = walk.positions[i * 3 + 1], z = walk.positions[i * 3 + 2];
    for (let k = 0; k < 8; k++) if (climbStarts(x, y, z, Math.cos((k * Math.PI) / 4), Math.sin((k * Math.PI) / 4))) { spots++; break; }
  }
  return { climbSpots: spots * (walk.sampleStep / unit) ** 2 };
}

/** How much of what can be seen from where the figurine stands is not collision at all.
 *  Lines of sight go out from cells of the surface it starts on, LOOKOUT_SPACING units
 *  apart, in DIRECTIONS directions spread evenly over the sphere (in opposite pairs). */
function openness(input: HealthInput): Pick<CollisionHealth, 'openShare'> {
  const { walk, blocked, eyeHeight } = input, start = startPlatform(input);
  const own: number[] = [];
  for (let i = 0; i < walk.platformId.length; i++) if (walk.platformId[i] === start) own.push(i);
  if (!own.length) return { openShare: 0 };
  const dirs: number[] = [];
  for (let k = 0; k < DIRECTIONS / 2; k++) { // a Fibonacci spiral over half the sphere, and each direction's opposite
    const y = (k + 0.5) / (DIRECTIONS / 2), r = Math.sqrt(1 - y * y), a = k * Math.PI * (3 - Math.sqrt(5));
    dirs.push(r * Math.cos(a), y, r * Math.sin(a), -r * Math.cos(a), -y, -r * Math.sin(a));
  }
  let lines = 0, open = 0;
  // Lookouts are the cells nearest the points of a lattice fixed in the world, not every
  // so-manyth cell: so two builds of the same room are looked out of from the same places,
  // and differ only in what is seen. (Taken every so-manyth cell, the same solid meshed
  // two ways read 2 points apart, and a larger floor 5.)
  const every = LOOKOUT_SPACING * input.unit, at = (v: number) => Math.abs(v / every - Math.round(v / every)) * every < walk.sampleStep / 2;
  for (const cell of own) {
    const i = cell * 3;
    if (!at(walk.positions[i]) || !at(walk.positions[i + 2])) continue;
    for (let d = 0; d < dirs.length; d += 3) { lines++; if (!blocked(walk.positions[i], walk.positions[i + 1] + eyeHeight, walk.positions[i + 2], dirs[d], dirs[d + 1], dirs[d + 2])) open++; }
  }
  return { openShare: lines ? open / lines : 0 };
}

function meshPieces({ mesh, unit }: HealthInput): Pick<CollisionHealth, 'triangles' | 'pieces' | 'smallPieces' | 'looseShare' | 'bumpiness'> {
  const triangles = mesh.index.length / 3 - 2, vertices = mesh.positions.length / 3;
  // triangles sharing a vertex are one piece (union-find over the vertices)
  const parent = new Int32Array(vertices).map((_, i) => i);
  const find = (v: number) => { while (parent[v] !== v) v = parent[v] = parent[parent[v]]; return v; };
  for (let t = 0; t < triangles; t++) {
    const a = find(mesh.index[t * 3]);
    for (let k = 1; k < 3; k++) { const b = find(mesh.index[t * 3 + k]); if (b !== a) parent[b] = a; }
  }
  const inPiece = new Map<number, number>();
  for (let t = 0; t < triangles; t++) { const p = find(mesh.index[t * 3]); inPiece.set(p, (inPiece.get(p) ?? 0) + 1); }
  let small = 0, loose = 0;
  for (const n of inPiece.values()) if (n < SMALL_PIECE) { small++; loose += n; }
  // Bumpiness: how far the mesh is from flat within each unit-sized box of space. Per box,
  // the triangles' normals (by area, either way round) are summed as an orientation
  // tensor; the share of it NOT along its main direction is 0 for a flat patch, whichever
  // way it faces and however many triangles draw it. It is measured per box of a fixed
  // size, not per vertex: per vertex, a finer mesh reads smoother only for being finer
  // (Marishka at mesh detail 2 read 0.070 against 0.112 and was plainly rougher).
  const P = mesh.positions, boxes = new Map<string, Float64Array>(); // per box: xx, xy, xz, yy, yz, zz, area
  for (let t = 0; t < triangles; t++) {
    const a = mesh.index[t * 3] * 3, b = mesh.index[t * 3 + 1] * 3, c = mesh.index[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, twice = Math.hypot(nx, ny, nz);
    if (!(twice > 0)) continue;
    const key = `${Math.floor((P[a] + P[b] + P[c]) / 3 / unit)},${Math.floor((P[a + 1] + P[b + 1] + P[c + 1]) / 3 / unit)},${Math.floor((P[a + 2] + P[b + 2] + P[c + 2]) / 3 / unit)}`;
    let m = boxes.get(key);
    if (!m) boxes.set(key, m = new Float64Array(7));
    const w = 1 / twice; // (n nᵀ of the unit normal, times the area: n nᵀ / |n|, halved all round)
    m[0] += nx * nx * w; m[1] += nx * ny * w; m[2] += nx * nz * w; m[3] += ny * ny * w; m[4] += ny * nz * w; m[5] += nz * nz * w; m[6] += twice;
  }
  let bumps = 0, area = 0;
  for (const m of boxes.values()) {
    bumps += m[6] - largestEigenvalue(m); area += m[6]; // (the tensor's trace is the box's area, in the same units as its eigenvalues)
  }
  return { triangles, pieces: inPiece.size, smallPieces: small, looseShare: triangles ? loose / triangles : 0, bumpiness: area ? bumps / area : 0 };
}

/** The largest eigenvalue of the symmetric 3 × 3 matrix [m0 m1 m2; m1 m3 m4; m2 m4 m5], in
 *  closed form (the trigonometric solution of its characteristic cubic). Exact whichever way
 *  its main direction lies: a search from a fixed starting direction finds nothing along a
 *  direction square to that start. */
function largestEigenvalue(m: Float64Array): number {
  const off = m[1] * m[1] + m[2] * m[2] + m[4] * m[4], q = (m[0] + m[3] + m[5]) / 3;
  const p2 = (m[0] - q) ** 2 + (m[3] - q) ** 2 + (m[5] - q) ** 2 + 2 * off;
  if (!(p2 > 0)) return q; // a multiple of the identity: every direction alike
  const p = Math.sqrt(p2 / 6), a = (m[0] - q) / p, b = m[1] / p, c = m[2] / p, d = (m[3] - q) / p, e = m[4] / p, f = (m[5] - q) / p;
  const half = (a * (d * f - e * e) - b * (b * f - e * c) + c * (b * e - d * c)) / 2; // det of (m − qI) / p, halved
  return q + 2 * p * Math.cos(Math.acos(Math.max(-1, Math.min(1, half))) / 3);
}

function fit({ mesh, splats, unit: voxel }: HealthInput): Pick<CollisionHealth, 'offMedian' | 'offP90' | 'missedShare'> {
  const m = splats.matrix, triangles = mesh.index.length / 3 - 2;
  // the opaque splats' centres in the world, and the mesh's vertices, each in a grid of voxel-sized boxes
  const centres: number[] = [];
  for (let i = 0; i < splats.count; i++) {
    if (splats.opacity[i] < OPAQUE) continue;
    const x = splats.centers[i * 3], y = splats.centers[i * 3 + 1], z = splats.centers[i * 3 + 2];
    centres.push(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);
  }
  const used = new Uint8Array(mesh.positions.length / 3), vertices: number[] = [];
  for (let k = 0; k < triangles * 3; k++) used[mesh.index[k]] = 1; // not the backstop plane's
  for (let v = 0; v < used.length; v++) if (used[v]) vertices.push(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]);
  const toSplat = nearestIn(centres, voxel), toMesh = nearestIn(vertices, voxel);

  const off: number[] = [];
  for (let t = 0, stride = Math.max(1, Math.floor(triangles / MESH_SAMPLES)); t < triangles; t += stride) {
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < 3; k++) { const v = mesh.index[t * 3 + k] * 3; x += mesh.positions[v] / 3; y += mesh.positions[v + 1] / 3; z += mesh.positions[v + 2] / 3; }
    off.push(toSplat(x, y, z));
  }
  off.sort((a, b) => a - b);
  let missed = 0, sampled = 0;
  for (let i = 0, n = centres.length / 3, stride = Math.max(1, Math.floor(n / SPLAT_SAMPLES)); i < n; i += stride) {
    sampled++;
    if (toMesh(centres[i * 3], centres[i * 3 + 1], centres[i * 3 + 2]) > MISSED) missed++;
  }
  return { offMedian: off[off.length >> 1] ?? 0, offP90: off[Math.floor(off.length * 0.9)] ?? 0, missedShare: sampled ? missed / sampled : 0 };
}

/** A lookup of the distance, in voxels, from a point to the nearest of `points` (x, y, z each), up to REACH. */
function nearestIn(points: number[], voxel: number): (x: number, y: number, z: number) => number {
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const boxes = new Map<string, number[]>();
  for (let i = 0; i < points.length; i += 3) {
    const k = key(Math.floor(points[i] / voxel), Math.floor(points[i + 1] / voxel), Math.floor(points[i + 2] / voxel));
    const box = boxes.get(k);
    if (box) box.push(i); else boxes.set(k, [i]);
  }
  return (x, y, z) => {
    const bx = Math.floor(x / voxel), by = Math.floor(y / voxel), bz = Math.floor(z / voxel);
    let best = (REACH * voxel) ** 2;
    for (let dx = -REACH; dx <= REACH; dx++)
      for (let dy = -REACH; dy <= REACH; dy++)
        for (let dz = -REACH; dz <= REACH; dz++) {
          const box = boxes.get(key(bx + dx, by + dy, bz + dz));
          if (!box) continue;
          for (const i of box) { const d = (points[i] - x) ** 2 + (points[i + 1] - y) ** 2 + (points[i + 2] - z) ** 2; if (d < best) best = d; }
        }
    return Math.sqrt(best) / voxel;
  };
}
