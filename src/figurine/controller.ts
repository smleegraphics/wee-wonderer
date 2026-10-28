// Moving the figurine each frame: walking and sprinting with momentum on the walkable cells,
// walking off their edges, jumping (from the ground, a moment after leaving it, and in the
// air through the abilities), falling and landing, pushing out of walls, and handing over to
// the climb, which starts by jumping into a wall (context/movement.md).

import * as THREE from 'three';
import { BODY, camera, figurine, move, player, TEL, velocity, WORLD_UP } from '../app';
import { collision, navGrid, PLATFORM_OPTS } from '../collision/room-collision';
import type { Ability, AirMove } from './abilities';
import { camLatch } from './camera';
import { charH, charModel, moveIsPlaying, placeFigurine, play, setMovePace } from './character';
import { CLIMB, climbGround, climbJumpOff, climbTilt, climbUpdate, tryStartClimb } from './climb';
import { launchSpeed, MOVE } from './movement';

export const STEP_DOWN_MAX = 0.6; // body heights: walking off a drop up to this steps down it; a deeper one is fallen off
export const lastGood = new THREE.Vector3();   // last position stood on (recovery)
export const WALL_LIFT = 0.25; // body-vs-wall tests ignore the body below this fraction of its height (see bodyOverlap)
const SPEED_STILL = 0.1;       // body heights a second: slower than this the figurine is standing
const LAND_HARD = 3;           // body heights a second, down: a landing at least this hard shows as one (the land move), a softer one goes straight on
const EDGE_WALL = 0.5;         // capsule radii: a body this far into something at an edge is against a wall there, not over a drop

const camFwd = new THREE.Vector3(), camRight = new THREE.Vector3(), wishDir = new THREE.Vector3(), mantleLocal = new THREE.Vector3();
export function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * Math.min(t, 1);
}

export const wallFeet = new THREE.Vector3(), zeroDisp = new THREE.Vector3(), wallCorr = new THREE.Vector3();
const navRecover = new THREE.Vector3();

// --- the state of the jump: what is pending, and what can still be done ---
let abilities: Ability[] = [];  // the loadout in play (characters.ts, abilities.ts)
let sprint = 0;       // 0 walking .. 1 sprinting: eases with Shift over MOVE.sprintRamp
let coyote = 0;       // seconds left in which a jump still counts as from the ground
let pressedAgo = -1;  // seconds since a jump press not yet made (-1: none); made while within MOVE.jumpBuffer
let cutArmed = false; // rising from a jump whose height letting go of Space can still cut

/** The abilities in play. */
export function setLoadout(next: Ability[]): void { abilities = next; }
/** The heights (body heights) of the jumps the loadout can make in the air, in order. */
export const airJumpHeights = () => abilities.flatMap((a) => a.airJumps?.() ?? []);

/** Space pressed: a jump off the wall, or one waiting to be made (from the ground, or in the air by an ability). */
export function jumpKey(): void {
  move.jump = true;
  if (figurine.state === 'climb') { climbJumpOff(); cutArmed = true; return; }
  pressedAgo = 0; // tried this frame whatever the grace, then for MOVE.jumpBuffer after
}
/** Space let go: a jump still rising is cut short (MOVE.jumpCut). */
export function jumpRelease(): void { move.jump = false; }

/** Stood still somewhere new (a start, a respawn): no speed, nothing pending, everything spent in the air back. */
export function resetMotion(): void {
  velocity.set(0, 0, 0);
  sprint = coyote = 0;
  pressedAgo = -1;
  cutArmed = false;
  figurine.mantleLeft = 0; // (put somewhere else mid climb-up: it ends there)
  for (const a of abilities) a.landed?.();
}

const airMove: AirMove = {
  launch(height) {
    velocity.y = launchSpeed(height) * charH;
    cutArmed = true;
    play('airJump', 0.05, true); // from its start again, even on the take-off's clip
  },
};

export function updateController(dt: number): void {
  // Movement is camera-relative — but an automatic camera move must not re-aim a key
  // that's already held (the swing behind a climber would turn "walk away from the
  // wall" into "walk into it"). Keys that were down when a swing began keep steering by
  // the view they were pressed in, until they're released, another key is pressed, or
  // the user takes the camera.
  if (!(move.f || move.b || move.l || move.r)) camLatch.basisHeld = false;
  if (!camLatch.basisHeld) {
    camera.getWorldDirection(camFwd); camFwd.y = 0; camFwd.normalize();
    camRight.crossVectors(camFwd, WORLD_UP).negate();
  }
  wishDir.set(0, 0, 0).addScaledVector(camFwd, move.f - move.b).addScaledVector(camRight, move.l - move.r);
  const moving = wishDir.lengthSq() > 0;
  if (moving) wishDir.normalize();
  if (!collision || !navGrid) return; // (no room yet: the NavGrid is rebuilt in the same step as the collision, so there is never one without the other)

  let grounded: boolean;
  let wasClimbing = false;
  if (figurine.mantleLeft > 0) {
    // climbing up over a lip: already standing on top; keys wait until the climb-up has played
    figurine.mantleLeft = Math.max(0, figurine.mantleLeft - dt);
    grounded = true;
  } else if (figurine.state === 'climb') {
    wasClimbing = true;
    grounded = climbUpdate(dt); // true only on the frame it ends standing (mantle / stepping off)
    if (grounded) landed(0);
    if (figurine.mantleLeft > 0) play('mantle', 0.05);
  } else {
    if (player.position.y < -charH * 3) { // lost the surface (rare): back to the last place stood on
      placeFigurine(lastGood, false);
      return;
    }
    steer(dt, moving);
    if (pressedAgo > MOVE.jumpBuffer) pressedAgo = -1; // a press too long ago: dropped
    if (pressedAgo >= 0) tryJump();
    grounded = figurine.state === 'ground' ? walk(dt) : fall(dt);
    if (pressedAgo >= 0) pressedAgo += dt;
  }
  figurine.wasGrounded = grounded;

  // Visual-only vertical smoothing, run for EVERY state so the camera follows: when
  // grounded, damp the bump bob; otherwise (airborne / climbing) track physics exactly.
  // A climb-up eases the model from where the body was onto the top, the height through
  // smoothFeetY so the camera rises with it: 1 at the start, 0 when it has played.
  const ease = figurine.mantleLeft > 0 ? (figurine.mantleLeft / CLIMB.mantleTime) ** 2 : 0;
  if (ease > 0) figurine.smoothFeetY = player.position.y + figurine.mantleFrom.y * ease;
  else if (grounded && !wasClimbing) figurine.smoothFeetY += (player.position.y - figurine.smoothFeetY) * Math.min(1, 10 * dt);
  else figurine.smoothFeetY = player.position.y;
  if (charModel) {
    // lean with the wall while climbing (climbTilt), about the chest, where the hands meet it
    const tilt = climbTilt(dt), chest = charH * CLIMB.chest;
    charModel.rotation.x = tilt;
    charModel.position.set(0, figurine.smoothFeetY - player.position.y + chest * (1 - Math.cos(tilt)), -chest * Math.sin(tilt));
    if (ease > 0) { // across: the offset in the player's own (turned) frame
      mantleLocal.set(figurine.mantleFrom.x, 0, figurine.mantleFrom.z).applyAxisAngle(WORLD_UP, -player.rotation.y).multiplyScalar(ease);
      charModel.position.x += mantleLocal.x; charModel.position.z += mantleLocal.z;
    }
  }

  animate(moving);
}

/** Speed and facing from the keys: towards the wished speed at the ground's rate, or the
 *  air's (MOVE.airControl of it); the top speed eases between walking and sprinting. */
const want = new THREE.Vector3();
function steer(dt: number, moving: boolean): void {
  sprint += (moving && move.run ? 1 : -1) * dt / Math.max(MOVE.sprintRamp, 1e-3);
  sprint = Math.min(1, Math.max(0, sprint));
  const top = (MOVE.walkSpeed + (MOVE.sprintSpeed - MOVE.walkSpeed) * sprint) * charH;
  want.copy(wishDir).multiplyScalar(moving ? top : 0);
  const walk = MOVE.walkSpeed * charH;
  const rate = (moving ? walk / Math.max(MOVE.accelTime, 1e-3) : walk / Math.max(MOVE.stopTime, 1e-3)) * dt;
  // Above top speed (Shift let go mid-sprint) the excess goes at the sprint ramp's pace, not the stop's.
  const excess = Math.hypot(velocity.x, velocity.z) > top ? (MOVE.sprintSpeed - MOVE.walkSpeed) * charH * dt / Math.max(MOVE.sprintRamp, 1e-3) : 0;
  const dx = want.x - velocity.x, dz = want.z - velocity.z, d = Math.hypot(dx, dz);
  const ease = Math.max(rate, excess) * (figurine.state === 'ground' ? 1 : MOVE.airControl); // in the air, all of it at the air's share
  if (d <= ease) { velocity.x = want.x; velocity.z = want.z; }
  else { velocity.x += (dx / d) * ease; velocity.z += (dz / d) * ease; }
  const speed = Math.hypot(velocity.x, velocity.z);
  if (speed > SPEED_STILL * charH) player.rotation.y = lerpAngle(player.rotation.y, Math.atan2(velocity.x, velocity.z), MOVE.turnRate * dt);
}

/** A jump waiting to be made: from the ground (or just off it), else by an ability in the air. */
function tryJump(): void {
  if (figurine.state === 'ground' || coyote > 0) {
    velocity.y = launchSpeed(MOVE.jumpHeight) * charH;
    figurine.state = 'air';
    pressedAgo = -1; coyote = 0;
    cutArmed = true;
    play('jumpStart', 0.06);
    return;
  }
  // In the air the press is the air jump, unless the figurine touches down within the early-jump
  // grace anyway: then it waits for the ground and jumps from there (a weak hop a hair above the
  // floor, with the air jump spent, was what an early press used to give while one was left).
  if (figurine.state === 'air' && landingWithin(MOVE.jumpBuffer)) return;
  if (figurine.state === 'air' && abilities.some((a) => a.airJump?.(airMove))) pressedAgo = -1;
}

/** Falling, will the figurine touch the walkable ground below it within `seconds`? */
function landingWithin(seconds: number): boolean {
  const p = player.position, g = navGrid?.surfaceBelow(p.x, p.z, p.y) ?? null;
  if (g === null || velocity.y > 0) return false;
  const pull = MOVE.gravity * MOVE.fallGravity * charH, down = -velocity.y, drop = p.y - g;
  return (Math.sqrt(down * down + 2 * pull * drop) - down) / pull <= seconds;
}

/** How deep the body, feet at (x,y,z), is sunk into the collision mesh — 0 when it
 *  fits. Only the body ABOVE a quarter of its height is tested: floor lumps below that
 *  are the nav's business (standing, landing), and letting them push is what used to
 *  wedge the figurine. The way out is left in `wallCorr`, the freed position in
 *  `wallFeet` (lifted). */
export function bodyOverlap(x: number, y: number, z: number, radius: number): number {
  if (!collision) return 0;
  const lift = charH * WALL_LIFT;
  wallFeet.set(x, y + lift, z);
  collision.moveCapsule(wallFeet, radius, Math.max(0.02, charH - lift - 2 * radius), zeroDisp, wallCorr);
  return wallCorr.length();
}

/** Push the body out of solid walls sideways, feet at `feetY`. Moves the player and
 *  returns how far; the push direction is left in `wallCorr`. */
function pushOutOfWalls(feetY: number, radius: number): number {
  const p = player.position;
  if (bodyOverlap(p.x, feetY, p.z, radius) === 0) return 0;
  p.x = wallFeet.x; p.z = wallFeet.z;
  return Math.hypot(wallCorr.x, wallCorr.z);
}

/** Does the body, at its width now, stand at (x, y, z) touching no wall? The walkable cells
 *  know headroom, not width, so this is what says a cell will do for this body. */
const bodyFits = (x: number, y: number, z: number): boolean => bodyOverlap(x, y, z, BODY.radius * charH) === 0;

/** After the body changes size or width where it is (another character, or anything else that
 *  resizes it): stand it on the ground (back where it last stood, if it was in the air or on a
 *  wall, whose fit was for the old body) and push it clear of the walls at its new width. If
 *  that takes it off the cells, it does not fit there: it falls from where the push left it,
 *  if there is ground below, or goes to the nearest place on the cells it fits. */
export function refitBody(): void {
  if (figurine.state !== 'ground') placeFigurine(lastGood, false);
  else resetMotion();
  const nav = navGrid, p = player.position;
  if (!nav || pushOutOfWalls(figurine.supportY, BODY.radius * charH) === 0) return;
  const s = nav.surfaceNear(p.x, p.z, figurine.supportY, charH * PLATFORM_OPTS.stepFactor);
  if (s !== null) { p.y = figurine.supportY = s; lastGood.copy(p); return; }
  if (nav.surfaceBelow(p.x, p.z, p.y) !== null) { figurine.state = 'air'; return; }
  if (nav.nearest(lastGood.x, lastGood.z, figurine.supportY, navRecover, bodyFits)) placeFigurine(navRecover, false);
}

/** On the ground: move on the walkable cells (continuing, stepping, over a gap narrower than
 *  the body, or sliding along what stops it), and off an edge into the air if there is
 *  somewhere below to land. Returns whether it is still on the ground. */
function walk(dt: number): boolean {
  const nav = navGrid!, p = player.position, radius = BODY.radius * charH, band = charH * PLATFORM_OPTS.stepFactor;
  const dx = velocity.x * dt, dz = velocity.z * dt, fromX = p.x, fromZ = p.z;
  if (dx !== 0 || dz !== 0) {
    const edge = stepTo(p.x + dx, p.z + dz, band, radius);
    if (edge === 'blocked') {
      // something stops it: slide, one axis at a time (the second from wherever the first
      // left it — both at once is the step just refused), losing the speed into it
      if (dx !== 0 && stepTo(p.x + dx, p.z, band, radius) === 'blocked') velocity.x = 0;
      if (dz !== 0 && figurine.state === 'ground' && stepTo(p.x, p.z + dz, band, radius) === 'blocked') velocity.z = 0; // (not once the first walked off an edge)
    }
    if (figurine.state === 'air') return false; // walked off an edge
    // Walls are pushed out of, but not off the cells: there the body does not fit beside the wall
    // (a top narrower than it is wide), so the step is refused like any other blocked one, losing
    // the speed into the wall. Let through, it left no ground underfoot, and the recovery below
    // put it on the nearest cell: back in the wall.
    const push = pushOutOfWalls(figurine.supportY, radius);
    if (push > 0 && nav.surfaceNear(p.x, p.z, figurine.supportY, band) === null) {
      p.x = fromX; p.z = fromZ;
      const nx = wallCorr.x / push, nz = wallCorr.z / push, into = velocity.x * nx + velocity.z * nz;
      if (into < 0) { velocity.x -= into * nx; velocity.z -= into * nz; }
    }
  }
  const here = nav.surfaceNear(p.x, p.z, figurine.supportY, band);
  if (here !== null) { p.y = here; figurine.supportY = here; lastGood.copy(p); return true; }
  if (nav.nearest(lastGood.x, lastGood.z, figurine.supportY, navRecover, bodyFits)) { p.copy(navRecover); figurine.supportY = navRecover.y; lastGood.copy(p); velocity.x = velocity.z = 0; } // recovered: and stopped, or its momentum drives it back off the cells every frame
  return true;
}

/** Try to walk to (x, z). Moves the player unless it is 'blocked'; 'air' when that walked
 *  off an edge. Only onto walkable cells: the NavGrid has already filled the small holes in
 *  a surface, and everything after a move (standing, landing, a wall grab's "ground to drop
 *  back to") asks the cells under the figurine. At an edge, a body pushed into something (a
 *  wall's foot) or nothing below to land on (the scan's rim) blocks; the edge is then slid
 *  along. Walls elsewhere are pushed out of after the move (pushOutOfWalls). */
function stepTo(x: number, z: number, band: number, radius: number): 'moved' | 'blocked' | 'air' {
  const nav = navGrid!, p = player.position, y = figurine.supportY;
  if (nav.surfaceNear(x, z, y, band) !== null) { p.x = x; p.z = z; return 'moved'; }
  if (bodyOverlap(x, y, z, radius) > radius * EDGE_WALL) return 'blocked';
  const below = nav.surfaceBelow(x, z, y - band);
  if (below === null) return 'blocked';
  p.x = x; p.z = z;
  if (y - below <= charH * STEP_DOWN_MAX) { figurine.supportY = below; return 'moved'; } // a step down
  figurine.state = 'air'; velocity.y = 0; coyote = MOVE.coyoteTime;
  return 'air';
}

/** In the air: fall under gravity (harder falling, and cut short when Space is let go
 *  rising), steer a little, grab a wall jumped into, and land on the walkable cells. */
function fall(dt: number): boolean {
  const nav = navGrid!, p = player.position, radius = BODY.radius * charH;
  coyote = Math.max(0, coyote - dt);
  if (cutArmed && velocity.y > 0 && !move.jump) { velocity.y *= MOVE.jumpCut; cutArmed = false; }
  if (velocity.y <= 0) cutArmed = false;
  // Gravity is the same all through a frame, so the frame's move is exact (a half step of its
  // pull on top of the speed it started with): a jump rises and carries the same at any frame
  // rate, and as far as the movement model says. Adding the pull to the speed first lost half
  // a frame's rise each jump (0.05 body heights at 30 a second).
  const pull = MOVE.gravity * (velocity.y < 0 ? MOVE.fallGravity : 1) * charH;
  const prevY = p.y;
  p.x += velocity.x * dt; p.z += velocity.z * dt; p.y += velocity.y * dt - 0.5 * pull * dt * dt;
  velocity.y -= pull * dt;
  // Walls are solid in the air too. Touching one we're travelling INTO is how a jump
  // grabs it — if it's climbable we start climbing right there, otherwise it simply
  // stops us and we slide along it.
  const push = pushOutOfWalls(p.y, radius);
  if (push > 1e-5) {
    const nx = wallCorr.x / push, nz = wallCorr.z / push; // out of the wall
    if (velocity.x * nx + velocity.z * nz < 0) {
      // Only grab a wall that stands on ground we could drop back to. In the air
      // nothing confines us to the walkable area, so a jump can sail past its edge
      // (or through a gap in the scan) — the faces out there hang over nothing, and
      // grabbing one strands us. Looked for back from the wall as far as the body is
      // wide plus a cell: a jump carries the body past the last cell before it touches
      // (Living Room's couch back stands 1.5 cells past the seat's last one).
      const ground = climbGround(p.y + radius * 0.5, -nx, -nz, 2 * radius + navGrid!.step);
      if (!ground) { if (TEL) console.log(`CLIMB-NO (mid-air) no ground below y=${p.y.toFixed(2)}`); }
      else if (tryStartClimb(-nx, -nz, p.y)) { pressedAgo = -1; return false; } // (a press waiting in the air is not for after the climb)
    }
    const into = velocity.x * nx + velocity.z * nz; // no more driving into it
    if (into < 0) { velocity.x -= into * nx; velocity.z -= into * nz; }
  }
  if (velocity.y <= 0) {
    // SWEPT landing: query from where the feet WERE this frame, so a fast fall catches
    // any surface crossed during the step instead of stepping over its narrow band.
    const floor = nav.surfaceBelow(p.x, p.z, prevY + radius * 0.5);
    if (floor !== null && p.y <= floor) {
      const impact = -velocity.y / charH;
      p.y = floor; velocity.y = 0; figurine.supportY = floor; lastGood.copy(p);
      landed(impact);
      return true;
    }
  }
  return false;
}

/** On the ground again, coming down at `impact` body heights a second: everything spent in the
 *  air is back, and a jump pressed just before is made now. */
function landed(impact: number): void {
  figurine.state = 'ground';
  play(impact > LAND_HARD ? 'land' : 'idle', 0.1);
  coyote = 0; cutArmed = false;
  for (const a of abilities) a.landed?.();
  if (pressedAgo >= 0) tryJump();
}

/** The move for how it is moving: on the ground by speed (idle, walk, sprint, with the pace
 *  matched to the speed so the feet do not slide while it builds), in the air the take-off then
 *  rising or falling. Climbing shows itself (climb.ts). */
function animate(moving: boolean): void {
  if (figurine.state === 'climb' || figurine.mantleLeft > 0) return; // (a climb-up shows itself)
  if (figurine.state === 'air') {
    if (moveIsPlaying('jumpStart') || moveIsPlaying('airJump')) return; // the take-off plays out over the rise
    play(velocity.y > 0 ? 'rise' : 'fall', 0.15);
    return;
  }
  if (moveIsPlaying('land')) return;
  const speed = Math.hypot(velocity.x, velocity.z) / charH;
  const next = !moving && speed < SPEED_STILL ? 'idle' : speed > (MOVE.walkSpeed + MOVE.sprintSpeed) / 2 ? 'sprint' : 'walk';
  play(next);
  setMovePace(speed);
}
