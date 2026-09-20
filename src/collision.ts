// Collision seam. The character controller talks ONLY to the `Collision`
// interface — it never sees how collision is represented. Today that's a fixed
// list of hand-authored furniture boxes (BoxCollision) for one curated demo
// scan. Later, an auto-generated backend (heightfield from the splat, then a
// voxel field for overhangs) can implement the same interface and drop in with
// no controller changes. See context/project-charter.md (generateCollision).

import * as THREE from 'three';

/** A climbable surface the character can grab: outward face normal, the height to
 *  mantle onto, and the flush stand position to snap to. Geometry-agnostic so a
 *  heightfield discontinuity can produce one too. */
export interface ClimbFace {
  normal: THREE.Vector3;
  topY: number;
  snap: THREE.Vector3;
}

/** The controller/collision seam. Any backend (hand-authored or generated). */
export interface Collision {
  /** Highest standable surface height under (x, z). Floor is 0. */
  groundHeightAt(x: number, z: number): number;
  /** Push `pos` out of any solid volume it's inside (and below the top of). Mutates pos.x/z. */
  resolve(pos: THREE.Vector3, radius: number): void;
  /** Nearest climbable face a character of height `charH` can grab from `pos`, or null. */
  climbableFaceAt(pos: THREE.Vector3, charH: number): ClimbFace | null;
}

/** An axis-aligned furniture box: a standable top, solid sides, optional climbable faces. */
export interface Box {
  pos: THREE.Vector3; // center
  size: THREE.Vector3; // full extents
  climbable?: boolean;
}

/** Hand-authored collision: a fixed set of AABB boxes for a curated demo scan. */
export class BoxCollision implements Collision {
  constructor(readonly boxes: Box[]) {}

  groundHeightAt(x: number, z: number): number {
    let h = 0;
    for (const b of this.boxes) {
      const top = b.pos.y + b.size.y / 2;
      if (Math.abs(x - b.pos.x) < b.size.x / 2 && Math.abs(z - b.pos.z) < b.size.z / 2 && top > h) h = top;
    }
    return h;
  }

  resolve(pos: THREE.Vector3, radius: number): void {
    for (const b of this.boxes) {
      if (pos.y >= b.pos.y + b.size.y / 2 - 0.02) continue; // on/above top → standing, not blocked
      const hx = b.size.x / 2 + radius, hz = b.size.z / 2 + radius;
      const dx = pos.x - b.pos.x, dz = pos.z - b.pos.z;
      if (Math.abs(dx) >= hx || Math.abs(dz) >= hz) continue;
      const px = hx - Math.abs(dx), pz = hz - Math.abs(dz);
      if (px < pz) pos.x = b.pos.x + Math.sign(dx || 1) * hx; // push out the shallower axis
      else pos.z = b.pos.z + Math.sign(dz || 1) * hz;
    }
  }

  climbableFaceAt(pos: THREE.Vector3, charH: number): ClimbFace | null {
    for (const b of this.boxes) {
      if (!b.climbable || pos.y >= b.pos.y + b.size.y / 2 - 0.01) continue;
      const dxo = Math.abs(pos.x - b.pos.x) - b.size.x / 2;
      const dzo = Math.abs(pos.z - b.pos.z) - b.size.z / 2;
      if (dxo >= charH * 0.9 || dzo >= charH * 0.9) continue; // not in reach of a side

      const dx = pos.x - b.pos.x, dz = pos.z - b.pos.z;
      const normal = new THREE.Vector3();
      const snap = pos.clone();
      if (dxo > dzo) { // grabbing an X-facing side
        normal.set(Math.sign(dx || 1), 0, 0);
        snap.x = b.pos.x + normal.x * (b.size.x / 2 + charH * 0.12);
        snap.z = THREE.MathUtils.clamp(pos.z, b.pos.z - b.size.z / 2 + charH * 0.2, b.pos.z + b.size.z / 2 - charH * 0.2);
      } else { // grabbing a Z-facing side
        normal.set(0, 0, Math.sign(dz || 1));
        snap.z = b.pos.z + normal.z * (b.size.z / 2 + charH * 0.12);
        snap.x = THREE.MathUtils.clamp(pos.x, b.pos.x - b.size.x / 2 + charH * 0.2, b.pos.x + b.size.x / 2 - charH * 0.2);
      }
      return { normal, topY: b.pos.y + b.size.y / 2, snap };
    }
    return null;
  }
}
