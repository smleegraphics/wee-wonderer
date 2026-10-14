// Wee Wonderer — app shell + character controller + room scan (M3).
//
// three.js on WebGPU owns everything. The scan (native GaussianSplat) is the
// world; the figurine (M2 controller) toddles on its floor, correctly occluded.
// Room transform (flip 194° / roll -1° / drop to y=0) was dialed in with the
// floor-plane fit in the room inspector; baked as constants here.

import * as THREE from 'three';
import { WebGPURenderer, MeshBasicNodeMaterial } from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { GaussianSplat } from 'three/addons/objects/GaussianSplat.js';
import { createGaussianSplatGeometry } from 'three/addons/utils/GaussianSplatUtils.js';
import { orientScan } from './orient-scan';
import type { Walkable, WalkableFillOptions } from './fill-scan-core';
import type { FilledScan } from './fill-scan.worker';
import { surfaceToGeometry } from './voxelize';
import { MeshCollision, type NavGrid, type PlatformField, type WallHit } from './collision';
import { voxelCacheKey, voxelCacheGet, voxelCachePut } from './voxel-cache';
import type { VoxelSurface, VoxelOptions } from './voxelize';
import type { CleanOptions } from './clean-scan-core';
import { buildClimbSideClip } from './climb-side-anim';
import { createHud } from './ui/hud';
import { workerCaller } from './worker-call';
import type { ParsedScan, ScanLoadProgress } from './load-scan.worker';
import { splatInternals } from './three-internals';
import { installReveal, startReveal, startLeave, updateReveal, revealPaused, HANDOVER } from './room-reveal';
import { createLoadingScene, type LoadingScene } from './loading-scene';
import { createPaperFigurine, type PaperFigurine } from './paper-figurine';
import { cameraPosition, cameraProjectionMatrixInverse, cameraWorldMatrix, cos, float, Fn, If, instanceIndex, mix, modelWorldMatrix, PI, pmremTexture, sin, smoothstep, uint, uniform, uv, varying, vec3, vec4, viewportUV } from 'three/tsl';

const q = new URLSearchParams(location.search);
const TEL = q.get('tel') === '1'; // debug telemetry: CLIMB-* console events + window.__dbg
// demo scans for the switcher UI — config, not logic (each auto-levels at load).
// `collision` is a scan's own collision settings, set by hand where the defaults do not suit it (useScanSettings).
const SCANS: { file: string; label: string; collision?: Partial<VoxelSettings> }[] = [
  { file: 'room2.ply', label: 'Playroom', collision: { floorFlat: 2 } }, // already tightly bounded — no cleanup needed. Its rug is uneven: ridges of it stand above the usual 1.5 grains and were left as bumps on the floor
  { file: 'livingroom-clean.ply', label: 'Living Room' }, // floater-stripped (scripts/clean-scan.mjs)
  { file: 'kitchen-clean.ply', label: 'Kitchen' },
  { file: 'counter-clean.ply', label: 'Counter' },
];
const DEFAULT_SCAN = q.get('scan') ?? SCANS[0].file;
const TARGET_RADIUS = 7; // normalize every scan to this world size (figurine ~0.45 tall)
// Collision voxelization: build a cleaned blocky surface mesh from the splat and
// show it as a debug overlay (toggle 'V', or ?voxel=1 to start visible).
// GRAIN is the length collision's settings are counted in: the voxel size they were
// tuned at, about a fifth of the figurine's height. The grid itself can be finer
// (VOXEL_SIZE); settings given in grains then mean the same thing at any grid size.
const GRAIN = TARGET_RADIUS / 72; // ~0.097 world units
const VOXEL_SIZE = Number(q.get('vox')) || GRAIN;
/** The spacing of the walkable cells: a grain, however fine the collision grid is. (Coarser
 *  only if the grid itself had to be: a scan too large for it.) Where the figurine can
 *  stand is sampled from the mesh at this spacing; making it finer as well changes what
 *  counts as a step and what as a slope, and is a separate question from the mesh's detail. */
const navStep = () => Math.max(GRAIN, lastVoxelSize);
/** How many walkable cells go to a grain (1, unless the cells had to be coarser). */
const cellsPerGrain = () => GRAIN / navStep();
const num = (key: string, def: number) => (q.has(key) ? Number(q.get(key)) : def);
/** The collision settings every scan starts from. */
const VOXEL_DEFAULTS = {
  iso: 0.35,      // isovalue as a fraction of median surface density (low → fills faint flat panels)
  despeckle: 20,  // drop solid islands smaller than this (stray cubes / floaters the low iso admits)
  close: 1,       // dilate→erode iterations (bridges tiny holes); kept low so it doesn't weld objects to the floor / web surfaces (loose "seal"). Big holes are handled by the enclosed floor/panel fills.
  fillFloor: 20,  // fill gaps in the surface the figurine plays on: on the ground, bare stretches nothing this many voxels wide can get into (1 = enclosed holes only). Living Room's bare floor closes at 20, not at 12
  panelFill: 2.5, // fill enclosed holes in vertical panels up to this area, in NORMALIZED scan units² (~room-relative, not metres — every scan is scaled to TARGET_RADIUS); blank cabinet doors/walls; 0 = off
  smooth: 0,      // majority occupancy passes (Taubin handles smoothing)
  taubin: 6,      // Taubin mesh-smoothing iterations
  floorFlat: 1.5, // flatten the mesh onto the ground's splats within this many grains of them. At 1 the top of Playroom's and Living Room's floor is left out (cells at 1.25 to 1.75 grains); at 2 a little more is flat and more low clutter is floor (Playroom is given 2 in SCANS)
  refine: 2,      // build the mesh on a grid up to this many times finer than the one that decides what is solid, trimmed in to the splats. Each scan gets what it has the splats for (of the demo scans, only Playroom gets 2)
};
type VoxelSettings = typeof VOXEL_DEFAULTS;
const VOXEL_KEYS = Object.keys(VOXEL_DEFAULTS) as (keyof VoxelSettings)[];
/** Settings given for this session, which hold whatever scan is loaded: in the address (the
 *  setting's name in lower case: ?floorflat=2&iso=0.2), and after that by a Debug slider. */
const voxelSet: Partial<VoxelSettings> = {};
for (const key of VOXEL_KEYS) if (q.has(key.toLowerCase())) voxelSet[key] = Number(q.get(key.toLowerCase()));
/** The settings collision is built with now (useScanSettings). */
const VOXEL_OPTS: VoxelSettings = { ...VOXEL_DEFAULTS, ...voxelSet };
const voxelSliders: Partial<Record<keyof VoxelSettings, (v: number) => void>> = {}; // each setting's Debug slider: call to show a value on it
/** Make the collision settings those of scan `id`: the defaults, then what the scan list
 *  gives for that scan, then whatever has been set for the session. An uploaded scan has
 *  no entry in the list, so it gets the defaults. (This is the one place a scan's settings
 *  are decided: settings measured from a scan would go between the defaults and the list's.) */
function useScanSettings(id: string): void {
  Object.assign(VOXEL_OPTS, VOXEL_DEFAULTS, SCANS.find((s) => s.file === id)?.collision, voxelSet);
  for (const key of VOXEL_KEYS) voxelSliders[key]?.(VOXEL_OPTS[key]);
}
// Walkable surfaces are de-quantized to the real splat height in the voxelizer,
// so no ground offset is needed; ?sink stays as a manual override (default 0).
const GROUND_OFFSET = num('sink', 0);
// Debug free-camera: when any of ?az/el/dist/cx/cy/cz is present, detach the
// figurine-follow and park the camera at a fixed orbit around a look-at point, so
// any part of the collision mesh can be framed for inspection (used with ?voxel=1).
// az/el = azimuth/elevation in radians; dist = distance in scene-radii (TARGET_RADIUS);
// cx/cy/cz = look-at point in world units (floor is y=0). Non-interactive by design.
// Debug mesh-only view (?meshonly=1): hide the splat and draw the collision surface
// as a solid lit mesh, so holes / fills are unmistakable (the wireframe-over-splat
// overlay is too cluttered to judge). Pairs with the free-cam for inspection.
const MESHONLY = q.get('meshonly') === '1';
const FREECAM = ['az', 'el', 'dist', 'cx', 'cy', 'cz'].some((k) => q.has(k));
const FREECAM_OPTS = { az: num('az', 0.9), el: num('el', 0.5), dist: num('dist', 2.2), cx: num('cx', 0), cy: num('cy', 1), cz: num('cz', 0) };
let showVoxels = q.get('voxel') === '1';
let collisionDebug: THREE.Mesh | null = null;
let voxelCheckbox: HTMLInputElement | null = null; // the Debug card's copy of showVoxels (the V key changes it too)
// Spike 1: platform-decomposition overlay (colored walkable surfaces). stepFactor
// = max step (in char-heights) two cells can differ and still be one platform;
// minCells drops floater specks. Tuned live to see how scans decompose.
let showPlatforms = q.get('platforms') === '1';
let platformDebug: THREE.InstancedMesh | null = null;
let platformCheckbox: HTMLInputElement | null = null;
let lastVoxelSize = GRAIN;
let groundY: number | null = null; // the height of the ground the figurine plays on in this scan (the voxelizer's), or null
const PLATFORM_OPTS = { stepFactor: 0.35, minCells: 6, climbDeg: 70, bridge: 2, fill: 3 }; // climbDeg: surfaces steeper than this (from horizontal) are walls to climb, gentler ones are ground to walk. minCells: an area, in grains². bridge, fill: how wide a gap in a surface is bridged, and how wide a hole in it filled, in grains
const STEP_DOWN_MAX = 0.6; // hop straight down a drop up to this (char-heights); taller → climb down the face
// Spike 2: the reliable ground. The controller stands on the NavGrid (no
// fall-through), is confined to it (no walking off), and recovers to `lastGood`.
let navGrid: NavGrid | null = null;
let navField: PlatformField | null = null; // navGrid's cells as a list, for the overlay and the gap fill
let navVersion = 0;                       // goes up each time the walkable cells are rebuilt
let supportY = 0;                       // height of the platform the player is standing on
const lastGood = new THREE.Vector3();   // last validated on-platform position (recovery)
let useNavGround = q.get('nav') !== '0'; // the platform reliability layer (on by default)
let collision: MeshCollision | null = null; // BVH over the voxel surface, rebuilt per scan
let currentFile = DEFAULT_SCAN;
// last-loaded scan data, kept so debug tunables can re-voxelize without reloading the PLY
let lastCenters: THREE.BufferAttribute | null = null;
let lastOpacity: Float32Array | null = null;
let lastCov: Float32Array | null = null; // per-splat covariance (6/splat) for anisotropic voxelization
const lastMatrix = new THREE.Matrix4();
const CAPSULE_RADIUS = 0.22; // capsule hemisphere radius, in char-heights
const PHYSICS_STEPS = 5;     // collide-and-slide substeps per frame
let loadToken = 0; // guards against a slow async collision build landing after a scan swap
let collisionKey = ''; // the settings (voxelCacheKey) the collision there is was built with
// scan import (upload + in-browser cleanup), session-only
const CLEAN_OPTS: CleanOptions = { alphaMin: 0.35, minMass: 4, scaleCapMul: 4, crop: true };
const uploads = new Map<string, string>(); // upload id → blob object URL
let lastUploadBuffer: ArrayBuffer | null = null; // raw bytes of the active upload (for live re-clean)
let lastUploadName = '';
const app = document.getElementById('app')!;
// The on-screen UI (context/ui.md). Demo scans load by filename; an uploaded id
// resolves to its blob URL in `uploads`.
const hud = createHud({
  rooms: SCANS.map((s) => ({ id: s.file, label: s.label })),
  onPickRoom: (id) => { const url = uploads.get(id); if (url) loadFromURL(url, id); else loadScan(id); },
  onImport: (file) => void importScan(file),
  onReset: () => { if (charLoaded) resetToSpawn(); }, // the way out of any spot the figurine gets stuck in
});
let scanLoading = false; // a scan is being fetched or its collision built
// The loading view: there is no room yet, and the figurine waits, idle, on a rippling
// sheet of paper dots (loading-scene.ts). When the view ends the room rises out of the
// sheet around the figurine (room-reveal.ts); when another room is picked, the one
// there goes back into the sheet first.
let loadingScene: LoadingScene | null = null; // made once the figurine's height is known
let paperFigurine: PaperFigurine | null = null; // the figurine's paper look while it waits (paper-figurine.ts)
let loadingShown = true;
let revealProgress = 0; // how much of the room is in place (the last value of updateReveal): 0 none, 1 all of it
let roomLeft: (() => void) | null = null;      // set while the old room is going back into the sheet: call it once it has gone
let roomGone: Promise<void> = Promise.resolve(); // resolves when there is no old room in the way of a new one
let loadAbort: AbortController | null = null;  // cancels the newest load's fetch, should another replace it

/** True until there is a room to stand in and a figurine to stand in it. */
function loadingViewOn(): boolean {
  return scanLoading || !charLoaded;
}

/** Bring the screen in line with whether the loading view is on. Call after anything it depends on changes. */
function updateLoading(): void {
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

function disposeSplat(): void {
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

const renderer = new WebGPURenderer({ antialias: false }); // no MSAA: every splat would be blended at several samples a pixel, which a soft splat gains nothing from (context/frame-time.md)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// What is seen around a scan. While the figurine waits it is the open air of the paper
// world (the UI's --sky token; index.html paints it before the first frame). As the room
// arrives it darkens to --beyond, which a scan's gaps and edges recede into. It follows
// how much of the room is in place, both ways, so it is never a cut.
const SURROUND = {
  sky: new THREE.Color(hud.token('--sky')), beyond: new THREE.Color(hud.token('--beyond')),
  darken: [HANDOVER, 0.8], // the part of the arrival it takes: from when the dots lift off, to a little before the last land, so the arrival ends on the room alone
};
const surround = new THREE.Color().copy(SURROUND.sky);
scene.background = surround;

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.001, 200);

// Orbit-follow camera: user drags to orbit / scrolls to zoom, and its pivot is
// glued to the figurine each frame so it follows while you look around.
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;
orbit.addEventListener('start', () => { camHandsOff = false; camSwinging = false; camBasisHeld = false; }); // the user's hand on the camera always wins over the auto-swing
orbit.enablePan = false; // pivot tracks the figurine; panning it away would fight that
orbit.maxPolarAngle = Math.PI * 0.49; // don't drop below the floor

const hemi = new THREE.HemisphereLight(0x8899bb, 0x22201c, 0.9); // fixed ambient fill...
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff4e0, 2.4);            // ...and fixed key light. Both are the fallback: off while the scan lights the scene (applyScanLight)
sun.position.set(3, 6, 4);
scene.add(sun);

// --- room scan --------------------------------------------------------------
// The scan is auto-leveled at load (RANSAC floor fit) — Y-up, floor at y=0.
// No per-scan constants: any scan (a demo, or the user's own) levels the same way.
const room = new THREE.Group();
scene.add(room);
let currentSplat: GaussianSplat | null = null;
let currentScan: { scan: ParsedScan; own: number; cellsUsed: number } | null = null; // the arrays currentSplat draws (the scan's `own` splats, then its fill), and which walkable cells (navVersion) that fill is for

/** Load (or swap to) a scan: dispose the old splat, auto-level the new one, respawn. */
function disposeCollision(): void {
  if (collisionDebug) {
    scene.remove(collisionDebug);
    collisionDebug.geometry.dispose();
    (collisionDebug.material as THREE.Material).dispose();
    collisionDebug = null;
  }
  disposePlatformOverlay();
  collision = null;
}

function disposePlatformOverlay(): void {
  if (!platformDebug) return;
  scene.remove(platformDebug);
  platformDebug.geometry.dispose();
  (platformDebug.material as THREE.Material).dispose();
  platformDebug = null;
}

/** Load a bundled demo scan from public/. */
function loadScan(file: string): void {
  loadFromURL(`${import.meta.env.BASE_URL}${file}`, file);
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

/** Load a scan from any URL (a bundled file or an uploaded blob). `id` is the
 *  stable identity used for the collision cache and status. */
function loadFromURL(url: string, id: string): void {
  const token = ++loadToken;
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
  if (charLoaded) { resetToSpawn(); requestScanLight(); }
}

/** Put a scan and its fill in the room as the splat object, at `position` in the room.
 *  `opacity` is each of the scan's own splats' (it does not change with the fill), and
 *  `cellsUsed` the navVersion of the walkable cells the fill was worked out from.
 *  Returns the scan as it was captured, which is the first `own` splats: collision and
 *  the light estimate work from these alone, never from the added ones. */
function showSplat({ scan, own }: FilledScan, position: THREE.Vector3, opacity: Float32Array, cellsUsed: number): { centers: THREE.BufferAttribute; cov: Float32Array } {
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

// --- fill the see-through ground the figurine can stand on (see context/splat-fill.md) ---
// Sizes are in grains (GRAIN).
const WALK_FILL = {
  on: true,
  cell: 0.5,     // spacing of the fill splats
  band: 1.5,     // the splats within this height of a walkable cell are the ones that draw its ground
  drop: 0.5,     // how far under those splats the fill lies
  patch: 40,     // fill only level ground of at least this area, in grains²: a tabletop, not the top of a toy...
  level: 0.25,   // ...where neighbouring walkable cells are level when the slope between them is within this
  under: 0.75,   // fill a spot when the scan's ground there is less opaque than this. At 0.9 the ordinary thin places in a well-captured floor are filled and show; at 0.5 the speckle in Kitchen's table is left
};
function walkFillOptions(): WalkableFillOptions {
  const { cell, band, drop, patch, level, under } = WALK_FILL;
  return { cell: cell * GRAIN, band: band * GRAIN, drop: drop * GRAIN, patch: Math.round(patch * cellsPerGrain() ** 2), level: level * navStep(), under };
}
/** Where the figurine can stand right now, for the fill; null if nowhere, or the scan is not being drawn (the mesh-only view). */
function walkableNow(): Walkable | null {
  if (MESHONLY || !navField || !navField.platformId.length) return null;
  return { positions: navField.positions, platformId: navField.platformId, step: navField.sampleStep };
}
/** Say how a fill went: a warning if it could not be worked out (the scan is then shown without one), and the numbers under ?tel=1. */
function reportWalkFill(id: string, filled: FilledScan, since: number): void {
  if (filled.failed) console.warn(`walkable fill: ${id} is shown without it — ${filled.failed}`);
  else if (TEL) console.log(`WALKFILL ${id}: ${filled.scan.centers.length / 3 - filled.own} splats added to ${filled.own} in ${(performance.now() - since).toFixed(0)}ms; ` +
    `${filled.seeThrough} of ${filled.cells} walkable cells were over half see-through`);
}
// How the fill is drawn, for looking at it (the Debug card). These are shader switches:
// nothing about the scan is rebuilt.
const FILL_VIEW = {
  opacity: 1,        // how much of the fill splats' opacity is drawn
  highlight: false,  // draw them in FILL_TINT instead of their own colour
  only: false,       // hide the scan's own splats
};
const FILL_TINT = new THREE.Color(1, 0, 1);
const fillShown = uniform(1), fillTinted = uniform(0), scanShown = uniform(1);
function applyFillView(): void {
  fillShown.value = WALK_FILL.on ? FILL_VIEW.opacity : 0;
  fillTinted.value = FILL_VIEW.highlight ? 1 : 0;
  scanShown.value = FILL_VIEW.only ? 0 : 1;
}
applyFillView();

const fillScan = workerCaller<{ scan: ParsedScan; matrix: number[]; walk: Walkable; opts: WalkableFillOptions }, FilledScan>(
  new Worker(new URL('./fill-scan.worker.ts', import.meta.url), { type: 'module' }), 'walkable fill');
const scanBuffers = (scan: ParsedScan) => [scan.centers, scan.covariances, scan.colors, ...Object.values(scan.sphericalHarmonics)].map((a) => a.buffer as ArrayBuffer);

/** Let FILL_VIEW decide how the splats after the scan's first `own`, which are the fill, and the scan's own are drawn. */
function installFillView(splat: GaussianSplat, own: number): void {
  const material = splat.material as unknown as { colorNode: any; needsUpdate: boolean };
  const order = splatInternals(splat)._sort?.orderRead;
  if (!order || !material.colorNode) { console.warn('walkable fill: this GaussianSplat does not expose its draw order — the fill cannot be switched off or highlighted'); return; }
  const isFill = varying(float(order.element(instanceIndex).greaterThanEqual(uint(own)).select(1, 0)));
  const base = material.colorNode; // vec4: the splat's colour and coverage
  material.colorNode = Fn(() => {
    const c = vec4(base).toVar();
    c.rgb.assign(mix(c.rgb, FILL_TINT, isFill.mul(fillTinted)));
    c.a.mulAssign(mix(scanShown, fillShown, isFill));
    return c;
  })();
  material.needsUpdate = true;
}

/** Bring the fill in line with where the figurine can stand now, without reloading the
 *  scan: work it out again and swap it in. Does nothing if the fill being drawn is already
 *  for the current walkable cells, unless `changed` says a tunable of the fill itself has. */
let refilling = false, refillWanted = false, refillChanged = false;
async function refillWalkable(changed = false): Promise<void> {
  if (refilling) { refillWanted = true; refillChanged ||= changed; return; } // one at a time: the newest state is picked up when this one lands
  const was = currentSplat, held = currentScan, walk = walkableNow(), token = loadToken, cellsUsed = navVersion;
  if (!was || !held || !walk || !lastOpacity) return; // (during a load there is no splat yet: showScan fills it, then calls this)
  if (held.cellsUsed === cellsUsed && !changed) return;
  refilling = true;
  try {
    // The worker takes its arrays for good, and the ones being drawn stay until the new
    // ones are ready, so it gets a copy of the scan's own splats.
    const { scan, own } = held, total = scan.centers.length / 3, since = performance.now();
    const sphericalHarmonics: Record<string, Uint32Array> = {};
    for (const [name, words] of Object.entries(scan.sphericalHarmonics)) sphericalHarmonics[name] = words.slice(0, (words.length / total) * own);
    const copy: ParsedScan = { centers: scan.centers.slice(0, own * 3), covariances: scan.covariances.slice(0, own * 6), colors: scan.colors.slice(0, own * 4), sphericalHarmonics };
    const filled = await fillScan({ scan: copy, matrix: Array.from(lastMatrix.elements), walk, opts: walkFillOptions() }, scanBuffers(copy));
    if (currentSplat !== was || token !== loadToken) return; // another scan is on its way in, or collision is being rebuilt (which fills again)
    reportWalkFill(currentFile, filled, since);
    if (filled.failed) return; // keep what is being drawn
    const position = was.position.clone(), opacity = lastOpacity;
    disposeSplat();
    showSplat(filled, position, opacity, cellsUsed);
    requestScanLight(); // the probe saw the old fill
  } catch (err) {
    hud.status(err instanceof Error ? err.message : String(err), 'error');
  } finally {
    refilling = false;
    if (refillWanted) { const again = refillChanged; refillWanted = refillChanged = false; void refillWalkable(again); }
  }
}

// --- character state ---------------------------------------------------------
const player = new THREE.Group();
scene.add(player);

const CONTRACT = [
  { name: 'idle', loop: true },
  { name: 'walk', loop: true },
  { name: 'run', loop: true },
  { name: 'climb', loop: true },
  { name: 'jump_start', loop: false },
  { name: 'jump_loop', loop: false, hold: true },
  { name: 'jump_land', loop: false },
] as const;

const TUNE = { walkSpeed: 1.6, runSpeed: 4.0, jumpVel: 3.2, gravity: -9.0, climbSpeed: 1.2, climbTurn: 6, climbBlend: 10, fade: 0.18, turnLerp: 12, camIn: 20, camOut: 3, camSwing: 4 };

const move = { f: 0, b: 0, l: 0, r: 0, run: false };
const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD']);
let state: 'ground' | 'jump_start' | 'air' | 'land' | 'climb' = 'ground';
const velocity = new THREE.Vector3(); // gravity/jump; horizontal input is applied per-frame
let wasGrounded = false;
let charH = 1;
let charModel: THREE.Object3D | null = null;
let charFeetOffset = 0;   // model's local y so its feet sit at the player origin
let smoothFeetY = 0;      // damped feet height for RENDER only (physics stays crisp)
let mixer: THREE.AnimationMixer | null = null;
const actions: Record<string, THREE.AnimationAction> = {};
let activeAction: THREE.AnimationAction | null = null;
let charLoaded = false;

function onLoaded(gltf: GLTF): void {
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
  loadingScene = createLoadingScene(charH, hud.token('--paper'));
  paperFigurine = createPaperFigurine(model, renderer, hud.token('--paper'));
  scene.add(loadingScene.object);
  if (collision) rebuildPlatformOverlay(); // rebuild the NavGrid now charH (headroom/step) is real
  resetToSpawn();
  updateLoading(); // after the figurine is in its place: if the room was only waiting for it, this starts the room arriving around it
  requestScanLight();
  console.log(`character: ${charH.toFixed(3)} tall, ${gltf.animations.length} clips`);
}

/** Put the figurine on the floor at the spawn point and re-frame the camera behind it. */
function resetToSpawn(): void {
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
  // align the spawn with the NavGrid so the reliability layer picks it up cleanly
  const s = navGrid?.surfaceNear(player.position.x, player.position.z, player.position.y, charH) ?? null;
  if (s !== null) player.position.y = s;
  player.rotation.set(0, 0, 0);
  velocity.set(0, 0, 0);
  wasGrounded = false;
  supportY = player.position.y;         // stand on the spawn surface
  lastGood.copy(player.position);
  smoothFeetY = player.position.y;
  if (charModel) charModel.position.y = charFeetOffset;
  state = 'ground';
  camera.position.copy(player.position).add(new THREE.Vector3(charH * 1.2, charH * 2.6, charH * 4.5));
  camPull = 1; camSwinging = false;
  orbit.target.set(player.position.x, player.position.y + charH * CAM_PIVOT, player.position.z);
  orbit.update();
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

function play(name: string, fade = TUNE.fade): void {
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
  if (name === 'jump_start') { velocity.y = TUNE.jumpVel * charH; state = 'air'; play('jump_loop', 0.08); }
  else if (name === 'jump_land') { state = 'ground'; play('idle', 0.25); }
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
  if (v && !e.repeat && MOVE_KEYS.has(e.code)) camBasisHeld = false; // a fresh press is a fresh intent, in the current view
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
function jumpKey(): void {
  if (state === 'ground') startJump();
  else if (state === 'climb') climbJumpOff();
}

// ?tel=1 only: drive the figurine in fixed steps, for a script whose run has to repeat
// exactly (scripts/climbfuzz.mjs). Driven by real key presses, a run cannot repeat: each
// frame is as long as the clock says, so a key held for the same 300 ms carries the
// figurine a different distance every time. Once a script has called __step, time stops
// coming from the clock: the figurine, its animation and the camera move only for the
// `seconds` a call asks for, in frames STEP_DT long, with the keys it names held (and a
// jump at the first). Between calls nothing moves, however long the script takes.
const STEP_DT = 1 / 30; // seconds: within the 0.05 a real frame is clamped to
let stepped = false, stepFrames = 0, stepDone: (() => void) | null = null;
if (TEL) (window as unknown as { __step?: (keys: string[], seconds: number, jump?: boolean) => Promise<void> }).__step = (keys, seconds, jump = false) =>
  new Promise<void>((done) => {
    stepped = true;
    for (const [code, k] of [['KeyW', 'f'], ['KeyS', 'b'], ['KeyA', 'l'], ['KeyD', 'r']] as const) {
      const down = keys.includes(code) ? 1 : 0;
      if (down && !move[k]) camBasisHeld = false; // a fresh press, as keyEvent has it
      move[k] = down;
    }
    move.run = keys.includes('ShiftLeft');
    if (jump) jumpKey();
    stepFrames = Math.max(1, Math.round(seconds / STEP_DT));
    stepDone = done;
  });

function startJump(): void {
  if (actions['jump_start']) { state = 'jump_start'; play('jump_start', 0.06); }
  else { velocity.y = TUNE.jumpVel * charH; state = 'air'; play(actions['jump_loop'] ? 'jump_loop' : 'idle', 0.08); }
}

// --- collision ---------------------------------------------------------------
// Voxelization runs in a Web Worker so the ~1s+ first build doesn't freeze the frame.
const voxelize = workerCaller<{ positions: Float32Array; opacity: Float32Array; cov: Float32Array | null; count: number; matrix: number[]; voxelSize: number; unit: number; opts: VoxelOptions }, VoxelSurface>(
  new Worker(new URL('./voxelize.worker.ts', import.meta.url), { type: 'module' }), 'collision build');

function voxelizeInWorker(centers: THREE.BufferAttribute, opacity: Float32Array, cov: Float32Array | null, matrixWorld: THREE.Matrix4, opts: VoxelOptions): Promise<VoxelSurface> {
  const positions = (centers.array as Float32Array).slice(); // copies so we can transfer
  const op = opacity.slice();                                 // (originals kept for re-voxelize)
  const cv = cov ? cov.slice() : null;
  return voxelize(
    { positions, opacity: op, cov: cv, count: centers.count, matrix: Array.from(matrixWorld.elements), voxelSize: VOXEL_SIZE, unit: GRAIN, opts },
    cv ? [positions.buffer, op.buffer, cv.buffer] : [positions.buffer, op.buffer],
  );
}

// Build the surface (cached after the first load), a three-mesh-bvh over it for
// the controller, and a toggleable debug overlay. `token` guards a slow async
// build from landing after the user has already swapped to another scan.
async function buildCollision(file: string, token: number, centers: THREE.BufferAttribute, opacity: Float32Array, cov: Float32Array | null, matrixWorld: THREE.Matrix4): Promise<void> {
  const t0 = performance.now();
  // uploads aren't cached: re-cleaning changes the splat under a stable id, so the
  // key wouldn't reflect it — always re-voxelize an upload.
  const useCache = !file.startsWith('upload:');
  const opts = { ...VOXEL_OPTS }; // as they are now: a slider can move while this waits, and the key must match what is built
  const key = voxelCacheKey(file, VOXEL_SIZE, opts, TARGET_RADIUS);
  let surf: VoxelSurface | null = useCache ? await voxelCacheGet(key) : null;
  const cached = surf !== null;
  if (token !== loadToken) return; // superseded while awaiting the cache
  if (!surf) {
    surf = await voxelizeInWorker(centers, opacity, cov, matrixWorld, opts);
    if (token !== loadToken) return; // superseded while voxelizing
    if (useCache) void voxelCachePut(key, surf);
  }
  const geom = surfaceToGeometry(surf);
  collision = new MeshCollision(geom, GROUND_OFFSET); // note: MeshBVH indexes geom in place
  collisionKey = key;
  const mesh = new THREE.Mesh(
    geom,
    MESHONLY
      ? new THREE.MeshStandardMaterial({ color: 0x9fb4c8, roughness: 0.95, metalness: 0, side: THREE.DoubleSide })
      : new THREE.MeshBasicMaterial({ color: 0x35e08b, wireframe: true, transparent: true, opacity: 0.55 }),
  );
  mesh.visible = showVoxels || MESHONLY;
  scene.add(mesh);
  collisionDebug = mesh;
  lastVoxelSize = surf.voxelSize;
  groundY = surf.groundY ?? null; // (?? : a surface cached before this was recorded has none)
  rebuildPlatformOverlay();
  console.log(
    `collision${cached ? ' (cached)' : ''}: ${surf.occupiedCount.toLocaleString()} voxels, ` +
    `${surf.triangleCount.toLocaleString()} tris @ ${surf.voxelSize.toFixed(3)}u, detail ${surf.detail ?? 1} ` +
    `in ${(performance.now() - t0).toFixed(0)}ms — press V to toggle overlay`,
  );
}

/** Re-voxelize the current scan with the current VOXEL_OPTS (for debug tunables),
 *  without reloading the PLY. Not while a room is loading: there is no settled room to
 *  rebuild then (the saved splats are still the last room's, under the new room's name),
 *  and bumping loadToken would tell the load it had been replaced, so that it never ends.
 *  The load builds collision itself, and catches up afterwards if the settings moved. */
function rebuildCollision(): void {
  if (scanLoading || !lastCenters || !lastOpacity) return;
  disposeCollision();
  buildCollision(currentFile, ++loadToken, lastCenters, lastOpacity, lastCov, lastMatrix)
    .catch((err: unknown) => hud.status(err instanceof Error ? err.message : String(err), 'error'));
}

// --- light the figurine from the scan (see context/lighting.md) ----------------
// The scan's lighting is baked into its splat colours, so the figurine can only match
// it by looking at the scan: render the splats into a cubemap from where the figurine
// is, prefilter it, and use that as the scene's environment light in place of the
// fixed lights. One probe, captured at the figurine — `follow` re-captures as it
// moves, which is the cheapest possible "dynamic" probe.
//   There are two captures, not one: a new capture goes into whichever isn't showing,
// and the light cross-fades over to it, so a re-capture never swaps in a single frame.
const SCAN_LIGHT = { on: true, intensity: 1.5, follow: false, blend: 0.4, fill: true, debug: false }; // blend: seconds to cross-fade to a new capture; fill: see scanFill
// (intensity 1.5: at 1 the figurine is lit like its surroundings, which reads as dull on a
// dark-green character; 2 washes it out in a bright scan like Playroom — context/lighting.md.)
// The probe: where it sits, what it renders, and how often follow mode moves it.
const SCAN_PROBE = {
  height: 0.7,              // body heights up the figurine. The value the default strength was tuned at (context/lighting.md)
  near: 0.05,               // body heights: the probe camera's near plane, well inside the figurine's own width so nothing beside it is clipped
  far: TARGET_RADIUS * 20,  // the probe camera's far plane: well past any scan (they are all scaled to TARGET_RADIUS)
  size: 64,                 // px per cube face. It lights one small figurine, mostly diffusely; the debug mirror ball is the only thing that shows the pixels
  followStep: 1,            // body heights: follow mode re-captures once the figurine is this far from the last capture...
  followIntervalMs: 500,    // ...and at most this often
};
// What the probe sees where the scan has nothing — typically the ceiling, which phone
// scans rarely capture, and the empty space around a tabletop scan. Left as the dark
// backdrop those directions read as "no light from there" and the figurine goes dark
// on top. The scan can't say what was really there, so this is an estimate: the
// average colour of the upper half of the scan (see estimateScanFill).
const scanFill = new THREE.Color();
// The probe's backdrop is our own dome, centred on the probe. (PMREMGenerator can paint
// a solid colour itself, but it does so with a unit box at the world origin, drawn from
// wherever its camera was left by the PREVIOUS capture — so once a capture has been
// taken more than half a unit from the origin, the next one's gaps come out black.)
const scanFillDome = new THREE.Mesh(
  new THREE.SphereGeometry(SCAN_PROBE.far * 0.5, 24, 12), // anywhere inside the far plane will do: it is drawn first and ignores depth
  new THREE.MeshBasicMaterial({ side: THREE.BackSide, depthTest: false, depthWrite: false, toneMapped: false, fog: false }),
);
scanFillDome.renderOrder = -1e6; // behind everything
scanFillDome.frustumCulled = false;
scanFillDome.visible = false;
scene.add(scanFillDome);
let scanLightPmrem: THREE.PMREMGenerator | null = null;
const scanLightEnv: Array<THREE.WebGLRenderTarget | null> = [null, null];
const scanLightMix = uniform(0);           // which capture is lighting the scene: 0 = the first, 1 = the second, between = mid-fade
let scanLightShown = 0;                    // the capture being shown, or faded toward
let scanLightNode: unknown = null;         // the environment: the two captures mixed by scanLightMix
const scanLightAt = new THREE.Vector3();   // where the newest probe was captured
let scanLightWanted = false;               // a capture has been asked for and not yet taken
let scanLightLast = -Infinity;             // when the last capture ran (performance.now)
let scanLightBroken = false;               // a capture threw: stop trying, and leave the fixed lights (or the last good capture) in charge
const scanProbeAt = new THREE.Vector3();

/** Ask for a new capture. It is taken as soon as one can be (see updateScanLight), so
 *  it is safe to ask at any time: before the scan has loaded, or in the middle of a fade. */
function requestScanLight(): void { scanLightWanted = true; }

/** Where the probe belongs right now: at the figurine. */
function scanProbePoint(out: THREE.Vector3): THREE.Vector3 {
  return out.set(player.position.x, player.position.y + charH * SCAN_PROBE.height, player.position.z);
}

/** Can a capture be taken? There has to be a scan to look at (the mesh-only view hides
 *  it, so there the fixed lights stay), and the figurine has to be standing in it — it
 *  is only placed once the scan's collision exists (resetToSpawn). */
function scanLightReady(): boolean {
  return !MESHONLY && !scanLightBroken && !!currentSplat && charLoaded && !!collision;
}

/** Render the scan into the capture that isn't showing, and start fading over to it. */
function captureScanLight(): void {
  const splat = currentSplat!;
  const pmrem = (scanLightPmrem ??= new THREE.PMREMGenerator(renderer as unknown as THREE.WebGLRenderer));
  const lit = scene as unknown as { environmentNode: unknown };
  // everything the capture changes about the scene, put back whatever happens
  const hidden: THREE.Object3D[] = [];
  const envNode = lit.environmentNode, bg = scene.background, dark = shadowDark.value;
  const resumeReveal = revealPaused(); // the probe must see the whole room, however far the reveal has got
  const t0 = performance.now();
  try {
    // only the scan lights the probe: hide the figurine and the debug overlays...
    for (const o of [player, collisionDebug, platformDebug, scanDebugBalls, scanDebugThumb, loadingScene?.object]) if (o && o.visible) { o.visible = false; hidden.push(o); }
    lit.environmentNode = null; scene.background = null;
    shadowDark.value = 0; // ...and the figurine's own shadow
    scanProbePoint(scanLightAt);
    scanFillDome.material.color.copy(SCAN_LIGHT.fill ? scanFill : SURROUND.beyond); // unfilled, a gap is what is around the scan: near-darkness
    scanFillDome.position.copy(scanLightAt);
    scanFillDome.visible = true;
    const shoot = (i: number) => {
      scanLightEnv[i] = pmrem.fromScene(scene, 0, charH * SCAN_PROBE.near, SCAN_PROBE.far, { size: SCAN_PROBE.size, position: scanLightAt, renderTarget: scanLightEnv[i] ?? undefined } as never);
    };
    if (!scanLightNode) {
      // first time: fill both, so the mix has two valid captures to read from
      shoot(0); shoot(1);
      scanLightNode = mix(pmremTexture(scanLightEnv[0]!.texture), pmremTexture(scanLightEnv[1]!.texture), scanLightMix);
      buildScanDebug();
      scanLightShown = 0; scanLightMix.value = 0;
    } else {
      const next = 1 - scanLightShown; // into the one that isn't showing, then fade over to it
      shoot(next);
      scanLightShown = next;
      // no fade when it would not be seen anyway: none asked for, or the figurine is all paper (waiting for a room, or at the start of its arrival)
      if (SCAN_LIGHT.blend <= 0 || paperFigurine?.allPaper()) scanLightMix.value = next;
    }
    if (TEL) console.log(`SCANLIGHT captured at ${scanLightAt.x.toFixed(2)},${scanLightAt.y.toFixed(2)},${scanLightAt.z.toFixed(2)} in ${(performance.now() - t0).toFixed(1)}ms`);
  } catch (err) {
    scanLightBroken = true;
    console.error('scan lighting: capture failed, so it is switched off', err);
  } finally {
    scanFillDome.visible = false;
    shadowDark.value = dark;
    resumeReveal();
    lit.environmentNode = envNode; scene.background = bg;
    for (const o of hidden) o.visible = true;
    // The capture left the splats sorted for the probe's last view. GaussianSplat only
    // re-sorts when the view DIRECTION changes, so a camera looking the same way as that
    // last view would keep the probe's order — in which everything nearer than the probe
    // shares one depth bin, i.e. is not sorted at all. Make the next frame sort afresh.
    splatInternals(splat)._sortInitialized = false;
    scanLightLast = performance.now();
  }
  applyScanLight();
}

/** Estimate the colour of what the scan is missing overhead: the average colour of its
 *  upper half — the splats above the scan's median height, where "median" and
 *  "average" are both weighted by how much each splat shows (opacity × size). In a
 *  room that is the upper walls, which a ceiling usually resembles; in a tabletop scan
 *  it is the upper part of whatever was captured. Colours are averaged as stored,
 *  which is also how the probe's own blur averages them. */
function estimateScanFill(centers: THREE.BufferAttribute, color: THREE.BufferAttribute, cov: Float32Array | null, world: THREE.Matrix4, out: THREE.Color): void {
  const n = centers.count, e = world.elements, BINS = 256;
  // one walk over the splats for each one's height and how much it shows — its opacity
  // times its footprint (the sum of its variances ∝ area); the rest works from these
  const height = new Float32Array(n), weight = new Float32Array(n);
  let y0 = Infinity, y1 = -Infinity, total = 0;
  for (let i = 0; i < n; i++) {
    const y = height[i] = e[1] * centers.getX(i) + e[5] * centers.getY(i) + e[9] * centers.getZ(i) + e[13];
    total += weight[i] = color.getW(i) * (cov ? cov[i * 6] + cov[i * 6 + 3] + cov[i * 6 + 5] : 1);
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const span = Math.max(y1 - y0, 1e-9), hist = new Float64Array(BINS);
  for (let i = 0; i < n; i++) hist[Math.min(BINS - 1, Math.floor(((height[i] - y0) / span) * BINS))] += weight[i];
  let acc = 0, bin = 0;
  while (bin < BINS - 1 && acc + hist[bin] < total / 2) acc += hist[bin++];
  const median = y0 + (bin / BINS) * span;
  let r = 0, g = 0, b = 0, sum = 0;
  for (let i = 0; i < n; i++) {
    if (height[i] < median) continue;
    const w = weight[i];
    r += color.getX(i) * w; g += color.getY(i) * w; b += color.getZ(i) * w; sum += w;
  }
  if (sum > 0) out.setRGB(r / sum, g / sum, b / sum); else out.copy(SURROUND.beyond);
  if (TEL) console.log(`SCANFILL rgb=${out.r.toFixed(2)},${out.g.toFixed(2)},${out.b.toFixed(2)} from splats above y=${median.toFixed(2)} (scan spans ${y0.toFixed(2)}..${y1.toFixed(2)})`);
}

/** Scan lighting replaces both fixed lights; with it off, or with no capture to use
 *  (before the first one, and always in the mesh-only view, which has no scan to
 *  capture), the fixed fill and sun light the scene as before. */
function applyScanLight(): void {
  const on = SCAN_LIGHT.on && !!scanLightNode;
  (scene as unknown as { environmentNode: unknown }).environmentNode = on ? scanLightNode : null;
  scene.environmentIntensity = SCAN_LIGHT.intensity;
  hemi.visible = sun.visible = !on;
  const dbg = on && SCAN_LIGHT.debug;
  if (scanDebugBalls) scanDebugBalls.visible = dbg;
  if (scanDebugThumb) scanDebugThumb.visible = dbg;
}

// Debug view of the probe: a thumbnail of exactly what it captured, and three balls
// lit by it. The thumbnail is the capture unwrapped as a panorama — up at the top,
// down at the bottom, all the way round left to right — so a dark band along the top
// IS the light arriving from overhead. The balls are a mirror (what the probe sees,
// sharp), a half-rough metal (the same, blurred) and a matte white one (the soft
// light every surface receives — its top is what the figurine's top gets).
let scanDebugBalls: THREE.Group | null = null;
let scanDebugThumb: THREE.Mesh | null = null;
const SCAN_DEBUG_BALLS = [{ roughness: 0, metalness: 1 }, { roughness: 0.5, metalness: 1 }, { roughness: 1, metalness: 0 }];
const SCAN_DEBUG = {
  ballRadius: 0.18,  // body heights: small enough not to hide the figurine
  ballHeight: 1.6,   // body heights above the feet: clear of its head
  ballSpacing: 2.6,  // ball radii between centres: a gap between neighbours
  thumbHeight: 0.2,  // of the view's height
  thumbMargin: 0.02, // of the view's height, off the corner
};

function buildScanDebug(): void {
  if (scanDebugBalls) return;
  const balls = new THREE.Group(), geo = new THREE.SphereGeometry(1, 32, 16);
  SCAN_DEBUG_BALLS.forEach((m, i) => {
    const ball = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xffffff, ...m }));
    ball.position.x = (i - 1) * SCAN_DEBUG.ballSpacing; // a row, in ball radii
    balls.add(ball);
  });
  balls.visible = false;
  scene.add(balls);
  scanDebugBalls = balls;

  // the panorama: each pixel looks up the capture in the direction it stands for
  const lon = uv().x.sub(0.5).mul(PI.mul(2)), lat = uv().y.sub(0.5).mul(PI);
  const dir = vec3(cos(lat).mul(sin(lon)), sin(lat), cos(lat).mul(cos(lon)));
  const mat = new MeshBasicNodeMaterial({ depthTest: false, depthWrite: false, transparent: true });
  mat.colorNode = mix(pmremTexture(scanLightEnv[0]!.texture, dir, float(0)), pmremTexture(scanLightEnv[1]!.texture, dir, float(0)), scanLightMix);
  const thumb = new THREE.Mesh(new THREE.PlaneGeometry(2, 1), mat);
  thumb.renderOrder = 1e6; // over everything
  thumb.frustumCulled = false;
  thumb.visible = false;
  scene.add(camera); // so the camera can carry the thumbnail
  camera.add(thumb);
  scanDebugThumb = thumb;
}

/** Keep the debug balls over the figurine's head and the thumbnail pinned to the
 *  bottom-left corner of the view. */
function updateScanDebug(): void {
  if (!scanDebugBalls || !scanDebugThumb || !scanDebugBalls.visible) return;
  scanDebugBalls.scale.setScalar(charH * SCAN_DEBUG.ballRadius);
  scanDebugBalls.position.set(player.position.x, player.position.y + charH * SCAN_DEBUG.ballHeight, player.position.z);
  scanDebugBalls.quaternion.copy(camera.quaternion); // the row runs across the screen
  const d = charH, halfH = d * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2), halfW = halfH * camera.aspect;
  const h = halfH * 2 * SCAN_DEBUG.thumbHeight, margin = halfH * 2 * SCAN_DEBUG.thumbMargin; // the panorama is twice as wide as tall
  scanDebugThumb.scale.setScalar(h);
  scanDebugThumb.position.set(-halfW + margin + h, -halfH + margin + h / 2, -d);
}

/** Per frame: advance the cross-fade, then take a capture if one is due — because it
 *  was asked for, or because follow mode is on and the figurine has moved on. */
function updateScanLight(dt: number): void {
  if (scanLightNode && scanLightMix.value !== scanLightShown) {
    const step = SCAN_LIGHT.blend > 0 ? dt / SCAN_LIGHT.blend : 1;
    scanLightMix.value = scanLightShown ? Math.min(1, scanLightMix.value + step) : Math.max(0, scanLightMix.value - step);
    // One fade at a time. A new capture is rendered into whichever isn't showing, and
    // mid-fade both are: so every capture, asked for or not, waits for the fade to arrive.
    return;
  }
  if (!scanLightReady()) return; // a request stays pending until there is something to capture
  if (!scanLightWanted && scanLightNode && SCAN_LIGHT.on && SCAN_LIGHT.follow) {
    const moved = scanProbePoint(scanProbeAt).distanceTo(scanLightAt);
    scanLightWanted = moved > charH * SCAN_PROBE.followStep && performance.now() - scanLightLast > SCAN_PROBE.followIntervalMs;
  }
  if (!scanLightWanted) return;
  scanLightWanted = false;
  captureScanLight();
}

// --- contact shadow (see context/lighting.md) --------------------------------
// The scan is not a surface a shadow can be cast onto: its splats are transparent
// blobs with no depth, so anything drawn as a separate layer is either hidden under
// them or shows through whatever stands in front. So the shadow is put INTO the
// splats: a splat lying at the surface the figurine touches is darkened where it falls
// inside a soft disc around the contact point (the same idea as Spark's SplatEdit). The
// shadow then sits exactly on the visible surface and is hidden by whatever is in front.
const CONTACT_SHADOW = { on: true, darkness: 0.55, size: 0.6 }; // size: radius in body heights
const SHADOW_THICKNESS = 0.5;  // body heights: how far above/below the feet still counts as the surface. Generous, because the
                               // visible floor is not where the feet are: measured medians of +0.18 (Playroom), -0.17 (Living Room), -0.25 (Counter)
const SHADOW_FADE_HEIGHT = 2;  // body heights off the surface at which the shadow has faded out
const SHADOW_EASE = 20;        // per second: how fast the shadow follows a change of surface (most of the way in a tenth of a second)
const SHADOW_GRAZE = 1e-3;     // a view ray this close to parallel with the surface (the sine of ~0.06°) doesn't meet it anywhere useful
const shadowCentre = uniform(new THREE.Vector3());          // where the figurine touches (or hangs over) a surface
const shadowNormal = uniform(new THREE.Vector3(0, 1, 0));   // that surface's facing: up on the ground, out of the wall when climbing
const shadowRadius = uniform(1), shadowThick = uniform(1), shadowDark = uniform(0);

/** Make a splat object darken itself inside the contact-shadow region. Two questions,
 *  answered at different rates:
 *    - Is this splat at the contact surface? Once per splat, from its centre: how far
 *      it is off the surface (`lift`). Everything further than the shadow's thickness
 *      is left alone — that is nearly every splat, and what keeps this cheap.
 *    - Which of its pixels are in the disc? Per pixel: where the view ray through the
 *      pixel meets the plane the figurine stands on. Floors are often a few very
 *      large, flat splats (a rug in Playroom is ~500 splats per body-width), so
 *      darkening whole splats by their centre gives a faint smudge in the wrong place.
 *      It is the figurine's plane, not the splat's own level: the figurine is drawn
 *      where its feet are, which is not quite where the scan's floor is, and a disc
 *      placed at each splat's height lands visibly in front of it.
 *  It reads two things from the splat's internals (splatInternals), both already on
 *  the GPU for the splat's own drawing: its centres, and the draw order, which says
 *  which splat each drawn instance is. */
function installContactShadow(splat: GaussianSplat): void {
  // (typed loosely: three's types don't describe the material's colour hook)
  const material = splat.material as unknown as { colorNode: any; needsUpdate: boolean };
  const internals = splatInternals(splat);
  const order = internals._sort?.orderRead, centreRead = internals._buffers?.centerRead;
  if (!order || !centreRead || !material.colorNode) { console.warn('contact shadow: this GaussianSplat does not expose its centres and draw order — shadow disabled'); return; }
  // per splat: how far its centre is off the contact surface, along the surface's normal
  const lift = varying(Fn(() => {
    const centre = centreRead.element(order.element(instanceIndex)).xyz;
    return modelWorldMatrix.mul(vec4(centre, 1)).xyz.sub(shadowCentre).dot(shadowNormal);
  })());
  const base = material.colorNode; // vec4: the splat's colour and coverage
  material.colorNode = Fn(() => {
    const c = vec4(base).toVar();
    If(lift.abs().lessThan(shadowThick).and(shadowDark.greaterThan(0)), () => {
      // per pixel: the view ray through this pixel, met with the plane the figurine stands on
      const ndc = vec4(viewportUV.x.mul(2).sub(1), viewportUV.y.oneMinus().mul(2).sub(1), 1, 1);
      const far = cameraProjectionMatrixInverse.mul(ndc);
      const ray = cameraWorldMatrix.mul(vec4(far.xyz.div(far.w), 0)).xyz.normalize();
      const from = cameraPosition.sub(shadowCentre);
      const toward = ray.dot(shadowNormal), off = from.dot(shadowNormal);       // the ray's and the camera's components along the normal
      // the ray meets the plane only if it isn't running alongside it, and only ahead of
      // the camera if it is heading toward the plane from the side the camera is on
      If(toward.abs().greaterThan(SHADOW_GRAZE).and(toward.mul(off).lessThan(0)), () => {
        const along = from.add(ray.mul(off.negate().div(toward)));               // offset from the contact point, in that plane
        const inside = smoothstep(shadowRadius, shadowRadius.mul(0.15), along.length())
          .mul(smoothstep(shadowThick, shadowThick.mul(0.6), lift.abs()));
        c.rgb.mulAssign(inside.mul(shadowDark).oneMinus());
      });
    });
    return c;
  })();
  material.needsUpdate = true;
}

/** Per frame: where the shadow falls, and how strong it is. */
const shadowAt = new THREE.Vector3(), shadowFacing = new THREE.Vector3();
function updateContactShadow(dt: number): void {
  const p = player.position, radius = CAPSULE_RADIUS * charH;
  let height = 0; // how far the figurine is off the surface it would shadow
  if (state === 'climb') {
    // on a wall: the shadow is on the face it's hanging from, behind its body
    shadowAt.set(p.x, p.y + charH * CLIMB.chest, p.z).addScaledVector(climbDir, radius * CLIMB.gap);
    shadowFacing.copy(climbDir).negate();
  } else if (state === 'air') {
    // in the air: onto the ground it would land on, straight below
    const ground = navGrid ? navGrid.surfaceBelow(p.x, p.z, p.y + radius * 0.5) : null;
    height = ground === null ? Infinity : Math.max(0, p.y - ground);
    shadowAt.set(p.x, ground ?? p.y, p.z);
    shadowFacing.copy(WORLD_UP);
  } else {
    // standing: right where the feet are
    shadowAt.copy(p);
    shadowFacing.copy(WORLD_UP);
  }
  // ease, so stepping onto a wall or off a ledge moves the shadow instead of jumping it
  const t = Math.min(1, SHADOW_EASE * dt), normal = shadowNormal.value;
  shadowCentre.value.lerp(shadowAt, t);
  // The normal turns toward the new facing. Blending two unit vectors only does that
  // while they aren't opposed: straight across (one wall to the wall facing it) the
  // blend passes through zero, and short of halfway it normalises back to where it
  // started. There is no shorter way round to ease along, so past a right angle it jumps.
  if (normal.dot(shadowFacing) < 0) normal.copy(shadowFacing);
  else normal.lerp(shadowFacing, t).normalize();
  const fade = 1 - Math.min(1, height / (charH * SHADOW_FADE_HEIGHT)); // higher → fainter and wider
  shadowRadius.value = charH * CONTACT_SHADOW.size * (2 - fade);
  shadowThick.value = charH * SHADOW_THICKNESS;
  shadowDark.value = CONTACT_SHADOW.on ? CONTACT_SHADOW.darkness * fade : 0;
}

// --- controller update ------------------------------------------------------
const camFwd = new THREE.Vector3(), camRight = new THREE.Vector3(), wishDir = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0), WORLD_DOWN = new THREE.Vector3(0, -1, 0);
const camLook = new THREE.Vector3(), camDir = new THREE.Vector3();
const CAM_PIVOT = 0.7; // the camera looks at the figurine this far up its height (about head centre)

// The follow camera is a spring arm from the pivot (the figurine) to the camera. The
// arm's full length (`camWant`) is the user's zoom and belongs to OrbitControls; when
// something blocks the view the arm is drawn shorter by `camPull`, WITHOUT touching
// the zoom, so it springs back out once the view is clear.
let camWant = 0;          // arm length with nothing in the way (the user's zoom)
let camPull = 1;          // rendered arm = camWant * camPull (1 = unobstructed)
let camSwinging = false;  // coming round to the figurine's back (see updateCamera)
let camHandsOff = true;    // the user hasn't orbited/zoomed since this climb began → auto-swing allowed
const camHome = new THREE.Vector3();
let camBasisHeld = false; // movement keys keep the camera frame they were pressed in (see updateController)

/** Glue the orbit pivot to the figurine so the camera follows while the user
 *  orbits/zooms; pull the camera in if something is between it and the pivot; and,
 *  on a wall, bring it round behind the figurine if that wall is what's in the way. */
function updateCamera(dt: number): void {
  const t = orbit.target;
  // hand OrbitControls the un-shortened arm — it reads the zoom off the camera position
  if (camPull < 1 && camWant > 0) {
    camDir.subVectors(camera.position, t).normalize();
    camera.position.copy(t).addScaledVector(camDir, camWant);
  }
  camLook.set(player.position.x, smoothFeetY + charH * CAM_PIVOT, player.position.z);
  t.lerp(camLook, 0.15);
  // Climbing puts the figurine flat against a wall, so a camera left on the wall's far
  // side (e.g. it walked off a ledge and now hangs on the face below) can't be fixed by
  // shortening the arm — the wall is closer than the figurine is wide. Swing round to
  // the open side instead: behind the figurine's back.
  if (state !== 'climb') camSwinging = false;
  if (camSwinging) {
    const ox = camera.position.x - t.x, oz = camera.position.z - t.z;
    const cur = Math.atan2(ox, oz), home = Math.atan2(-climbDir.x, -climbDir.z);
    const a = lerpAngle(cur, home, TUNE.camSwing * dt) - cur;
    const c = Math.cos(a), sn = Math.sin(a);
    camera.position.x = t.x + ox * c + oz * sn;
    camera.position.z = t.z + oz * c - ox * sn;
    if (Math.abs(lerpAngle(cur, home, 1) - cur) < 0.05) camSwinging = false; // arrived
  }
  orbit.update();
  camDir.subVectors(camera.position, t);
  camWant = camDir.length();
  if (!collision || camWant < 1e-4) { camPull = 1; return; }
  camDir.divideScalar(camWant);
  const clear = collision.rayDistance(t, camDir, camWant);
  const blocked = clear < camWant;
  // Offer the swing only while the user is leaving the camera alone, and only if the
  // view from behind the figurine is actually clearer than this one — otherwise it
  // would trade one blocked view for another and fight every attempt to orbit out of it.
  if (blocked && state === 'climb' && camHandsOff && !camSwinging) {
    const flat = Math.hypot(camDir.x, camDir.z); // keep the current elevation
    camHome.set(-climbDir.x * flat, camDir.y, -climbDir.z * flat);
    if (collision.rayDistance(t, camHome, camWant) > clear) {
      camSwinging = true;
      camBasisHeld = !!(move.f || move.b || move.l || move.r); // keys already down keep steering by the view they were pressed in
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
  camera.position.copy(t).addScaledVector(camDir, camWant * camPull);
}
/** Debug free-camera: park at a fixed spherical orbit around the look-at point
 *  (see FREECAM_OPTS). Deterministic — lets a headless screenshot frame any region. */
const freeCenter = new THREE.Vector3();
function updateFreeCam(): void {
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
function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * Math.min(t, 1);
}

// --- climb (scale a near-vertical wall, then cling; Space to jump off) --------
// Automatic: walking into a wall enters climb. The figurine ascends the face,
// following it up; when the wall ends it tops out — onto a surface if there's one
// to stand on, otherwise it clings at the top until you jump (Space) off.
const climbDir = new THREE.Vector3();   // horizontal direction into the wall we're on
const climbTry = new THREE.Vector3();   // scratch: a candidate direction, until a climb actually starts
const climbProbe = new THREE.Vector3(); // scratch for the forward wall raycast
const climbSide = new THREE.Vector3();  // scratch: sideways direction along the wall
let climbAwaitRelease = false;          // grabbed a lip mid-walk: the still-held walk keys mean "keep going down" until let go
let climbV = 0, climbH = 0;             // this frame's climb input after latches: up/down, right/left
let climbSideMix = 0;                   // animation blend: -1 = shimmy left, 0 = up/down climb, +1 = shimmy right
let climbAtEdge = false;                // sideways shuffle is stopped at the wall's edge (telemetry de-dupe)
let climbCling = false;                 // topped out with nowhere to stand → hanging
let climbBlocked = false;               // the body is being pushed out of something (telemetry de-dupe)

/** Climb geometry. Heights and reaches are fractions of the figurine's height; `gap`
 *  and `mantleOver` are in capsule radii. */
const CLIMB = {
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

/** Walk it or climb it — one cutoff, the "Climb threshold" slider: a surface steeper
 *  than that is a wall. The NavGrid won't stand on it (this is its `slopeMin`) and the
 *  climb will hang on it. Returned as the largest |normal.y| a wall may have. */
function wallSlopeMax(): number {
  return Math.cos(THREE.MathUtils.degToRad(PLATFORM_OPTS.climbDeg));
}
function isWall(w: WallHit): boolean {
  return Math.abs(w.up) <= wallSlopeMax();
}

/** A surface the climber can be on: the nearest one along `dir`, seen from its OUTER
 *  side. A surface met from behind means the probe began inside something solid (a
 *  jump can sink into the top of an object with no walkable surface on it) — that is
 *  the inside of a wall, not a wall to hang on, and nothing beyond it counts either.
 *  The result is reused by the next probe: read it first. */
function climbWall(origin: THREE.Vector3, dir: THREE.Vector3, max: number): WallHit | null {
  const w = collision ? collision.wallAhead(origin, dir, max) : null;
  return w && w.front ? w : null;
}

/** The walkable ground a climber on a wall in direction (dx,dz), feet at `y`, would
 *  come down onto: under it, or — since the cell hard against a wall's foot often
 *  isn't walkable — a step back from the wall. null = the wall hangs over nothing we
 *  can stand on. */
const climbGroundAt = new THREE.Vector3();
function climbGround(y: number, dx: number, dz: number): THREE.Vector3 | null {
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
function climbStartsHere(x: number, feetY: number, z: number, dir: THREE.Vector3): boolean {
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
function tryStartClimb(dx: number, dz: number, feetY = supportY): boolean {
  if (!collision || !actions['climb']) return false;
  climbTry.set(dx, 0, dz);
  if (climbTry.lengthSq() < 1e-9) return false;
  climbTry.normalize();
  const p = player.position;
  if (!climbStartsHere(p.x, feetY, p.z, climbTry)) return false;
  const { dist, up } = climbStart;
  const midAir = state === 'air';
  climbDir.copy(climbTry);
  climbCling = false;
  climbAwaitRelease = false;
  state = 'climb';
  velocity.set(0, 0, 0);
  player.rotation.y = Math.atan2(climbDir.x, climbDir.z); // face the wall
  play('climb', TUNE.fade);
  camHandsOff = true;
  if (TEL) console.log(`CLIMB-START${midAir ? ' (mid-air)' : ''} y=${p.y.toFixed(2)} dist=${dist.toFixed(2)} up=${up.toFixed(2)}`);
  return true;
}

/** True if we're walking off a ledge whose face is a wall; if so, grab the lip and
 *  enter the climb (hanging just below it) so you can descend the face. */
function tryStartClimbDown(dx: number, dz: number): boolean {
  if (!collision || !navGrid || !actions['climb']) return false;
  climbTry.set(dx, 0, dz);
  if (climbTry.lengthSq() < 1e-9) return false;
  climbTry.normalize();
  const p = player.position, gap = CAPSULE_RADIUS * charH * CLIMB.gap;
  const tx = p.x + climbTry.x * navGrid.step, tz = p.z + climbTry.z * navGrid.step;
  // must be a real edge: nothing walkable to continue onto at this level...
  if (navGrid.surfaceNear(tx, tz, supportY, charH * STEP_DOWN_MAX) !== null) return false;
  // ...with a meaningful drop below...
  const lipY = supportY - charH * CLIMB.lipProbe;
  const below = navGrid.surfaceBelow(tx, tz, lipY);
  if (below === null || supportY - below < charH * STEP_DOWN_MAX) return false;
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
  if (TEL) console.log(`CLIMBDOWN-START y=${(supportY - charH * CLIMB.hang).toFixed(2)} below=${below.toFixed(2)} face=${w.distance.toFixed(2)}`);
  p.set(fx + ox * gap, supportY - charH * CLIMB.hang, fz + oz * gap);
  climbDir.set(-ox, 0, -oz);                  // into the wall
  climbCling = false;
  // The keys held right now mean "walk off this ledge", not climb input: once we've
  // turned to face the wall, the same forward key would mean UP and haul us straight
  // back over the lip. Until they're released they keep meaning what they meant —
  // carry on over the edge, i.e. down the face; after that W/S/A/D steer the climb.
  climbAwaitRelease = true;
  state = 'climb';
  velocity.set(0, 0, 0);
  play('climb', TUNE.fade);
  camHandsOff = true;
  return true;
}

/** Jump off the wall: launch up and away from the face. */
function climbJumpOff(): void {
  velocity.set(-climbDir.x * TUNE.walkSpeed * charH, TUNE.jumpVel * charH, -climbDir.z * TUNE.walkSpeed * charH);
  state = 'air'; climbCling = false;
  play(actions['jump_loop'] ? 'jump_loop' : 'idle', 0.08);
}

/** Leave the climb standing at (x,y,z) on walkable ground. */
function climbStandAt(x: number, y: number, z: number): void {
  const p = player.position;
  p.set(x, y, z);
  supportY = y; lastGood.copy(p);
  state = 'ground'; velocity.set(0, 0, 0);
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
function updateClimbBlend(dt: number): void {
  const c = actions['climb'], r = actions['climb_side_r'], l = actions['climb_side_l'];
  if (!c || !r || !l) return;
  const on = state === 'climb', moving = on && (climbV !== 0 || climbH !== 0);
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
function climbUpdate(dt: number): boolean {
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
  // carried into whatever is beside or above it. Push the body out of anything this
  // move put it in — the same collide-and-slide walking uses, in all three axes here.
  // An object in the way pushes straight back, so the move makes no headway; a lump
  // of the wall itself pushes outward, and the climber rides over it.
  //   Only while the overlap is shallower than the body's radius, though: that is as
  // deep as one frame's move can take it, and as deep as "which way is out" has a
  // single answer. Deeper means the body was already inside something when the move
  // began (a grab that started that way) — pushing then can eject it through the far
  // side of a thin shell, so it is left alone.
  const sunk = bodyOverlap(p.x, p.y, p.z, radius);
  if (sunk > radius * CLIMB.skin && sunk <= radius) {
    if (TEL && !climbBlocked) console.log(`CLIMB-PUSHED y=${p.y.toFixed(2)} by=${(sunk / radius).toFixed(2)}r`);
    p.set(wallFeet.x, wallFeet.y - charH * WALL_LIFT, wallFeet.z);
    climbBlocked = true;
  } else climbBlocked = false;
  return false;
}

// scratch vectors for the collide-and-slide loop (avoid per-frame allocation)
const hVel = new THREE.Vector3(), disp = new THREE.Vector3(), correction = new THREE.Vector3(), slideN = new THREE.Vector3();
const navRecover = new THREE.Vector3();
const wallFeet = new THREE.Vector3(), zeroDisp = new THREE.Vector3(), wallCorr = new THREE.Vector3();
const WALL_LIFT = 0.25; // body-vs-wall tests ignore the body below this fraction of its height (see bodyOverlap)

function updateController(dt: number): void {
  // Movement is camera-relative — but an automatic camera move must not re-aim a key
  // that's already held (the swing behind a climber would turn "walk away from the
  // wall" into "walk into it"). Keys that were down when a swing began keep steering by
  // the view they were pressed in, until they're released, another key is pressed, or
  // the user takes the camera.
  if (!(move.f || move.b || move.l || move.r)) camBasisHeld = false;
  if (!camBasisHeld) {
    camera.getWorldDirection(camFwd); camFwd.y = 0; camFwd.normalize();
    camRight.crossVectors(camFwd, WORLD_UP).negate();
  }
  wishDir.set(0, 0, 0).addScaledVector(camFwd, move.f - move.b).addScaledVector(camRight, move.l - move.r);
  const moving = wishDir.lengthSq() > 0;
  if (moving) wishDir.normalize();

  if (state === 'jump_start') return;        // anticipation freeze; onActionFinished launches
  if (!collision) return;

  // Movement for this frame → `grounded`. Climb runs its own update (on the wall);
  // everything else walks/jumps. Both then fall through to the shared render + camera
  // follow below, so the camera tracks the figurine in every state.
  let grounded: boolean;
  climbV = climbH = 0;
  let wasClimbing = false;
  if (state === 'climb') {
    wasClimbing = true;
    grounded = climbUpdate(dt); // true only on the frame it ends standing (mantle / stepping off)
  } else {
    if (player.position.y < -charH * 3) { // lost the surface (rare edge case)
      if (navGrid && useNavGround) { player.position.copy(lastGood); supportY = lastGood.y; velocity.set(0, 0, 0); state = 'ground'; } // snap back to the last valid spot (gentle)
      else resetToSpawn();
      return;
    }
    if (moving) player.rotation.y = lerpAngle(player.rotation.y, Math.atan2(wishDir.x, wishDir.z), TUNE.turnLerp * dt);
    const speed = (move.run ? TUNE.runSpeed : TUNE.walkSpeed) * charH;
    hVel.copy(wishDir).multiplyScalar(moving ? speed : 0);
    const radius = CAPSULE_RADIUS * charH;
    grounded = navGrid && useNavGround ? navMove(dt, radius) : meshMove(dt, radius);
  }
  wasGrounded = grounded;

  // Visual-only vertical smoothing, run for EVERY state so the camera follows: when
  // grounded, damp the bump bob; otherwise (airborne / climbing) track physics exactly.
  if (grounded && !wasClimbing) smoothFeetY += (player.position.y - smoothFeetY) * Math.min(1, 10 * dt);
  else smoothFeetY = player.position.y;
  if (charModel) charModel.position.y = charFeetOffset + (smoothFeetY - player.position.y);

  updateClimbBlend(dt);
  updateLocomotion(grounded, moving); // early-returns while climbing
}

/** How deep the body, feet at (x,y,z), is sunk into the collision mesh — 0 when it
 *  fits. Only the body ABOVE a quarter of its height is tested: floor lumps below that
 *  are the nav's business (standing, landing), and letting them push is what used to
 *  wedge the figurine. The way out is left in `wallCorr`, the freed position in
 *  `wallFeet` (lifted). */
function bodyOverlap(x: number, y: number, z: number, radius: number): number {
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
  if (state === 'air') {
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
      if (floor !== null && p.y <= floor) { p.y = floor; velocity.set(0, 0, 0); supportY = floor; lastGood.copy(p); return true; }
    }
    return false;
  }
  // grounded: walk on the nav (step / slide / step-down), then push out of walls
  const moving = hVel.x !== 0 || hVel.z !== 0;
  if (moving) navHorizontal(hVel.x * dt, hVel.z * dt, band);
  // walls and furniture are solid: push the body out of them sideways
  if (moving) pushOutOfWalls(supportY, radius);
  // Moving into a wall right ahead? Start climbing it. (Triggering off the wall
  // itself — not a near-head-on "block" — makes it fire consistently at any angle.)
  if (moving && tryStartClimb(hVel.x, hVel.z)) return false;
  // Walking off a ledge whose face is a wall? Grab the lip and climb down.
  if (moving && tryStartClimbDown(hVel.x, hVel.z)) return false;
  const here = nav.surfaceNear(p.x, p.z, supportY, band);
  if (here !== null) { p.y = here; supportY = here; velocity.set(0, 0, 0); lastGood.copy(p); return true; }
  if (nav.nearest(lastGood.x, lastGood.z, supportY, navRecover)) { p.copy(navRecover); supportY = navRecover.y; velocity.set(0, 0, 0); lastGood.copy(p); } // recovered
  return true;
}

/** Move on the nav: onto a continuing surface (small step up/down), sliding along a
 *  wall/edge, or a controlled step-DOWN onto a lower platform. Leaves the position
 *  unchanged if there's nowhere to go. */
function navHorizontal(dx: number, dz: number, band: number): void {
  const nav = navGrid!, p = player.position, x0 = p.x, z0 = p.z, tx = x0 + dx, tz = z0 + dz;
  if (nav.surfaceNear(tx, tz, supportY, band) !== null) { p.x = tx; p.z = tz; return; } // continues
  // slide: one axis at a time, the second from wherever the first left us — applying
  // both from the start would be the diagonal step that was just refused
  if (dx !== 0 && nav.surfaceNear(tx, z0, supportY, band) !== null) p.x = tx;
  if (dz !== 0 && nav.surfaceNear(p.x, tz, supportY, band) !== null) p.z = tz;
  if (p.x !== x0 || p.z !== z0) return;
  const down = nav.surfaceBelow(tx, tz, supportY - band);
  if (down !== null && supportY - down <= charH * STEP_DOWN_MAX) { p.x = tx; p.z = tz; supportY = down; }
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
  if (!grounded && wasGrounded && velocity.y <= 0) {
    const gy = collision.groundHeightAt(player.position.x, player.position.z, player.position.y + radius);
    if (gy <= player.position.y && player.position.y - gy < charH * 0.35) { player.position.y = gy; velocity.set(0, 0, 0); grounded = true; }
  }
  return grounded;
}

/** Drive the animation state machine from grounded + movement. */
function updateLocomotion(grounded: boolean, moving: boolean): void {
  if (state === 'climb') return; // climbing owns its own state + animation
  if (!grounded) {
    if (state !== 'air') { state = 'air'; play(actions['jump_loop'] ? 'jump_loop' : 'idle', 0.15); }
    return;
  }
  if (state === 'air') { // just landed
    if (actions['jump_land']) { state = 'land'; play('jump_land', 0.06); return; }
    state = 'ground';
  }
  if (state === 'land') return; // let the land clip finish (onActionFinished → ground)
  state = 'ground';
  play(moving ? (move.run && actions['run'] ? 'run' : 'walk') : 'idle');
}

// --- boot --------------------------------------------------------------------
/** ?tel=1 only: publish the controller's state on `window.__dbg` for the headless
 *  tests. While climbing, `probe` is the nearest surface ahead of / behind / above /
 *  below the chest, tagged F or B for the side it was seen from. A B ahead, behind or
 *  above means the climber is inside something solid, which must never happen. (Below
 *  is informational: the flattened floor's top and underside coincide.) `sunk` is how
 *  deep the climber's body is in the mesh, in capsule radii. */
const dbgAt = new THREE.Vector3(), dbgDir = new THREE.Vector3();
function publishDebugState(): void {
  const P = player.position, ca = actions['climb'];
  let probe: unknown = null, sunk: number | null = null; // sunk: how deep the body is in the mesh, in capsule radii
  if (collision && state === 'climb') {
    const c = collision;
    dbgAt.set(P.x, P.y + charH * CLIMB.chest, P.z);
    const see = (dir: THREE.Vector3, max: number) => { const w = c.wallAhead(dbgAt, dir, max); return w ? `${w.distance.toFixed(2)}${w.front ? 'F' : 'B'}` : '-'; };
    probe = { ahead: see(climbDir, charH * 2), behind: see(dbgDir.copy(climbDir).negate(), charH * 2), above: see(WORLD_UP, charH * 20), below: see(WORLD_DOWN, charH * 20) };
    sunk = +(bodyOverlap(P.x, P.y, P.z, CAPSULE_RADIUS * charH) / (CAPSULE_RADIUS * charH)).toFixed(2);
  }
  (window as unknown as { __dbg?: unknown }).__dbg = {
    state, cling: climbCling, probe, sunk,
    px: +P.x.toFixed(3), py: +P.y.toFixed(3), pz: +P.z.toFixed(3),
    climbYaw: +THREE.MathUtils.radToDeg(Math.atan2(climbDir.x, climbDir.z)).toFixed(1),
    camDist: +camera.position.distanceTo(orbit.target).toFixed(2), camWant: +camWant.toFixed(2), camSwinging,
    anim: activeAction ? activeAction.getClip().name : 'none',
    climbPaused: ca ? ca.paused : null,
    reveal: +revealProgress.toFixed(3), // how much of the room is in place: 0 while waiting, 1 once it has arrived
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
  const { collisionHealth } = await import('./collision-health');
  return collisionHealth({
    walk: navField,
    mesh: { positions: collisionDebug.geometry.attributes.position.array, index: collisionDebug.geometry.index!.array },
    splats: { centers: lastCenters.array, opacity: lastOpacity, count: lastCenters.count, matrix: lastMatrix.elements },
    spawn: [player.position.x, player.position.y, player.position.z],
    unit: GRAIN,
    realCells: Math.round(WALK_FILL.patch * cellsPerGrain() ** 2), // the same line the gap fill draws between ground and a scrap
    move: { jumpVel: TUNE.jumpVel * charH, gravity: -TUNE.gravity * charH, runSpeed: TUNE.runSpeed * charH, climbOver: CAPSULE_RADIUS * charH * CLIMB.mantleOver },
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
function applyMatteView(): void {
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

const clock = new THREE.Clock();
let frames = 0;

async function main(): Promise<void> {
  await renderer.init();
  loadScan(DEFAULT_SCAN);
  setupDebugMenu();
  new GLTFLoader().load(`${import.meta.env.BASE_URL}character.glb`, onLoaded, undefined, (err) => hud.status(`character.glb load failed: ${String(err)}`, 'error'));

  renderer.setAnimationLoop(() => {
    const still = stepped && stepFrames === 0; // (__step: between a script's calls)
    const dt = stepped ? (still ? 0 : STEP_DT) : Math.min(clock.getDelta(), 0.05);
    const waiting = loadingViewOn();
    if (charLoaded && !still) { if (!waiting) updateController(dt); if (FREECAM) updateFreeCam(); else updateCamera(dt); }
    mixer?.update(dt);
    if (charLoaded) { updateContactShadow(dt); updateScanLight(dt); updateScanDebug(); }
    // Everything about waiting follows from one number, how much of the room is in place,
    // so the way into the loading view is as gradual as the way out of it.
    const arrived = revealProgress = updateReveal(dt);
    if (roomLeft && arrived === 0) { clearRoom(); roomLeft(); roomLeft = null; } // the old room is back in the sheet: now it can go
    room.visible = arrived > 0;
    loadingScene?.show(1 - Math.min(1, arrived / HANDOVER)); // the stand-in dots give way to the scan's own at the start of its arrival
    paperFigurine?.show(arrived);                             // the figurine is paper too, and itself once the room is in
    surround.lerpColors(SURROUND.sky, SURROUND.beyond, THREE.MathUtils.smoothstep(arrived, SURROUND.darken[0], SURROUND.darken[1]));
    if (TEL) publishDebugState();
    if (TEL) applyMatteView();
    if (stepFrames > 0 && --stepFrames === 0) { stepDone?.(); stepDone = null; }
    void renderer.renderAsync(scene, camera).then(() => {
      if (charLoaded && ++frames === 3) (window as unknown as { __wwReady?: boolean }).__wwReady = true;
    });
  });
}

addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

/** Show/hide the voxel collision overlay, keeping key + checkbox in sync. */
function setVoxelOverlay(on: boolean): void {
  showVoxels = on;
  if (collisionDebug) collisionDebug.visible = on;
  if (voxelCheckbox) voxelCheckbox.checked = on;
}

function setPlatformOverlay(on: boolean): void {
  showPlatforms = on;
  if (platformDebug) platformDebug.visible = on;
  if (platformCheckbox) platformCheckbox.checked = on;
}

// Spike 1 overlay: decompose the current collision into walkable platforms and
// draw one flat colored tile per cell, colored by platform (golden-ratio hues so
// neighbors are distinct). Rebuilt on scan swap or when a platform slider moves.
const platformTmp = new THREE.Object3D();
const platformColor = new THREE.Color();
function rebuildPlatformOverlay(): void {
  disposePlatformOverlay();
  navGrid = null; navField = null;
  if (!collision) return;
  // leveling puts the real floor at y=0; reject anything a char-height below it as sub-floor floater noise
  const per = cellsPerGrain();
  navGrid = collision.buildNavGrid(navStep(), charH, charH * PLATFORM_OPTS.stepFactor, Math.round(PLATFORM_OPTS.minCells * per * per), wallSlopeMax(), -charH,
    Math.round(PLATFORM_OPTS.bridge * per), Math.round(PLATFORM_OPTS.fill * per));
  const field = navField = navGrid.toField();
  navVersion++;
  void refillWalkable(); // where the figurine can stand has changed, and the fill follows it
  const cells = field.positions.length / 3;
  // size histogram: how concentrated are cells? (a few big surfaces + noise specks?)
  const sizes = new Int32Array(field.platformCount);
  for (let i = 0; i < cells; i++) sizes[field.platformId[i]]++;
  const sorted = [...sizes].sort((a, b) => b - a);
  const big = sorted.filter((s) => s >= cells * 0.05).length; // platforms holding >=5% of cells
  const top3 = cells ? Math.round((100 * (sorted[0] + (sorted[1] ?? 0) + (sorted[2] ?? 0))) / cells) : 0;
  console.log(
    `platforms: ${field.platformCount} total (${big} big), ${cells} cells @ step ${field.sampleStep.toFixed(3)}u — ` +
    `top3 hold ${top3}% of cells, largest=${sorted[0] ?? 0}`,
  );
  if (cells === 0) return;
  const tile = field.sampleStep * 0.92;
  const geom = new THREE.BoxGeometry(tile, tile * 0.35, tile);
  const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.7 });
  const mesh = new THREE.InstancedMesh(geom, mat, cells);
  for (let i = 0; i < cells; i++) {
    platformTmp.position.set(field.positions[i * 3], field.positions[i * 3 + 1], field.positions[i * 3 + 2]);
    platformTmp.updateMatrix();
    mesh.setMatrixAt(i, platformTmp.matrix);
    platformColor.setHSL((field.platformId[i] * 0.61803) % 1, 0.7, 0.55);
    mesh.setColorAt(i, platformColor);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.visible = showPlatforms;
  mesh.frustumCulled = false;
  scene.add(mesh);
  platformDebug = mesh;
}

// The Debug card (the wrench tile, or the ` key). Put new debug tunables here, in
// the section they belong to, rather than reaching for URL params.
function setupDebugMenu(): void {
  const overlays = hud.debug.section('Overlays', true);
  voxelCheckbox = overlays.addToggle('Voxel wireframe (V)', showVoxels, setVoxelOverlay,
    'Draw the collision mesh over the scan as a wireframe.');
  platformCheckbox = overlays.addToggle('Platforms (P)', showPlatforms, setPlatformOverlay,
    'Spike 1: color the walkable surfaces the collision decomposes into — floor, ' +
    'couch, counter. Distinct colors = distinct platforms (reached by climbing/jumping).');

  const light = hud.debug.section('Lighting and shadow');
  light.addToggle('Contact shadow', CONTACT_SHADOW.on, (on) => { CONTACT_SHADOW.on = on; },
    'Darken the scan in a soft patch where the figurine touches it (the floor under its feet, or the wall it is climbing).');
  light.addSlider('Shadow darkness', CONTACT_SHADOW.darkness, 0, 1, 0.05, (v) => { CONTACT_SHADOW.darkness = v; },
    'How dark the contact shadow gets at its centre.');
  light.addSlider('Shadow size', CONTACT_SHADOW.size, 0.2, 1.5, 0.05, (v) => { CONTACT_SHADOW.size = v; },
    'Radius of the shadow, in figurine heights.');
  light.addToggle('Scan lighting', SCAN_LIGHT.on, (on) => { SCAN_LIGHT.on = on; applyScanLight(); },
    'Light the figurine from the scan itself (a cubemap of the splats, captured at the figurine) instead of the fixed ambient fill.');
  light.addToggle('Follow figurine', SCAN_LIGHT.follow, (on) => { SCAN_LIGHT.follow = on; if (on) requestScanLight(); },
    'Re-capture the light as the figurine moves, so it changes from place to place. Off = captured once at the spawn point.');
  light.addToggle('Fill gaps', SCAN_LIGHT.fill, (on) => { SCAN_LIGHT.fill = on; requestScanLight(); },
    'Where the scan has nothing (usually the ceiling), light the figurine with the average colour of the scan\'s upper half instead of darkness.');
  light.addToggle('Light debug view', SCAN_LIGHT.debug, (on) => { SCAN_LIGHT.debug = on; applyScanLight(); },
    'Show what the light probe captured (panorama, bottom-left: up is at the top) and three balls lit by it: mirror, half-rough metal, matte white.');
  light.addSlider('Light strength', SCAN_LIGHT.intensity, 0, 3, 0.05, (v) => { SCAN_LIGHT.intensity = v; applyScanLight(); },
    'How strongly the scan lights the figurine.');
  light.addSlider('Light blend (s)', SCAN_LIGHT.blend, 0, 2, 0.1, (v) => { SCAN_LIGHT.blend = v; },
    'Seconds to cross-fade from one light capture to the next in follow mode. 0 = swap instantly.');

  const fill = hud.debug.section('Patch splat holes');
  fill.addToggle('Patch holes', WALK_FILL.on, (on) => { WALK_FILL.on = on; applyFillView(); },
    'Where the ground the figurine can stand on lets the backdrop through, draw flat splats coloured from the ground around the gap.');
  fill.addToggle('Highlight fill', FILL_VIEW.highlight, (on) => { FILL_VIEW.highlight = on; applyFillView(); },
    'Draw the added splats in bright pink, to see where they are. They lie just under the ground\'s own splats, so pink shows only where the scan lets it through.');
  fill.addToggle('Fill only', FILL_VIEW.only, (on) => { FILL_VIEW.only = on; applyFillView(); },
    'Hide the scan\'s own splats and draw just the added ones. Compare with the Platforms overlay: the fill covers the same ground.');
  fill.addSlider('Fill opacity', FILL_VIEW.opacity, 0, 1, 0.05, (v) => { FILL_VIEW.opacity = v; applyFillView(); },
    'Fade the added splats, to compare with the bare scan.');
  fill.addSlider('Fill where under (opacity)', WALK_FILL.under, 0.1, 0.95, 0.05, (v) => { WALK_FILL.under = v; void refillWalkable(true); },
    'Fill a spot when the scan\'s ground there is less opaque than this. Higher fills thinner patches too, and starts to blur ground that was fine (a rug\'s seams). Works the fill out again.');
  fill.addSlider('Smallest level patch (cells)', WALK_FILL.patch, 1, 200, 1, (v) => { WALK_FILL.patch = v; void refillWalkable(true); },
    'Fill only level ground of at least this many walkable cells. Lower takes in small tops (a box, a toy), where a flat sheet fits badly. Works the fill out again.');
  fill.addSlider('Fill spacing (voxels)', WALK_FILL.cell, 0.25, 1, 0.25, (v) => { WALK_FILL.cell = v; void refillWalkable(true); },
    'Distance between the added splats, in collision voxels. Smaller = more, smaller splats. Works the fill out again.');

  const ground = hud.debug.section('Ground and platforms');
  ground.addToggle('Reliable ground (nav)', useNavGround, (on) => { useNavGround = on; },
    'Spike 2: stand on / confine to the hole-filled NavGrid so the figurine can\'t ' +
    'fall through gaps or walk off platform edges. Off = raw mesh collision only.');
  ground.addSlider('Step limit', PLATFORM_OPTS.stepFactor, 0.1, 1, 0.05, (v) => {
    PLATFORM_OPTS.stepFactor = v; rebuildPlatformOverlay();
  }, 'Max height (in char-heights) two neighboring cells can differ and still be ONE ' +
     'platform. Higher = merges steps/bumps into one surface; lower = splits into more platforms.');
  ground.addSlider('Min platform size', PLATFORM_OPTS.minCells, 1, 40, 1, (v) => {
    PLATFORM_OPTS.minCells = v; rebuildPlatformOverlay();
  }, 'Drop platforms smaller than this many cells (floater/noise rejection). Higher = only big surfaces survive.');
  ground.addSlider('Climb threshold (deg)', PLATFORM_OPTS.climbDeg, 30, 89, 1, (v) => { PLATFORM_OPTS.climbDeg = v; rebuildPlatformOverlay(); },
    'Surfaces steeper than this angle (from the ground) are walls you CLIMB; gentler ones are ' +
    'ground you walk on. Lower = more things count as walls; higher = only near-vertical faces.');

  const surface = hud.debug.section('Collision surface');
  /** A slider for one collision setting. Moving it sets that for the session (voxelSet) and rebuilds. */
  const voxelSlider = (key: keyof VoxelSettings, label: string, min: number, max: number, step: number, help: string) => {
    voxelSliders[key] = surface.addSlider(label, VOXEL_OPTS[key], min, max, step, (v) => {
      voxelSet[key] = VOXEL_OPTS[key] = v;
      rebuildCollision();
    }, help);
  };
  voxelSlider('iso', 'Isovalue (fill)', 0.15, 0.7, 0.05, 'Surface threshold as a fraction of median density. LOWER fills faint flat ' +
     'panels (cabinet doors, distant walls) but eventually admits floater haze; ' +
     'higher hugs only well-scanned surfaces. Default 0.35 suits casual scans.');
  voxelSlider('close', 'Surface hole-fill', 0, 5, 1, 'Bridges holes in the collision mesh (walls / climbable faces / floor) by ' +
     'closing gaps up to ~2× this many voxels. Higher fills bigger holes but welds ' +
     'objects to the floor / webs surfaces (a looser "seal"); big holes are better ' +
     'handled by the floor/panel fills. Default 1 keeps the seal tight.');
  voxelSlider('refine', 'Mesh detail (up to)', 1, 3, 1, 'What is solid is decided on the coarse collision grid, where a thinly scanned wall still adds up to a wall. ' +
     'The mesh can then be built on a grid 2 or 3 times finer and trimmed in to the splats. Each scan gets as fine a ' +
     'grid as it has splats for, up to this: a sparse scan stays at 1 whatever is set here, since a finer grid would ' +
     'only read its noise. The console line for each build says which detail it got.');
  voxelSlider('fillFloor', 'Ground gap fill (voxels)', 0, 40, 1, 'Makes bare stretches of the ground walkable when nothing this many voxels wide could get into them from outside, ' +
     'past the floor, walls and furniture round them (the figurine is about 5 voxels tall). Higher closes wider-mouthed ' +
     'bays; 1 fills only holes with floor all round; 0 = off. Only the ground: a worktop or table keeps its edges.');
  voxelSlider('panelFill', 'Panel fill (area)', 0, 4, 0.25, 'Fills enclosed holes in flat vertical panels (blank cabinet doors / walls that ' +
     'splatting captured too faintly) up to this area, in normalized scan units² ' +
     '(~room-relative — not metres). Bigger fills larger blank panels but can start ' +
     'closing real openings (doorways/windows); 0 = off. Default 2.5.');
  voxelSlider('floorFlat', 'Floor flatten (grains)', 0, 3, 0.25, 'The collision within this many grains of the ground is flattened onto the level the ground is drawn at ' +
     '(a grain is about a fifth of the figurine). Higher = flatter, and more low clutter (a rug, a board, the foot ' +
     'of a toy) becomes floor; lower leaves the top of the floor uneven. Only ground that is flat is flattened: ' +
     'a blanket is left as it is. 0 = off.');

  // cleanup tunables for imported scans (re-clean + reload the active upload)
  const cleanup = hud.debug.section('Import cleanup');
  cleanup.addSlider('Opacity floor', CLEAN_OPTS.alphaMin ?? 0.35, 0, 0.9, 0.05, (v) => { CLEAN_OPTS.alphaMin = v; void recleanUpload(); },
    'For imported scans: drop splats fainter than this. Higher burns off more floater haze (but can eat real surfaces).');
  cleanup.addSlider('Density', CLEAN_OPTS.minMass ?? 4, 0, 12, 0.5, (v) => { CLEAN_OPTS.minMass = v; void recleanUpload(); },
    'For imported scans: min opacity mass a voxel needs to be kept. Higher removes more isolated floaters.');
  cleanup.addToggle('Crop to room', CLEAN_OPTS.crop ?? true, (on) => { CLEAN_OPTS.crop = on; void recleanUpload(); },
    'For imported scans: auto-level and crop to the room box (removes far background spray).');
}

// --- scan import (upload + in-browser cleanup) ------------------------------
const cleanInWorker = workerCaller<{ buffer: ArrayBuffer; opts: CleanOptions }, { buffer: ArrayBuffer; kept: number; total: number }>(
  new Worker(new URL('./clean-scan.worker.ts', import.meta.url), { type: 'module' }), 'scan cleanup');

/** Import an uploaded .ply: keep a copy for live re-clean, then clean + load it. */
async function importScan(file: File): Promise<void> {
  if (!/\.ply$/i.test(file.name)) { hud.status(`${file.name}: not a .ply file`, 'error'); return; }
  try {
    hud.status(`Reading ${file.name}…`, 'busy');
    const raw = await file.arrayBuffer();
    lastUploadBuffer = raw.slice(0); // retain a copy; the worker transfers (detaches) the other
    lastUploadName = file.name;
    await cleanAndLoad(raw, file.name);
  } catch (err) {
    hud.status(`${file.name}: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

/** Re-clean the active upload with the current CLEAN_OPTS (for the debug sliders). */
async function recleanUpload(): Promise<void> {
  if (!lastUploadBuffer) return;
  try { await cleanAndLoad(lastUploadBuffer.slice(0), lastUploadName); } // pass a copy; keep the original
  catch (err) { hud.status(`${lastUploadName}: ${err instanceof Error ? err.message : String(err)}`, 'error'); }
}

async function cleanAndLoad(rawToTransfer: ArrayBuffer, name: string): Promise<void> {
  hud.status(`Cleaning ${name}…`, 'busy');
  const id = `upload:${name}`;
  const res = await cleanInWorker({ buffer: rawToTransfer, opts: CLEAN_OPTS }, [rawToTransfer]); // the buffer is transferred (detached here)
  const url = URL.createObjectURL(new Blob([res.buffer], { type: 'application/octet-stream' }));
  const prev = uploads.get(id); if (prev) URL.revokeObjectURL(prev);
  uploads.set(id, url);
  hud.addRoom({ id, label: `${name} (yours)` });
  loadFromURL(url, id);
  hud.status(`${name}: kept ${res.kept.toLocaleString()} / ${res.total.toLocaleString()} splats`, 'done');
}

main().catch((err: unknown) => { console.error(err); hud.status(err instanceof Error ? err.message : String(err), 'error'); });
