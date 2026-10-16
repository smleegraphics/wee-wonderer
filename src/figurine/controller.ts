// Moving the figurine each frame: walking on the walkable cells, jumping and falling,
// pushing out of walls, and handing over to the climb.

import * as THREE from 'three';
import { camera, CAPSULE_RADIUS, figurine, move, player, q, TEL, TUNE, velocity, WORLD_UP } from '../app';
import { collision, navGrid, PLATFORM_OPTS } from '../collision/room-collision';
import { camLatch } from './camera';
import { actions, charFeetOffset, charH, charModel, play, resetToSpawn } from './character';
import { climbGround, climbUpdate, resetClimbInput, tryStartClimb, tryStartClimbDown, updateClimbBlend } from './climb';
 // climbDeg: surfaces steeper than this (from horizontal) are walls to climb, gentler ones are ground to walk. minCells: an area, in grains². bridge, fill: how wide a gap in a surface is bridged, and how wide a hole in it filled, in grains
export const STEP_DOWN_MAX = 0.6;                       // goes up each time the walkable cells are rebuilt
export const lastGood = new THREE.Vector3(); // capsule hemisphere radius, in char-heights
const PHYSICS_STEPS = 5;

const camFwd = new THREE.Vector3(), camRight = new THREE.Vector3(), wishDir = new THREE.Vector3();
export function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * Math.min(t, 1);
}

// scratch vectors for the collide-and-slide loop (avoid per-frame allocation)
const hVel = new THREE.Vector3(), disp = new THREE.Vector3(), correction = new THREE.Vector3(), slideN = new THREE.Vector3();
const navRecover = new THREE.Vector3();
export const wallFeet = new THREE.Vector3(), zeroDisp = new THREE.Vector3(), wallCorr = new THREE.Vector3();
export const WALL_LIFT = 0.25; // body-vs-wall tests ignore the body below this fraction of its height (see bodyOverlap)

/** Movement tunables: `on` stands the figurine on the walkable cells (the platform
 *  reliability layer, on by default); off, it moves on the raw mesh. */
export const NAV = { on: q.get('nav') !== '0' };

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

  if (figurine.state === 'jump_start') return;        // anticipation freeze; onActionFinished launches
  if (!collision) return;

  // Movement for this frame → `grounded`. Climb runs its own update (on the wall);
  // everything else walks/jumps. Both then fall through to the shared render + camera
  // follow below, so the camera tracks the figurine in every state.
  let grounded: boolean;
  resetClimbInput();
  let wasClimbing = false;
  if (figurine.state === 'climb') {
    wasClimbing = true;
    grounded = climbUpdate(dt); // true only on the frame it ends standing (mantle / stepping off)
  } else {
    if (player.position.y < -charH * 3) { // lost the surface (rare edge case)
      if (navGrid && NAV.on) { player.position.copy(lastGood); figurine.supportY = lastGood.y; velocity.set(0, 0, 0); figurine.state = 'ground'; } // snap back to the last valid spot (gentle)
      else resetToSpawn();
      return;
    }
    if (moving) player.rotation.y = lerpAngle(player.rotation.y, Math.atan2(wishDir.x, wishDir.z), TUNE.turnLerp * dt);
    const speed = (move.run ? TUNE.runSpeed : TUNE.walkSpeed) * charH;
    hVel.copy(wishDir).multiplyScalar(moving ? speed : 0);
    const radius = CAPSULE_RADIUS * charH;
    grounded = navGrid && NAV.on ? navMove(dt, radius) : meshMove(dt, radius);
  }
  figurine.wasGrounded = grounded;

  // Visual-only vertical smoothing, run for EVERY state so the camera follows: when
  // grounded, damp the bump bob; otherwise (airborne / climbing) track physics exactly.
  if (grounded && !wasClimbing) figurine.smoothFeetY += (player.position.y - figurine.smoothFeetY) * Math.min(1, 10 * dt);
  else figurine.smoothFeetY = player.position.y;
  if (charModel) charModel.position.y = charFeetOffset + (figurine.smoothFeetY - player.position.y);

  updateClimbBlend(dt);
  updateLocomotion(grounded, moving); // early-returns while climbing
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

/** Nav-driven movement: horizontal motion confined to the walkable platform (with
 *  axis-separated edge-sliding so you slide along a wall instead of freezing),
 *  standing on the hole-filled NavGrid. Ballistic while airborne (jump/fall),
 *  landing on the platform at its real height. Returns whether we're grounded. */
function navMove(dt: number, radius: number): boolean {
  const nav = navGrid!, p = player.position;
  const band = charH * PLATFORM_OPTS.stepFactor; // max step you can walk up/down
  if (figurine.state === 'air') {
    velocity.y += TUNE.gravity * charH * dt;
    const prevY = p.y;
    // horizontal = input (air control) + any launch velocity (e.g. jumping off a wall)
    const vx = hVel.x + velocity.x, vz = hVel.z + velocity.z;
    p.x += vx * dt; p.z += vz * dt; p.y += velocity.y * dt;
    // Walls are solid in the air too. Touching one we're travelling INTO is how a jump
    // grabs it — if it's climbable we start climbing right there, otherwise it simply
    // stops us and we slide along it.
    const push = pushOutOfWalls(p.y, radius);
    if (push > 1e-5) {
      const nx = wallCorr.x / push, nz = wallCorr.z / push; // out of the wall
      if (vx * nx + vz * nz < 0) {
        // Only grab a wall that stands on ground we could drop back to. In the air
        // nothing confines us to the walkable area, so a jump can sail past its edge
        // (or through a gap in the scan) — the faces out there hang over nothing, and
        // grabbing one strands us.
        const ground = climbGround(p.y + radius * 0.5, -nx, -nz);
        if (!ground) { if (TEL) console.log(`CLIMB-NO (mid-air) no ground below y=${p.y.toFixed(2)}`); }
        else if (tryStartClimb(-nx, -nz, p.y)) return false;
      }
      const into = velocity.x * nx + velocity.z * nz;       // a launch can't keep driving into it
      if (into < 0) { velocity.x -= into * nx; velocity.z -= into * nz; }
    }
    if (velocity.y <= 0) {
      // SWEPT landing: query from where the feet WERE this frame, so a fast fall
      // (jumping off a wall) catches any surface crossed during the step instead of
      // stepping straight over the narrow band at the new position.
      const floor = nav.surfaceBelow(p.x, p.z, prevY + radius * 0.5);
      if (floor !== null && p.y <= floor) { p.y = floor; velocity.set(0, 0, 0); figurine.supportY = floor; lastGood.copy(p); return true; }
    }
    return false;
  }
  // grounded: walk on the nav (step / slide / step-down), then push out of walls
  const moving = hVel.x !== 0 || hVel.z !== 0;
  if (moving) navHorizontal(hVel.x * dt, hVel.z * dt, band);
  // walls and furniture are solid: push the body out of them sideways
  if (moving) pushOutOfWalls(figurine.supportY, radius);
  // Moving into a wall right ahead? Start climbing it. (Triggering off the wall
  // itself — not a near-head-on "block" — makes it fire consistently at any angle.)
  if (moving && tryStartClimb(hVel.x, hVel.z)) return false;
  // Walking off a ledge whose face is a wall? Grab the lip and climb down.
  if (moving && tryStartClimbDown(hVel.x, hVel.z)) return false;
  const here = nav.surfaceNear(p.x, p.z, figurine.supportY, band);
  if (here !== null) { p.y = here; figurine.supportY = here; velocity.set(0, 0, 0); lastGood.copy(p); return true; }
  if (nav.nearest(lastGood.x, lastGood.z, figurine.supportY, navRecover)) { p.copy(navRecover); figurine.supportY = navRecover.y; velocity.set(0, 0, 0); lastGood.copy(p); } // recovered
  return true;
}

/** Move on the nav: onto a continuing surface (small step up/down), sliding along a
 *  wall/edge, or a controlled step-DOWN onto a lower platform. Leaves the position
 *  unchanged if there's nowhere to go. */
function navHorizontal(dx: number, dz: number, band: number): void {
  const nav = navGrid!, p = player.position, x0 = p.x, z0 = p.z, tx = x0 + dx, tz = z0 + dz;
  if (nav.surfaceNear(tx, tz, figurine.supportY, band) !== null) { p.x = tx; p.z = tz; return; } // continues
  // slide: one axis at a time, the second from wherever the first left us — applying
  // both from the start would be the diagonal step that was just refused
  if (dx !== 0 && nav.surfaceNear(tx, z0, figurine.supportY, band) !== null) p.x = tx;
  if (dz !== 0 && nav.surfaceNear(p.x, tz, figurine.supportY, band) !== null) p.z = tz;
  if (p.x !== x0 || p.z !== z0) return;
  const down = nav.surfaceBelow(tx, tz, figurine.supportY - band);
  if (down !== null && figurine.supportY - down <= charH * STEP_DOWN_MAX) { p.x = tx; p.z = tz; figurine.supportY = down; }
}

/** Raw capsule-vs-mesh collide-and-slide (the pre-nav movement, kept for A/B). One
 *  unified pass handles walls, floor, steps and slopes. Returns whether grounded. */
function meshMove(dt: number, radius: number): boolean {
  if (!collision) return false;
  const segLen = Math.max(0.02, charH - 2 * radius);
  const subdt = dt / PHYSICS_STEPS;
  let grounded = false;
  for (let s = 0; s < PHYSICS_STEPS; s++) {
    velocity.y += TUNE.gravity * charH * subdt;
    disp.set(hVel.x * subdt, velocity.y * subdt, hVel.z * subdt);
    collision.moveCapsule(player.position, radius, segLen, disp, correction);
    // `correction` is the depenetration push-out only (excludes the move above),
    // so jumping up (no penetration) is not mistaken for standing on ground.
    if (correction.y > Math.abs(subdt * velocity.y * 0.25)) { velocity.set(0, 0, 0); grounded = true; }
    else if (correction.lengthSq() > 1e-12) { slideN.copy(correction).normalize(); velocity.addScaledVector(slideN, -slideN.dot(velocity)); }
  }
  // stick to a small down-step rather than briefly launching (kills stair-edge jitter)
  if (!grounded && figurine.wasGrounded && velocity.y <= 0) {
    const gy = collision.groundHeightAt(player.position.x, player.position.z, player.position.y + radius);
    if (gy <= player.position.y && player.position.y - gy < charH * 0.35) { player.position.y = gy; velocity.set(0, 0, 0); grounded = true; }
  }
  return grounded;
}

/** Drive the animation state machine from grounded + movement. */
function updateLocomotion(grounded: boolean, moving: boolean): void {
  if (figurine.state === 'climb') return; // climbing owns its own state + animation
  if (!grounded) {
    if (figurine.state !== 'air') { figurine.state = 'air'; play(actions['jump_loop'] ? 'jump_loop' : 'idle', 0.15); }
    return;
  }
  if (figurine.state === 'air') { // just landed
    if (actions['jump_land']) { figurine.state = 'land'; play('jump_land', 0.06); return; }
    figurine.state = 'ground';
  }
  if (figurine.state === 'land') return; // let the land clip finish (onActionFinished → ground)
  figurine.state = 'ground';
  play(moving ? (move.run && actions['run'] ? 'run' : 'walk') : 'idle');
}
