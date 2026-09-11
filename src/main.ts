// Wee Wonderer — app shell + character controller (M2).
//
// three.js on WebGPU owns everything. The character + controller are ported from
// the reference harness (context/character-README.md contract): measure height
// from bones, feet at the player origin, AnimationMixer with contract loop modes,
// and a ground/jump/air/land/climb state machine. Collision is the swappable seam
// groundHeightAt() / resolveWallCollision() — hand-authored props for now; the
// splat scan + real collision arrive at M3.

import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';

const app = document.getElementById('app')!;

const renderer = new WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1c22);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.01, 200);
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;

scene.add(new THREE.HemisphereLight(0x8899bb, 0x22201c, 0.9));
const sun = new THREE.DirectionalLight(0xfff4e0, 2.4);
sun.position.set(3, 6, 4);
scene.add(sun);

// --- test world (hand-authored collision proxies; sized once charH is known) --
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(60, 60),
  new THREE.MeshStandardMaterial({ color: 0x1c1d23, roughness: 0.95 }),
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const box = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshStandardMaterial({ color: 0x2e3039, roughness: 0.8 }),
);
const wall = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshStandardMaterial({
    color: 0xc07b16,
    roughness: 0.7,
    emissive: 0x503208,
    emissiveIntensity: 0.55, // reads "climbable" even in the dark scene
  }),
);
scene.add(box, wall);

// --- character state ---------------------------------------------------------
const player = new THREE.Group(); // controller moves this; the mesh hangs off it
scene.add(player);

const CONTRACT = [
  { name: 'idle', loop: true },
  { name: 'walk', loop: true },
  { name: 'run', loop: true },
  { name: 'climb', loop: true },
  { name: 'jump_start', loop: false },
  { name: 'jump_loop', loop: false, hold: true }, // 1-frame apex, held
  { name: 'jump_land', loop: false }, // not in this GLB by design; handled if absent
] as const;

const TUNE = {
  walkSpeed: 1.6, // char-heights / s
  runSpeed: 4.0,
  jumpVel: 3.2,
  gravity: -9.0,
  climbSpeed: 1.2,
  fade: 0.18,
  turnLerp: 12,
};

const move = { f: 0, b: 0, l: 0, r: 0, run: false };
let state: 'ground' | 'jump_start' | 'air' | 'land' | 'climb' = 'ground';
let vy = 0;
let charH = 1;
let mixer: THREE.AnimationMixer | null = null;
const actions: Record<string, THREE.AnimationAction> = {};
let activeAction: THREE.AnimationAction | null = null;
let charLoaded = false;
const climbNormal = new THREE.Vector3(0, 0, 1);

// --- load + measure + wire the mixer -----------------------------------------
function onLoaded(gltf: GLTF): void {
  const model = gltf.scene;
  player.add(model);

  setupMixer(gltf, model); // mixer first, so we can pose before measuring

  // Measure from posed BONE world positions — never a skinned mesh's static
  // bounding box (that's the bind pose and causes the "floating character" bug).
  if (actions['idle']) {
    play('idle', 0);
    mixer!.update(0);
  }
  model.updateMatrixWorld(true);
  const bb = measureSkinnedBounds(model);
  charH = Math.max(bb.max.y - bb.min.y, 1e-4);
  model.position.y = -bb.min.y; // feet on the player origin

  // size props + camera relative to the character (char-heights)
  box.scale.set(charH * 1.6, charH * 0.55, charH * 1.6);
  box.position.set(charH * 3, charH * 0.275, 0);
  wall.scale.set(charH * 2.4, charH * 3.2, charH * 0.4);
  wall.position.set(0, charH * 1.6, -charH * 3.2);

  camera.position.set(charH * 3.2, charH * 2.4, charH * 4.6);
  camera.near = charH * 0.02;
  camera.far = charH * 200;
  camera.updateProjectionMatrix();
  orbit.target.set(0, charH * 0.6, 0);

  play('idle', 0);
  charLoaded = true;
  console.log(`character: ${charH.toFixed(3)} units tall, ${gltf.animations.length} clips`);
}

function setupMixer(gltf: GLTF, model: THREE.Object3D): void {
  mixer = new THREE.AnimationMixer(model);
  const clipByName: Record<string, THREE.AnimationClip> = {};
  gltf.animations.forEach((c) => (clipByName[c.name] = c));

  for (const spec of CONTRACT) {
    const clip = clipByName[spec.name];
    if (!clip) continue;
    const a = mixer.clipAction(clip);
    if (spec.loop) {
      a.setLoop(THREE.LoopRepeat, Infinity);
    } else {
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true; // hold last pose instead of snapping to frame 0
    }
    actions[spec.name] = a;
  }
  mixer.addEventListener('finished', onActionFinished);
}

/** Bounds from bone world positions (see character README — skinned-vertex sampling lies). */
function measureSkinnedBounds(model: THREE.Object3D): THREE.Box3 {
  const bounds = new THREE.Box3();
  const v = new THREE.Vector3();
  let bones = 0;
  model.traverse((o) => {
    if ((o as THREE.Bone).isBone) {
      o.getWorldPosition(v);
      bounds.expandByPoint(v);
      bones++;
    }
  });
  if (!bones) bounds.setFromObject(model);
  return bounds;
}

// --- animation helpers (the crossfade pattern) -------------------------------
function play(name: string, fade = TUNE.fade): void {
  const next = actions[name];
  if (!next || next === activeAction) return;
  next.reset().play();
  const spec = CONTRACT.find((s) => s.name === name);
  if (spec && !spec.loop) {
    next.setLoop(THREE.LoopOnce, 1);
    next.clampWhenFinished = true;
  }
  if (activeAction) activeAction.crossFadeTo(next, fade, false);
  activeAction = next;
}

function onActionFinished(e: { action: THREE.AnimationAction }): void {
  const name = e.action.getClip().name;
  if (name === 'jump_start') {
    // liftoff happens when the crouch anticipation finishes
    vy = TUNE.jumpVel * charH;
    state = 'air';
    play('jump_loop', 0.08);
  } else if (name === 'jump_land') {
    state = 'ground';
    play('idle', 0.25);
  }
}

// --- input -------------------------------------------------------------------
function keyEvent(e: KeyboardEvent, v: 0 | 1): void {
  switch (e.code) {
    case 'KeyW': move.f = v; break;
    case 'KeyS': move.b = v; break;
    case 'KeyA': move.l = v; break;
    case 'KeyD': move.r = v; break;
    case 'ShiftLeft': case 'ShiftRight': move.run = !!v; break;
    case 'Space':
      if (v && state === 'ground') startJump();
      e.preventDefault();
      break;
    case 'KeyC':
      if (v) toggleClimb();
      break;
  }
}
addEventListener('keydown', (e) => keyEvent(e, 1));
addEventListener('keyup', (e) => keyEvent(e, 0));

function startJump(): void {
  if (actions['jump_start']) {
    state = 'jump_start';
    play('jump_start', 0.06); // vy applied in onActionFinished when the crouch completes
  } else {
    vy = TUNE.jumpVel * charH;
    state = 'air';
    play(actions['jump_loop'] ? 'jump_loop' : 'idle', 0.08);
  }
}

// --- climb -------------------------------------------------------------------
function nearWall(): boolean {
  if (player.position.y >= wall.scale.y - 0.01) return false;
  const dxo = Math.abs(player.position.x - wall.position.x) - wall.scale.x / 2;
  const dzo = Math.abs(player.position.z - wall.position.z) - wall.scale.z / 2;
  return dxo < charH * 0.9 && dzo < charH * 0.9;
}

function toggleClimb(): void {
  if (state === 'climb') { exitClimb(); return; }
  if (state !== 'ground' || !actions['climb'] || !nearWall()) return;

  const dx = player.position.x - wall.position.x;
  const dz = player.position.z - wall.position.z;
  const dxo = Math.abs(dx) - wall.scale.x / 2;
  const dzo = Math.abs(dz) - wall.scale.z / 2;
  if (dxo > dzo) climbNormal.set(Math.sign(dx || 1), 0, 0);
  else climbNormal.set(0, 0, Math.sign(dz || 1));

  state = 'climb';
  vy = 0;
  const half = climbNormal.x !== 0 ? wall.scale.x / 2 : wall.scale.z / 2;
  const lateralHalf = climbNormal.x !== 0 ? wall.scale.z / 2 : wall.scale.x / 2;
  player.position.x = climbNormal.x !== 0
    ? wall.position.x + climbNormal.x * (half + charH * 0.12)
    : THREE.MathUtils.clamp(player.position.x, wall.position.x - lateralHalf + charH * 0.2, wall.position.x + lateralHalf - charH * 0.2);
  player.position.z = climbNormal.z !== 0
    ? wall.position.z + climbNormal.z * (half + charH * 0.12)
    : THREE.MathUtils.clamp(player.position.z, wall.position.z - lateralHalf + charH * 0.2, wall.position.z + lateralHalf - charH * 0.2);
  player.rotation.y = Math.atan2(-climbNormal.x, -climbNormal.z);
  play('climb', TUNE.fade);
}

function exitClimb(): void {
  state = 'air';
  vy = 0;
  play(actions['jump_loop'] ? 'jump_loop' : 'idle', 0.12);
}

// --- collision seam (swap for splat sampling at M3) --------------------------
function groundHeightAt(x: number, z: number): number {
  if (Math.abs(x - box.position.x) < box.scale.x / 2 && Math.abs(z - box.position.z) < box.scale.z / 2)
    return box.scale.y;
  if (Math.abs(x - wall.position.x) < wall.scale.x / 2 && Math.abs(z - wall.position.z) < wall.scale.z / 2)
    return wall.scale.y;
  return 0;
}

function resolveWallCollision(): void {
  if (state === 'climb') return;
  const r = charH * 0.14;
  const hx = wall.scale.x / 2 + r, hz = wall.scale.z / 2 + r;
  const dx = player.position.x - wall.position.x;
  const dz = player.position.z - wall.position.z;
  if (player.position.y >= wall.scale.y - 0.01) return;
  if (Math.abs(dx) >= hx || Math.abs(dz) >= hz) return;
  const px = hx - Math.abs(dx), pz = hz - Math.abs(dz);
  if (px < pz) player.position.x = wall.position.x + Math.sign(dx || 1) * hx;
  else player.position.z = wall.position.z + Math.sign(dz || 1) * hz;
}

// --- controller update -------------------------------------------------------
const camFwd = new THREE.Vector3(), camRight = new THREE.Vector3(), wishDir = new THREE.Vector3();

function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * Math.min(t, 1);
}

function updateController(dt: number): void {
  camera.getWorldDirection(camFwd); camFwd.y = 0; camFwd.normalize();
  camRight.crossVectors(camFwd, new THREE.Vector3(0, 1, 0)).negate();
  wishDir.set(0, 0, 0)
    .addScaledVector(camFwd, move.f - move.b)
    .addScaledVector(camRight, move.l - move.r);
  const moving = wishDir.lengthSq() > 0;
  if (moving) wishDir.normalize();
  const speed = (move.run ? TUNE.runSpeed : TUNE.walkSpeed) * charH;

  if (state === 'climb') {
    player.position.y += (move.f - move.b) * TUNE.climbSpeed * charH * dt;
    const topY = wall.position.y + wall.scale.y / 2;
    if (player.position.y >= topY) {
      player.position.y = topY;
      player.position.addScaledVector(climbNormal, -charH * 0.35);
      state = 'ground';
      play('idle', TUNE.fade);
    } else if (player.position.y <= 0) {
      player.position.y = 0;
      player.position.addScaledVector(climbNormal, charH * 0.05);
      state = 'ground';
      play('idle', TUNE.fade);
    }
  } else {
    if (moving && state !== 'jump_start') {
      player.position.addScaledVector(wishDir, speed * dt);
      player.rotation.y = lerpAngle(player.rotation.y, Math.atan2(wishDir.x, wishDir.z), TUNE.turnLerp * dt);
    }
    resolveWallCollision();

    const groundY = groundHeightAt(player.position.x, player.position.z);
    if (state === 'air') {
      vy += TUNE.gravity * charH * dt;
      player.position.y += vy * dt;
      if (vy <= 0 && player.position.y <= groundY) {
        player.position.y = groundY;
        vy = 0;
        if (actions['jump_land']) { state = 'land'; play('jump_land', 0.06); }
        else { state = 'ground'; play('idle', TUNE.fade); }
      }
    } else if (state === 'ground') {
      if (player.position.y > groundY + 0.001) {
        state = 'air'; vy = 0;
        play(actions['jump_loop'] ? 'jump_loop' : 'idle', 0.15); // edge-fall → jump_loop
      } else {
        player.position.y = groundY;
        if (moving) play(move.run && actions['run'] ? 'run' : 'walk');
        else play('idle');
      }
    }
  }

  // contextual climb prompt (keep this pattern for the toy)
  hint.hidden = !(state === 'ground' && actions['climb'] && nearWall());

  // keep the orbit target glued to the character
  orbit.target.lerp(
    new THREE.Vector3(player.position.x, player.position.y + charH * 0.6, player.position.z),
    0.15,
  );
}

// --- hint element ------------------------------------------------------------
const hint = document.createElement('div');
hint.textContent = 'Press C to climb';
hint.hidden = true;
hint.style.cssText =
  'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);padding:6px 14px;' +
  'background:rgba(23,24,29,.88);color:#e8930d;font:14px ui-monospace,monospace;' +
  'border:1px solid #e8930d;border-radius:6px;pointer-events:none';
document.body.appendChild(hint);

// --- boot --------------------------------------------------------------------
const clock = new THREE.Clock();
let frames = 0;

async function main(): Promise<void> {
  await renderer.init();
  new GLTFLoader().load(
    `${import.meta.env.BASE_URL}character.glb`,
    onLoaded,
    undefined,
    (err) => showBanner(`character.glb load failed: ${String(err)}`),
  );

  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);
    if (charLoaded) updateController(dt);
    mixer?.update(dt);
    orbit.update();
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
  document.body.insertAdjacentHTML(
    'beforeend',
    `<pre style="position:fixed;top:0;left:0;right:0;margin:0;padding:12px;color:#f88;background:#1a1c22;font:12px ui-monospace;white-space:pre-wrap;z-index:9">${msg}</pre>`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  showBanner(err instanceof Error ? err.message : String(err));
});
