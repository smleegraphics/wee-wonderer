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
import { MeshCollision } from './collision';
import { voxelCacheKey, voxelCacheGet, voxelCachePut } from './voxel-cache';
import type { VoxelSurface, VoxelOptions } from './voxelize';

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
  iso: num('iso', 0.5),          // isovalue as a fraction of median surface density
  despeckle: num('despeckle', 12), // drop solid islands smaller than this (stray cubes)
  close: num('close', 1),        // dilate→erode iterations (fills floor/wall holes)
  fillFloor: num('fillfloor', 1), // fill enclosed holes in the floor layer
  smooth: num('smooth', 0),      // majority occupancy passes (Taubin handles smoothing)
  taubin: num('taubin', 6),      // Taubin mesh-smoothing iterations
  floorFlat: num('floorflat', 0.75), // snap mesh within this many voxels of y=0 flat
};
// Walkable surfaces are de-quantized to the real splat height in the voxelizer,
// so no ground offset is needed; ?sink stays as a manual override (default 0).
const GROUND_OFFSET = num('sink', 0);
let showVoxels = q.get('voxel') === '1';
let collisionDebug: THREE.Mesh | null = null;
let voxelCheckbox: HTMLInputElement | null = null;
let collision: MeshCollision | null = null; // BVH over the voxel surface, rebuilt per scan
let currentFile = DEFAULT_SCAN;
// last-loaded scan data, kept so debug tunables can re-voxelize without reloading the PLY
let lastCenters: THREE.BufferAttribute | null = null;
let lastOpacity: Float32Array | null = null;
const lastMatrix = new THREE.Matrix4();
const CAPSULE_RADIUS = 0.22; // capsule hemisphere radius, in char-heights
const PHYSICS_STEPS = 5;     // collide-and-slide substeps per frame
let loadToken = 0; // guards against a slow async collision build landing after a scan swap
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
  collision = null;
}

function loadScan(file: string): void {
  const token = ++loadToken;
  currentFile = file;
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
    `${import.meta.env.BASE_URL}${file}`,
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
      const splat = new GaussianSplat(geometry);
      splat.position.copy(o.center).multiplyScalar(-1); // recenter to origin
      room.add(splat);
      room.quaternion.copy(o.quaternion); // auto-leveled: floor normal → +Y
      room.scale.setScalar(k);
      room.position.y = k * o.floorOffsetY; // floor at y=0 (in scaled space)
      currentSplat = splat;
      room.updateMatrixWorld(true);
      lastCenters = centers; lastOpacity = opacity; lastMatrix.copy(splat.matrixWorld);
      console.log(`loaded ${file}: radius ${o.radius.toFixed(2)} → scaled ${k.toFixed(2)}x`);
      await buildCollision(file, token, centers, opacity, splat.matrixWorld);
      if (token === loadToken && charLoaded) resetToSpawn();
    },
    undefined,
    (err) => showBanner(`${file} load failed: ${String(err)}`),
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
  resetToSpawn();
  console.log(`character: ${charH.toFixed(3)} tall, ${gltf.animations.length} clips`);
}

/** Put the figurine on the floor at the spawn point and re-frame the camera behind it. */
function resetToSpawn(): void {
  player.position.set(Number(q.get('fx') ?? 0), 0, Number(q.get('fz') ?? 0));
  player.rotation.set(0, 0, 0);
  velocity.set(0, 0, 0);
  wasGrounded = false;
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
    case 'Space': if (v && state === 'ground') startJump(); e.preventDefault(); break;
    case 'KeyC': if (v) toggleClimb(); break;
    case 'KeyV': if (v) setVoxelOverlay(!showVoxels); break;
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

function voxelizeInWorker(centers: THREE.BufferAttribute, opacity: Float32Array, matrixWorld: THREE.Matrix4, opts: VoxelOptions): Promise<VoxelSurface> {
  return new Promise((resolve) => {
    const id = ++voxelReqId;
    voxelPending.set(id, resolve);
    const positions = (centers.array as Float32Array).slice(); // copies so we can transfer
    const op = opacity.slice();                                 // (originals kept for re-voxelize)
    voxelWorker.postMessage(
      { id, positions, opacity: op, count: centers.count, matrix: Array.from(matrixWorld.elements), voxelSize: VOXEL_SIZE, opts },
      [positions.buffer, op.buffer],
    );
  });
}

// Build the surface (cached after the first load), a three-mesh-bvh over it for
// the controller, and a toggleable debug overlay. `token` guards a slow async
// build from landing after the user has already swapped to another scan.
async function buildCollision(file: string, token: number, centers: THREE.BufferAttribute, opacity: Float32Array, matrixWorld: THREE.Matrix4): Promise<void> {
  const t0 = performance.now();
  const key = voxelCacheKey(file, VOXEL_SIZE, VOXEL_OPTS, TARGET_RADIUS);
  let surf: VoxelSurface | null = await voxelCacheGet(key);
  const cached = surf !== null;
  if (token !== loadToken) return; // superseded while awaiting the cache
  if (!surf) {
    surf = await voxelizeInWorker(centers, opacity, matrixWorld, VOXEL_OPTS);
    if (token !== loadToken) return; // superseded while voxelizing
    void voxelCachePut(key, surf);
  }
  const geom = surfaceToGeometry(surf);
  collision = new MeshCollision(geom, GROUND_OFFSET); // note: MeshBVH indexes geom in place
  const mesh = new THREE.Mesh(
    geom,
    new THREE.MeshBasicMaterial({ color: 0x35e08b, wireframe: true, transparent: true, opacity: 0.55 }),
  );
  mesh.visible = showVoxels;
  scene.add(mesh);
  collisionDebug = mesh;
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
  void buildCollision(currentFile, ++loadToken, lastCenters, lastOpacity, lastMatrix);
}

// --- controller update ------------------------------------------------------
const camFwd = new THREE.Vector3(), camRight = new THREE.Vector3(), wishDir = new THREE.Vector3();
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
function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * Math.min(t, 1);
}

// --- climb (grab a wall / mantle onto furniture) ----------------------------
const climbNormal = new THREE.Vector3(0, 0, 1);
const forward = new THREE.Vector3();
let climbTopY = 0;

function toggleClimb(): void {
  if (state === 'climb') { exitClimb(); return; }
  if (state !== 'ground' || !actions['climb'] || !collision) return;
  forward.set(Math.sin(player.rotation.y), 0, Math.cos(player.rotation.y));
  const face = collision.climbableFaceAt(player.position, charH, forward);
  if (!face) return;
  climbNormal.copy(face.normal);
  climbTopY = face.topY;
  state = 'climb'; velocity.set(0, 0, 0);
  player.position.x = face.snap.x;
  player.position.z = face.snap.z;
  player.rotation.y = Math.atan2(-climbNormal.x, -climbNormal.z); // face the wall
  play('climb', TUNE.fade);
}
function exitClimb(): void { state = 'air'; velocity.set(0, 0, 0); play(actions['jump_loop'] ? 'jump_loop' : 'idle', 0.12); }

function climbUpdate(dt: number): void {
  player.position.y += (move.f - move.b) * TUNE.climbSpeed * charH * dt;
  const floorY = collision ? collision.groundHeightAt(player.position.x, player.position.z, climbTopY + charH) : 0;
  if (player.position.y >= climbTopY) { // mantle over the top
    player.position.y = climbTopY;
    player.position.addScaledVector(climbNormal, -charH * 0.35);
    state = 'ground'; play('idle', TUNE.fade);
  } else if (player.position.y <= floorY) { // slid back to the floor
    player.position.y = floorY;
    player.position.addScaledVector(climbNormal, charH * 0.05);
    state = 'ground'; play('idle', TUNE.fade);
  }
}

// scratch vectors for the collide-and-slide loop (avoid per-frame allocation)
const hVel = new THREE.Vector3(), disp = new THREE.Vector3(), correction = new THREE.Vector3(), slideN = new THREE.Vector3();

function updateController(dt: number): void {
  camera.getWorldDirection(camFwd); camFwd.y = 0; camFwd.normalize();
  camRight.crossVectors(camFwd, new THREE.Vector3(0, 1, 0)).negate();
  wishDir.set(0, 0, 0).addScaledVector(camFwd, move.f - move.b).addScaledVector(camRight, move.l - move.r);
  const moving = wishDir.lengthSq() > 0;
  if (moving) wishDir.normalize();

  if (state === 'climb') { climbUpdate(dt); return; }
  if (state === 'jump_start') return;        // anticipation freeze; onActionFinished launches
  if (!collision) return;
  if (player.position.y < -charH * 3) { resetToSpawn(); return; } // fell out of the world → respawn

  if (moving) player.rotation.y = lerpAngle(player.rotation.y, Math.atan2(wishDir.x, wishDir.z), TUNE.turnLerp * dt);
  const speed = (move.run ? TUNE.runSpeed : TUNE.walkSpeed) * charH;
  hVel.copy(wishDir).multiplyScalar(moving ? speed : 0);

  // Capsule collide-and-slide: apply gravity + horizontal input, depenetrate the
  // capsule out of the mesh, and slide along contacts. One unified pass handles
  // walls, floor, steps and slopes — no separate wall-push vs ground-snap conflict.
  const radius = CAPSULE_RADIUS * charH;
  const segLen = Math.max(0.02, charH - 2 * radius);
  const subdt = dt / PHYSICS_STEPS;
  let grounded = false;
  for (let s = 0; s < PHYSICS_STEPS; s++) {
    velocity.y += TUNE.gravity * charH * subdt;
    disp.set(hVel.x * subdt, velocity.y * subdt, hVel.z * subdt);
    collision.moveCapsule(player.position, radius, segLen, disp, correction);
    // `correction` is the depenetration push-out only (excludes the move above),
    // so jumping up (no penetration) is not mistaken for standing on ground.
    if (correction.y > Math.abs(subdt * velocity.y * 0.25)) {   // pushed up ⇒ on ground
      velocity.set(0, 0, 0); grounded = true;
    } else if (correction.lengthSq() > 1e-12) {                 // hit a wall ⇒ slide along it
      slideN.copy(correction).normalize();
      velocity.addScaledVector(slideN, -slideN.dot(velocity));
    }
  }

  // Ground snapping: if we just walked off a small down-step, stick to it rather
  // than briefly launching (kills stair-edge jitter). Only heading downward.
  if (!grounded && wasGrounded && velocity.y <= 0) {
    const gy = collision.groundHeightAt(player.position.x, player.position.z, player.position.y + radius);
    if (gy <= player.position.y && player.position.y - gy < charH * 0.35) {
      player.position.y = gy; velocity.set(0, 0, 0); grounded = true;
    }
  }
  wasGrounded = grounded;

  // Visual-only vertical smoothing: physics feet (player.position.y) can bob as the
  // capsule rides small bumps; damp the RENDERED height when grounded so it reads
  // smooth. Airborne (jump/fall) follows physics exactly so the arc stays crisp.
  if (grounded) smoothFeetY += (player.position.y - smoothFeetY) * Math.min(1, 10 * dt);
  else smoothFeetY = player.position.y;
  if (charModel) charModel.position.y = charFeetOffset + (smoothFeetY - player.position.y);

  updateLocomotion(grounded, moving);
}

/** Drive the animation state machine from grounded + movement. */
function updateLocomotion(grounded: boolean, moving: boolean): void {
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
    if (charLoaded) { updateController(dt); updateCamera(); }
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

/** A dropdown (top-left) to switch demo scans at runtime. */
function setupScanSwitcher(): void {
  const sel = document.createElement('select');
  sel.style.cssText =
    'position:fixed;top:12px;left:12px;z-index:10;padding:7px 12px;' +
    'border:1px solid #3a3b44;border-radius:8px;color:#e8e8ea;' +
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
  sel.onchange = () => loadScan(sel.value);
  document.body.appendChild(sel);
}

/** Show/hide the voxel collision overlay, keeping key + checkbox in sync. */
function setVoxelOverlay(on: boolean): void {
  showVoxels = on;
  if (collisionDebug) collisionDebug.visible = on;
  if (voxelCheckbox) voxelCheckbox.checked = on;
}

// A small debug panel (top-right). Put new debug tunables here (addToggle /
// addSlider) rather than reaching for URL params.
let debugPanel: HTMLDivElement | null = null;

/** A checkbox row; returns the input so callers can keep it in sync. */
function addToggle(label: string, initial: boolean, onChange: (v: boolean) => void): HTMLInputElement {
  const row = document.createElement('label');
  row.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = initial;
  cb.onchange = () => onChange(cb.checked);
  row.append(cb, label);
  debugPanel!.appendChild(row);
  return cb;
}

/** A labelled slider with a live value readout; fires `onChange` on release. */
function addSlider(label: string, initial: number, min: number, max: number, step: number, onChange: (v: number) => void): void {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:3px';
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
  addSlider('Floor flatten (voxels)', VOXEL_OPTS.floorFlat, 0, 2, 0.05, (v) => {
    VOXEL_OPTS.floorFlat = v;
    rebuildCollision();
  });

  document.body.appendChild(panel);
}

function showBanner(msg: string): void {
  document.body.insertAdjacentHTML('beforeend', `<pre style="position:fixed;top:0;left:0;right:0;margin:0;padding:12px;color:#f88;background:#1a1c22;font:12px ui-monospace;white-space:pre-wrap;z-index:9">${msg}</pre>`);
}

main().catch((err: unknown) => { console.error(err); showBanner(err instanceof Error ? err.message : String(err)); });
