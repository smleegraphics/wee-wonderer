// The figurine: its model and how it shows each move, where it starts, and the keys.

import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { camera, CAPSULE_RADIUS, figurine, hud, move, orbit, player, q } from '../app';
import { collision, groundY, navGrid, PLATFORM_OPTS, rebuildPlatformOverlay, setPlatformOverlay, setVoxelOverlay, showPlatforms, showVoxels } from '../collision/room-collision';
import { loadout } from './abilities';
import { camLatch, frameOpeningShot } from './camera';
import { CHARACTERS, type Move, MOVE_FALLBACK, MOVE_PLAYS } from './characters';
import { jumpKey, jumpRelease, lastGood, resetMotion, setLoadout } from './controller';
import { useMoveSettings } from './movement';
import { requestScanLight } from '../lighting/scan-light';
import { loadingViewOn, setUpLoadingView, updateLoading } from '../scan/room';

/** The character in play. One for now; choosing one is a later piece of work. */
export const CHARACTER = CHARACTERS[0];
const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD']);
const FADE = 0.18; // seconds: how long one move's clip blends into the next, unless asked otherwise
export let charH = 1;
export let charModel: THREE.Object3D | null = null;
export let mixer: THREE.AnimationMixer | null = null;
const actions: Partial<Record<Move, THREE.AnimationAction>> = {}; // one per move the character shows (its own clip, or a held frame)
export let activeMove: Move | null = null;  // the move whose action is playing
let activeAction: THREE.AnimationAction | null = null;
const heldAt = new Map<THREE.AnimationAction, number>(); // the actions that hold one frame, and its time
export let charLoaded = false;

export function onLoaded(gltf: GLTF): void {
  useMoveSettings(CHARACTER.tune);
  setLoadout(loadout(CHARACTER.abilities));
  const model = gltf.scene;
  setupMixer(gltf, model);
  play('idle', 0);
  mixer!.update(0);
  // Scaled to the character's height, measured standing in its idle pose with skinning
  // applied (a skinned mesh's own bounds are its bind pose: context/technical-notes.md).
  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model, true);
  model.scale.setScalar(CHARACTER.height / Math.max(bounds.max.y - bounds.min.y, 1e-6));
  model.updateMatrixWorld(true);
  bounds.setFromObject(model, true);
  charH = Math.max(bounds.max.y - bounds.min.y, 1e-4);
  const feet = -bounds.min.y; // lift so its feet are at the player's origin
  const holder = new THREE.Group(); // carries that lift: the controller moves `charModel` for its smoothing alone
  model.position.y = feet;
  holder.add(model);
  player.add(holder);
  charModel = holder;

  camera.near = charH * 0.02;
  camera.far = charH * 400;
  camera.updateProjectionMatrix();
  orbit.minDistance = charH * 2.5;
  orbit.maxDistance = charH * 14;

  charLoaded = true;
  setUpLoadingView(model);
  if (collision) rebuildPlatformOverlay(); // rebuild the NavGrid now charH (headroom/step) is real
  resetToSpawn();
  updateLoading(); // after the figurine is in its place: if the room was only waiting for it, this starts the room arriving around it
  requestScanLight();
  console.log(`character: ${CHARACTER.id}, ${charH.toFixed(3)} tall, can ${[CHARACTER.climbs ? 'climb' : '', ...CHARACTER.abilities].filter(Boolean).join(', ') || 'nothing extra'}`);
}

/** An action for each move the character's entry gives a clip for: the clip played (looping or
 *  once, MOVE_PLAYS), or one frame of it held still. */
function setupMixer(gltf: GLTF, model: THREE.Object3D): void {
  mixer = new THREE.AnimationMixer(model);
  const clipByName = new Map(gltf.animations.map((c) => [c.name, c]));
  for (const [m, use] of Object.entries(CHARACTER.clips) as [Move, NonNullable<typeof CHARACTER.clips[Move]>][]) {
    const name = typeof use === 'string' ? use : use.clip, clip = clipByName.get(name);
    if (!clip) { console.warn(`character ${CHARACTER.id}: no clip "${name}" for ${m}`); continue; }
    // a held frame is its own action (the clip played from that frame, paused), so it can blend like any other
    const a = mixer.clipAction(typeof use === 'string' ? clip : clip.clone(), model);
    if (typeof use !== 'string') { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; a.time = use.hold; a.paused = true; }
    else if (MOVE_PLAYS[m] === 'loop') a.setLoop(THREE.LoopRepeat, Infinity);
    else { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
    if (typeof use !== 'string') heldAt.set(a, use.hold);
    actions[m] = a;
  }
}

/** The move whose action shows `m`: `m` itself, or the first down its fallback chain the character has. */
function shownBy(m: Move): Move | null {
  for (let at: Move | undefined = m; at; at = MOVE_FALLBACK[at]) if (actions[at]) return at;
  return null;
}

/** Is `m` (or what shows it) a one-off clip still playing out? A loop or a held frame never is, so
 *  nothing waits on one (a landing shown by the idle loop must not hold the figurine still). */
export function moveIsPlaying(m: Move): boolean {
  const a = activeAction;
  return !!a && shownBy(m) === activeMove && a.loop === THREE.LoopOnce && !heldAt.has(a) && a.isRunning();
}

/** Play move `m`, blending over `fade` seconds. Playing what already plays does nothing, unless
 *  `again`: then it starts over (the air jump pushing off on the take-off's clip). */
export function play(m: Move, fade = FADE, again = false): void {
  const shown = shownBy(m);
  if (!shown) return;
  const next = actions[shown]!;
  if (next === activeAction) { if (again) restart(next); return; }
  restart(next);
  if (activeAction) activeAction.crossFadeTo(next, fade, false);
  activeAction = next; activeMove = shown;
}

function restart(a: THREE.AnimationAction): void {
  a.reset().play();
  a.timeScale = 1;
  const hold = heldAt.get(a);
  if (hold !== undefined) { a.time = hold; a.paused = true; }
}

/** Play the current clip at `pace` times its authored speed, so the feet keep up with the
 *  figurine while it speeds up and slows down (within reason: a crawl is not a slow-motion walk). */
export function setMovePace(pace: number): void {
  if (activeAction && !heldAt.has(activeAction)) activeAction.timeScale = Math.min(1.3, Math.max(0.6, pace));
}

/** Put the figurine on the floor at the spawn point and re-frame the camera behind it. */
export function resetToSpawn(): void {
  // Start on the ground (unless placed with ?fx=&fz=): the spot nearest the scan's centre,
  // at the level the scan's ground is (a room's floor, a table's top), where the figurine
  // fits. Without the level, findSpawn takes the lowest place near the centre with room
  // to stand, which need not be the ground: on Counter it is the inside of a glass bowl, a
  // step up from the worktop. That is kept for when nothing at the ground's level fits.
  // (The walkable cell nearest the centre is not enough: a cell only has room overhead at
  // one point, and Kitchen's nearest is the table under the Lego bulldozer, between its
  // tracks, where the figurine is boxed in.)
  if (q.has('fx') || q.has('fz')) {
    player.position.set(Number(q.get('fx') ?? 0), 0, Number(q.get('fz') ?? 0));
  } else if (collision && charH > 0) {
    const radius = CAPSULE_RADIUS * charH, segLen = Math.max(0.02, charH - 2 * radius);
    if (groundY === null || !collision.findSpawn(radius, segLen, player.position, groundY, charH * PLATFORM_OPTS.stepFactor))
      collision.findSpawn(radius, segLen, player.position);
  } else {
    player.position.set(0, 0, 0);
  }
  placeFigurine(player.position, true);
}

/** Stand the figurine at `at`, still, on the walkable surface there. `opening` frames the
 *  room's opening shot behind it (a start); without it the follow camera just catches up
 *  (put back somewhere after losing the ground). */
export function placeFigurine(at: THREE.Vector3, opening: boolean): void {
  player.position.copy(at);
  // align with the NavGrid so the reliability layer picks it up cleanly
  const s = navGrid?.surfaceNear(player.position.x, player.position.z, player.position.y, charH) ?? null;
  if (s !== null) player.position.y = s;
  player.rotation.set(0, 0, 0);
  resetMotion();
  figurine.wasGrounded = false;
  figurine.supportY = player.position.y;         // stand on the surface there
  lastGood.copy(player.position);
  figurine.smoothFeetY = player.position.y;
  if (charModel) charModel.position.y = 0;
  figurine.state = 'ground';
  if (opening) frameOpeningShot();
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
    case 'ShiftLeft': case 'ShiftRight': move.run = !!v; break; // held: sprint (built up over MOVE.sprintRamp)
    case 'Space':
      e.preventDefault();
      if (v && !e.repeat) jumpKey();
      else if (!v) jumpRelease();
      break;
  }
}
addEventListener('keydown', (e) => keyEvent(e, 1));
addEventListener('keyup', (e) => keyEvent(e, 0));
