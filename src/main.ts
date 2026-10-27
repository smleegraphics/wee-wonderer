// Wee Wonderer: a tiny figurine explores a Gaussian-splat scan of a real room.
// This file puts the app together (what the on-screen controls do), loads the default
// scan and the figurine, and runs the frame loop. The parts are in the folders beside it.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { camera, DEFAULT_SCAN, FREECAM, hud, hudActions, move, renderer, scene, TEL } from './app';
import { setupDebugMenu } from './debug-menu';
import { camLatch, updateCamera, updateFreeCam } from './figurine/camera';
import { charLoaded, jumpKey, mixer, onLoaded } from './figurine/character';
import { updateController } from './figurine/controller';
import { restartGame, updateGame } from './game/game';
import { updateContactShadow } from './lighting/contact-shadow';
import { updateScanDebug, updateScanLight } from './lighting/scan-light';
import { importScan, pickUpload } from './scan/import';
import { loadingViewOn, loadScan, updateArrival } from './scan/room';
import { applyMatteView, publishDebugState } from './telemetry';

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
      if (down && !move[k]) camLatch.basisHeld = false; // a fresh press, as keyEvent has it
      move[k] = down;
    }
    move.run = keys.includes('ShiftLeft');
    if (jump) jumpKey();
    stepFrames = Math.max(1, Math.round(seconds / STEP_DT));
    stepDone = done;
  });

// What the on-screen UI's controls do. An imported scan is brought back from memory;
// anything else is an example scan, loaded by file name.
Object.assign(hudActions, {
  pickRoom: (id: string) => { if (!pickUpload(id)) loadScan(id); },
  importScan: (file: File) => void importScan(file),
  reset: () => { if (charLoaded) restartGame(); }, // the way out of any spot the figurine gets stuck in: back to where the room's game starts
});

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
    updateGame(dt);
    mixer?.update(dt);
    if (charLoaded) { updateContactShadow(dt); updateScanLight(dt); updateScanDebug(); }
    updateArrival(dt);
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

main().catch((err: unknown) => { console.error(err); hud.status(err instanceof Error ? err.message : String(err), 'error'); });
