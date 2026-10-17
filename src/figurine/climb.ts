// Climbing: starting a climb, moving on the wall, topping out and stepping off, under
// the rules in context/climb.md.

import * as THREE from 'three';
import type { WallHit } from '../collision/collision';
import { CAPSULE_RADIUS, figurine, move, player, TEL, TUNE, velocity, WORLD_DOWN } from '../app';
import { collision, navGrid, wallSlopeMax } from '../collision/room-collision';
import { camLatch } from './camera';
import { actions, charH, play } from './character';
import { bodyOverlap, lastGood, lerpAngle, STEP_DOWN_MAX, WALL_LIFT, wallFeet } from './controller';

// Automatic: walking into a wall enters climb. The figurine ascends the face,
// following it up; when the wall ends it tops out — onto a surface if there's one
// to stand on, otherwise it clings at the top until you jump (Space) off.
export const climbDir = new THREE.Vector3();   // horizontal direction into the wall we're on
const climbTry = new THREE.Vector3();   // scratch: a candidate direction, until a climb actually starts
const climbProbe = new THREE.Vector3(); // scratch for the forward wall raycast
const climbSide = new THREE.Vector3();  // scratch: sideways direction along the wall
const climbFrom = new THREE.Vector3();  // scratch: where the body was before a move that might not fit
let climbAwaitRelease = false;          // grabbed a lip mid-walk: the still-held walk keys mean "keep going down" until let go
let climbV = 0, climbH = 0;             // this frame's climb input after latches: up/down, right/left
/** Every frame starts with no climb input: climbUpdate sets it, and the animation blend reads it in every state. */
export function resetClimbInput(): void { climbV = climbH = 0; }
let climbSideMix = 0;                   // animation blend: -1 = shimmy left, 0 = up/down climb, +1 = shimmy right
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

export function isWall(w: WallHit): boolean {
  return Math.abs(w.up) <= wallSlopeMax();
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
 *  isn't walkable — a step back from the wall. null = the wall hangs over nothing we
 *  can stand on. */
const climbGroundAt = new THREE.Vector3();
export function climbGround(y: number, dx: number, dz: number): THREE.Vector3 | null {
  if (!navGrid) return null;
  const p = player.position;
  for (let i = 0; i < 2; i++) {
    const back = i * navGrid.step, x = p.x - dx * back, z = p.z - dz * back;
    const g = navGrid.surfaceBelow(x, z, y);
    if (g !== null) return climbGroundAt.set(x, g, z);
  }
  return null;
}

/** Is there a wall to start climbing, standing at (x, feetY, z) and facing `dir` (unit,
 *  level)? The one test of that: tryStartClimb acts on it, and the collision health check
 *  counts the places it passes. Leaves the nearer hit's distance and slope in climbStart. */
const climbStart = { dist: 0, up: 0 };
export function climbStartsHere(x: number, feetY: number, z: number, dir: THREE.Vector3): boolean {
  const reach = (CAPSULE_RADIUS + CLIMB.startReach) * charH;
  // Require a wall at chest AND head — proves it's tall enough to scale (not a low
  // bump), and that the climb won't top out the instant it starts.
  climbStart.dist = Infinity;
  for (let i = 0; i < 2; i++) {
    const w = climbWall(climbProbe.set(x, feetY + charH * (i ? CLIMB.head : CLIMB.chest), z), dir, reach);
    if (!w || !isWall(w)) return false;
    if (w.distance < climbStart.dist) { climbStart.dist = w.distance; climbStart.up = w.up; }
  }
  return true;
}

/** True if a wall is right in front (in the `dx,dz` direction); if so, enter the climb
 *  at `feetY` — the ground we're standing on, or wherever the feet are when a jump
 *  carries us into the wall. */
export function tryStartClimb(dx: number, dz: number, feetY = figurine.supportY): boolean {
  if (!collision || !actions['climb']) return false;
  climbTry.set(dx, 0, dz);
  if (climbTry.lengthSq() < 1e-9) return false;
  climbTry.normalize();
  const p = player.position;
  if (!climbStartsHere(p.x, feetY, p.z, climbTry)) return false;
  const { dist, up } = climbStart;
  const midAir = figurine.state === 'air';
  climbDir.copy(climbTry);
  climbCling = false;
  climbAwaitRelease = false;
  figurine.state = 'climb';
  velocity.set(0, 0, 0);
  player.rotation.y = Math.atan2(climbDir.x, climbDir.z); // face the wall
  play('climb', TUNE.fade);
  camLatch.handsOff = true;
  if (TEL) console.log(`CLIMB-START${midAir ? ' (mid-air)' : ''} y=${p.y.toFixed(2)} dist=${dist.toFixed(2)} up=${up.toFixed(2)}`);
  return true;
}

/** True if we're walking off a ledge whose face is a wall; if so, grab the lip and
 *  enter the climb (hanging just below it) so you can descend the face. */
export function tryStartClimbDown(dx: number, dz: number): boolean {
  if (!collision || !navGrid || !actions['climb']) return false;
  climbTry.set(dx, 0, dz);
  if (climbTry.lengthSq() < 1e-9) return false;
  climbTry.normalize();
  const p = player.position, gap = CAPSULE_RADIUS * charH * CLIMB.gap;
  const tx = p.x + climbTry.x * navGrid.step, tz = p.z + climbTry.z * navGrid.step;
  // must be a real edge: nothing walkable to continue onto at this level...
  if (navGrid.surfaceNear(tx, tz, figurine.supportY, charH * STEP_DOWN_MAX) !== null) return false;
  // ...with a meaningful drop below...
  const lipY = figurine.supportY - charH * CLIMB.lipProbe;
  const below = navGrid.surfaceBelow(tx, tz, lipY);
  if (below === null || figurine.supportY - below < charH * STEP_DOWN_MAX) return false;
  // ...and a wall descending from the lip. Find it the way we'll hang on it: looking
  // back at the ledge from out past the edge, just below the lip. (Probing outward from
  // under our own feet starts inside the ledge and says nothing about which way the
  // face points.)
  const reach = (CAPSULE_RADIUS + CLIMB.lipReach) * charH;
  climbProbe.set(p.x + climbTry.x * reach, lipY, p.z + climbTry.z * reach);
  climbSide.copy(climbTry).negate();
  const w = climbWall(climbProbe, climbSide, reach);
  if (!w || !isWall(w)) return false;
  const hn = Math.hypot(w.nx, w.nz);
  if (hn < 1e-6) return false;
  // grip the lip: hang off the face, feet just below the lip, FACING the face — we
  // walked off forwards, so that's a turn-around to face back the way we came.
  const fx = climbProbe.x + climbSide.x * w.distance, fz = climbProbe.z + climbSide.z * w.distance; // point on the face
  const ox = w.nx / hn, oz = w.nz / hn;       // the face's outward direction
  // The face was found below the lip, but the body reaches above it: where the face
  // is set back under the lip, the body would hang inside the lip. Push it clear; too
  // deep for that, and there is no hanging here.
  climbFrom.copy(p);
  p.set(fx + ox * gap, figurine.supportY - charH * CLIMB.hang, fz + oz * gap);
  if (!fitClimbBody(CAPSULE_RADIUS * charH)) { p.copy(climbFrom); return false; }
  if (TEL) console.log(`CLIMBDOWN-START y=${p.y.toFixed(2)} below=${below.toFixed(2)} face=${w.distance.toFixed(2)}`);
  climbDir.set(-ox, 0, -oz);                  // into the wall
  climbCling = false;
  // The keys held right now mean "walk off this ledge", not climb input: once we've
  // turned to face the wall, the same forward key would mean UP and haul us straight
  // back over the lip. Until they're released they keep meaning what they meant —
  // carry on over the edge, i.e. down the face; after that W/S/A/D steer the climb.
  climbAwaitRelease = true;
  figurine.state = 'climb';
  velocity.set(0, 0, 0);
  play('climb', TUNE.fade);
  camLatch.handsOff = true;
  return true;
}

/** Jump off the wall: launch up and away from the face. */
export function climbJumpOff(): void {
  velocity.set(-climbDir.x * TUNE.walkSpeed * charH, TUNE.jumpVel * charH, -climbDir.z * TUNE.walkSpeed * charH);
  figurine.state = 'air'; climbCling = false;
  play(actions['jump_loop'] ? 'jump_loop' : 'idle', 0.08);
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

/** Blend the climb animation by direction of travel on the wall: the authored up/down
 *  cycle, the generated sideways shimmy (left or right), or a mix on diagonals. Runs
 *  every frame so the shimmy also eases out when the climb ends. */
export function updateClimbBlend(dt: number): void {
  const c = actions['climb'], r = actions['climb_side_r'], l = actions['climb_side_l'];
  if (!c || !r || !l) return;
  const on = figurine.state === 'climb', moving = on && (climbV !== 0 || climbH !== 0);
  // resting on the wall holds whatever blend the last move left (the pose just freezes)
  const target = !on ? 0 : moving ? climbH / (Math.abs(climbV) + Math.abs(climbH)) : climbSideMix;
  climbSideMix += (target - climbSideMix) * Math.min(1, TUNE.climbBlend * dt);
  r.weight = Math.max(0, climbSideMix);
  l.weight = Math.max(0, -climbSideMix);
  c.weight = on ? 1 - Math.abs(climbSideMix) : 1;
  r.paused = l.paused = !moving;
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
  if (climbAwaitRelease) {
    // still holding the keys that walked us over the edge → keep going that way: down
    if (move.f || move.b || move.l || move.r) { v = -1; h = 0; }
    else climbAwaitRelease = false;
  }
  if (climbCling && v > 0) {                   // topped out: can't go higher, but W takes any ledge that's there
    if (tryMantle()) return true;
    v = 0;
  }
  climbV = v; climbH = h;                      // for the animation blend
  if (actions['climb']) actions['climb'].paused = v === 0 && h === 0; // anim only while moving on the wall
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
