// Climbing: starting a climb, moving on the wall, topping out and stepping off, under
// the rules in context/climb.md.

import * as THREE from 'three';
import type { WallHit } from '../collision/collision';
import { BODY, figurine, move, player, TEL, TUNE, velocity, WORLD_DOWN } from '../app';
import { collision, grabSlopeMax, lastVoxelSize, navGrid } from '../collision/room-collision';
import { camLatch } from './camera';
import { character, charH, pauseMove, play } from './character';
import { bodyOverlap, lastGood, lerpAngle, WALL_LIFT, wallFeet } from './controller';
import { launchSpeed, MOVE } from './movement';

// A jump into a wall grabs it (the controller's fall, tryStartClimb). The figurine ascends the
// face, following it up; when the wall ends it tops out — onto a surface if there's one to
// stand on, otherwise it clings at the top until you jump (Space) off.
export const climbDir = new THREE.Vector3();   // horizontal direction into the wall we're on
const climbTry = new THREE.Vector3();   // scratch: a candidate direction, until a climb actually starts
const climbProbe = new THREE.Vector3(); // scratch for the forward wall raycast
const climbSide = new THREE.Vector3();  // scratch: sideways direction along the wall
const climbFrom = new THREE.Vector3();  // scratch: where the body was before the snap to the face, which might not fit
const climbFrame = new THREE.Vector3(); // scratch: where the body was at the start of the frame
const axisFrom = new THREE.Vector3(), axisTo = new THREE.Vector3(), axisFacing = new THREE.Vector3(); // scratch: the body's axis, and how the wall it touches faces
let climbAtEdge = false;                // sideways shuffle is stopped at the wall's edge (telemetry de-dupe)
export let climbCling = false;                 // topped out with nowhere to stand → hanging
let overTried = false;                  // hanging at a top, a way over was looked for here and there was none
let climbUnfit = false;                 // this frame's move was undone (telemetry de-dupe)
let climbInGap = false;                 // going up through a gap in the face (telemetry de-dupe)
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
  gap: 1.1,         // body centre held this many radii off the face (just clear of it)
  mantleOver: 3,    // a mantle looks for a surface up to this many radii over the lip (the nearest it finds)...
  mantleNear: 0.4,  // ...onto a surface within this of the feet...
  mantleUp: 0.3,    // ...and no more than this above them
  pullUp: 1,        // hanging at a top, W pulls up onto a surface this far above the feet (a hand's reach; Living Room has one at 0.79)
  setBack: 4,       // at a top, a face going on up this many radii further back (past a narrow ledge) is stepped over to and climbed
  dropOver: 5,      // at a top, ground this many radii over the lip (the far side of a thin top) is climbed over and dropped onto
  gapAbove: 0.8,    // going up with no wall at the grip, a face picking up again within this above it is a gap in the wall, not its top (measured gaps: 0.2 to 0.7)
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
const climbStart = { dist: 0, up: 0, why: '', ledge: false }; // why: what was missing when the test failed (for the CLIMB-NO log); ledge: a face at chest height that ends below the head
export function climbStartsHere(x: number, feetY: number, z: number, dir: THREE.Vector3): boolean {
  const reach = (BODY.radius + CLIMB.startReach) * charH;
  // Require a wall at chest AND head — proves it's tall enough to scale (not a low
  // bump), and that the climb won't top out the instant it starts.
  climbStart.dist = Infinity;
  climbStart.ledge = false;
  for (let i = 0; i < 2; i++) {
    const w = climbWall(climbProbe.set(x, feetY + charH * (i ? CLIMB.head : CLIMB.chest), z), dir, reach);
    if (i === 1 && !w) climbStart.ledge = true;
    if (!w || !isWall(w)) { climbStart.why = `${i ? 'head' : 'chest'}: ${w ? `too shallow (up=${w.up.toFixed(2)})` : 'nothing within reach'}`; return false; }
    if (w.distance < climbStart.dist) { climbStart.dist = w.distance; climbStart.up = w.up; }
  }
  return true;
}

/** True if a wall is right in front (in the `dx,dz` direction); if so, enter the climb
 *  with the feet at `feetY`, where a jump has carried them into the wall. */
export function tryStartClimb(dx: number, dz: number, feetY: number): boolean {
  if (!collision || !character.climbs) return false;
  climbTry.set(dx, 0, dz);
  if (climbTry.lengthSq() < 1e-9) return false;
  climbTry.normalize();
  const p = player.position;
  // A face at chest and head height is a wall to climb. One at chest height that ends below
  // the head is a ledge: grab it too, and the climb tops out over it straight away (a pull-up,
  // or a hang where there is nothing to stand on). Walking into either never starts a climb.
  const wall = climbStartsHere(p.x, feetY, p.z, climbTry), ledge = !wall && climbStart.ledge;
  if (!wall && !ledge) { if (TEL) console.log(`CLIMB-NO (mid-air) y=${feetY.toFixed(2)} ${climbStart.why}`); return false; }
  const { dist, up } = climbStart;
  climbDir.copy(climbTry);
  climbCling = false;
  figurine.state = 'climb';
  velocity.set(0, 0, 0);
  player.rotation.y = Math.atan2(climbDir.x, climbDir.z); // face the wall
  tiltWanted = 0; overTried = false; // a new wall: no lean until it is measured, and a way over not yet looked for
  play('climb', 0.1);
  camLatch.handsOff = true;
  if (TEL) console.log(`CLIMB-${ledge ? 'LEDGE' : 'START'} (mid-air) y=${p.y.toFixed(2)} dist=${dist.toFixed(2)} up=${up.toFixed(2)}`);
  return true;
}

/** How the figure leans with the wall while climbing (figure only: the body that collides
 *  stays upright). `on`, and the most it leans, in degrees either way. */
export const CLIMB_TILT = { on: true, max: 15 };
const TILT_RATE = 4; // per second, eased: a lumpy scan's facing changes from frame to frame (at 8 it wobbled)
const TILT_TOUCH = 0.5; // capsule radii past the climbing gap: the surfaces this near the body are the ones it touches, which it lies along
let tiltWanted = 0;  // radians: the lean the wall's facing asks for (forward positive)
let tiltShown = 0;   // radians: the lean shown, eased toward that (or upright, off the wall)

/** The lean shown, in degrees (telemetry). */
export const climbTiltShown = () => THREE.MathUtils.radToDeg(tiltShown);

/** The figure's lean this frame, radians forward, eased toward the wall's facing while climbing
 *  and back to upright otherwise. */
export function climbTilt(dt: number): number {
  const max = THREE.MathUtils.degToRad(CLIMB_TILT.max);
  const want = figurine.state === 'climb' && !climbCling && CLIMB_TILT.on ? THREE.MathUtils.clamp(tiltWanted, -max, max) : 0; // (hanging at a top: upright)
  tiltShown += (want - tiltShown) * Math.min(1, TILT_RATE * dt);
  return tiltShown;
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

/** Top out of a climb onto a surface over the lip, if there is one to stand on, no more than
 *  `reachUp` body heights above the feet: the nearest, a step at a time out to mantleOver radii. (One point two radii over missed tops that start a
 *  little further back: Counter's at 2.3 and 2.5.) */
function tryMantle(reachUp = CLIMB.mantleUp): boolean {
  if (!navGrid) return false;
  const p = player.position, radius = BODY.radius * charH;
  for (let over = radius; over <= radius * CLIMB.mantleOver + 1e-6; over += navGrid.step / 2) {
    const overX = p.x + climbDir.x * over, overZ = p.z + climbDir.z * over;
    const g = navGrid.surfaceNear(overX, overZ, p.y + charH * (reachUp - CLIMB.mantleNear) / 2, charH * (reachUp + CLIMB.mantleNear) / 2); // a surface from mantleNear below the feet to reachUp above them
    if (g === null) continue;
    climbStandAt(overX, g, overZ);
    if (TEL) console.log(`CLIMB-MANTLE to=${g.toFixed(2)} over=${(over / radius).toFixed(1)}r`);
    return true;
  }
  return false;
}

/** At the top of a climb: over it, whichever way there is, in this order. A surface to stand
 *  on within `reachUp` (tryMantle: 'stood'); a face going on up further back, past a ledge too
 *  narrow to stand on, stepped over to and climbed ('moved'); ground on the far side of a thin
 *  top, climbed over and dropped onto ('moved', falling). Else null: the climber clings there.
 *  Every one of 36 clings at the tops of Counter's, Kitchen's and Living Room's objects had
 *  ground on the far side; the side of Kitchen's bulldozer has its cab set back behind the track. */
function overTheTop(reachUp: number): 'stood' | 'moved' | null {
  if (tryMantle(reachUp)) return 'stood';
  if (stepToSetBack()) return 'moved';
  if (dropOverTheTop()) return 'moved';
  return null;
}

/** A face going on up further back than the climb follows (past a ledge too narrow to stand
 *  on): step over to it and climb on. Probed from the grip to the head, out to setBack radii;
 *  only where there is a ledge to step over. */
function stepToSetBack(): boolean {
  const p = player.position, radius = BODY.radius * charH, gap = radius * CLIMB.gap, near = radius + charH * CLIMB.followReach;
  for (let up = CLIMB.grip * charH; up <= CLIMB.head * charH + 1e-6; up += lastVoxelSize) {
    const w = climbWall(climbProbe.set(p.x, p.y + up, p.z), climbDir, near + radius * CLIMB.setBack);
    if (!w || !isWall(w) || w.distance <= near) continue;
    // only over a ledge: something solid just under the feet halfway across. Without it a step
    // crossed open air to whatever stood behind (6.7 radii, in Living Room, then stuck there)
    const mid = (w.distance - gap) / 2;
    if (!climbWall(climbProbe.set(p.x + climbDir.x * mid, p.y + charH * CLIMB.grip, p.z + climbDir.z * mid), WORLD_DOWN, charH * (CLIMB.grip + CLIMB.mantleNear))) return false;
    climbFrom.copy(p);
    p.addScaledVector(climbDir, w.distance - gap);
    if (!fitClimbBody(radius)) { p.copy(climbFrom); return false; }
    climbCling = false;
    if (TEL) console.log(`CLIMB-SETBACK y=${p.y.toFixed(2)} by=${((w.distance - gap) / radius).toFixed(1)}r`);
    return true;
  }
  return false;
}

/** Ground on the far side of a thin top (the inside of a bowl, behind a couch back): climb over,
 *  just clear of the lip, and drop onto it. Only lower than a mantle reaches: anything nearer
 *  was a surface to stand on. Out to dropOver radii. */
function dropOverTheTop(): boolean {
  if (!navGrid) return false;
  const p = player.position, radius = BODY.radius * charH;
  for (let over = radius * (CLIMB.gap + 0.5); over <= radius * CLIMB.dropOver + 1e-6; over += navGrid.step / 2) {
    const x = p.x + climbDir.x * over, z = p.z + climbDir.z * over, g = navGrid.surfaceBelow(x, z, p.y);
    if (g === null || g > p.y - charH * CLIMB.mantleNear) continue;
    climbFrom.copy(p);
    p.x = x; p.z = z;
    if (!fitClimbBody(radius)) { p.copy(climbFrom); continue; }
    climbCling = false;
    figurine.state = 'air';
    velocity.set(0, 0, 0);
    play('fall', 0.15);
    if (TEL) console.log(`CLIMB-OVER y=${p.y.toFixed(2)} over=${(over / radius).toFixed(1)}r down=${((p.y - g) / charH).toFixed(2)}h`);
    return true;
  }
  return false;
}

/** Does the face pick up again within gapAbove over a height `y` (a dent or gap in an uneven
 *  wall, so the climb is not at its top)? Probed a voxel at a time, as climbableFace probes. */
function wallAbove(y: number, reach: number): boolean {
  for (let up = lastVoxelSize; up <= charH * CLIMB.gapAbove + 1e-6; up += lastVoxelSize) {
    const w = climbWall(climbProbe.set(player.position.x, y + up, player.position.z), climbDir, reach);
    if (w && isWall(w)) return true;
  }
  return false;
}


/** Free movement on the wall: W/S = up/down, A/D = the figurine's own left/right along
 *  the face (wall-relative, not camera-relative), diagonals combine. The figurine turns
 *  with the wall as it curves, stops at the wall's side edges, and carries on around an
 *  inside corner onto the adjoining wall. Returns true on the frame the climb ends
 *  standing on the ground (a mantle, or stepping off at the wall's foot). */
export function climbUpdate(dt: number): boolean {
  if (!collision) return false;
  climbFrame.copy(player.position); // where this frame started, should none of its move fit
  const p = player.position, radius = BODY.radius * charH, gap = radius * CLIMB.gap;
  const followReach = radius + charH * CLIMB.followReach;
  // keep facing the wall (eased, so following a curve / turning a corner isn't a snap)
  player.rotation.y = lerpAngle(player.rotation.y, Math.atan2(climbDir.x, climbDir.z), TUNE.turnLerp * dt);

  let v = move.f - move.b;                     // W = up, S = down
  let h = move.r - move.l;                     // D = figurine's right, A = its left
  if (h !== 0 || v < 0) overTried = false;    // moved: what is over the top may have changed
  if (climbCling && v > 0) {                   // hanging at a top: W goes over it if there is any way over (overTheTop)
    const over = overTried ? null : overTheTop(CLIMB.pullUp);
    if (over === 'stood') return true;
    if (over === 'moved') return false;
    overTried = true;                          // none from here: not looked for again until the climber moves
    v = 0;
  }
  play(climbCling ? 'ledgeHang' : 'climb', 0.15);
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
  if (wall) { climbCling = false; climbInGap = false; } // wall above the feet again (the lip rose) → not topped out
  else if (climbCling) wall = climbWall(climbProbe.set(p.x, p.y + probeUp, p.z), climbDir, followReach);
  if (wall) {
    // Hold the gap to the wall over the whole body, grip to head, not at the grip alone: a
    // face that bulges out higher up (the side of Counter's bowl) pressed the chest and head
    // into it, and the push out of it cancelled every step up. Where the body is nearest the
    // wall is where the gap is kept, so it leans out over a bulge and in under a recess.
    const nearest = collision.nearestAhead(axisFrom.set(p.x, p.y + probeUp, p.z), axisTo.set(p.x, p.y + charH * CLIMB.head, p.z), climbDir, followReach, gap + radius * TILT_TOUCH, grabSlopeMax(), axisFacing);
    // The figure lies parallel to the wall it touches: its up is the world's up made
    // perpendicular to the way the touching faces face, averaged by area. A face turned to the
    // sky (leaning away) tips it forward, one turned to the ground (over it) tips it back. Only
    // faces steep enough to climb count (isWall's cutoff): the top of what it climbs, large and
    // turned to the sky, tipped it 30° to 39° forward on every object in Kitchen.
    tiltWanted = axisFacing.lengthSq() > 0 ? Math.asin(THREE.MathUtils.clamp(axisFacing.y, -1, 1)) : 0; // (touching nothing: upright, never the last lean held)
    climbFrom.copy(p);
    p.addScaledVector(climbDir, Math.min(wall.distance, nearest) - gap);
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
    // no wall at this height. Going up: a gap in the face if it picks up again just above
    // (carry on up); else the top, and over it if there is a way (overTheTop); else cling.
    if (wallAbove(p.y + charH * CLIMB.grip, followReach)) {
      if (TEL && !climbInGap) console.log(`CLIMB-GAP y=${p.y.toFixed(2)}`);
      climbInGap = true;
    } else {
      climbInGap = false;
      const over = overTheTop(CLIMB.mantleUp);
      if (over === 'stood') return true;
      if (over === 'moved') return false;
      climbCling = true; // no way over → cling at the top
      if (TEL) console.log(`CLIMB-CLING y=${p.y.toFixed(2)}`);
    }
  }

  // --- the whole body has to fit, not just the grip ---
  // The face is followed at one point near the feet, so the rest of the body can be
  // carried into whatever is beside or above it. A step is about a quarter of a radius
  // at the longest frame, so `fitClimbBody` can push it back out. The snap to the face
  // can go further: where the face is further back near the feet than higher up (a
  // recess, or under an overhanging lip), it carries the body up to `followReach`
  // forward into the part that sticks out. Such a snap is not made this frame; the
  // sideways and vertical moves stand, and the gap closes once the body is clear. If it
  // still does not fit, the step along or up the wall went in itself (a thin solid beside
  // it, an overhang over a gap: Living Room, climbfuzz seed 2), and none of the frame's
  // move is made.
  let fits = fitClimbBody(radius);
  if (!fits && wall) { p.copy(climbFrom); fits = fitClimbBody(radius); }
  if (!fits) {
    if (TEL && !climbUnfit) console.log(`CLIMB-UNFIT y=${p.y.toFixed(2)} sunk=${(bodyOverlap(p.x, p.y, p.z, radius) / radius).toFixed(2)}r inside=${chestInside(p.x, p.y, p.z, climbDir) ? insideWhy : 'no'}`);
    p.copy(climbFrame);
  }
  climbUnfit = !fits;
  return false;
}

/** Is the chest, feet at (x, y, z), inside something solid? Inside a solid, the surface met
 *  first is seen from behind whichever way one looks; so it is inside when most of six rays
 *  (ahead along `dir`, behind, either side, up, down) meet one from behind (INSIDE_RAYS). One ray
 *  is not enough: a scan's mesh has holes, and a ray through a hole in the wall ahead meets the
 *  inside of the object's far side from behind (Living Room: every one of 9 climbs stuck at the
 *  foot of an object, the body touching nothing). The overlap test cannot tell either: a body
 *  wholly inside crosses no surface and reads 0. The climb fuzz asks the same (`__dbg.inside`). */
const INSIDE_RAYS = 4; // of the six, meeting a surface from behind
const INSIDE_LOOK = ['ahead', 'behind', 'left', 'right', 'up', 'down']; // (telemetry names, in the order below)
const insideAt = new THREE.Vector3(), insideDir = new THREE.Vector3();
let insideWhy = ''; // which rays found it inside (telemetry: built only under ?tel=1)
export function chestInside(x: number, y: number, z: number, dir: THREE.Vector3): boolean {
  if (!collision) return false;
  insideAt.set(x, y + charH * CLIMB.chest, z);
  let behind = 0;
  if (TEL) insideWhy = '';
  for (let i = 0; i < 6; i++) {
    // ahead along `dir`, behind, left, right, up, down
    if (i < 4) insideDir.set(i === 0 ? dir.x : i === 1 ? -dir.x : i === 2 ? -dir.z : dir.z, 0, i === 0 ? dir.z : i === 1 ? -dir.z : i === 2 ? dir.x : -dir.x);
    else insideDir.set(0, i === 4 ? 1 : -1, 0);
    const w = collision.wallAhead(insideAt, insideDir, charH * 4);
    if (w && !w.front) { behind++; if (TEL) insideWhy += `${INSIDE_LOOK[i]} `; }
  }
  return behind >= INSIDE_RAYS;
}

/** Make a climber's body fit after a move, feet at the player's position. An overlap up
 *  to a radius is pushed out, with the same collide-and-slide walking uses, in all three
 *  axes here: an object in the way pushes straight back, so the move makes no headway;
 *  a lump of the wall itself pushes outward, and the climber rides over it. Returns
 *  false, moving nothing, when the body is deeper than a radius: "which way is out" no
 *  longer has a single answer, and a push can eject it through the far side of a thin
 *  shell. The caller then undoes the move or refuses it, so no move leaves the body that
 *  deep (context/climb.md, rule 12). A chest inside something solid is refused the same way. */
function fitClimbBody(radius: number): boolean {
  const p = player.position, sunk = bodyOverlap(p.x, p.y, p.z, radius);
  if (sunk > radius || chestInside(p.x, p.y, p.z, climbDir)) return false;
  const pushed = sunk > radius * CLIMB.skin;
  if (pushed) {
    if (TEL && !climbBlocked) console.log(`CLIMB-PUSHED y=${p.y.toFixed(2)} by=${(sunk / radius).toFixed(2)}r`);
    p.set(wallFeet.x, wallFeet.y - charH * WALL_LIFT, wallFeet.z);
  }
  climbBlocked = pushed;
  return true;
}
