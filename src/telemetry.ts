// ?tel=1 only: what the headless checks read (window.__dbg, the collision health
// numbers for scripts/collisioncheck.mjs, the matte view for scripts/holes.mjs).

import * as THREE from 'three';
import { BODY, camera, figurine, FREECAM_OPTS, GRAIN, orbit, player, surround, TARGET_RADIUS, TEL, velocity, WORLD_DOWN, WORLD_UP } from './app';
import { cellsPerGrain, collision, collisionDebug, lastVoxelSize, navField, platformDebug } from './collision/room-collision';
import { camSwinging, camWant } from './figurine/camera';
import { activeMove, charH } from './figurine/character';
import { chestInside, CLIMB, climbCling, climbDir, climbStartsHere, climbTiltShown, climbWall, isWall } from './figurine/climb';
import { airJumpHeights, bodyOverlap } from './figurine/controller';
import { launchSpeed, MOVE } from './figurine/movement';
import { scanDebugThumb, scanDebugThumbRect } from './lighting/scan-light';
import { currentSplat, lastCenters, lastMatrix, lastOpacity, revealProgress } from './scan/room';
import { applyFillView, FILL_VIEW, WALK_FILL } from './scan/walk-fill';

/** ?tel=1 only: publish the controller's state on `window.__dbg` for the headless
 *  tests. While climbing, `probe` is the nearest surface ahead of / behind / above /
 *  below the chest, tagged F or B for the side it was seen from. A B ahead, behind or
 *  above means the climber is inside something solid, which must never happen. (Below
 *  is informational: the flattened floor's top and underside coincide.) `sunk` is how
 *  deep the climber's body is in the mesh, in capsule radii. */
const dbgAt = new THREE.Vector3(), dbgDir = new THREE.Vector3();
export function publishDebugState(): void {
  const P = player.position;
  let probe: unknown = null, sunk: number | null = null; // sunk: how deep the body is in the mesh, in capsule radii
  if (collision && figurine.state === 'climb') {
    const c = collision;
    dbgAt.set(P.x, P.y + charH * CLIMB.chest, P.z);
    const see = (dir: THREE.Vector3, max: number) => { const w = c.wallAhead(dbgAt, dir, max); return w ? `${w.distance.toFixed(2)}${w.front ? 'F' : 'B'}` : '-'; };
    probe = { ahead: see(climbDir, charH * 2), behind: see(dbgDir.copy(climbDir).negate(), charH * 2), above: see(WORLD_UP, charH * 20), below: see(WORLD_DOWN, charH * 20) };
    sunk = +(bodyOverlap(P.x, P.y, P.z, BODY.radius * charH) / (BODY.radius * charH)).toFixed(2);
  }
  (window as unknown as { __dbg?: unknown }).__dbg = {
    state: figurine.state, cling: climbCling, probe, sunk, tilt: +climbTiltShown().toFixed(1),
    inside: figurine.state === 'climb' ? chestInside(P.x, P.y, P.z, climbDir) : null, // the climber's chest inside something solid (the climb fuzz's rule)
    px: +P.x.toFixed(3), py: +P.y.toFixed(3), pz: +P.z.toFixed(3),
    speed: +(Math.hypot(velocity.x, velocity.z) / charH).toFixed(2), vy: +(velocity.y / charH).toFixed(2), // body heights a second: across, and up
    climbYaw: +THREE.MathUtils.radToDeg(Math.atan2(climbDir.x, climbDir.z)).toFixed(1),
    camDist: +camera.position.distanceTo(orbit.target).toFixed(2), camWant: +camWant.toFixed(2), camSwinging,
    move: activeMove, // the move the figurine is showing (characters.ts)
    reveal: +revealProgress.toFixed(3), // how much of the room is in place: 0 while waiting, 1 once it has arrived
    lightView: scanDebugThumb?.visible ? scanDebugThumbRect() : null, // where the scan light's panorama is on screen, while its debug view is on
  };
}

/** For the collision health check: is there a face the figurine could climb from
 *  standing at (ax, ay, az) up to the surface at (bx, by, bz)? That is, a wall in front of
 *  it, on the way from one to the other, at every height from its feet to where a mantle
 *  takes over. Probed as the climb itself probes (climbWall, isWall). */
const faceFrom = new THREE.Vector3(), faceDir = new THREE.Vector3();
function climbableFace(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
  const away = faceDir.set(bx - ax, 0, bz - az).length();
  if (away < 1e-6) return false; // straight overhead: nothing to climb from here
  faceDir.divideScalar(away);
  const up = lastVoxelSize, top = by - charH * CLIMB.mantleUp; // (probed at every cell of the grid, up to where a mantle reaches: a surface this far above the feet)
  for (let h = Math.min(ay + up / 2, (ay + by) / 2); ; h = Math.min(top, h + up)) {
    const w = climbWall(faceFrom.set(ax, h, az), faceDir, away + GRAIN);
    if (!w || !isWall(w)) return false;
    if (h >= top) return true;
  }
}

// ?tel=1 only: what `scripts/collisioncheck.mjs` reads. The measuring is in its own module,
// loaded when asked for, so none of it is part of normal play.
if (TEL) (window as unknown as { __collisionHealth?: () => Promise<unknown> }).__collisionHealth = async () => {
  if (!navField || !collisionDebug || !lastCenters || !lastOpacity) return null; // no room yet
  const { collisionHealth } = await import('./collision/collision-health');
  return collisionHealth({
    walk: navField,
    mesh: { positions: collisionDebug.geometry.attributes.position.array, index: collisionDebug.geometry.index!.array },
    splats: { centers: lastCenters.array, opacity: lastOpacity, count: lastCenters.count, matrix: lastMatrix.elements },
    spawn: [player.position.x, player.position.y, player.position.z],
    unit: GRAIN,
    realCells: Math.round(WALK_FILL.patch * cellsPerGrain() ** 2), // the same line the gap fill draws between ground and a scrap
    move: { jumpVel: launchSpeed(MOVE.jumpHeight) * charH, gravity: MOVE.gravity * charH, runSpeed: MOVE.sprintSpeed * charH, climbOver: BODY.radius * charH * CLIMB.mantleOver, fallGravity: MOVE.fallGravity, airJumpVels: airJumpHeights().map((h) => launchSpeed(h) * charH) },
    climbable: climbableFace,
    blocked: (ox, oy, oz, dx, dy, dz) => !!collision && collision.wallAhead(faceFrom.set(ox, oy, oz), faceDir.set(dx, dy, dz), TARGET_RADIUS * 4) !== null, // (further than any scan reaches)
    eyeHeight: charH * 0.5,
    climbStarts: (x, y, z, dx, dz) => climbStartsHere(x, y, z, faceDir.set(dx, 0, dz)),
  });
};

/** ?tel=1 only: what `scripts/holes.mjs` measures the scan's gaps with. While
 *  `window.__matte` is set, the view is the scan alone, or the collision mesh alone drawn
 *  solid (with or without its backstop plane), over a backdrop of the given colour, from
 *  the given fixed camera (needs a camera parameter in the URL). Two backdrops give each
 *  pixel's opacity. `fill` sets how much of the gap fill is drawn (as the Debug card's "Fill opacity" does). It does not undo itself. */
type MatteView = { mode: 'splat' | 'mesh' | 'meshNoPlane'; bg: [number, number, number]; cam?: Partial<typeof FREECAM_OPTS>; fill?: number };
export function applyMatteView(): void {
  const view = (window as unknown as { __matte?: MatteView }).__matte;
  if (!view || !currentSplat || !collisionDebug) return;
  if (view.cam) Object.assign(FREECAM_OPTS, view.cam);
  if (view.fill !== undefined && view.fill !== FILL_VIEW.opacity) { FILL_VIEW.opacity = view.fill; applyFillView(); }
  surround.setRGB(view.bg[0], view.bg[1], view.bg[2], THREE.SRGBColorSpace);
  player.visible = false;
  if (platformDebug) platformDebug.visible = false;
  currentSplat.visible = view.mode === 'splat';
  collisionDebug.visible = view.mode !== 'splat';
  if (!(collisionDebug.material instanceof THREE.MeshBasicMaterial) || collisionDebug.material.wireframe) {
    (collisionDebug.material as THREE.Material).dispose();
    collisionDebug.material = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  }
  const indices = collisionDebug.geometry.index!.count;
  collisionDebug.geometry.setDrawRange(0, view.mode === 'meshNoPlane' ? indices - 6 : indices); // the voxelizer appends the backstop plane as the last two triangles
}
