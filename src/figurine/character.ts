// The figurine: its model and animations, where it starts, and the keys.

import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { buildClimbSideClip } from './climb-side-anim';
import { camera, CAPSULE_RADIUS, figurine, hud, move, orbit, player, q, TUNE, velocity } from '../app';
import { collision, groundY, navGrid, PLATFORM_OPTS, rebuildPlatformOverlay, setPlatformOverlay, setVoxelOverlay, showPlatforms, showVoxels } from '../collision/room-collision';
import { camLatch, frameOpeningShot } from './camera';
import { climbJumpOff } from './climb';
import { lastGood } from './controller';
import { requestScanLight } from '../lighting/scan-light';
import { loadingViewOn, setUpLoadingView, updateLoading } from '../scan/room';

const CONTRACT = [
  { name: 'idle', loop: true },
  { name: 'walk', loop: true },
  { name: 'run', loop: true },
  { name: 'climb', loop: true },
  { name: 'jump_start', loop: false },
  { name: 'jump_loop', loop: false, hold: true },
  { name: 'jump_land', loop: false },
] as const;
const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD']);
export let charH = 1;
export let charModel: THREE.Object3D | null = null;
export let charFeetOffset = 0;   // model's local y so its feet sit at the player origin
export let mixer: THREE.AnimationMixer | null = null;
export const actions: Record<string, THREE.AnimationAction> = {};
export let activeAction: THREE.AnimationAction | null = null;
export let charLoaded = false;

export function onLoaded(gltf: GLTF): void {
  const model = gltf.scene;
  player.add(model);
  setupMixer(gltf, model);
  if (actions['idle']) { play('idle', 0); mixer!.update(0); }
  model.updateMatrixWorld(true);
  const bb = measureSkinnedBounds(model);
  charH = Math.max(bb.max.y - bb.min.y, 1e-4);
  model.position.y = -bb.min.y; // feet at the player origin
  charModel = model;
  charFeetOffset = -bb.min.y;

  camera.near = charH * 0.02;
  camera.far = charH * 400;
  camera.updateProjectionMatrix();
  orbit.minDistance = charH * 2.5;
  orbit.maxDistance = charH * 14;

  play('idle', 0);
  charLoaded = true;
  setUpLoadingView(model);
  if (collision) rebuildPlatformOverlay(); // rebuild the NavGrid now charH (headroom/step) is real
  resetToSpawn();
  updateLoading(); // after the figurine is in its place: if the room was only waiting for it, this starts the room arriving around it
  requestScanLight();
  console.log(`character: ${charH.toFixed(3)} tall, ${gltf.animations.length} clips`);
}

/** Put the figurine at the room's own start (roomSpawn) and re-frame the camera behind it. */
const spawnAt = new THREE.Vector3();
export function resetToSpawn(): void {
  placeFigurine(roomSpawn(spawnAt), true);
}

/** Where the room starts the figurine, into `out`, without moving it. A theme may start it
 *  elsewhere (context/game.md); what can be reached, and the collision health numbers, are
 *  still measured from here. */
export function roomSpawn(out: THREE.Vector3): THREE.Vector3 {
  // On the ground (unless placed with ?fx=&fz=): the spot nearest the scan's centre,
  // at the level the scan's ground is (a room's floor, a table's top), where the figurine
  // fits. Without the level, findSpawn takes the lowest place near the centre with room
  // to stand, which need not be the ground: on Counter it is the inside of a glass bowl, a
  // step up from the worktop. That is kept for when nothing at the ground's level fits.
  // (The walkable cell nearest the centre is not enough: a cell only has room overhead at
  // one point, and Kitchen's nearest is the table under the Lego bulldozer, between its
  // tracks, where the figurine is boxed in.)
  if (q.has('fx') || q.has('fz')) {
    out.set(Number(q.get('fx') ?? 0), 0, Number(q.get('fz') ?? 0));
  } else if (collision && charH > 0) {
    const radius = CAPSULE_RADIUS * charH, segLen = Math.max(0.02, charH - 2 * radius);
    if (groundY === null || !collision.findSpawn(radius, segLen, out, groundY, charH * PLATFORM_OPTS.stepFactor))
      collision.findSpawn(radius, segLen, out);
  } else {
    out.set(0, 0, 0);
  }
  const s = navGrid?.surfaceNear(out.x, out.z, out.y, charH) ?? null; // on the NavGrid's surface there, as placeFigurine stands it
  if (s !== null) out.y = s;
  return out;
}

/** Stand the figurine at `at`, still, on the walkable surface there. `opening` frames the
 *  room's opening shot behind it (a start); without it the follow camera just catches up
 *  (a theme putting it back somewhere safe). */
export function placeFigurine(at: THREE.Vector3, opening: boolean): void {
  player.position.copy(at);
  // align with the NavGrid so the reliability layer picks it up cleanly
  const s = navGrid?.surfaceNear(player.position.x, player.position.z, player.position.y, charH) ?? null;
  if (s !== null) player.position.y = s;
  player.rotation.set(0, 0, 0);
  velocity.set(0, 0, 0);
  figurine.wasGrounded = false;
  figurine.supportY = player.position.y;         // stand on the spawn surface
  lastGood.copy(player.position);
  figurine.smoothFeetY = player.position.y;
  if (charModel) charModel.position.y = charFeetOffset;
  figurine.state = 'ground';
  if (opening) frameOpeningShot();
}

function setupMixer(gltf: GLTF, model: THREE.Object3D): void {
  mixer = new THREE.AnimationMixer(model);
  const clipByName: Record<string, THREE.AnimationClip> = {};
  gltf.animations.forEach((c) => (clipByName[c.name] = c));
  for (const spec of CONTRACT) {
    const clip = clipByName[spec.name];
    if (!clip) continue;
    const a = mixer.clipAction(clip);
    if (spec.loop) a.setLoop(THREE.LoopRepeat, Infinity);
    else { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
    actions[spec.name] = a;
  }
  // Sideways climbing has no authored clip — derive a shimmy each way from `climb`.
  // They run permanently at zero weight; updateClimbBlend mixes them in on the wall.
  if (clipByName['climb']) {
    for (const [name, dir] of [['climb_side_r', 1], ['climb_side_l', -1]] as const) {
      const clip = buildClimbSideClip(clipByName['climb'], model, dir, name);
      if (!clip) continue;
      const a = mixer.clipAction(clip);
      a.setLoop(THREE.LoopRepeat, Infinity);
      a.weight = 0; a.paused = true;
      a.play();
      actions[name] = a;
    }
  }
  mixer.addEventListener('finished', onActionFinished);
}

function measureSkinnedBounds(model: THREE.Object3D): THREE.Box3 {
  const bounds = new THREE.Box3();
  const v = new THREE.Vector3();
  let bones = 0;
  model.traverse((o) => { if ((o as THREE.Bone).isBone) { o.getWorldPosition(v); bounds.expandByPoint(v); bones++; } });
  if (!bones) bounds.setFromObject(model);
  return bounds;
}

export function play(name: string, fade = TUNE.fade): void {
  const next = actions[name];
  if (!next || next === activeAction) return;
  next.reset().play();
  const spec = CONTRACT.find((s) => s.name === name);
  if (spec && !spec.loop) { next.setLoop(THREE.LoopOnce, 1); next.clampWhenFinished = true; }
  if (activeAction) activeAction.crossFadeTo(next, fade, false);
  activeAction = next;
}

function onActionFinished(e: { action: THREE.AnimationAction }): void {
  const name = e.action.getClip().name;
  if (name === 'jump_start') { velocity.y = TUNE.jumpVel * charH; figurine.state = 'air'; play('jump_loop', 0.08); }
  else if (name === 'jump_land') { figurine.state = 'ground'; play('idle', 0.25); }
}

function keyEvent(e: KeyboardEvent, v: 0 | 1): void {
  // A key pressed on a UI control, or while the title screen is up, is not for the game.
  // Releases always get through, so a held key can never stick down.
  if (v && (hud.titleOpen() || hud.owns(e.target))) return;
  if (v) switch (e.code) { // the app's own keys work whether or not there is a room
    case 'KeyV': setVoxelOverlay(!showVoxels); return;
    case 'KeyP': setPlatformOverlay(!showPlatforms); return;
    case 'Backquote': hud.toggleDebug(); return;
  }
  if (v && loadingViewOn()) return; // the rest are the figurine's, which cannot move until there is a room
  if (v && !e.repeat && MOVE_KEYS.has(e.code)) camLatch.basisHeld = false; // a fresh press is a fresh intent, in the current view
  switch (e.code) {
    case 'KeyW': move.f = v; break;
    case 'KeyS': move.b = v; break;
    case 'KeyA': move.l = v; break;
    case 'KeyD': move.r = v; break;
    case 'ShiftLeft': case 'ShiftRight': move.run = !!v; break;
    case 'Space': if (v) jumpKey(); e.preventDefault(); break;
  }
}
addEventListener('keydown', (e) => keyEvent(e, 1));
addEventListener('keyup', (e) => keyEvent(e, 0));

/** The jump key: a jump from the ground, or off the wall when climbing. */
export function jumpKey(): void {
  if (figurine.state === 'ground') startJump();
  else if (figurine.state === 'climb') climbJumpOff();
}

function startJump(): void {
  if (actions['jump_start']) { figurine.state = 'jump_start'; play('jump_start', 0.06); }
  else { velocity.y = TUNE.jumpVel * charH; figurine.state = 'air'; play(actions['jump_loop'] ? 'jump_loop' : 'idle', 0.08); }
}
