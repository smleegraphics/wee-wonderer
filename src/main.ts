// Wee Wonderer — app shell + character controller + room scan (M3).
//
// three.js on WebGPU owns everything. The scan (native GaussianSplat) is the
// world; the figurine (M2 controller) toddles on its floor, correctly occluded.
// Room transform (flip 194° / roll -1° / drop to y=0) was dialed in with the
// floor-plane fit in the room inspector; baked as constants here.

import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { GaussianSplat } from 'three/addons/objects/GaussianSplat.js';
import { GaussianSplatPLYLoader } from 'three/addons/loaders/GaussianSplatPLYLoader.js';
import { orientScan } from './orient-scan';
import { surfaceToGeometry } from './voxelize';
import { MeshCollision, type NavGrid } from './collision';
import { voxelCacheKey, voxelCacheGet, voxelCachePut } from './voxel-cache';
import type { VoxelSurface, VoxelOptions } from './voxelize';
import type { CleanOptions } from './clean-scan-core';

const q = new URLSearchParams(location.search);
// demo scans for the switcher UI — config, not logic (each auto-levels at load).
const SCANS: { file: string; label: string }[] = [
  { file: 'room2.ply', label: 'Playroom' }, // already tightly bounded — no cleanup needed
  { file: 'livingroom-clean.ply', label: 'Living Room' }, // floater-stripped (scripts/clean-scan.mjs)
  { file: 'kitchen-clean.ply', label: 'Kitchen' },
  { file: 'counter-clean.ply', label: 'Counter' },
];
const DEFAULT_SCAN = q.get('scan') ?? SCANS[0].file;
const TARGET_RADIUS = 7; // normalize every scan to this world size (figurine ~0.45 tall)
// Collision voxelization: build a cleaned blocky surface mesh from the splat and
// show it as a debug overlay (toggle 'V', or ?voxel=1 to start visible).
const VOXEL_SIZE = Number(q.get('vox')) || TARGET_RADIUS / 72; // ~0.097 world units
const num = (key: string, def: number) => (q.has(key) ? Number(q.get(key)) : def);
const VOXEL_OPTS = {
  iso: num('iso', 0.35),         // isovalue as a fraction of median surface density (low → fills faint flat panels)
  despeckle: num('despeckle', 20), // drop solid islands smaller than this (stray cubes / floaters the low iso admits)
  close: num('close', 1),        // dilate→erode iterations (bridges tiny holes); kept low so it doesn't weld objects to the floor / web surfaces (loose "seal"). Big holes are handled by the enclosed floor/panel fills.
  fillFloor: num('fillfloor', 1), // fill enclosed holes in the floor layer
  panelFill: num('panelfill', 2.5), // fill enclosed holes in vertical panels up to this area, in NORMALIZED scan units² (~room-relative, not metres — every scan is scaled to TARGET_RADIUS); blank cabinet doors/walls; 0 = off
  smooth: num('smooth', 0),      // majority occupancy passes (Taubin handles smoothing)
  taubin: num('taubin', 6),      // Taubin mesh-smoothing iterations
  floorFlat: num('floorflat', 0.75), // snap mesh within this many voxels of y=0 flat
};
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
let voxelCheckbox: HTMLInputElement | null = null;
// Spike 1: platform-decomposition overlay (colored walkable surfaces). stepFactor
// = max step (in char-heights) two cells can differ and still be one platform;
// minCells drops floater specks. Tuned live to see how scans decompose.
let showPlatforms = q.get('platforms') === '1';
let platformDebug: THREE.InstancedMesh | null = null;
let platformCheckbox: HTMLInputElement | null = null;
let lastVoxelSize = TARGET_RADIUS / 72;
const PLATFORM_OPTS = { stepFactor: 0.35, minCells: 6, climbMax: 1.6, climbDeg: 70 }; // climbMax in char-heights; climbDeg = surfaces steeper than this (from horizontal) climb, not walk — 70° ≈ "vertical or almost vertical"
if (q.has('climbdeg')) PLATFORM_OPTS.climbDeg = Number(q.get('climbdeg'));
if (q.has('stepf')) PLATFORM_OPTS.stepFactor = Number(q.get('stepf'));
const DROP_MAX = 3.5; // furthest you can step down off a ledge (char-heights); beyond = a floater/void → confine
// Spike 2: the reliable ground. The controller stands on the NavGrid (no
// fall-through), is confined to it (no walking off), and recovers to `lastGood`.
let navGrid: NavGrid | null = null;
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
// scan import (upload + in-browser cleanup), session-only
const CLEAN_OPTS: CleanOptions = { alphaMin: 0.35, minMass: 4, scaleCapMul: 4, crop: true };
const uploads = new Map<string, string>(); // upload id → blob object URL
let scanSelect: HTMLSelectElement | null = null;
let lastUploadBuffer: ArrayBuffer | null = null; // raw bytes of the active upload (for live re-clean)
let lastUploadName = '';
const app = document.getElementById('app')!;

const renderer = new WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1c22);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.001, 200);

// Orbit-follow camera: user drags to orbit / scrolls to zoom, and its pivot is
// glued to the figurine each frame so it follows while you look around.
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;
orbit.enablePan = false; // pivot tracks the figurine; panning it away would fight that
orbit.maxPolarAngle = Math.PI * 0.49; // don't drop below the floor

scene.add(new THREE.HemisphereLight(0x8899bb, 0x22201c, 0.9));
const sun = new THREE.DirectionalLight(0xfff4e0, 2.4);
sun.position.set(3, 6, 4);
scene.add(sun);

// --- room scan --------------------------------------------------------------
// The scan is auto-leveled at load (RANSAC floor fit) — Y-up, floor at y=0.
// No per-scan constants: any scan (a demo, or the user's own) levels the same way.
const room = new THREE.Group();
scene.add(room);
let currentSplat: GaussianSplat | null = null;

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

/** Load a scan from any URL (a bundled file or an uploaded blob). `id` is the
 *  stable identity used for the collision cache and status. */
function loadFromURL(url: string, id: string): void {
  const token = ++loadToken;
  currentFile = id;
  if (currentSplat) {
    room.remove(currentSplat);
    currentSplat.geometry.dispose();
    (currentSplat.material as THREE.Material).dispose();
    (currentSplat as unknown as { dispose?: () => void }).dispose?.();
    currentSplat = null;
  }
  disposeCollision();
  room.quaternion.identity();
  room.position.set(0, 0, 0);
  room.scale.setScalar(1);
  new GaussianSplatPLYLoader().load(
    url,
    async (geometry) => {
      // capture the real splat centers + per-splat opacity now — GaussianSplat
      // swaps geometry for a billboard quad, so these must be read before
      // construction. Opacity is the alpha of the loader's color attribute.
      const centers = geometry.getAttribute('position') as THREE.BufferAttribute;
      const color = geometry.getAttribute('color') as THREE.BufferAttribute;
      const opacity = new Float32Array(centers.count);
      for (let i = 0; i < opacity.length; i++) opacity[i] = color.getW(i);
      const o = orientScan(centers);
      // scans have arbitrary unit scales — normalize each to a consistent world
      // size so the fixed-size figurine stays a sensible fraction of every room.
      const k = TARGET_RADIUS / o.radius;
      // per-splat 3-D Gaussian covariance drives anisotropic voxelization (splats fill
      // their real ellipsoid footprint). The worldspace transform is applied in the core.
      const covAttr = geometry.getAttribute('covariance') as THREE.BufferAttribute | undefined;
      const cov = covAttr && covAttr.itemSize === 6 ? (covAttr.array as Float32Array) : null;
      const splat = new GaussianSplat(geometry);
      splat.position.copy(o.center).multiplyScalar(-1); // recenter to origin
      splat.visible = !MESHONLY; // mesh-only debug view hides the splat
      room.add(splat);
      room.quaternion.copy(o.quaternion); // auto-leveled: floor normal → +Y
      room.scale.setScalar(k);
      room.position.y = k * o.floorOffsetY; // floor at y=0 (in scaled space)
      currentSplat = splat;
      room.updateMatrixWorld(true);
      lastCenters = centers; lastOpacity = opacity; lastCov = cov; lastMatrix.copy(splat.matrixWorld);
      console.log(`loaded ${id}: radius ${o.radius.toFixed(2)} → scaled ${k.toFixed(2)}x`);
      await buildCollision(id, token, centers, opacity, cov, splat.matrixWorld);
      if (token === loadToken && charLoaded) resetToSpawn();
    },
    undefined,
    (err) => showBanner(`${id} load failed: ${String(err)}`),
  );
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

const TUNE = { walkSpeed: 1.6, runSpeed: 4.0, jumpVel: 3.2, gravity: -9.0, climbSpeed: 1.2, fade: 0.18, turnLerp: 12 };

const move = { f: 0, b: 0, l: 0, r: 0, run: false };
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
  if (collision) rebuildPlatformOverlay(); // rebuild the NavGrid now charH (headroom/step) is real
  resetToSpawn();
  console.log(`character: ${charH.toFixed(3)} tall, ${gltf.animations.length} clips`);
}

/** Put the figurine on the floor at the spawn point and re-frame the camera behind it. */
function resetToSpawn(): void {
  // pick a clear floor spot for this scan (unless overridden with ?fx=&fz=)
  if (q.has('fx') || q.has('fz')) {
    player.position.set(Number(q.get('fx') ?? 0), 0, Number(q.get('fz') ?? 0));
  } else if (collision && charH > 0) {
    const radius = CAPSULE_RADIUS * charH, segLen = Math.max(0.02, charH - 2 * radius);
    collision.findSpawn(radius, segLen, player.position);
  } else {
    player.position.set(0, 0, 0);
  }
  // align the spawn with the NavGrid so the reliability layer picks it up cleanly
  if (navGrid) {
    const s = navGrid.surfaceNear(player.position.x, player.position.z, player.position.y, charH);
    if (s !== null) player.position.y = s;
  }
  player.rotation.set(0, 0, 0);
  velocity.set(0, 0, 0);
  wasGrounded = false;
  supportY = player.position.y;         // stand on the spawn surface
  lastGood.copy(player.position);
  smoothFeetY = player.position.y;
  if (charModel) charModel.position.y = charFeetOffset;
  state = 'ground';
  camera.position.copy(player.position).add(new THREE.Vector3(charH * 1.2, charH * 2.6, charH * 4.5));
  orbit.target.set(player.position.x, player.position.y + charH * 0.7, player.position.z);
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
  switch (e.code) {
    case 'KeyW': move.f = v; break;
    case 'KeyS': move.b = v; break;
    case 'KeyA': move.l = v; break;
    case 'KeyD': move.r = v; break;
    case 'ShiftLeft': case 'ShiftRight': move.run = !!v; break;
    case 'Space':
      if (v && state === 'ground') startJump();
      else if (v && state === 'climb') climbJumpOff();
      e.preventDefault(); break;
    case 'KeyV': if (v) setVoxelOverlay(!showVoxels); break;
    case 'KeyP': if (v) setPlatformOverlay(!showPlatforms); break;
  }
}
addEventListener('keydown', (e) => keyEvent(e, 1));
addEventListener('keyup', (e) => keyEvent(e, 0));

function startJump(): void {
  if (actions['jump_start']) { state = 'jump_start'; play('jump_start', 0.06); }
  else { velocity.y = TUNE.jumpVel * charH; state = 'air'; play(actions['jump_loop'] ? 'jump_loop' : 'idle', 0.08); }
}

// --- collision ---------------------------------------------------------------
// Voxelization runs in a Web Worker so the ~1s+ first build doesn't freeze the
// frame. Requests are matched to responses by id.
const voxelWorker = new Worker(new URL('./voxelize.worker.ts', import.meta.url), { type: 'module' });
const voxelPending = new Map<number, (s: VoxelSurface) => void>();
let voxelReqId = 0;
voxelWorker.onmessage = (e: MessageEvent<{ id: number; surface?: VoxelSurface; error?: string }>) => {
  if (e.data.error) { console.error('voxel worker failed:', e.data.error); return; }
  const resolve = voxelPending.get(e.data.id);
  if (resolve && e.data.surface) { voxelPending.delete(e.data.id); resolve(e.data.surface); }
};
voxelWorker.onerror = (e) => console.error('voxel worker error:', e.message, e.filename, e.lineno);

function voxelizeInWorker(centers: THREE.BufferAttribute, opacity: Float32Array, cov: Float32Array | null, matrixWorld: THREE.Matrix4, opts: VoxelOptions): Promise<VoxelSurface> {
  return new Promise((resolve) => {
    const id = ++voxelReqId;
    voxelPending.set(id, resolve);
    const positions = (centers.array as Float32Array).slice(); // copies so we can transfer
    const op = opacity.slice();                                 // (originals kept for re-voxelize)
    const cv = cov ? cov.slice() : null;
    voxelWorker.postMessage(
      { id, positions, opacity: op, cov: cv, count: centers.count, matrix: Array.from(matrixWorld.elements), voxelSize: VOXEL_SIZE, opts },
      cv ? [positions.buffer, op.buffer, cv.buffer] : [positions.buffer, op.buffer],
    );
  });
}

// Build the surface (cached after the first load), a three-mesh-bvh over it for
// the controller, and a toggleable debug overlay. `token` guards a slow async
// build from landing after the user has already swapped to another scan.
async function buildCollision(file: string, token: number, centers: THREE.BufferAttribute, opacity: Float32Array, cov: Float32Array | null, matrixWorld: THREE.Matrix4): Promise<void> {
  const t0 = performance.now();
  // uploads aren't cached: re-cleaning changes the splat under a stable id, so the
  // key wouldn't reflect it — always re-voxelize an upload.
  const useCache = !file.startsWith('upload:');
  const key = voxelCacheKey(file, VOXEL_SIZE, VOXEL_OPTS, TARGET_RADIUS);
  let surf: VoxelSurface | null = useCache ? await voxelCacheGet(key) : null;
  const cached = surf !== null;
  if (token !== loadToken) return; // superseded while awaiting the cache
  if (!surf) {
    surf = await voxelizeInWorker(centers, opacity, cov, matrixWorld, VOXEL_OPTS);
    if (token !== loadToken) return; // superseded while voxelizing
    if (useCache) void voxelCachePut(key, surf);
  }
  const geom = surfaceToGeometry(surf);
  collision = new MeshCollision(geom, GROUND_OFFSET); // note: MeshBVH indexes geom in place
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
  rebuildPlatformOverlay();
  console.log(
    `collision${cached ? ' (cached)' : ''}: ${surf.occupiedCount.toLocaleString()} voxels, ` +
    `${surf.triangleCount.toLocaleString()} tris @ ${surf.voxelSize.toFixed(3)}u ` +
    `in ${(performance.now() - t0).toFixed(0)}ms — press V to toggle overlay`,
  );
}

/** Re-voxelize the current scan with the current VOXEL_OPTS (for debug tunables),
 *  without reloading the PLY. */
function rebuildCollision(): void {
  if (!lastCenters || !lastOpacity) return;
  disposeCollision();
  void buildCollision(currentFile, ++loadToken, lastCenters, lastOpacity, lastCov, lastMatrix);
}

// --- controller update ------------------------------------------------------
const camFwd = new THREE.Vector3(), camRight = new THREE.Vector3(), wishDir = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const camLook = new THREE.Vector3(), camDir = new THREE.Vector3();

/** Glue the orbit pivot to the figurine so the camera follows while the user
 *  orbits/zooms, and pull the camera in if a wall is between it and the pivot. */
function updateCamera(): void {
  camLook.set(player.position.x, smoothFeetY + charH * 0.7, player.position.z);
  orbit.target.lerp(camLook, 0.15);
  orbit.update();
  if (!collision) return;
  camDir.subVectors(camera.position, orbit.target);
  const want = camDir.length();
  if (want < 1e-4) return;
  camDir.divideScalar(want);
  const allowed = collision.rayDistance(orbit.target, camDir, want);
  if (allowed < want) camera.position.copy(orbit.target).addScaledVector(camDir, Math.max(allowed - charH * 0.15, charH * 0.4));
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
const climbDir = new THREE.Vector3();   // horizontal direction into the wall
const climbProbe = new THREE.Vector3(); // scratch for the forward wall raycast
let climbCling = false;                 // topped out with nowhere to stand → hanging
let climbFrameCount = 0;                // frames spent ascending in the current climb

/** True if a near-vertical wall is right in front (in the `dx,dz` move direction);
 *  if so, enter the climb. Called when horizontal movement got blocked. */
function tryStartClimb(dx: number, dz: number): boolean {
  if (!collision || !actions['climb']) return false;
  climbDir.set(dx, 0, dz);
  if (climbDir.lengthSq() < 1e-9) return false;
  climbDir.normalize();
  const radius = CAPSULE_RADIUS * charH, reach = radius + charH * 0.35;
  // probe at chest and head height — the obstacle must reach ~chest to be worth
  // climbing (filters out low bumps, which you step over rather than scale)
  let wall: { up: number; distance: number } | null = null;
  for (const h of [0.5, 0.85]) {
    const w = collision.wallAhead(climbProbe.set(player.position.x, supportY + charH * h, player.position.z), climbDir, reach);
    if (w && Math.abs(w.up) <= 0.5 && (!wall || w.distance < wall.distance)) wall = w;
  }
  if (!wall) { // nothing steep enough in front to climb
    if (q.get('tel') === '1') console.log(`CLIMB-NO no-wall (reach=${reach.toFixed(2)})`);
    return false;
  }
  climbCling = false;
  state = 'climb';
  velocity.set(0, 0, 0);
  player.rotation.y = Math.atan2(climbDir.x, climbDir.z); // face the wall
  play('climb', TUNE.fade);
  climbFrameCount = 0;
  if (q.get('tel') === '1') console.log(`CLIMB-START y=${player.position.y.toFixed(2)} dist=${wall.distance.toFixed(2)} up=${wall.up.toFixed(2)}`);
  return true;
}

/** Jump off the wall: launch up and away from the face. */
function climbJumpOff(): void {
  velocity.set(-climbDir.x * TUNE.walkSpeed * charH, TUNE.jumpVel * charH, -climbDir.z * TUNE.walkSpeed * charH);
  state = 'air'; climbCling = false;
  play(actions['jump_loop'] ? 'jump_loop' : 'idle', 0.08);
}

function climbUpdate(dt: number): void {
  // ascend only while actively holding forward; otherwise hold in place on the wall
  const ascending = move.f > 0 && !climbCling;
  if (actions['climb']) actions['climb'].paused = !ascending; // freeze the anim when not climbing up
  if (!ascending) return; // resting / clinging — Space jumps off
  const p = player.position, radius = CAPSULE_RADIUS * charH;
  climbFrameCount++;
  p.y += TUNE.climbSpeed * charH * dt; // ascend the face
  climbProbe.set(p.x, p.y + charH * 0.5, p.z);
  const wall = collision ? collision.wallAhead(climbProbe, climbDir, radius + charH * 0.4) : null;
  if (wall) { // still against the wall → hold a fixed gap to the face and keep climbing
    p.addScaledVector(climbDir, wall.distance - radius * 1.1);
    return;
  }
  // wall ended → topped out. Is there a surface to stand on just over the lip?
  const overX = p.x + climbDir.x * radius * 2, overZ = p.z + climbDir.z * radius * 2;
  const g = navGrid ? navGrid.surfaceNear(overX, overZ, p.y, charH * 0.8) : null;
  if (g !== null && g <= p.y + charH * 0.3) { // mantle onto it
    p.set(overX, g, overZ);
    supportY = g; lastGood.copy(p);
    state = 'ground'; velocity.set(0, 0, 0); play('idle', TUNE.fade);
    if (q.get('tel') === '1') console.log(`CLIMB-MANTLE frames=${climbFrameCount} to=${g.toFixed(2)}`);
  } else {
    climbCling = true; // nothing up there → cling at the top of the wall
    if (q.get('tel') === '1') console.log(`CLIMB-CLING frames=${climbFrameCount} y=${p.y.toFixed(2)}`);
  }
}

// scratch vectors for the collide-and-slide loop (avoid per-frame allocation)
const hVel = new THREE.Vector3(), disp = new THREE.Vector3(), correction = new THREE.Vector3(), slideN = new THREE.Vector3();
const navRecover = new THREE.Vector3();
const wallFeet = new THREE.Vector3(), zeroDisp = new THREE.Vector3(), wallCorr = new THREE.Vector3();

function updateController(dt: number): void {
  camera.getWorldDirection(camFwd); camFwd.y = 0; camFwd.normalize();
  camRight.crossVectors(camFwd, WORLD_UP).negate();
  wishDir.set(0, 0, 0).addScaledVector(camFwd, move.f - move.b).addScaledVector(camRight, move.l - move.r);
  const moving = wishDir.lengthSq() > 0;
  if (moving) wishDir.normalize();

  if (state === 'climb') { climbUpdate(dt); return; }
  if (state === 'jump_start') return;        // anticipation freeze; onActionFinished launches
  if (!collision) return;
  if (player.position.y < -charH * 3) { // lost the surface (rare edge case)
    if (navGrid && useNavGround) { player.position.copy(lastGood); supportY = lastGood.y; velocity.set(0, 0, 0); state = 'ground'; } // snap back to the last valid spot (gentle)
    else resetToSpawn();
    return;
  }
  if (q.get('tel') === '1' && frames % 30 === 0) console.log(`x=${player.position.x.toFixed(2)} z=${player.position.z.toFixed(2)} Y=${player.position.y.toFixed(2)} sup=${supportY.toFixed(2)} ${state}`);

  if (moving) player.rotation.y = lerpAngle(player.rotation.y, Math.atan2(wishDir.x, wishDir.z), TUNE.turnLerp * dt);
  const speed = (move.run ? TUNE.runSpeed : TUNE.walkSpeed) * charH;
  hVel.copy(wishDir).multiplyScalar(moving ? speed : 0);

  // Locomotion. With the reliability layer on, movement is NAV-DRIVEN: free
  // horizontal motion confined to the walkable platform — so the figurine can't be
  // trapped by the bumpy mesh, fall through a hole, or walk off an edge — standing
  // on the hole-filled NavGrid. With it off, fall back to raw capsule-vs-mesh
  // collide-and-slide (kept for A/B comparison via the debug toggle).
  const radius = CAPSULE_RADIUS * charH;
  const grounded = navGrid && useNavGround ? navMove(dt, radius) : meshMove(dt, radius);
  wasGrounded = grounded;
  (window as unknown as { __ww?: unknown }).__ww = { state, cling: climbCling, x: player.position.x, y: player.position.y, z: player.position.z, sup: supportY };

  // Visual-only vertical smoothing: physics feet (player.position.y) can bob as the
  // capsule rides small bumps; damp the RENDERED height when grounded so it reads
  // smooth. Airborne (jump/fall) follows physics exactly so the arc stays crisp.
  if (grounded) smoothFeetY += (player.position.y - smoothFeetY) * Math.min(1, 10 * dt);
  else smoothFeetY = player.position.y;
  if (charModel) charModel.position.y = charFeetOffset + (smoothFeetY - player.position.y);

  updateLocomotion(grounded, moving);
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
    // horizontal = input (air control) + any launch velocity (e.g. jumping off a wall)
    p.x += (hVel.x + velocity.x) * dt; p.z += (hVel.z + velocity.z) * dt; p.y += velocity.y * dt;
    if (velocity.y <= 0) {
      const floor = nav.surfaceBelow(p.x, p.z, p.y + radius * 0.5);
      if (floor !== null && p.y <= floor) { p.y = floor; velocity.set(0, 0, 0); supportY = floor; lastGood.copy(p); return true; }
    }
    return false;
  }
  // grounded: walk on the nav (step / slide / step-down), then push out of walls
  const moving = hVel.x !== 0 || hVel.z !== 0;
  const startX = p.x, startZ = p.z;
  if (moving) navHorizontal(hVel.x * dt, hVel.z * dt, band);
  // Wall collision: push the capsule out of solid mesh (walls/furniture) horizontally.
  // Feet lifted above floor bumps so only walls push; NavGrid owns the vertical (no
  // bump-wedging, no fall-through).
  if (collision && moving) {
    const segLen = Math.max(0.02, charH - 2 * radius);
    wallFeet.set(p.x, supportY + charH * 0.25, p.z);
    collision.moveCapsule(wallFeet, radius, segLen, zeroDisp, wallCorr);
    p.x = wallFeet.x; p.z = wallFeet.z;
  }
  // Blocked by a wall (pushed but barely moved)? If it's near-vertical, start climbing it.
  if (moving) {
    const intended = Math.hypot(hVel.x, hVel.z) * dt;
    const actual = Math.hypot(p.x - startX, p.z - startZ);
    if (actual < intended * 0.5 && tryStartClimb(hVel.x, hVel.z)) return false;
  }
  const here = nav.surfaceNear(p.x, p.z, supportY, band);
  if (here !== null) { p.y = here; supportY = here; velocity.set(0, 0, 0); lastGood.copy(p); return true; }
  if (nav.nearest(lastGood.x, lastGood.z, supportY, navRecover)) { p.copy(navRecover); supportY = navRecover.y; velocity.set(0, 0, 0); lastGood.copy(p); } // recovered
  return true;
}

/** Move on the nav: onto a continuing surface (small step up/down), sliding along a
 *  wall/edge, or a controlled step-DOWN onto a lower platform. Leaves the position
 *  unchanged if blocked (a wall/edge) — navMove's block detection then tries a climb. */
function navHorizontal(dx: number, dz: number, band: number): void {
  const nav = navGrid!, p = player.position, x0 = p.x, z0 = p.z, tx = x0 + dx, tz = z0 + dz;
  if (nav.surfaceNear(tx, tz, supportY, band) !== null) { p.x = tx; p.z = tz; return; } // continues
  // grazing an edge/wall: if either axis alone stays on the platform, slide along it
  const xOK = dx !== 0 && nav.surfaceNear(x0 + dx, z0, supportY, band) !== null;
  const zOK = dz !== 0 && nav.surfaceNear(x0, z0 + dz, supportY, band) !== null;
  if (xOK || zOK) { if (xOK) p.x = x0 + dx; if (zOK) p.z = z0 + dz; return; }
  // step DOWN onto a lower platform within reach (render eases the drop)
  const down = nav.surfaceBelow(tx, tz, supportY - band);
  if (down !== null && down >= supportY - charH * DROP_MAX) { p.x = tx; p.z = tz; supportY = down; }
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
const clock = new THREE.Clock();
let frames = 0;

async function main(): Promise<void> {
  await renderer.init();
  loadScan(DEFAULT_SCAN);
  setupScanSwitcher();
  setupDebugMenu();
  new GLTFLoader().load(`${import.meta.env.BASE_URL}character.glb`, onLoaded, undefined, (err) => showBanner(`character.glb load failed: ${String(err)}`));

  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);
    if (charLoaded) { updateController(dt); if (FREECAM) updateFreeCam(); else updateCamera(); }
    mixer?.update(dt);
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

/** A dropdown (top-left) to switch scans at runtime, plus an Import button. */
function setupScanSwitcher(): void {
  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;top:12px;left:12px;z-index:10;display:flex;gap:6px;align-items:center';

  const sel = document.createElement('select');
  scanSelect = sel;
  sel.style.cssText =
    'padding:7px 12px;border:1px solid #3a3b44;border-radius:8px;color:#e8e8ea;' +
    'background:rgba(23,24,29,0.85);cursor:pointer;backdrop-filter:blur(4px);' +
    'font:13px ui-monospace,Menlo,monospace';
  for (const s of SCANS) {
    const opt = document.createElement('option');
    opt.value = s.file;
    opt.textContent = s.label;
    opt.style.color = '#111';
    if (s.file === DEFAULT_SCAN) opt.selected = true;
    sel.appendChild(opt);
  }
  // demo scans load by filename; uploaded ids resolve to a blob URL in `uploads`
  sel.onchange = () => { const v = sel.value; const url = uploads.get(v); if (url) loadFromURL(url, v); else loadScan(v); };
  bar.appendChild(sel);

  const btn = document.createElement('button');
  btn.textContent = '+ Import';
  btn.title = 'Import your own scan (uncompressed 3DGS .ply)';
  btn.style.cssText =
    'padding:7px 11px;border:1px solid #3a3b44;border-radius:8px;color:#e8e8ea;' +
    'background:rgba(23,24,29,0.85);cursor:pointer;backdrop-filter:blur(4px);font:13px ui-monospace,Menlo,monospace';
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = '.ply';
  picker.style.display = 'none';
  picker.onchange = () => { if (picker.files?.[0]) importScan(picker.files[0]); picker.value = ''; };
  btn.onclick = () => picker.click();
  bar.append(btn, picker);

  document.body.appendChild(bar);
  setupDropZone();
}

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
  navGrid = null;
  if (!collision) return;
  const slopeMin = Math.cos((PLATFORM_OPTS.climbDeg * Math.PI) / 180); // steeper than climbDeg → not walkable (a climbable wall)
  // leveling puts the real floor at y=0; reject anything a char-height below it as sub-floor floater noise
  navGrid = collision.buildNavGrid(lastVoxelSize, charH, charH * PLATFORM_OPTS.stepFactor, PLATFORM_OPTS.minCells, slopeMin, -charH);
  const field = navGrid.toField();
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

// A small debug panel (top-right). Put new debug tunables here (addToggle /
// addSlider) rather than reaching for URL params.
let debugPanel: HTMLDivElement | null = null;

/** A checkbox row; returns the input so callers can keep it in sync. */
function addToggle(label: string, initial: boolean, onChange: (v: boolean) => void, tooltip?: string): HTMLInputElement {
  const row = document.createElement('label');
  row.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none';
  if (tooltip) row.title = tooltip;
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = initial;
  cb.onchange = () => onChange(cb.checked);
  row.append(cb, label);
  debugPanel!.appendChild(row);
  return cb;
}

/** A labelled slider with a live value readout; fires `onChange` on release. */
function addSlider(label: string, initial: number, min: number, max: number, step: number, onChange: (v: number) => void, tooltip?: string): void {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:3px';
  if (tooltip) wrap.title = tooltip;
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;justify-content:space-between;gap:10px';
  const name = document.createElement('span'); name.textContent = label;
  const val = document.createElement('span'); val.textContent = initial.toFixed(2); val.style.opacity = '0.7';
  head.append(name, val);
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(min); slider.max = String(max); slider.step = String(step);
  slider.value = String(initial);
  slider.style.cssText = 'width:150px;accent-color:#2e6cff;cursor:pointer';
  slider.oninput = () => { val.textContent = Number(slider.value).toFixed(2); };
  slider.onchange = () => onChange(Number(slider.value));
  wrap.append(head, slider);
  debugPanel!.appendChild(wrap);
}

function setupDebugMenu(): void {
  const panel = document.createElement('div');
  panel.style.cssText =
    'position:fixed;top:12px;right:12px;z-index:10;display:flex;flex-direction:column;gap:10px;' +
    'padding:10px 12px;border:1px solid #3a3b44;border-radius:8px;background:rgba(23,24,29,0.85);' +
    'color:#e8e8ea;font:12px ui-monospace,Menlo,monospace;backdrop-filter:blur(4px)';
  const title = document.createElement('div');
  title.textContent = 'Debug';
  title.style.cssText = 'opacity:0.55;font-size:10px;letter-spacing:0.08em;text-transform:uppercase';
  panel.appendChild(title);
  debugPanel = panel;

  voxelCheckbox = addToggle('Voxel wireframe (V)', showVoxels, setVoxelOverlay);
  platformCheckbox = addToggle('Platforms (P)', showPlatforms, setPlatformOverlay,
    'Spike 1: color the walkable surfaces the collision decomposes into — floor, ' +
    'couch, counter. Distinct colors = distinct platforms (reached by climbing/jumping).');
  addToggle('Reliable ground (nav)', useNavGround, (on) => { useNavGround = on; },
    'Spike 2: stand on / confine to the hole-filled NavGrid so the figurine can\'t ' +
    'fall through gaps or walk off platform edges. Off = raw mesh collision only.');
  addSlider('Platform: step limit', PLATFORM_OPTS.stepFactor, 0.1, 1, 0.05, (v) => {
    PLATFORM_OPTS.stepFactor = v; rebuildPlatformOverlay();
  }, 'Max height (in char-heights) two neighboring cells can differ and still be ONE ' +
     'platform. Higher = merges steps/bumps into one surface; lower = splits into more platforms.');
  addSlider('Platform: min size', PLATFORM_OPTS.minCells, 1, 40, 1, (v) => {
    PLATFORM_OPTS.minCells = v; rebuildPlatformOverlay();
  }, 'Drop platforms smaller than this many cells (floater/noise rejection). Higher = only big surfaces survive.');
  addSlider('Isovalue (fill)', VOXEL_OPTS.iso, 0.15, 0.7, 0.05, (v) => {
    VOXEL_OPTS.iso = v;
    rebuildCollision();
  }, 'Surface threshold as a fraction of median density. LOWER fills faint flat ' +
     'panels (cabinet doors, distant walls) but eventually admits floater haze; ' +
     'higher hugs only well-scanned surfaces. Default 0.35 suits casual scans.');
  addSlider('Surface hole-fill', VOXEL_OPTS.close, 0, 5, 1, (v) => {
    VOXEL_OPTS.close = v;
    rebuildCollision();
  }, 'Bridges holes in the collision mesh (walls / climbable faces / floor) by ' +
     'closing gaps up to ~2× this many voxels. Higher fills bigger holes but welds ' +
     'objects to the floor / webs surfaces (a looser "seal"); big holes are better ' +
     'handled by the floor/panel fills. Default 1 keeps the seal tight.');
  addSlider('Panel fill (area)', VOXEL_OPTS.panelFill, 0, 4, 0.25, (v) => {
    VOXEL_OPTS.panelFill = v;
    rebuildCollision();
  }, 'Fills enclosed holes in flat vertical panels (blank cabinet doors / walls that ' +
     'splatting captured too faintly) up to this area, in normalized scan units² ' +
     '(~room-relative — not metres). Bigger fills larger blank panels but can start ' +
     'closing real openings (doorways/windows); 0 = off. Default 2.5.');
  addSlider('Climb threshold (deg)', PLATFORM_OPTS.climbDeg, 30, 89, 1, (v) => { PLATFORM_OPTS.climbDeg = v; rebuildPlatformOverlay(); },
    'Surfaces steeper than this angle (from the ground) are CLIMBED; gentler ones you walk up. ' +
    'Lower = more things count as climbable walls; higher = only near-vertical faces climb.');
  addSlider('Auto-climb height', PLATFORM_OPTS.climbMax, 0.5, 3, 0.1, (v) => { PLATFORM_OPTS.climbMax = v; },
    'Spike 3: walking into a ledge up to this tall (in char-heights) auto-climbs onto it; ' +
    'taller = a wall you stop at. No effect on step-down (you can always step off a ledge).');
  addSlider('Floor flatten (voxels)', VOXEL_OPTS.floorFlat, 0, 2, 0.05, (v) => {
    VOXEL_OPTS.floorFlat = v;
    rebuildCollision();
  }, 'Height of the band above the floor (in voxels) snapped perfectly flat. ' +
     'Higher = flatter floor but low clutter (toys) gets absorbed; ' +
     'lower = keeps low clutter but more floor waviness returns. 0 = off.');

  // cleanup tunables for imported scans (re-clean + reload the active upload)
  addSlider('Import: opacity floor', CLEAN_OPTS.alphaMin ?? 0.35, 0, 0.9, 0.05, (v) => { CLEAN_OPTS.alphaMin = v; void recleanUpload(); },
    'For imported scans: drop splats fainter than this. Higher burns off more floater haze (but can eat real surfaces).');
  addSlider('Import: density', CLEAN_OPTS.minMass ?? 4, 0, 12, 0.5, (v) => { CLEAN_OPTS.minMass = v; void recleanUpload(); },
    'For imported scans: min opacity mass a voxel needs to be kept. Higher removes more isolated floaters.');
  addToggle('Import: crop to room', CLEAN_OPTS.crop ?? true, (on) => { CLEAN_OPTS.crop = on; void recleanUpload(); },
    'For imported scans: auto-level and crop to the room box (removes far background spray).');

  document.body.appendChild(panel);
}

// --- scan import (upload + in-browser cleanup) ------------------------------
const cleanWorker = new Worker(new URL('./clean-scan.worker.ts', import.meta.url), { type: 'module' });
type CleanResp = { id: number; buffer?: ArrayBuffer; kept?: number; total?: number; error?: string };
const cleanCbs = new Map<number, { resolve: (r: { buffer: ArrayBuffer; kept: number; total: number }) => void; reject: (e: string) => void }>();
let cleanReqId = 0;
cleanWorker.onmessage = (e: MessageEvent<CleanResp>) => {
  const cb = cleanCbs.get(e.data.id); if (!cb) return; cleanCbs.delete(e.data.id);
  if (e.data.error) cb.reject(e.data.error);
  else cb.resolve({ buffer: e.data.buffer!, kept: e.data.kept!, total: e.data.total! });
};
cleanWorker.onerror = (e) => showStatus(`cleanup worker error: ${e.message}`, true);

function cleanInWorker(buffer: ArrayBuffer, opts: CleanOptions): Promise<{ buffer: ArrayBuffer; kept: number; total: number }> {
  return new Promise((resolve, reject) => {
    const id = ++cleanReqId;
    cleanCbs.set(id, { resolve, reject });
    cleanWorker.postMessage({ id, buffer, opts }, [buffer]); // buffer is transferred (detached here)
  });
}

/** Import an uploaded .ply: keep a copy for live re-clean, then clean + load it. */
async function importScan(file: File): Promise<void> {
  if (!/\.ply$/i.test(file.name)) { showStatus(`${file.name}: not a .ply file`, true); return; }
  try {
    showStatus(`Reading ${file.name}…`);
    const raw = await file.arrayBuffer();
    lastUploadBuffer = raw.slice(0); // retain a copy; the worker transfers (detaches) the other
    lastUploadName = file.name;
    await cleanAndLoad(raw, file.name);
  } catch (err) {
    showStatus(`${file.name}: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

/** Re-clean the active upload with the current CLEAN_OPTS (for the debug sliders). */
async function recleanUpload(): Promise<void> {
  if (!lastUploadBuffer) return;
  try { await cleanAndLoad(lastUploadBuffer.slice(0), lastUploadName); } // pass a copy; keep the original
  catch (err) { showStatus(`${lastUploadName}: ${err instanceof Error ? err.message : String(err)}`, true); }
}

async function cleanAndLoad(rawToTransfer: ArrayBuffer, name: string): Promise<void> {
  showStatus(`Cleaning ${name}…`);
  const id = `upload:${name}`;
  const res = await cleanInWorker(rawToTransfer, CLEAN_OPTS);
  const url = URL.createObjectURL(new Blob([res.buffer], { type: 'application/octet-stream' }));
  const prev = uploads.get(id); if (prev) URL.revokeObjectURL(prev);
  uploads.set(id, url);
  addUploadOption(id, name);
  if (scanSelect) scanSelect.value = id;
  loadFromURL(url, id);
  showStatus(`${name}: kept ${res.kept.toLocaleString()} / ${res.total.toLocaleString()} splats`);
}

function addUploadOption(id: string, name: string): void {
  if (!scanSelect) return;
  let opt = Array.from(scanSelect.options).find((o) => o.value === id);
  if (!opt) { opt = document.createElement('option'); opt.value = id; opt.style.color = '#111'; scanSelect.appendChild(opt); }
  opt.textContent = `${name} (yours)`;
}

let statusEl: HTMLDivElement | null = null;
function showStatus(msg: string, isError = false): void {
  if (!statusEl) {
    statusEl = document.createElement('div');
    statusEl.style.cssText =
      'position:fixed;bottom:12px;left:12px;z-index:11;padding:7px 12px;border-radius:8px;' +
      'background:rgba(23,24,29,0.9);color:#e8e8ea;font:12px ui-monospace,Menlo,monospace;backdrop-filter:blur(4px);max-width:60vw';
    document.body.appendChild(statusEl);
  }
  statusEl.textContent = msg;
  statusEl.style.border = isError ? '1px solid #c0483a' : '1px solid #3a3b44';
  statusEl.style.display = 'block';
}

/** Full-window drag-and-drop to import a .ply. */
function setupDropZone(): void {
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:20;display:none;align-items:center;justify-content:center;' +
    'background:rgba(20,40,90,0.55);color:#fff;font:600 20px ui-monospace,Menlo,monospace;' +
    'pointer-events:none;border:3px dashed rgba(255,255,255,0.6);box-sizing:border-box';
  overlay.textContent = 'Drop a .ply to import';
  document.body.appendChild(overlay);
  let depth = 0;
  addEventListener('dragenter', (e) => { e.preventDefault(); depth++; overlay.style.display = 'flex'; });
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('dragleave', (e) => { e.preventDefault(); if (--depth <= 0) overlay.style.display = 'none'; });
  addEventListener('drop', (e) => {
    e.preventDefault(); depth = 0; overlay.style.display = 'none';
    const f = e.dataTransfer?.files?.[0]; if (f) void importScan(f);
  });
}

function showBanner(msg: string): void {
  document.body.insertAdjacentHTML('beforeend', `<pre style="position:fixed;top:0;left:0;right:0;margin:0;padding:12px;color:#f88;background:#1a1c22;font:12px ui-monospace;white-space:pre-wrap;z-index:9">${msg}</pre>`);
}

main().catch((err: unknown) => { console.error(err); showBanner(err instanceof Error ? err.message : String(err)); });
