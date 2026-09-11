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

const q = new URLSearchParams(location.search);
// which demo scan to load — config, not logic (auto-leveled at load, see below)
const SCAN_FILE = q.get('scan') ?? 'room2.ply';
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

function loadRoom(): void {
  new GaussianSplatPLYLoader().load(
    `${import.meta.env.BASE_URL}${SCAN_FILE}`,
    (geometry) => {
      const o = orientScan(geometry.getAttribute('position') as THREE.BufferAttribute);
      const splat = new GaussianSplat(geometry);
      splat.position.copy(o.center).multiplyScalar(-1); // recenter to origin
      room.add(splat);
      room.quaternion.copy(o.quaternion); // auto-leveled: floor normal → +Y
      room.position.y = o.floorOffsetY; // floor at y=0
      console.log(`room loaded + auto-leveled (radius ${o.radius.toFixed(2)})`);
    },
    undefined,
    (err) => showBanner(`${SCAN_FILE} load failed: ${String(err)}`),
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
let vy = 0;
let charH = 1;
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

  // spawn on the floor (y=0); tune the rug spot with ?fx=&fz=
  player.position.set(Number(q.get('fx') ?? 0), 0, Number(q.get('fz') ?? 0));

  camera.near = charH * 0.02;
  camera.far = charH * 400;
  camera.updateProjectionMatrix();
  orbit.minDistance = charH * 2.5;
  orbit.maxDistance = charH * 14;
  orbit.target.set(player.position.x, player.position.y + charH * 0.7, player.position.z);
  camera.position.copy(player.position).add(new THREE.Vector3(charH * 1.2, charH * 2.6, charH * 4.5));
  orbit.update();

  play('idle', 0);
  charLoaded = true;
  console.log(`character: ${charH.toFixed(3)} tall, ${gltf.animations.length} clips`);
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
  if (name === 'jump_start') { vy = TUNE.jumpVel * charH; state = 'air'; play('jump_loop', 0.08); }
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
  }
}
addEventListener('keydown', (e) => keyEvent(e, 1));
addEventListener('keyup', (e) => keyEvent(e, 0));

function startJump(): void {
  if (actions['jump_start']) { state = 'jump_start'; play('jump_start', 0.06); }
  else { vy = TUNE.jumpVel * charH; state = 'air'; play(actions['jump_loop'] ? 'jump_loop' : 'idle', 0.08); }
}

// --- collision seam ---------------------------------------------------------
// M3a: flat room floor at y=0. Furniture/step collision (jump/climb targets)
// comes next as hand-authored boxes plugged in here.
function groundHeightAt(_x: number, _z: number): number { return 0; }

// --- controller update ------------------------------------------------------
const camFwd = new THREE.Vector3(), camRight = new THREE.Vector3(), wishDir = new THREE.Vector3();
const camLook = new THREE.Vector3();

/** Glue the orbit pivot to the figurine so the camera follows while the user orbits/zooms. */
function updateCamera(): void {
  camLook.set(player.position.x, player.position.y + charH * 0.7, player.position.z);
  orbit.target.lerp(camLook, 0.15);
  orbit.update();
}
function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * Math.min(t, 1);
}

function updateController(dt: number): void {
  camera.getWorldDirection(camFwd); camFwd.y = 0; camFwd.normalize();
  camRight.crossVectors(camFwd, new THREE.Vector3(0, 1, 0)).negate();
  wishDir.set(0, 0, 0).addScaledVector(camFwd, move.f - move.b).addScaledVector(camRight, move.l - move.r);
  const moving = wishDir.lengthSq() > 0;
  if (moving) wishDir.normalize();
  const speed = (move.run ? TUNE.runSpeed : TUNE.walkSpeed) * charH;

  if (moving && state !== 'jump_start') {
    player.position.addScaledVector(wishDir, speed * dt);
    player.rotation.y = lerpAngle(player.rotation.y, Math.atan2(wishDir.x, wishDir.z), TUNE.turnLerp * dt);
  }

  const groundY = groundHeightAt(player.position.x, player.position.z);
  if (state === 'air') {
    vy += TUNE.gravity * charH * dt;
    player.position.y += vy * dt;
    if (vy <= 0 && player.position.y <= groundY) {
      player.position.y = groundY; vy = 0;
      if (actions['jump_land']) { state = 'land'; play('jump_land', 0.06); }
      else { state = 'ground'; play('idle', TUNE.fade); }
    }
  } else if (state === 'ground') {
    if (player.position.y > groundY + 0.001) { state = 'air'; vy = 0; play(actions['jump_loop'] ? 'jump_loop' : 'idle', 0.15); }
    else { player.position.y = groundY; if (moving) play(move.run && actions['run'] ? 'run' : 'walk'); else play('idle'); }
  }
}

// --- boot --------------------------------------------------------------------
const clock = new THREE.Clock();
let frames = 0;

async function main(): Promise<void> {
  await renderer.init();
  loadRoom();
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

function showBanner(msg: string): void {
  document.body.insertAdjacentHTML('beforeend', `<pre style="position:fixed;top:0;left:0;right:0;margin:0;padding:12px;color:#f88;background:#1a1c22;font:12px ui-monospace;white-space:pre-wrap;z-index:9">${msg}</pre>`);
}

main().catch((err: unknown) => { console.error(err); showBanner(err instanceof Error ? err.message : String(err)); });
