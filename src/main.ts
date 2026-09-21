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
// demo scans for the switcher UI — config, not logic (each auto-levels at load).
const SCANS: { file: string; label: string }[] = [
  { file: 'room2.ply', label: 'Playroom' },
  { file: 'livingroom.ply', label: 'Living Room' },
  { file: 'kitchen.ply', label: 'Kitchen' },
  { file: 'counter.ply', label: 'Counter' },
];
const DEFAULT_SCAN = q.get('scan') ?? SCANS[0].file;
const TARGET_RADIUS = 7; // normalize every scan to this world size (figurine ~0.45 tall)
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
function loadScan(file: string): void {
  if (currentSplat) {
    room.remove(currentSplat);
    currentSplat.geometry.dispose();
    (currentSplat.material as THREE.Material).dispose();
    (currentSplat as unknown as { dispose?: () => void }).dispose?.();
    currentSplat = null;
  }
  room.quaternion.identity();
  room.position.set(0, 0, 0);
  room.scale.setScalar(1);
  new GaussianSplatPLYLoader().load(
    `${import.meta.env.BASE_URL}${file}`,
    (geometry) => {
      const o = orientScan(geometry.getAttribute('position') as THREE.BufferAttribute);
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
      if (charLoaded) resetToSpawn();
      console.log(`loaded ${file}: radius ${o.radius.toFixed(2)} → scaled ${k.toFixed(2)}x`);
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
  vy = 0;
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
  loadScan(DEFAULT_SCAN);
  setupScanSwitcher();
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

/** A small button bar (top-left) to switch demo scans at runtime. */
function setupScanSwitcher(): void {
  const bar = document.createElement('div');
  bar.style.cssText =
    'position:fixed;top:12px;left:12px;display:flex;gap:6px;z-index:10;' +
    'font:13px ui-monospace,Menlo,monospace';
  const setActive = (active: HTMLButtonElement) => {
    for (const c of Array.from(bar.children) as HTMLButtonElement[])
      c.style.background = c === active ? '#2e6cff' : 'rgba(23,24,29,0.85)';
  };
  for (const s of SCANS) {
    const btn = document.createElement('button');
    btn.textContent = s.label;
    btn.style.cssText =
      'padding:6px 11px;border:1px solid #3a3b44;border-radius:8px;color:#e8e8ea;' +
      'background:rgba(23,24,29,0.85);cursor:pointer;backdrop-filter:blur(4px)';
    btn.onclick = () => { loadScan(s.file); setActive(btn); };
    if (s.file === DEFAULT_SCAN) btn.style.background = '#2e6cff';
    bar.appendChild(btn);
  }
  document.body.appendChild(bar);
}

function showBanner(msg: string): void {
  document.body.insertAdjacentHTML('beforeend', `<pre style="position:fixed;top:0;left:0;right:0;margin:0;padding:12px;color:#f88;background:#1a1c22;font:12px ui-monospace;white-space:pre-wrap;z-index:9">${msg}</pre>`);
}

main().catch((err: unknown) => { console.error(err); showBanner(err instanceof Error ? err.message : String(err)); });
