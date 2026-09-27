// Collision seam. The controller talks ONLY to the `Collision` interface — it
// never sees how collision is represented. The backend here is MeshCollision: a
// three-mesh-bvh over the voxelized splat surface (see voxelize.ts). Because it's
// a full mesh (not a heightfield) the character can walk under tables as well as
// onto them. An earlier hand-authored BoxCollision implemented the same seam.

import * as THREE from 'three';
import { MeshBVH, type ExtendedTriangle } from 'three-mesh-bvh';

/** A climbable surface: outward face normal (points back at the character), the
 *  height to mantle onto, and the flush stand position to snap to. */
export interface ClimbFace {
  normal: THREE.Vector3;
  topY: number;
  snap: THREE.Vector3;
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
  /** Nearest climbable vertical face along `forward`, or null. */
  climbableFaceAt(pos: THREE.Vector3, charH: number, forward: THREE.Vector3): ClimbFace | null;
  /** Find a sensible spawn near the content centre: stand on the lowest real
   *  up-facing surface with headroom (the floor in a room, the couch/table top in
   *  a floorless scan), never the phantom backstop plane. Writes {x,y,z} to `out`. */
  findSpawn(radius: number, segLength: number, out: THREE.Vector3): void;
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

  climbableFaceAt(pos: THREE.Vector3, charH: number, forward: THREE.Vector3): ClimbFace | null {
    this.ray.origin.set(pos.x, pos.y + charH * 0.4, pos.z);
    this.ray.direction.set(forward.x, 0, forward.z).normalize();
    if (this.ray.direction.lengthSq() < 1e-6) return null;
    const hit = this.bvh.raycastFirst(this.ray, THREE.DoubleSide);
    if (!hit || hit.distance > charH * 0.6) return null;
    const nrm = hit.face?.normal;
    if (!nrm || Math.abs(nrm.y) > 0.4) return null; // not a vertical-ish face

    const d = this.ray.direction;
    // stand-on height just past the wall; cast down from well above
    const topY = this.groundHeightAt(pos.x + d.x * (hit.distance + charH * 0.3), pos.z + d.z * (hit.distance + charH * 0.3), pos.y + charH * 3);
    if (topY <= pos.y + charH * 0.15) return null; // nothing higher to mantle onto

    const back = Math.max(0, hit.distance - charH * 0.12);
    return {
      normal: new THREE.Vector3(-d.x, 0, -d.z).normalize(),
      topY,
      snap: new THREE.Vector3(pos.x + d.x * back, pos.y, pos.z + d.z * back),
    };
  }

  findSpawn(radius: number, segLength: number, out: THREE.Vector3): void {
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
        const s = this.standSurface(x, z, capH); // lowest real up-facing surface with headroom
        if (!s) continue;
        const sy = s.y, onPlane = !s.real;
        const clear = this.isClearSpawn(x, sy, z, radius, segLength, capH);
        if (!onPlane) {
          if (clear) { out.set(x, sy, z); return; }   // ideal: clear spot on real geometry
          if (Number.isNaN(realFallbackY)) { realFallbackY = sy; realX = x; realZ = z; }
        } else if (clear && Number.isNaN(planeFallbackY)) { planeFallbackY = sy; planeX = x; planeZ = z; }
      }
    }
    if (!Number.isNaN(realFallbackY)) out.set(realX, realFallbackY, realZ);       // on the content, cramped
    else if (!Number.isNaN(planeFallbackY)) out.set(planeX, planeFallbackY, planeZ); // only the backstop was clear
    else out.set(0, 0, 0);                                                        // nothing — origin
  }

  /** The lowest REAL up-facing surface at (x,z) with `needAbove` headroom (a floor,
   *  a couch seat, a table top…), or the backstop plane as a last resort, or null.
   *  Casts a ray down through the whole scene and inspects every crossing. */
  private standSurface(x: number, z: number, needAbove: number): { y: number; real: boolean } | null {
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
      if ((h.faceIndex ?? 0) < this.planeStartTri) return { y, real: true }; // lowest real walkable — done
      if (!plane) plane = { y, real: false }; // backstop plane, kept as a fallback
    }
    return plane;
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
