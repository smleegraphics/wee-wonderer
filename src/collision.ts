// Collision seam. The controller talks ONLY to the `Collision` interface — it
// never sees how collision is represented. The backend here is MeshCollision: a
// three-mesh-bvh over the voxelized splat surface (see voxelize.ts). Because it's
// a full mesh (not a heightfield) the character can walk under tables as well as
// onto them. An earlier hand-authored BoxCollision implemented the same seam.

import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

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
  /** Push `pos` horizontally out of nearby walls/solids (capsule approximation). Mutates x/z. */
  resolve(pos: THREE.Vector3, radius: number): void;
  /** Nearest climbable vertical face along `forward`, or null. */
  climbableFaceAt(pos: THREE.Vector3, charH: number, forward: THREE.Vector3): ClimbFace | null;
}

const DOWN = new THREE.Vector3(0, -1, 0);

/** three-mesh-bvh backend over a world-space collision surface mesh. */
export class MeshCollision implements Collision {
  private bvh: MeshBVH;
  private ray = new THREE.Ray();
  private probe = new THREE.Vector3();
  private near: { point: THREE.Vector3; distance: number; faceIndex: number } = {
    point: new THREE.Vector3(), distance: 0, faceIndex: 0,
  };

  /** `geometry` is a world-space triangle soup (no mesh transform applied).
   *  `groundOffset` lowers reported ground heights so feet seat on the visible
   *  splat surface rather than the voxel's top face (which sits ~a voxel above). */
  constructor(geometry: THREE.BufferGeometry, private groundOffset = 0) {
    if (!geometry.index) geometry.setIndex([...Array(geometry.getAttribute('position').count).keys()]);
    this.bvh = new MeshBVH(geometry);
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

  resolve(pos: THREE.Vector3, radius: number): void {
    // sample a few heights up the body; push out of the nearest surface at each.
    for (const h of [1, 3, 5]) {
      this.probe.set(pos.x, pos.y + radius * h, pos.z);
      const res = this.bvh.closestPointToPoint(this.probe, this.near, 0, radius);
      if (!res) continue;
      const dx = this.probe.x - res.point.x, dz = this.probe.z - res.point.z;
      const len = Math.hypot(dx, dz);
      if (len < 1e-6) continue; // purely vertical (floor/ceiling) — not a wall
      const push = radius - res.distance;
      pos.x += (dx / len) * push;
      pos.z += (dz / len) * push;
    }
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
}
