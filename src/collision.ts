// Collision seam. The controller talks ONLY to the `Collision` interface — it
// never sees how collision is represented. The backend here is MeshCollision: a
// three-mesh-bvh over the voxelized splat surface (see voxelize.ts). Because it's
// a full mesh (not a heightfield) the character can walk under tables as well as
// onto them. An earlier hand-authored BoxCollision implemented the same seam.

import * as THREE from 'three';
import { MeshBVH, type ExtendedTriangle } from 'three-mesh-bvh';

/** A surface found by a forward probe: how far it is and which way it faces (the
 *  normal points back toward the probe). */
export interface WallHit {
  distance: number;
  up: number; // normal.y — near 0 ⇒ a near-vertical wall face
  nx: number; // horizontal part of the normal
  nz: number;
  front: boolean; // true = seen from outside; false = from behind / inside the solid
}

/** A decomposition of the reachable geometry into connected walkable surfaces
 *  ("platforms" — the floor, a couch seat, a counter top). One entry per sampled
 *  walkable cell; `platformId` labels which connected surface it belongs to.
 *  Cells in different platforms are reached by climbing/jumping, not walking. */
export interface PlatformField {
  positions: Float32Array; // x,y,z per surviving walkable cell
  platformId: Int32Array;  // 0..platformCount-1, which platform each cell is in
  platformCount: number;
  sampleStep: number;      // grid spacing the columns were sampled at
}

/** A queryable 2.5-D walkable-height grid derived from the platforms — the
 *  reliable ground the controller stands on. Each (ix,iz) column holds zero or
 *  more walkable heights (floor AND counter top), stored as a per-cell linked
 *  list. Interior holes within a platform are filled so a column that *should*
 *  have ground does — nothing to fall through. */
export class NavGrid {
  constructor(
    readonly nx: number, readonly nz: number,
    readonly minX: number, readonly minZ: number, readonly step: number,
    private readonly head: Int32Array,  // (ix*nz+iz) → first entry index, or -1
    private readonly nextE: Int32Array, // entry → next entry in the same column, or -1
    private readonly ey: Float32Array,  // entry height
    private readonly ep: Int32Array,    // entry platform id
    readonly platformCount: number,
  ) {}

  private cellIndex(x: number, z: number): number {
    const ix = Math.floor((x - this.minX) / this.step);
    const iz = Math.floor((z - this.minZ) / this.step);
    if (ix < 0 || ix >= this.nx || iz < 0 || iz >= this.nz) return -1;
    return ix * this.nz + iz;
  }

  /** The walkable surface at (x,z) closest to `targetY` within `band` (the max
   *  step you can walk over), or null if the platform doesn't continue here — i.e.
   *  an edge. Used to keep feet on the surface and to confine to the platform. */
  surfaceNear(x: number, z: number, targetY: number, band: number): number | null {
    const c = this.cellIndex(x, z);
    if (c < 0) return null;
    let best: number | null = null, bestD = band;
    for (let e = this.head[c]; e !== -1; e = this.nextE[e]) {
      const d = Math.abs(this.ey[e] - targetY);
      if (d <= bestD) { bestD = d; best = this.ey[e]; }
    }
    return best;
  }

  /** The highest walkable surface at (x,z) at or below `y` — a landing floor for
   *  a falling/jumping capsule, at the real platform height (not y=0). */
  surfaceBelow(x: number, z: number, y: number): number | null {
    const c = this.cellIndex(x, z);
    if (c < 0) return null;
    let best: number | null = null;
    for (let e = this.head[c]; e !== -1; e = this.nextE[e])
      if (this.ey[e] <= y && (best === null || this.ey[e] > best)) best = this.ey[e];
    return best;
  }

  /** Nearest walkable point to (x,z) with height near `targetY`, searched in
   *  expanding rings — recovery when the player has left every platform. */
  nearest(x: number, z: number, targetY: number, out: THREE.Vector3): boolean {
    const ix0 = Math.floor((x - this.minX) / this.step);
    const iz0 = Math.floor((z - this.minZ) / this.step);
    for (let r = 0; r < Math.max(this.nx, this.nz); r++) {
      let bestD = Infinity, bx = 0, by = 0, bz = 0, found = false;
      for (let dx = -r; dx <= r; dx++)
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue; // shell of the ring only
          const ix = ix0 + dx, iz = iz0 + dz;
          if (ix < 0 || ix >= this.nx || iz < 0 || iz >= this.nz) continue;
          for (let e = this.head[ix * this.nz + iz]; e !== -1; e = this.nextE[e]) {
            const d = Math.abs(this.ey[e] - targetY);
            if (d < bestD) { bestD = d; by = this.ey[e]; bx = this.minX + (ix + 0.5) * this.step; bz = this.minZ + (iz + 0.5) * this.step; found = true; }
          }
        }
      if (found) { out.set(bx, by, bz); return true; }
    }
    return false;
  }

  /** Flatten to a per-cell list for the debug overlay (includes hole-filled cells). */
  toField(): PlatformField {
    const pos: number[] = [], id: number[] = [];
    for (let ix = 0; ix < this.nx; ix++)
      for (let iz = 0; iz < this.nz; iz++)
        for (let e = this.head[ix * this.nz + iz]; e !== -1; e = this.nextE[e]) {
          pos.push(this.minX + (ix + 0.5) * this.step, this.ey[e], this.minZ + (iz + 0.5) * this.step);
          id.push(this.ep[e]);
        }
    return { positions: new Float32Array(pos), platformId: new Int32Array(id), platformCount: this.platformCount, sampleStep: this.step };
  }
}

/** The controller/collision seam. Any backend (hand-authored or generated). */
export interface Collision {
  /** Highest standable surface under (x,z), searched downward from `fromY`.
   *  Casting from just above the feet (not infinity) finds the floor *under* a
   *  table rather than the tabletop. Floor fallback is 0. */
  groundHeightAt(x: number, z: number, fromY?: number): number;
  /** Move a vertical capsule (feet at `feet`, hemisphere `radius`, straight
   *  `segLength`) by `displacement`, then depenetrate it out of the mesh. Mutates
   *  `feet` to the resolved position and writes the depenetration-only correction
   *  (post-move push-out, excluding `displacement`) into `outCorrection` — used to
   *  detect ground and to slide. The collide-and-slide core. */
  moveCapsule(feet: THREE.Vector3, radius: number, segLength: number, displacement: THREE.Vector3, outCorrection: THREE.Vector3): void;
  /** Nearest surface ahead along `dir` within `max` — its distance + facing normal, or null.
   *  The result is a reused object: read it before the next call. */
  wallAhead(origin: THREE.Vector3, dir: THREE.Vector3, max: number): WallHit | null;
  /** Find a sensible spawn near the content centre: stand on the lowest real
   *  up-facing surface with headroom (the floor in a room, the couch/table top in
   *  a floorless scan), never the phantom backstop plane, where the capsule fits.
   *  With `level`, only surfaces within `band` of that height count, and nothing is
   *  written unless such a spot is found. Writes {x,y,z} to `out`; true if it found a
   *  spot on real geometry where the capsule fits. */
  findSpawn(radius: number, segLength: number, out: THREE.Vector3, level?: number, band?: number): boolean;
  /** Build the walkable NavGrid — the reliable, hole-filled ground the controller
   *  stands on and is confined to. */
  buildNavGrid(sampleStep: number, headroom: number, stepThreshold: number, minCells: number, slopeMin?: number, minY?: number, bridge?: number, fillIters?: number): NavGrid;
}

const DOWN = new THREE.Vector3(0, -1, 0);
const UP = new THREE.Vector3(0, 1, 0);

/** three-mesh-bvh backend over a world-space collision surface mesh. */
export class MeshCollision implements Collision {
  private bvh: MeshBVH;
  private bounds: THREE.Box3;
  private planeStartTri: number;    // triangles >= this index are the backstop floor plane (last 2)
  private ray = new THREE.Ray();
  private seg = new THREE.Line3();
  private capsBox = new THREE.Box3();
  private triPoint = new THREE.Vector3();
  private capsPoint = new THREE.Vector3();
  private spawnFeet = new THREE.Vector3();
  private spawnCorr = new THREE.Vector3();
  private spawnOrigin = new THREE.Vector3();
  private zeroDisp = new THREE.Vector3();
  private capRadius = 0; // radius for the current shapecast (read by the hoisted callbacks)
  // Built once (not per moveCapsule call) to avoid closure allocation on the hot path.
  private readonly shapecastCbs = {
    intersectsBounds: (b: THREE.Box3) => b.intersectsBox(this.capsBox),
    intersectsTriangle: (tri: ExtendedTriangle) => {
      const dist = tri.closestPointToSegment(this.seg, this.triPoint, this.capsPoint);
      if (dist < this.capRadius) {
        const depth = this.capRadius - dist;
        this.capsPoint.sub(this.triPoint).normalize(); // direction from surface toward the capsule
        this.seg.start.addScaledVector(this.capsPoint, depth);
        this.seg.end.addScaledVector(this.capsPoint, depth);
      }
    },
  };

  /** `geometry` is a world-space triangle soup (no mesh transform applied).
   *  `groundOffset` lowers reported ground heights so feet seat on the visible
   *  splat surface rather than the voxel's top face (which sits ~a voxel above). */
  constructor(geometry: THREE.BufferGeometry, private groundOffset = 0) {
    if (!geometry.index) geometry.setIndex([...Array(geometry.getAttribute('position').count).keys()]);
    geometry.computeBoundingBox();
    this.bounds = geometry.boundingBox ?? new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 0, 1));
    // the voxelizer appends the backstop floor plane as the last 2 triangles;
    // `indirect` keeps the original index order so this stays true and raycast
    // faceIndices map back to it (a plain BVH reorders the index in place).
    this.planeStartTri = Math.max(0, (geometry.index?.count ?? 0) / 3 - 2);
    this.bvh = new MeshBVH(geometry, { indirect: true });
  }

  /** Distance to the first surface along `dir` (unit) from `origin`, else `max`.
   *  Used to keep the follow-camera from clipping through walls. */
  rayDistance(origin: THREE.Vector3, dir: THREE.Vector3, max: number): number {
    this.ray.origin.copy(origin);
    this.ray.direction.copy(dir);
    const hit = this.bvh.raycastFirst(this.ray, THREE.DoubleSide);
    return hit && hit.distance < max ? hit.distance : max;
  }

  /** Nearest surface straight ahead along `dir` within `max`: its distance and its
   *  normal, flipped to face back at the ray (|up| near 0 ⇒ a near-vertical wall face;
   *  nx/nz say which way that face points, so the climb can turn with the wall). null
   *  if nothing's there. Used by the climb to find and follow a wall. Returns one
   *  reused object — read it before calling again. */
  private readonly wallHit: WallHit = { distance: 0, up: 0, nx: 0, nz: 0, front: false };
  wallAhead(origin: THREE.Vector3, dir: THREE.Vector3, max: number): WallHit | null {
    this.ray.origin.copy(origin);
    this.ray.direction.copy(dir);
    const hit = this.bvh.raycastFirst(this.ray, THREE.DoubleSide);
    if (!hit || hit.distance > max) return null;
    const n = hit.face?.normal, out = this.wallHit; // reused: probes run every frame
    out.distance = hit.distance;
    if (!n) { out.up = 1; out.nx = 0; out.nz = 0; out.front = false; return out; }
    out.front = n.dot(dir) <= 0;         // the ray met the surface's outer side
    const flip = out.front ? 1 : -1;     // double-sided hit → make the normal oppose the ray
    out.up = n.y * flip; out.nx = n.x * flip; out.nz = n.z * flip;
    return out;
  }

  groundHeightAt(x: number, z: number, fromY = 1e4): number {
    this.ray.origin.set(x, fromY, z);
    this.ray.direction.copy(DOWN);
    const hit = this.bvh.raycastFirst(this.ray, THREE.DoubleSide);
    return hit ? hit.point.y - this.groundOffset : 0;
  }

  moveCapsule(feet: THREE.Vector3, radius: number, segLength: number, displacement: THREE.Vector3, outCorrection: THREE.Vector3): void {
    feet.add(displacement);
    const ax = feet.x, ay = feet.y, az = feet.z; // position after the move, before depenetration
    const seg = this.seg, box = this.capsBox;
    this.capRadius = radius;
    // capsule = segment between the two hemisphere centers (world space)
    seg.start.set(feet.x, feet.y + radius, feet.z);
    seg.end.set(feet.x, feet.y + radius + segLength, feet.z);
    box.makeEmpty();
    box.expandByPoint(seg.start);
    box.expandByPoint(seg.end);
    box.expandByScalar(radius);
    // iterative depenetration: push the capsule out of every triangle it overlaps
    this.bvh.shapecast(this.shapecastCbs);
    feet.set(seg.start.x, seg.start.y - radius, seg.start.z);
    outCorrection.set(feet.x - ax, feet.y - ay, feet.z - az);
  }

  findSpawn(radius: number, segLength: number, out: THREE.Vector3, level = NaN, band = Infinity): boolean {
    // Spiral (x,z) outward from the ORIGIN — the scan's recentered content centre
    // (splat median), which sits inside the real content — and stand on the lowest
    // real surface there.
    const b = this.bounds;
    const maxR = Math.max(Math.abs(b.min.x), b.max.x, Math.abs(b.min.z), b.max.z);
    const capH = segLength + 2 * radius;
    const step = Math.max(radius * 2, capH * 0.5);
    // Spiral outward from the centre. Prefer a clear spot on REAL reconstructed
    // geometry (a floor in a room, a couch/table top in a floorless scan) — never
    // the phantom backstop plane below the content. Fall back, in order, to: any
    // real-geometry spot (even if cramped), then a clear plane spot, then origin.
    let realFallbackY = NaN, realX = 0, realZ = 0;
    let planeFallbackY = NaN, planeX = 0, planeZ = 0;
    for (let ring = 0; ring * step <= maxR + step; ring++) {
      const r = ring * step;
      const n = ring === 0 ? 1 : Math.max(8, Math.round((2 * Math.PI * r) / step));
      for (let a = 0; a < n; a++) {
        const ang = (a / n) * Math.PI * 2;
        const x = r * Math.cos(ang), z = r * Math.sin(ang);
        const s = this.standSurface(x, z, capH, level, band); // lowest real up-facing surface with headroom (at `level`, if given)
        if (!s) continue;
        const sy = s.y, onPlane = !s.real;
        const clear = this.isClearSpawn(x, sy, z, radius, segLength, capH);
        if (!onPlane) {
          if (clear) { out.set(x, sy, z); return true; }   // ideal: clear spot on real geometry
          if (Number.isNaN(realFallbackY)) { realFallbackY = sy; realX = x; realZ = z; }
        } else if (clear && Number.isNaN(planeFallbackY)) { planeFallbackY = sy; planeX = x; planeZ = z; }
      }
    }
    if (!Number.isNaN(level)) return false;                                        // nowhere at that level: the caller decides
    if (!Number.isNaN(realFallbackY)) out.set(realX, realFallbackY, realZ);       // on the content, cramped
    else if (!Number.isNaN(planeFallbackY)) out.set(planeX, planeFallbackY, planeZ); // only the backstop was clear
    else out.set(0, 0, 0);                                                        // nothing — origin
    return false;
  }

  /** The lowest REAL up-facing surface at (x,z) with `needAbove` headroom (a floor,
   *  a couch seat, a table top…), or the backstop plane as a last resort, or null.
   *  With `level`, only surfaces within `band` of it. Casts a ray down through the
   *  whole scene and inspects every crossing. */
  private standSurface(x: number, z: number, needAbove: number, level = NaN, band = Infinity): { y: number; real: boolean } | null {
    this.ray.origin.set(x, this.bounds.max.y + 1, z);
    this.ray.direction.copy(DOWN);
    const hits = this.bvh.raycast(this.ray, THREE.DoubleSide);
    if (!hits.length) return null;
    hits.sort((h1, h2) => h1.point.y - h2.point.y); // ascending: lowest first
    let plane: { y: number; real: boolean } | null = null;
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      if ((h.face?.normal.y ?? 1) <= 0.4) continue; // not walkable (ceiling / underside / steep)
      let above = Infinity; // nearest crossing above this one → headroom
      for (let j = 0; j < hits.length; j++) { const yj = hits[j].point.y; if (yj > h.point.y + 0.02 && yj < above) above = yj; }
      if (above - h.point.y < needAbove) continue; // no room to stand
      const y = h.point.y - this.groundOffset;
      if (Math.abs(y - level) > band) continue; // not at the height asked for (never true without a level: NaN)
      if ((h.faceIndex ?? 0) < this.planeStartTri) return { y, real: true }; // lowest real walkable — done
      if (!plane) plane = { y, real: false }; // backstop plane, kept as a fallback
    }
    return plane;
  }

  /** True if a capsule at (x,z) standing at world height `y` has `need` clear space
   *  above it — used to tell a real floor-gap (empty above, fill it) from a wall
   *  footprint (solid above, don't fill it) when closing platform holes. */
  private hasHeadroom(x: number, z: number, y: number, need: number): boolean {
    this.ray.origin.set(x, y + this.groundOffset + 0.02, z);
    this.ray.direction.copy(UP);
    const hit = this.bvh.raycastFirst(this.ray, THREE.DoubleSide);
    return !hit || hit.distance >= need;
  }

  /** Decompose the reachable geometry into connected walkable platforms and index
   *  them into a queryable, hole-filled NavGrid — the reliable ground.
   *  Sample a grid of downward columns; at each, every up-facing surface (not the
   *  backstop plane, not a ceiling/underside) with `headroom` clearance above is a
   *  walkable cell — a column can yield several (floor AND counter top). Cells in
   *  neighboring columns whose heights differ by at most `stepThreshold` are one
   *  platform (a gentle slope/step you walk); bigger gaps are separate platforms (a
   *  climb). Platforms under `minCells` cells are dropped as floater noise, then
   *  interior holes within each surviving platform are filled (`fillIters` cells)
   *  so there is nothing to fall through. */
  buildNavGrid(sampleStep: number, headroom: number, stepThreshold: number, minCells: number, slopeMin = 0.4, minY = -Infinity, bridge = 2, fillIters = 3): NavGrid {
    const b = this.bounds;
    const nx = Math.max(1, Math.ceil((b.max.x - b.min.x) / sampleStep));
    const nz = Math.max(1, Math.ceil((b.max.z - b.min.z) / sampleStep));
    const SLOPE_MIN = slopeMin; // up-face normal.y at/below this is too steep to stand → a climbable wall
    // walkable cells in parallel arrays; per column a singly-linked list
    // (head in `colHead`, next in `cnext`) threads its cells for neighbor lookup.
    const cy: number[] = [], cix: number[] = [], ciz: number[] = [], cnext: number[] = [];
    const colHead = new Int32Array(nx * nz).fill(-1);
    for (let ix = 0; ix < nx; ix++)
      for (let iz = 0; iz < nz; iz++) {
        const x = b.min.x + (ix + 0.5) * sampleStep, z = b.min.z + (iz + 0.5) * sampleStep;
        this.ray.origin.set(x, b.max.y + 1, z);
        this.ray.direction.copy(DOWN);
        const hits = this.bvh.raycast(this.ray, THREE.DoubleSide);
        if (!hits.length) continue;
        hits.sort((h1, h2) => h1.point.y - h2.point.y);
        for (let i = 0; i < hits.length; i++) {
          const h = hits[i];
          if ((h.face?.normal.y ?? 1) <= SLOPE_MIN) continue;          // not up-facing
          if ((h.faceIndex ?? 0) >= this.planeStartTri) continue;      // backstop plane, not real ground
          let above = Infinity;
          for (let j = 0; j < hits.length; j++) { const yj = hits[j].point.y; if (yj > h.point.y + 0.02 && yj < above) above = yj; }
          if (above - h.point.y < headroom) continue;                  // no room to stand
          const y = h.point.y - this.groundOffset;
          if (y < minY) continue;                                      // below the leveled floor → sub-floor floater, not walkable
          const id = cy.length;
          cy.push(y); cix.push(ix); ciz.push(iz);
          cnext.push(colHead[ix * nz + iz]); colHead[ix * nz + iz] = id;
        }
      }
    // union same-height cells within a `bridge`-cell window into platforms: small
    // sampling gaps (mesh holes, occluders) would otherwise split one continuous
    // floor into many, so we bridge across them.
    const n = cy.length;
    const parent = new Int32Array(n);
    for (let i = 0; i < n; i++) parent[i] = i;
    const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    for (let i = 0; i < n; i++) {
      const ix = cix[i], iz = ciz[i], y = cy[i];
      for (let dx = -bridge; dx <= bridge; dx++)
        for (let dz = -bridge; dz <= bridge; dz++) {
          if (dx === 0 && dz === 0) continue;
          const jx = ix + dx, jz = iz + dz;
          if (jx < 0 || jx >= nx || jz < 0 || jz >= nz) continue;
          for (let j = colHead[jx * nz + jz]; j !== -1; j = cnext[j])
            if (Math.abs(cy[j] - y) <= stepThreshold) { const ra = find(i), rb = find(j); if (ra !== rb) parent[ra] = rb; }
        }
    }
    // drop tiny (floater) components, renumber survivors to 0..platformCount-1
    const size = new Map<number, number>();
    for (let i = 0; i < n; i++) { const r = find(i); size.set(r, (size.get(r) ?? 0) + 1); }
    const remap = new Map<number, number>();
    let platformCount = 0;
    for (const [root, sz] of size) if (sz >= minCells) remap.set(root, platformCount++);

    // index surviving cells into the NavGrid (grow-able entry lists)
    const head = new Int32Array(nx * nz).fill(-1);
    const nextE: number[] = [], ey: number[] = [], ep: number[] = [];
    const addEntry = (c: number, y: number, p: number) => { const e = ey.length; ey.push(y); ep.push(p); nextE.push(head[c]); head[c] = e; };
    for (let i = 0; i < n; i++) {
      const pid = remap.get(find(i));
      if (pid === undefined) continue;
      addEntry(cix[i] * nz + ciz[i], cy[i], pid);
    }
    // fill interior holes per platform: close its footprint mask, and for each newly
    // enclosed cell add an entry at the height of its nearest platform neighbor —
    // but only where a capsule actually fits (skips wall footprints, so walls stay solid).
    const clear = (ix: number, iz: number, y: number) =>
      this.hasHeadroom(b.min.x + (ix + 0.5) * sampleStep, b.min.z + (iz + 0.5) * sampleStep, y, headroom);
    fillPlatformHoles(nx, nz, platformCount, head, nextE, ey, ep, addEntry, fillIters, clear);

    return new NavGrid(nx, nz, b.min.x, b.min.z, sampleStep,
      head, Int32Array.from(nextE), Float32Array.from(ey), Int32Array.from(ep), platformCount);
  }

  /** True if a capsule standing on (x,y,z) has headroom and isn't inside a
   *  wall/furniture (depenetration doesn't shove it sideways or off the surface). */
  private isClearSpawn(x: number, y: number, z: number, radius: number, segLength: number, capH: number): boolean {
    this.spawnOrigin.set(x, y + radius * 0.5, z);
    if (this.rayDistance(this.spawnOrigin, UP, capH) < capH * 0.9) return false; // low overhead
    this.spawnFeet.set(x, y, z);
    this.zeroDisp.set(0, 0, 0);
    this.moveCapsule(this.spawnFeet, radius, segLength, this.zeroDisp, this.spawnCorr);
    const horiz = Math.hypot(this.spawnCorr.x, this.spawnCorr.z);
    return horiz < radius * 0.4 && Math.abs(this.spawnFeet.y - y) < radius * 0.8; // not in a wall, stayed put
  }
}

/** Fill interior holes in each platform's footprint so its NavGrid coverage is
 *  continuous (nothing to fall through). For a platform, close its 2-D occupancy
 *  mask (dilate then erode — fills gaps up to `iters` cells without growing the
 *  outer boundary), and give each newly enclosed cell an entry at the height of
 *  its nearest real platform cell. */
function fillPlatformHoles(
  nx: number, nz: number, platformCount: number,
  head: Int32Array, nextE: number[], ey: number[], ep: number[],
  addEntry: (c: number, y: number, p: number) => void, iters: number,
  clear: (ix: number, iz: number, y: number) => boolean,
): void {
  if (iters <= 0) return;
  // Each platform is worked on inside its own bounds (with room for the dilation), not
  // over the whole grid: there are a hundred or so platforms, most of them small, and on
  // a fine grid the whole grid a hundred times over is seconds on the main thread.
  const x0 = new Int32Array(platformCount).fill(nx), z0 = new Int32Array(platformCount).fill(nz), x1 = new Int32Array(platformCount).fill(-1), z1 = new Int32Array(platformCount).fill(-1);
  for (let ix = 0; ix < nx; ix++)
    for (let iz = 0; iz < nz; iz++)
      for (let e = head[ix * nz + iz]; e !== -1; e = nextE[e]) {
        const p = ep[e];
        if (ix < x0[p]) x0[p] = ix; if (ix > x1[p]) x1[p] = ix; if (iz < z0[p]) z0[p] = iz; if (iz > z1[p]) z1[p] = iz;
      }
  const pad = iters + 1;
  for (let p = 0; p < platformCount; p++) {
    if (x1[p] < 0) continue;
    const ox = Math.max(0, x0[p] - pad), oz = Math.max(0, z0[p] - pad); // the corner of this platform's window on the grid
    const wx = Math.min(nx - 1, x1[p] + pad) - ox + 1, wz = Math.min(nz - 1, z1[p] + pad) - oz + 1;
    const mask = new Uint8Array(wx * wz);
    const h = new Float32Array(wx * wz); // a representative height per cell of this platform
    for (let ix = 0; ix < wx; ix++)
      for (let iz = 0; iz < wz; iz++)
        for (let e = head[(ix + ox) * nz + iz + oz]; e !== -1; e = nextE[e])
          if (ep[e] === p) { mask[ix * wz + iz] = 1; h[ix * wz + iz] = ey[e]; break; }
    let cur: Uint8Array = mask;
    for (let k = 0; k < iters; k++) cur = morph2D(cur, wx, wz, true);  // dilate
    for (let k = 0; k < iters; k++) cur = morph2D(cur, wx, wz, false); // erode → net: fill holes
    for (let ix = 0; ix < wx; ix++)
      for (let iz = 0; iz < wz; iz++) {
        const c = ix * wz + iz;
        if (!cur[c] || mask[c]) continue; // only the newly enclosed cells
        let hy = NaN; // nearest original-mask height, searched in rings
        for (let r = 1; r <= iters + 1 && Number.isNaN(hy); r++)
          for (let dx = -r; dx <= r && Number.isNaN(hy); dx++)
            for (let dz = -r; dz <= r; dz++) {
              if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
              const jx = ix + dx, jz = iz + dz;
              if (jx < 0 || jx >= wx || jz < 0 || jz >= wz) continue;
              if (mask[jx * wz + jz]) { hy = h[jx * wz + jz]; break; }
            }
        if (!Number.isNaN(hy) && clear(ix + ox, iz + oz, hy)) addEntry((ix + ox) * nz + iz + oz, hy, p); // skip cells blocked by a wall
      }
  }
}

/** One pass of binary dilation (any 8-neighbor set) or erosion (all set); the grid
 *  edge counts as empty. */
function morph2D(src: Uint8Array, nx: number, nz: number, dilate: boolean): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let ix = 0; ix < nx; ix++)
    for (let iz = 0; iz < nz; iz++) {
      let any = false, all = true;
      for (let dx = -1; dx <= 1; dx++)
        for (let dz = -1; dz <= 1; dz++) {
          const jx = ix + dx, jz = iz + dz;
          const v = jx < 0 || jx >= nx || jz < 0 || jz >= nz ? 0 : src[jx * nz + jz];
          if (v) any = true; else all = false;
        }
      out[ix * nz + iz] = (dilate ? any : all) ? 1 : 0;
    }
  return out;
}
