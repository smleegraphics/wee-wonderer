// The room on screen: loading a scan (fetched and parsed in a worker, levelled, scaled,
// its collision built and its ground filled), putting it in the scene, and the loading
// view meanwhile: the old room leaving, the new one arriving around the figurine
// (context/ui.md).

import * as THREE from 'three';
import { GaussianSplat } from 'three/addons/objects/GaussianSplat.js';
import { createGaussianSplatGeometry } from 'three/addons/utils/GaussianSplatUtils.js';
import { orientScan } from './orient-scan';
import type { FilledScan } from './fill-scan.worker';
import { voxelCacheKey } from '../collision/voxel-cache';
import { workerCaller } from '../worker-call';
import type { ParsedScan, ScanLoadProgress } from './load-scan.worker';
import { updateReveal, HANDOVER, startReveal, startLeave, installReveal } from '../loading/room-reveal';
import { type LoadingScene, createLoadingScene } from '../loading/loading-scene';
import { type PaperFigurine, createPaperFigurine } from '../loading/paper-figurine';
import { scanURL } from './scans';
import { DEFAULT_SCAN, hud, MESHONLY, player, renderer, room, scene, surround, SURROUND, TARGET_RADIUS, TEL, VOXEL_SIZE } from '../app';
import { buildCollision, collisionKey, disposeCollision, navVersion, rebuildCollision, useScanSettings, VOXEL_OPTS } from '../collision/room-collision';
import { charH, charLoaded, play, resetToSpawn } from '../figurine/character';
import { installContactShadow } from '../lighting/contact-shadow';
import { estimateScanFill, requestScanLight, scanFill } from '../lighting/scan-light';
import { fillScan, installFillView, refillWalkable, reportWalkFill, scanBuffers, walkableNow, walkFillOptions } from './walk-fill';
 // BVH over the voxel surface, rebuilt per scan
export let currentFile = DEFAULT_SCAN;
// last-loaded scan data, kept so debug tunables can re-voxelize without reloading the PLY
export let lastCenters: THREE.BufferAttribute | null = null;
export let lastOpacity: Float32Array | null = null;
export let lastCov: Float32Array | null = null; // per-splat covariance (6/splat) for anisotropic voxelization
export const lastMatrix = new THREE.Matrix4();     // collide-and-slide substeps per frame
export let loadToken = 0; // guards against a slow async collision build landing after a scan swap
/** A new load (or collision rebuild) begins: every one still running is now superseded. */
export function newLoadToken(): number { return ++loadToken; }
export let scanLoading = false; // a scan is being fetched or its collision built
// The loading view: there is no room yet, and the figurine waits, idle, on a rippling
// sheet of paper dots (loading-scene.ts). When the view ends the room rises out of the
// sheet around the figurine (room-reveal.ts); when another room is picked, the one
// there goes back into the sheet first.
export let loadingScene: LoadingScene | null = null; // made once the figurine's height is known
export let paperFigurine: PaperFigurine | null = null; // the figurine's paper look while it waits (paper-figurine.ts)
let loadingShown = true;
export let revealProgress = 0; // how much of the room is in place (the last value of updateReveal): 0 none, 1 all of it
let roomLeft: (() => void) | null = null;      // set while the old room is going back into the sheet: call it once it has gone
let roomGone: Promise<void> = Promise.resolve(); // resolves when there is no old room in the way of a new one
let loadAbort: AbortController | null = null;  // cancels the newest load's fetch, should another replace it

/** True until there is a room to stand in and a figurine to stand in it. */
export function loadingViewOn(): boolean {
  return scanLoading || !charLoaded;
}

/** Make the loading view's dots and the figurine's paper look, once the figurine (and so its height) is known. */
export function setUpLoadingView(model: THREE.Object3D): void {
  loadingScene = createLoadingScene(charH, hud.token('--paper'));
  paperFigurine = createPaperFigurine(model, renderer, hud.token('--paper'));
  scene.add(loadingScene.object);
}

/** Per frame: how much of the room is in place, and everything that follows from it.
 *  Everything about waiting follows from that one number, so the way into the loading
 *  view is as gradual as the way out of it. */
export function updateArrival(dt: number): void {
  const arrived = revealProgress = updateReveal(dt);
  if (roomLeft && arrived === 0) { clearRoom(); roomLeft(); roomLeft = null; } // the old room is back in the sheet: now it can go
  room.visible = arrived > 0;
  loadingScene?.show(1 - Math.min(1, arrived / HANDOVER)); // the stand-in dots give way to the scan's own at the start of its arrival
  paperFigurine?.show(arrived);                             // the figurine is paper too, and itself once the room is in
  surround.lerpColors(SURROUND.sky, SURROUND.beyond, THREE.MathUtils.smoothstep(arrived, SURROUND.darken[0], SURROUND.darken[1]));
}

/** Bring the screen in line with whether the loading view is on. Call after anything it depends on changes. */
export function updateLoading(): void {
  const on = loadingViewOn();
  hud.setLoading(on);
  if (!on && loadingShown) revealRoom(); // the view has just ended
  loadingShown = on;
}

/** How far the room reaches from the figurine: the scan is centred on the origin and scaled to TARGET_RADIUS. */
function roomReach(): number {
  return TARGET_RADIUS + Math.hypot(player.position.x, player.position.z);
}

/** Bring the room in around the figurine, from where it stands. */
function revealRoom(): void {
  loadingScene?.place(player.position);
  startReveal(player.position, roomReach(), charH, hud.token('--paper'));
}

export function disposeSplat(): void {
  if (!currentSplat) return;
  room.remove(currentSplat);
  currentSplat.geometry.dispose();
  (currentSplat.material as THREE.Material).dispose();
  (currentSplat as unknown as { dispose?: () => void }).dispose?.();
  currentSplat = null;
  currentScan = null;
}

/** Take the room there is, and its collision, out of the scene. */
function clearRoom(): void {
  disposeSplat();
  disposeCollision();
  room.quaternion.identity();
  room.position.set(0, 0, 0);
  room.scale.setScalar(1);
}
export let currentSplat: GaussianSplat | null = null;
export let currentScan: { scan: ParsedScan; own: number; cellsUsed: number } | null = null;

/** Load an example scan from the scan host (scans.ts). */
export function loadScan(file: string): void {
  loadFromURL(scanURL(file), file);
}

// The .ply is fetched and parsed in a worker (load-scan.worker.ts): on the main
// thread a large scan froze the page for seconds.
const parseScan = workerCaller<{ url: string }, ParsedScan, ScanLoadProgress>(
  new Worker(new URL('./load-scan.worker.ts', import.meta.url), { type: 'module' }), 'scan load');

// The steps of a load, in order: what the loading note says during each, and its share
// of the progress indicator. Only fetching can say how far through it is; the others
// move the indicator on when they end. Fetching has half: over a network it is most of
// the wait (scans are 30 to 475 MB). The rest is split as the time is on Playroom, the
// largest scan (unpack 7.6 s, build 3.2 s, served locally; Kitchen is 0.6 s and 1.3 s).
const LOAD_STEPS = {
  fetch: { says: 'Fetching the scan', share: 0.5 },
  unpack: { says: 'Unpacking the scan', share: 0.3 },
  build: { says: 'Building the room', share: 0.2 },
} as const;
type LoadStep = keyof typeof LOAD_STEPS;
let loadStepNow: { step: LoadStep; since: number } | null = null; // the step the newest load is on, and when it began (performance.now)

/** Tell the player which step the newest load is on and how far `through` it (0..1) it is, or that it is 'done'. */
function loadStep(token: number, step: LoadStep | 'done', through = 0): void {
  if (token !== loadToken) return;
  const was = loadStepNow;
  if (TEL && was && was.step !== step) console.log(`LOAD ${was.step} took ${(performance.now() - was.since).toFixed(0)}ms`);
  if (step === 'done') {
    if (was) hud.loadProgress(LOAD_STEPS[was.step].says, 1);
    loadStepNow = null;
    return;
  }
  if (was?.step !== step) loadStepNow = { step, since: performance.now() };
  let before = 0;
  for (const [name, s] of Object.entries(LOAD_STEPS)) { if (name === step) break; before += s.share; }
  hud.loadProgress(LOAD_STEPS[step].says, before + LOAD_STEPS[step].share * through);
}

/** Load a scan from any URL (an example scan from the scan host, or an imported scan's
 *  blob). `id` is the stable identity used for the collision cache and status. */
export function loadFromURL(url: string, id: string): void {
  const token = newLoadToken();
  currentFile = id;
  useScanSettings(id);
  hud.setCurrentRoom(id);
  scanLoading = true;
  loadAbort?.abort(); // the load this one replaces, if it is still fetching
  const abort = loadAbort = new AbortController();
  // The figurine waits where it stands (the controller is off while loading), and the
  // room there is goes back into the sheet around it before it is taken away. One
  // already on its way out carries on.
  if (charLoaded) play('idle');
  if (!roomLeft) {
    if (currentSplat) {
      loadingScene?.place(startLeave(player.position, roomReach()));
      roomGone = new Promise((gone) => { roomLeft = gone; });
    } else clearRoom(); // nothing to see leave (the first load, or after one that failed)
  }
  updateLoading();
  loadStep(token, 'fetch');
  // only the newest load may end the loading screen or report on itself
  const finish = (error?: unknown) => {
    if (token !== loadToken) return;
    if (error === undefined) loadStep(token, 'done');
    scanLoading = false;
    updateLoading();
    // a collision slider moved while the room was loading (rebuildCollision waits for this): catch up
    if (error === undefined && collisionKey !== voxelCacheKey(id, VOXEL_SIZE, VOXEL_OPTS, TARGET_RADIUS)) rebuildCollision();
    if (error !== undefined) hud.status(`${id}: ${error instanceof Error ? error.message : String(error)}`, 'error');
  };
  showScan(new URL(url, location.href).href, id, token, abort.signal).then(() => finish(), finish); // absolute: a worker resolves URLs against its own script
}

/** Fetch and parse the scan, put it in the room levelled and scaled, and build its collision. */
async function showScan(url: string, id: string, token: number, cancelled: AbortSignal): Promise<void> {
  const parsed = await parseScan({ url }, [], { signal: cancelled, onProgress: (p) => loadStep(token, p.step, p.step === 'fetch' ? p.fetched : 0) });
  await roomGone; // the old room has to be out of the way first; it usually is long before this
  if (token !== loadToken) return; // superseded while loading
  loadStep(token, 'build');
  const ownCenters = new THREE.BufferAttribute(parsed.centers, 3);
  const o = orientScan(ownCenters);
  // scans have arbitrary unit scales — normalize each to a consistent world
  // size so the fixed-size figurine stays a sensible fraction of every room.
  const k = TARGET_RADIUS / o.radius;
  room.quaternion.copy(o.quaternion); // auto-leveled: floor normal → +Y
  room.scale.setScalar(k);
  room.position.y = k * o.floorOffsetY; // floor at y=0 (in scaled space)
  room.updateMatrixWorld(true);
  const toWorld = new THREE.Matrix4().makeTranslation(-o.center.x, -o.center.y, -o.center.z).premultiply(room.matrixWorld); // the scan recentred on the origin, then the room's transform
  // Collision first, from the scan as it was captured: where the figurine can stand
  // decides where splats are added (context/splat-fill.md).
  const own = parsed.centers.length / 3;
  const opacity = new Float32Array(own);
  for (let i = 0; i < own; i++) opacity[i] = parsed.colors[i * 4 + 3] / 255;
  await buildCollision(id, token, ownCenters, opacity, parsed.covariances, toWorld);
  if (token !== loadToken) return; // superseded while building
  // The spawn needs only the collision, and must be decided now, before the next frame:
  // from here the camera tests the new room's mesh, and a figurine still at its old spot
  // (the origin, or the last room's spawn) is inside it, which pulls the camera in close.
  if (charLoaded) resetToSpawn();
  const tFill = performance.now();
  const walk = walkableNow(), cellsUsed = navVersion;
  const filled: FilledScan = walk ? await fillScan({ scan: parsed, matrix: Array.from(toWorld.elements), walk, opts: walkFillOptions() }, scanBuffers(parsed))
    : { scan: parsed, own, cells: 0, seeThrough: 0 };
  if (token !== loadToken) return; // superseded while filling
  if (walk) reportWalkFill(id, filled, tFill);
  const shown = showSplat(filled, o.center.multiplyScalar(-1), opacity, cellsUsed); // recentred on the origin
  // The walkable cells may have been rebuilt while the fill was being worked out (the
  // figurine arriving gives them its real height), when there was no splat to refill.
  void refillWalkable();
  estimateScanFill(shown.centers, new THREE.BufferAttribute(filled.scan.colors.subarray(0, own * 4), 4, true), shown.cov, lastMatrix, scanFill);
  console.log(`loaded ${id}: radius ${o.radius.toFixed(2)} → scaled ${k.toFixed(2)}x`);
  if (charLoaded) requestScanLight(); // (needs the splat in place)
}

/** Put a scan and its fill in the room as the splat object, at `position` in the room.
 *  `opacity` is each of the scan's own splats' (it does not change with the fill), and
 *  `cellsUsed` the navVersion of the walkable cells the fill was worked out from.
 *  Returns the scan as it was captured, which is the first `own` splats: collision and
 *  the light estimate work from these alone, never from the added ones. */
export function showSplat({ scan, own }: FilledScan, position: THREE.Vector3, opacity: Float32Array, cellsUsed: number): { centers: THREE.BufferAttribute; cov: Float32Array } {
  const centers = new THREE.BufferAttribute(scan.centers.subarray(0, own * 3), 3);
  // per-splat 3-D Gaussian covariance drives anisotropic voxelization (splats fill
  // their real ellipsoid footprint). The worldspace transform is applied in the core.
  const cov = scan.covariances.subarray(0, own * 6);
  const splat = new GaussianSplat(createGaussianSplatGeometry(scan.centers, scan.covariances, scan.colors, scan.sphericalHarmonics));
  if (!MESHONLY) installFillView(splat, own);
  installReveal(splat, scan.centers.length / 3);
  installContactShadow(splat);
  splat.position.copy(position);
  splat.visible = !MESHONLY; // mesh-only debug view hides the splat
  room.add(splat);
  currentSplat = splat;
  currentScan = { scan, own, cellsUsed };
  room.updateMatrixWorld(true);
  lastCenters = centers; lastOpacity = opacity; lastCov = cov; lastMatrix.copy(splat.matrixWorld);
  return { centers, cov };
}
