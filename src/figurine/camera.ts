// The follow camera: a spring arm from the figurine that shortens when something is in
// the way and swings round behind a climber, and the opening shot (context/climb.md,
// "Follow camera"). Also the fixed debug camera (?az, ?el, ?dist, ?cx, ?cy, ?cz).

import * as THREE from 'three';
import { BODY, camera, figurine, FREECAM_OPTS, move, orbit, orbitCamera, player, TARGET_RADIUS, TUNE, WORLD_UP } from '../app';
import { collision } from '../collision/room-collision';
import { gatherSight, seeThrough } from '../scan/splat-sight';
import { charH } from './character';
import { climbDir } from './climb';
import { lerpAngle } from './controller';

orbit.addEventListener('start', () => { camLatch.handsOff = false; camSwinging = false; camLatch.basisHeld = false; }); // the user's hand on the camera always wins over the auto-swing
const camLook = new THREE.Vector3(), camDir = new THREE.Vector3();
const CAM_PIVOT = 0.7; // the camera looks at the figurine this far up its height (about head centre)
/** The opening shot (`resetToSpawn`): the camera's arm from the pivot, in figurine
 *  heights. In front of the figurine (which faces +Z unturned), a little to one side,
 *  looking down at it. */
const CAM_START = new THREE.Vector3(1.2, 2.6 - CAM_PIVOT, 4.5);
/** How high the opening shot's camera is over the figurine's feet, in figurine heights: the
 *  start is looked for where nothing is over it up to here (resetToSpawn), so the shot sees it. */
export const CAM_START_HEIGHT = CAM_PIVOT + CAM_START.y;
const CAM_START_TURNS = 16; // sides of the figurine the opening shot may be turned to: 22.5° apart

// The follow camera is a spring arm from the pivot (the figurine) to the camera. The
// arm's full length (`camWant`) is the user's zoom: the distance of OrbitControls' own
// camera (`orbitCamera`, app.ts), which nothing else moves. When something blocks the
// view, the camera that is shown (`camera`) sits on the same line but shorter, by
// `camPull`, so the zoom is untouched and the view springs back out once it is clear.
export let camWant = 0;          // arm length with nothing in the way (the user's zoom)
let camPull = 1;          // rendered arm = camWant * camPull (1 = unobstructed)
export let camSwinging = false;  // coming round to the figurine's back (see updateCamera)
const camHome = new THREE.Vector3();
/** Who the camera answers to, set from several places: the climb, the keys, and the user's hand on it. */
export const camLatch = {
  handsOff: true,     // the user hasn't orbited/zoomed since this climb began → auto-swing allowed
  basisHeld: false,   // movement keys keep the camera frame they were pressed in (see updateController)
};

/** Glue the orbit pivot to the figurine so the camera follows while the user
 *  orbits/zooms; show the view pulled in if something is between it and the pivot; and,
 *  on a wall, bring it round behind the figurine if that wall is what's in the way. */
export function updateCamera(dt: number): void {
  const t = orbit.target;
  camLook.set(player.position.x + figurine.drawn.x, figurine.smoothFeetY + charH * CAM_PIVOT, player.position.z + figurine.drawn.z); // the drawn figure (it catches up after a move over a top)
  t.lerp(camLook, 0.15);
  // Climbing puts the figurine flat against a wall, so a camera left on the wall's far
  // side (e.g. it walked off a ledge and now hangs on the face below) can't be fixed by
  // shortening the arm — the wall is closer than the figurine is wide. Swing round to
  // the open side instead: behind the figurine's back.
  if (figurine.state !== 'climb') camSwinging = false;
  if (camSwinging) {
    const ox = orbitCamera.position.x - t.x, oz = orbitCamera.position.z - t.z; // (the swing re-aims what the player looks from)
    const cur = Math.atan2(ox, oz), home = Math.atan2(-climbDir.x, -climbDir.z);
    const a = lerpAngle(cur, home, TUNE.camSwing * dt) - cur;
    const c = Math.cos(a), sn = Math.sin(a);
    orbitCamera.position.x = t.x + ox * c + oz * sn;
    orbitCamera.position.z = t.z + oz * c - ox * sn;
    if (Math.abs(lerpAngle(cur, home, 1) - cur) < 0.05) camSwinging = false; // arrived
  }
  orbit.update();
  camDir.subVectors(orbitCamera.position, t);
  camWant = camDir.length();
  if (!collision || camWant < 1e-4) { camPull = 1; showView(); return; }
  camDir.divideScalar(camWant);
  const clear = collision.rayDistance(t, camDir, camWant);
  const blocked = clear < camWant;
  // Offer the swing only while the user is leaving the camera alone, and only if the
  // view from behind the figurine is actually clearer than this one — otherwise it
  // would trade one blocked view for another and fight every attempt to orbit out of it.
  if (blocked && figurine.state === 'climb' && camLatch.handsOff && !camSwinging) {
    const flat = Math.hypot(camDir.x, camDir.z); // keep the current elevation
    camHome.set(-climbDir.x * flat, camDir.y, -climbDir.z * flat);
    if (collision.rayDistance(t, camHome, camWant) > clear) {
      camSwinging = true;
      camLatch.basisHeld = !!(move.f || move.b || move.l || move.r); // keys already down keep steering by the view they were pressed in
    }
  }
  // shorten fast (don't show the inside of a wall), lengthen gently (an occluder that
  // flickers in and out — thin leaves, scan lumps — then holds the arm instead of shaking it)
  // ...but never closer than the distance at which the figurine still fits in frame
  // (its tallest half, pivot → feet, filling half the view): nearer than that there is
  // no picture of it to show, only the inside of its head. If the occluder is nearer
  // still, it stays in shot until the view clears or the camera comes round.
  const closest = (charH * CAM_PIVOT) / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const goal = blocked ? Math.max(clear - charH * 0.15, Math.min(closest, camWant)) / camWant : 1;
  camPull += (Math.min(goal, 1) - camPull) * Math.min(1, (goal < camPull ? TUNE.camIn : TUNE.camOut) * dt);
  showView();
}

/** Put the camera that is shown where the player looks from, `camPull` of the way along
 *  the arm: facing as OrbitControls' camera faces, from the same line. */
function showView(): void {
  camera.position.lerpVectors(orbit.target, orbitCamera.position, camPull);
  camera.quaternion.copy(orbitCamera.quaternion);
}

/** Frame the figurine from scratch (resetToSpawn): the arm at full length, the pivot on
 *  the figurine, and the camera at the opening shot. */
export function frameOpeningShot(): void {
  camPull = 1; camSwinging = false;
  orbit.target.set(player.position.x, player.position.y + charH * CAM_PIVOT, player.position.z);
  // The opening shot, turned to a side of the figurine with a clear view of it. From a
  // fixed side, a room with something solid there (Living Room) opened with the camera
  // pulled in as close as it goes, filling the screen with the figurine's face. The
  // figurine turns with the shot, so every room opens on the same framing.
  const { turn } = openingView(orbit.target);
  player.rotation.y = turn;
  orbitCamera.position.copy(CAM_START).applyAxisAngle(WORLD_UP, turn).multiplyScalar(charH).add(orbit.target);
  orbit.update();
  showView();
}

/** The opening shot sees the figurine when this much of it shows past the splats (seeThrough,
 *  averaged over its sight lines): three quarters, so a wisp across it passes and a wall of
 *  floaters does not. Living Room opened behind 56 floaters that let none of it through,
 *  on a side the collision called clear: the mesh leaves floaters out. */
const OPENING_SEES = 0.75;
const SIGHT_AT = [0.25, 0.55, 0.85]; // where the shot's sight lines end on the figurine, as shares of its height: legs, body, head
const sightCam = new THREE.Vector3(), sightTo = new THREE.Vector3(), sightBack = new THREE.Vector3(), sightPivot = new THREE.Vector3();

/** How far to turn the opening shot about the figurine, pivot at `pivot`, and how much of the
 *  figurine it then sees (0 to 1). The side nearest the unturned one whose arm meets no
 *  collision and sees enough of the figurine past the splats; failing that, of the sides
 *  clear of the collision the one that sees the most; failing that, the one that sees
 *  furthest. Unturned when there is no collision yet to test against. */
export function openingView(pivot: THREE.Vector3): { turn: number; sees: number } {
  if (!collision) return { turn: 0, sees: 1 };
  const len = CAM_START.length() * charH, step = (Math.PI * 2) / CAM_START_TURNS;
  const feetY = pivot.y - charH * CAM_PIVOT, body = BODY.radius * charH;
  const splats = gatherSight(pivot, len + charH, feetY + charH * SIGHT_AT[0]); // (no sight line goes lower than its end on the legs)
  let best = 0, bestSees = 0, bestRank = -1;
  for (let i = 0; i < CAM_START_TURNS; i++) {
    const turn = (i % 2 ? 1 : -1) * Math.ceil(i / 2) * step; // 0, +1, -1, +2, -2 … steps: nearest the unturned shot first
    camDir.copy(CAM_START).applyAxisAngle(WORLD_UP, turn).normalize();
    const clear = collision.rayDistance(pivot, camDir, len);
    let sees = 0;
    if (clear >= len) {
      sightCam.copy(pivot).addScaledVector(camDir, len);
      sees = 1;
      if (splats) {
        sees = 0;
        for (const at of SIGHT_AT) {
          sightTo.set(pivot.x, feetY + charH * at, pivot.z);
          sightTo.addScaledVector(sightBack.subVectors(sightTo, sightCam).normalize(), -body); // (to the near side of the body: splats inside it are hidden by it)
          sees += seeThrough(sightCam, sightTo) / SIGHT_AT.length;
        }
      }
      if (sees >= OPENING_SEES) return { turn, sees };
    }
    const rank = clear >= len ? 1 + sees : clear / len; // clear of the collision first, then by what it sees
    if (rank > bestRank) { best = turn; bestSees = sees; bestRank = rank; }
  }
  return { turn: best, sees: bestSees };
}

/** Would the opening shot see the figurine standing at `feet` (resetToSpawn: a start it
 *  cannot see looks broken)? */
export function openingSees(feet: THREE.Vector3): boolean {
  return openingView(sightPivot.set(feet.x, feet.y + charH * CAM_PIVOT, feet.z)).sees >= OPENING_SEES;
}

/** The camera let off the figurine (the Debug card's "Free camera"): drag to orbit, right-drag
 *  to pan, scroll to zoom, as near or far as you like, for looking round a scan. The follow
 *  camera's limits are kept (setFollowDistance) and put back when it is turned off. */
export const GOD_CAM = { on: false };
const followLimits = { min: 0, max: Infinity, pan: false, polar: Math.PI };
/** How near and far the follow camera may be (the character's size sets it, character.ts): kept
 *  here, and applied unless the free camera is on, which would otherwise have them reset under it. */
export function setFollowDistance(min: number, max: number): void {
  followLimits.min = min; followLimits.max = max;
  if (!GOD_CAM.on) { orbit.minDistance = min; orbit.maxDistance = max; }
}
export function setGodCam(on: boolean): void {
  if (on === GOD_CAM.on) return;
  GOD_CAM.on = on;
  if (on) {
    followLimits.pan = orbit.enablePan; followLimits.polar = orbit.maxPolarAngle;
    orbit.minDistance = 0; orbit.maxDistance = Infinity; orbit.enablePan = true; orbit.maxPolarAngle = Math.PI;
  } else {
    orbit.minDistance = followLimits.min; orbit.maxDistance = followLimits.max; orbit.enablePan = followLimits.pan; orbit.maxPolarAngle = followLimits.polar;
  }
}
export function updateGodCam(): void {
  orbit.update();
  camera.position.copy(orbitCamera.position);
  camera.quaternion.copy(orbitCamera.quaternion);
}

/** Debug free-camera: park at a fixed spherical orbit around the look-at point
 *  (see FREECAM_OPTS). Deterministic — lets a headless screenshot frame any region. */
const freeCenter = new THREE.Vector3();
export function updateFreeCam(): void {
  const { az, el, dist, cx, cy, cz } = FREECAM_OPTS;
  freeCenter.set(cx, cy, cz);
  const r = TARGET_RADIUS * dist;
  camera.position.set(
    cx + r * Math.cos(el) * Math.sin(az),
    cy + r * Math.sin(el),
    cz + r * Math.cos(el) * Math.cos(az),
  );
  camera.lookAt(freeCenter);
  orbit.target.copy(freeCenter);
}
