// The figurine: its model and how it shows each move, where it starts, and the keys.

import * as THREE from 'three';
import { type GLTF, GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { BODY, camera, figurine, hud, move, orbit, player, q, TEL } from '../app';
import { collision, groundY, navGrid, PLATFORM_OPTS, rebuildPlatformOverlay, setPlatformOverlay, setVoxelOverlay, showPlatforms, showVoxels } from '../collision/room-collision';
import { loadout } from './abilities';
import { CAM_START_HEIGHT, camLatch, frameOpeningShot } from './camera';
import { type CharacterEntry, CHARACTERS, type ClipUse, clipOf, type Move, MOVE_FALLBACK, MOVE_PLAYS } from './characters';
import { clipPace } from './clip-pace';
import { jumpKey, jumpRelease, lastGood, refitBody, resetMotion, setLoadout } from './controller';
import { MOVE, useMoveSettings } from './movement';
import { requestScanLight } from '../lighting/scan-light';
import { loadingViewOn, setUpLoadingView, updateLoading } from '../scan/room';

const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD']);
const FADE = 0.18; // seconds: how long one move's clip blends into the next, unless asked otherwise
const PACE_RANGE = [0.5, 2]; // the slowest and fastest a walking clip plays, times its authored speed
const CHARACTER_KEY = 'ww.character'; // localStorage: the character last chosen on this device
/** The character in play (characters.ts). Changed by useCharacter. */
export let character: CharacterEntry = savedCharacter();
export let charH = 1;
export let charModel: THREE.Object3D | null = null; // holds the model, lifted so its feet are at the player's origin
let model: THREE.Object3D | null = null;
export let mixer: THREE.AnimationMixer | null = null;
let actions: Partial<Record<Move, THREE.AnimationAction>> = {}; // one per move the character shows (its own clip, or a held frame)
export let activeMove: Move | null = null;  // the move whose action is playing
let activeAction: THREE.AnimationAction | null = null;
let heldAt = new Map<THREE.AnimationAction, number>(); // the actions that hold one frame, and its time
let paces: Partial<Record<Move, number>> = {}; // the speed each walk/run clip reads right at, body heights a second (clip-pace.ts)
export let charLoaded = false;
let loads = 0;   // loads asked for so far: only the last one asked for is put in play (a slower earlier one is dropped)
let wanted = ''; // the character that load is of (or the one in play once it is done or failed)

function savedCharacter(): CharacterEntry {
  let id: string | null = null;
  try { id = localStorage.getItem(CHARACTER_KEY); } catch { /* no storage: the default */ }
  return CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0];
}

/** Load character `id` (characters.ts) and put it in play where the figurine is. */
export function loadCharacter(id: string): void {
  const entry = CHARACTERS.find((c) => c.id === id);
  if (!entry || id === wanted) return; // already in play, or on its way
  const ticket = ++loads;
  wanted = id;
  new GLTFLoader().load(`${import.meta.env.BASE_URL}${entry.model}`, (gltf) => { if (ticket === loads) useCharacter(entry, gltf); }, undefined, (err) => {
    if (ticket !== loads) return; // a load given up on: its failure is not news
    wanted = charLoaded ? character.id : '';
    hud.status(`${entry.label}: ${entry.model} did not load (${String(err)})`, 'error');
  });
}

/** Put a loaded character in play: its model in place of the last one's, its moves, its size and
 *  width, how it moves and what it can do. The first one also starts the figurine off. */
function useCharacter(entry: CharacterEntry, gltf: GLTF): void {
  const first = !charLoaded, before = character;
  if (charModel) { player.remove(charModel); disposeModel(charModel); }
  if (mixer && model) { mixer.stopAllAction(); mixer.uncacheRoot(model); }
  character = entry;
  try { localStorage.setItem(CHARACTER_KEY, entry.id); } catch { /* no storage: chosen for this visit only */ }
  useMoveSettings(entry.tune);
  setLoadout(loadout(entry.abilities));
  BODY.radius = entry.radius;

  model = gltf.scene;
  setupMixer(gltf, model);
  play('idle', 0);
  mixer!.update(0);
  // Scaled to the character's height, measured standing in its idle pose with skinning
  // applied (a skinned mesh's own bounds are its bind pose: context/technical-notes.md).
  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model, true);
  model.scale.setScalar(entry.height / Math.max(bounds.max.y - bounds.min.y, 1e-6));
  model.updateMatrixWorld(true);
  bounds.setFromObject(model, true);
  charH = Math.max(bounds.max.y - bounds.min.y, 1e-4);
  model.position.y = -bounds.min.y; // feet at the player's origin
  charModel = new THREE.Group(); // carries that lift: the controller moves `charModel` for its smoothing alone
  charModel.add(model);
  player.add(charModel);
  measurePaces(gltf, model);
  mixer!.update(0); // (measuring moved its bones)

  camera.near = charH * 0.02;
  camera.far = charH * 400;
  camera.updateProjectionMatrix();
  orbit.minDistance = charH * 2.5;
  orbit.maxDistance = charH * 14;

  charLoaded = true;
  setUpLoadingView(model);
  // the NavGrid's headroom and steps are in body heights (compared as set, not as measured: the
  // measured height carries rounding from the bounds, so it never quite equals the last one's)
  if (collision && (first || entry.height !== before.height)) rebuildPlatformOverlay();
  if (first) {
    resetToSpawn();
    updateLoading(); // after the figurine is in its place: if the room was only waiting for it, this starts the room arriving around it
  } else refitBody(); // another size or width where the last one was: on the ground, clear of walls
  requestScanLight();
  hud.setCurrentCharacter(entry.id);
  if (TEL) console.log(`character: ${entry.id}, ${charH.toFixed(3)} tall, can ${[entry.climbs ? 'climb' : '', ...entry.abilities].filter(Boolean).join(', ') || 'nothing extra'}; ` +
    `walk reads right at ${paces.walk?.toFixed(2) ?? '?'}, sprint at ${paces.sprint?.toFixed(2) ?? '?'} body heights a second`);
}

/** Every geometry, material, texture and skeleton under `root`, freed. */
function disposeModel(root: THREE.Object3D): void {
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) (o as THREE.SkinnedMesh).skeleton.dispose(); // its bone texture, if it made one
    const mesh = o as THREE.Mesh;
    mesh.geometry?.dispose();
    for (const m of Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []) {
      for (const v of Object.values(m)) if ((v as THREE.Texture)?.isTexture) (v as THREE.Texture).dispose();
      m.dispose();
    }
  });
}

/** The speed each of the character's walking clips reads right at (clip-pace.ts). */
function measurePaces(gltf: GLTF, root: THREE.Object3D): void {
  paces = {};
  for (const m of ['walk', 'sprint'] as const) {
    const use = character.clips[m], clip = use && clipOf(use).hold === undefined ? gltf.animations.find((c) => c.name === clipOf(use).name) : undefined;
    const pace = clip ? clipPace(root, clip, charH) : null;
    if (pace !== null) paces[m] = pace;
  }
}

/** An action for each move the character's entry gives a clip for: the clip played (looping or
 *  once, MOVE_PLAYS), or one frame of it held still. */
function setupMixer(gltf: GLTF, model: THREE.Object3D): void {
  mixer = new THREE.AnimationMixer(model);
  actions = {}; heldAt = new Map(); activeAction = null; activeMove = null;
  const clipByName = new Map(gltf.animations.map((c) => [c.name, c]));
  for (const [m, use] of Object.entries(character.clips) as [Move, ClipUse][]) {
    const { name, hold } = clipOf(use), clip = clipByName.get(name);
    if (!clip) { console.warn(`character ${character.id}: no clip "${name}" for ${m}`); continue; }
    // a held frame is its own action (the clip played from that frame, paused), so it can blend like any other
    const a = mixer.clipAction(hold === undefined ? clip : clip.clone(), model);
    if (hold !== undefined) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; a.time = hold; a.paused = true; }
    else if (MOVE_PLAYS[m] === 'loop') a.setLoop(THREE.LoopRepeat, Infinity);
    else { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
    if (hold !== undefined) heldAt.set(a, hold);
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

/** Hold move `m`'s clip still (`still`), or let it play: the climb pauses while the climber rests. */
export function pauseMove(m: Move, still: boolean): void {
  const shown = shownBy(m), a = shown && actions[shown];
  if (a && !heldAt.has(a)) a.paused = still;
}

/** Play the current clip so its feet keep up with the figurine at `speed` (body heights a second):
 *  at the speed its clip carries it (measured, clip-pace.ts) it plays as authored. A clip that
 *  could not be measured (no skin, or no foot that moves) is taken to be made for the game's own
 *  speed for that move. Within PACE_RANGE: past that the legs would blur or crawl, and the feet
 *  slide instead. */
export function setMovePace(speed: number): void {
  if (!activeMove || !activeAction || heldAt.has(activeAction)) return;
  const measured = paces[activeMove];
  const pace = measured !== undefined ? measured * MOVE.paceScale : activeMove === 'sprint' ? MOVE.sprintSpeed : activeMove === 'walk' ? MOVE.walkSpeed : undefined;
  if (pace) activeAction.timeScale = THREE.MathUtils.clamp(speed / pace, PACE_RANGE[0], PACE_RANGE[1]);
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
  // tracks, where the figurine is boxed in.) A spot in the open, with nothing over it up to the
  // opening shot's camera, comes before a nearer one under something: Record Player Table's
  // centre is under its sideboard, which the figurine fits beneath.
  if (q.has('fx') || q.has('fz')) {
    player.position.set(Number(q.get('fx') ?? 0), 0, Number(q.get('fz') ?? 0));
  } else if (collision && charH > 0) {
    const radius = BODY.radius * charH, segLen = Math.max(0.02, charH - 2 * radius);
    const open = charH * CAM_START_HEIGHT;
    if (groundY === null || !collision.findSpawn(radius, segLen, player.position, groundY, charH * PLATFORM_OPTS.stepFactor, open))
      collision.findSpawn(radius, segLen, player.position, NaN, Infinity, open);
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
