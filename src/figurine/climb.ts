// Climbing: starting a climb, moving on the wall, topping out and stepping off, under
// the rules in context/climb.md.

import * as THREE from 'three';
import type { WallHit } from '../collision/collision';
import { CAPSULE_RADIUS, figurine, move, player, TEL, TUNE, velocity, WORLD_DOWN } from '../app';
import { collision, grabSlopeMax, navGrid } from '../collision/room-collision';
import { camLatch } from './camera';
import { CHARACTER, charH, pauseMove, play } from './character';
import { bodyOverlap, lastGood, lerpAngle, WALL_LIFT, wallFeet } from './controller';
import { launchSpeed, MOVE } from './movement';

// Automatic: walking into a wall enters climb. The figurine ascends the face,
// following it up; when the wall ends it tops out — onto a surface if there's one
// to stand on, otherwise it clings at the top until you jump (Space) off.
export const climbDir = new THREE.Vector3();   // horizontal direction into the wall we're on
const climbTry = new THREE.Vector3();   // scratch: a candidate direction, until a climb actually starts
const climbProbe = new THREE.Vector3(); // scratch for the forward wall raycast
const climbSide = new THREE.Vector3();  // scratch: sideways direction along the wall
const climbFrom = new THREE.Vector3();  // scratch: where the body was before a move that might not fit
let climbAtEdge = false;                // sideways shuffle is stopped at the wall's edge (telemetry de-dupe)
export let climbCling = false;                 // topped out with nowhere to stand → hanging
let climbBlocked = false;               // the body is being pushed out of something (telemetry de-dupe)

/** Climb geometry. Heights and reaches are fractions of the figurine's height; `gap`
 *  and `mantleOver` are in capsule radii. */
export const CLIMB = {
  chest: 0.5,       // a wall must be there at chest height...
  head: 0.9,        // ...and at head height to be worth scaling (not a low bump)
  grip: 0.15,       // on the wall, the face is followed just above the feet
  lipGrip: -0.1,    // clinging at the top, the feet are past it: grip just below them
  startReach: 0.5,  // how far ahead of the body a wall starts a climb
  followReach: 0.4, // how far off the face may be while following it
  lipReach: 0.6,    // how far past a ledge's edge to look back for its face...
  lipProbe: 0.3,    // ...and how far below the lip
  hang: 0.2,        // feet this far below the lip after grabbing it
  gap: 1.1,         // body centre held this many radii off the face (just clear of it)
  mantleOver: 2,    // a mantle steps this many radii over the lip...
  mantleNear: 0.4,  // ...onto a surface within this of the feet...
  mantleUp: 0.3,    // ...and no more than this above them
  landTol: 0.1,     // descending: step off once the feet are this close to the ground
  skin: 0.05,       // radii: the body resting this far into a surface is touching it, not inside it
};

/** Is this a face to climb? Steeper than the grab cutoff (grabSlopeMax): the one test of it. */
export function isWall(w: WallHit): boolean {
  return Math.abs(w.up) <= grabSlopeMax();
}

/** A surface the climber can be on: the nearest one along `dir`, seen from its OUTER
 *  side. A surface met from behind means the probe began inside something solid (a
 *  jump can sink into the top of an object with no walkable surface on it) — that is
 *  the inside of a wall, not a wall to hang on, and nothing beyond it counts either.
 *  The result is reused by the next probe: read it first. */
export function climbWall(origin: THREE.Vector3, dir: THREE.Vector3, max: number): WallHit | null {
  const w = collision ? collision.wallAhead(origin, dir, max) : null;
  return w && w.front ? w : null;
}

/** The walkable ground a climber on a wall in direction (dx,dz), feet at `y`, would
 *  come down onto: under it, or — since the cell hard against a wall's foot often
 *  isn't walkable — back from the wall, up to `reach` (one cell by default: a climber on
 *  the face is over its foot). null = the wall hangs over nothing we can stand on. */
const climbGroundAt = new THREE.Vector3();
export function climbGround(y: number, dx: number, dz: number, reach = navGrid?.step ?? 0): THREE.Vector3 | null {
  if (!navGrid) return null;
  const p = player.position, step = navGrid.step / 2;
  for (let back = 0; back <= reach + 1e-6; back += step) {
    const x = p.x - dx * back, z = p.z - dz * back;
    const g = navGrid.surfaceBelow(x, z, y);
    if (g !== null) return climbGroundAt.set(x, g, z);
  }
  return null;
}

/** Is there a wall to start climbing, standing at (x, feetY, z) and facing `dir` (unit,
 *  level)? The one test of that: tryStartClimb acts on it, and the collision health check
 *  counts the places it passes. Leaves the nearer hit's distance and slope in climbStart. */
const climbStart = { dist: 0, up: 0, why: '' }; // why: what was missing when the test failed (for the CLIMB-NO log)
export function climbStartsHere(x: number, feetY: number, z: number, dir: THREE.Vector3): boolean {
  const reach = (CAPSULE_RADIUS + CLIMB.startReach) * charH;
  // Require a wall at chest AND head — proves it's tall enough to scale (not a low
  // bump), and that the climb won't top out the instant it starts.
  climbStart.dist = Infinity;
  for (let i = 0; i < 2; i++) {
    const w = climbWall(climbProbe.set(x, feetY + charH * (i ? CLIMB.head : CLIMB.chest), z), dir, reach);
    if (!w || !isWall(w)) { climbStart.why = `${i ? 'head' : 'chest'}: ${w ? `too shallow (up=${w.up.toFixed(2)})` : 'nothing within reach'}`; return false; }
    if (w.distance < climbStart.dist) { climbStart.dist = w.distance; climbStart.up = w.up; }
  }
  return true;
}

/** True if a wall is right in front (in the `dx,dz` direction); if so, enter the climb
 *  at `feetY` — the ground we're standing on, or wherever the feet are when a jump
 *  carries us into the wall. */
export function tryStartClimb(dx: number, dz: number, feetY = figurine.supportY): boolean {
  if (!collision || !CHARACTER.climbs) return false;
  climbTry.set(dx, 0, dz);
  if (climbTry.lengthSq() < 1e-9) return false;
  climbTry.normalize();
  const p = player.position;
  if (!climbStartsHere(p.x, feetY, p.z, climbTry)) { if (TEL) console.log(`CLIMB-NO (mid-air) y=${feetY.toFixed(2)} ${climbStart.why}`); return false; }
  const { dist, up } = climbStart;
  const midAir = figurine.state === 'air';
  climbDir.copy(climbTry);
  climbCling = false;
  figurine.state = 'climb';
  velocity.set(0, 0, 0);
  player.rotation.y = Math.atan2(climbDir.x, climbDir.z); // face the wall
  play('climb', 0.1);
  camLatch.handsOff = true;
  if (TEL) console.log(`CLIMB-START${midAir ? ' (mid-air)' : ''} y=${p.y.toFixed(2)} dist=${dist.toFixed(2)} up=${up.toFixed(2)}`);
  return true;
}

/** Jump off the wall: launch up and away from the face, as a jump from the ground rises. */
export function climbJumpOff(): void {
  const away = MOVE.walkSpeed * charH;
  velocity.set(-climbDir.x * away, launchSpeed(MOVE.jumpHeight) * charH, -climbDir.z * away);
  figurine.state = 'air'; climbCling = false;
  play('rise', 0.08);
}

/** Leave the climb standing at (x,y,z) on walkable ground. */
function climbStandAt(x: number, y: number, z: number): void {
  const p = player.position;
  p.set(x, y, z);
  figurine.supportY = y; lastGood.copy(p);
  figurine.state = 'ground'; velocity.set(0, 0, 0);
}

/** Top out of a climb onto a surface just over the lip, if there is one to stand on. */
function tryMantle(): boolean {
  const p = player.position, over = CAPSULE_RADIUS * charH * CLIMB.mantleOver;
  const overX = p.x + climbDir.x * over, overZ = p.z + climbDir.z * over;
  const g = navGrid ? navGrid.surfaceNear(overX, overZ, p.y, charH * CLIMB.mantleNear) : null; // only a surface near the top
  if (g === null || g > p.y + charH * CLIMB.mantleUp) return false;
  climbStandAt(overX, g, overZ);
  if (TEL) console.log(`CLIMB-MANTLE to=${g.toFixed(2)}`);
  return true;
}


/** Free movement on the wall: W/S = up/down, A/D = the figurine's own left/right along
 *  the face (wall-relative, not camera-relative), diagonals combine. The figurine turns
 *  with the wall as it curves, stops at the wall's side edges, and carries on around an
 *  inside corner onto the adjoining wall. Returns true on the frame the climb ends
 *  standing on the ground (a mantle, or stepping off at the wall's foot). */
export function climbUpdate(dt: number): boolean {
  if (!collision) return false;
  const p = player.position, radius = CAPSULE_RADIUS * charH, gap = radius * CLIMB.gap;
  const followReach = radius + charH * CLIMB.followReach;
  // keep facing the wall (eased, so following a curve / turning a corner isn't a snap)
  player.rotation.y = lerpAngle(player.rotation.y, Math.atan2(climbDir.x, climbDir.z), TUNE.turnLerp * dt);

  let v = move.f - move.b;                     // W = up, S = down
  let h = move.r - move.l;                     // D = figurine's right, A = its left
  if (climbCling && v > 0) {                   // topped out: can't go higher, but W takes any ledge that's there
    if (tryMantle()) return true;
    v = 0;
  }
  pauseMove('climb', v === 0 && h === 0);       // the clip plays only while moving on the wall
  if (v === 0 && h === 0) return false;        // resting / clinging — Space jumps off
  if (v !== 0 && h !== 0) { v *= Math.SQRT1_2; h *= Math.SQRT1_2; } // diagonals aren't faster
  if (v < 0) climbCling = false;               // heading down releases a topped-out cling
  const step = TUNE.climbSpeed * charH * dt;
  // The face is followed just above the feet (so going UP tops out only when the feet
  // reach the top, and going DOWN keeps tracking it). Clinging at the top, the feet
  // are already past that, so grip just below them — on the lip — instead.
  const probeUp = charH * (climbCling ? CLIMB.lipGrip : CLIMB.grip);

  // --- sideways: along the wall tangent (the figurine's right = climbDir × up) ---
  if (h !== 0) {
    const sgn = Math.sign(h);
    climbSide.set(-climbDir.z * sgn, 0, climbDir.x * sgn);
    const hStep = Math.abs(h) * step;
    climbProbe.set(p.x, p.y + probeUp, p.z);
    const beside = climbWall(climbProbe, climbSide, gap + hStep);
    if (beside) {
      // something in the way sideways. A wall = an inside corner → carry on around it
      // onto that wall; anything else just stops the shuffle.
      const hn = Math.hypot(beside.nx, beside.nz);
      if (isWall(beside) && hn > 1e-6) {
        if (TEL) console.log(`CLIMB-CORNER y=${p.y.toFixed(2)} dist=${beside.distance.toFixed(2)}`);
        climbDir.set(-beside.nx / hn, 0, -beside.nz / hn);
      }
    } else {
      // only shuffle while the SAME face continues there: a hit that jumps by more than
      // a body radius is some other surface beyond the wall's edge, not this wall.
      const nx = p.x + climbSide.x * hStep, nz = p.z + climbSide.z * hStep;
      const w = climbWall(climbProbe.set(nx, p.y + probeUp, nz), climbDir, followReach);
      if (w && Math.abs(w.distance - gap) <= radius) { p.x = nx; p.z = nz; climbAtEdge = false; }
      else {
        if (!climbAtEdge && TEL) console.log(`CLIMB-EDGE y=${p.y.toFixed(2)} ${w ? `jump=${(w.distance - gap).toFixed(2)}` : 'no-wall'}`);
        climbAtEdge = true; // the wall ends here → stop (no wrapping around outside corners)
      }
    }
  }

  // --- vertical ---
  const prevY = p.y;
  p.y += v * step;
  if (v < 0) {
    // Descending onto the ground → step off it, back to walking. Only ground the feet
    // come DOWN onto counts: a surface above them (the ledge we're hanging from, just
    // over the lip) is not somewhere a descent lands.
    const at = climbGround(prevY, climbDir.x, climbDir.z);
    if (at && p.y <= at.y + charH * CLIMB.landTol) {
      climbStandAt(at.x, at.y, at.z);
      return true;
    }
    // A descent needs a bottom. Solid beneath the feet is one, walkable or not. And
    // where the face hangs over nothing we could come down onto (a gap in the walkable
    // area), there is nowhere for a descent to arrive — so it doesn't go.
    const solid = climbWall(climbProbe.set(p.x, prevY + radius, p.z), WORLD_DOWN, radius + step);
    if (solid) p.y = Math.max(p.y, prevY + radius - solid.distance);
    else if (!at) p.y = prevY;
  }

  // --- stay on the face: hold the gap to it and turn with it ---
  let wall = climbWall(climbProbe.set(p.x, p.y + charH * CLIMB.grip, p.z), climbDir, followReach);
  if (wall) climbCling = false;                // wall above the feet again (the lip rose) → not topped out
  else if (climbCling) wall = climbWall(climbProbe.set(p.x, p.y + probeUp, p.z), climbDir, followReach);
  if (wall) {
    climbFrom.copy(p);
    p.addScaledVector(climbDir, wall.distance - gap);
    // steer into the face along its normal, so a curved / angled wall is followed
    // around. Eased: scan surfaces are lumpy, and per-triangle normals jitter.
    const hn = Math.hypot(wall.nx, wall.nz);
    if (isWall(wall) && hn > 1e-6) {
      const t = Math.min(1, TUNE.climbTurn * dt);
      climbDir.x += (-wall.nx / hn - climbDir.x) * t;
      climbDir.z += (-wall.nz / hn - climbDir.z) * t;
      climbDir.normalize();
    }
  } else if (v > 0) {
    // no wall at this height. Going up → topped out: mantle onto a surface, else cling.
    if (tryMantle()) return true;
    climbCling = true; // nothing up there → cling at the top
    if (TEL) console.log(`CLIMB-CLING y=${p.y.toFixed(2)}`);
  }

  // --- the whole body has to fit, not just the grip ---
  // The face is followed at one point near the feet, so the rest of the body can be
  // carried into whatever is beside or above it. A step is about a quarter of a radius
  // at the longest frame, so `fitClimbBody` can push it back out. The snap to the face
  // can go further: where the face is further back near the feet than higher up (a
  // recess, or under an overhanging lip), it carries the body up to `followReach`
  // forward into the part that sticks out. Such a snap is not made this frame; the
  // sideways and vertical moves stand, and the gap closes once the body is clear.
  if (!fitClimbBody(radius) && wall) { p.copy(climbFrom); fitClimbBody(radius); }
  return false;
}

/** Make a climber's body fit after a move, feet at the player's position. An overlap up
 *  to a radius is pushed out, with the same collide-and-slide walking uses, in all three
 *  axes here: an object in the way pushes straight back, so the move makes no headway;
 *  a lump of the wall itself pushes outward, and the climber rides over it. Returns
 *  false, moving nothing, when the body is deeper than a radius: "which way is out" no
 *  longer has a single answer, and a push can eject it through the far side of a thin
 *  shell. The caller then undoes the move or refuses it, so no move leaves the body that
 *  deep (context/climb.md, rule 12). */
function fitClimbBody(radius: number): boolean {
  const p = player.position, sunk = bodyOverlap(p.x, p.y, p.z, radius);
  if (sunk > radius) return false;
  const pushed = sunk > radius * CLIMB.skin;
  if (pushed) {
    if (TEL && !climbBlocked) console.log(`CLIMB-PUSHED y=${p.y.toFixed(2)} by=${(sunk / radius).toFixed(2)}r`);
    p.set(wallFeet.x, wallFeet.y - charH * WALL_LIFT, wallFeet.z);
  }
  climbBlocked = pushed;
  return true;
}
