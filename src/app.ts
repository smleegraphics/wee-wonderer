// What every part of the app shares: the page's options (?scan, ?tel and the debug
// ones), the scale scans are brought to, the renderer, scene and camera, the on-screen
// UI's handle, the room and the figurine's objects, and how the figurine is moving.
// Of the app's own files it imports only the UI, the scan list and one constant of the
// reveal, none of which import anything back, so it is always loaded before what uses it.

import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createHud } from './ui/hud';
import { HANDOVER } from './loading/room-reveal';
import { LISTED_SCANS, SCAN_FILE_TYPES } from './scan/scans';
import { CHARACTERS } from './figurine/characters';

export const q = new URLSearchParams(location.search);
export const TEL = q.get('tel') === '1'; // debug telemetry: CLIMB-* console events + window.__dbg
export const DEFAULT_SCAN = q.get('scan') ?? LISTED_SCANS[0].file;
export const TARGET_RADIUS = 7; // normalize every scan to this world size (figurine ~0.45 tall)
// Collision voxelization: build a cleaned blocky surface mesh from the splat and
// show it as a debug overlay (toggle 'V', or ?voxel=1 to start visible).
// GRAIN is the length collision's settings are counted in: the voxel size they were
// tuned at, about a fifth of the figurine's height. The grid itself can be finer
// (VOXEL_SIZE); settings given in grains then mean the same thing at any grid size.
export const GRAIN = TARGET_RADIUS / 72; // ~0.097 world units
export const VOXEL_SIZE = Number(q.get('vox')) || GRAIN;
export const num = (key: string, def: number) => (q.has(key) ? Number(q.get(key)) : def);
// Debug free-camera: when any of ?az/el/dist/cx/cy/cz is present, detach the
// figurine-follow and park the camera at a fixed orbit around a look-at point, so
// any part of the collision mesh can be framed for inspection (used with ?voxel=1).
// az/el = azimuth/elevation in radians; dist = distance in scene-radii (TARGET_RADIUS);
// cx/cy/cz = look-at point in world units (floor is y=0). Non-interactive by design.
// Debug mesh-only view (?meshonly=1): hide the splat and draw the collision surface
// as a solid lit mesh, so holes / fills are unmistakable (the wireframe-over-splat
// overlay is too cluttered to judge). Pairs with the free-cam for inspection.
export const MESHONLY = q.get('meshonly') === '1';
export const FREECAM = ['az', 'el', 'dist', 'cx', 'cy', 'cz'].some((k) => q.has(k));
export const FREECAM_OPTS = { az: num('az', 0.9), el: num('el', 0.5), dist: num('dist', 2.2), cx: num('cx', 0), cy: num('cy', 1), cz: num('cz', 0) };
/** The collision capsule: its radius in body heights, the character's own (characters.ts), set when one is chosen. */
export const BODY = { radius: 0.22 };
const app = document.getElementById('app')!;
// The on-screen UI (context/ui.md). What its controls do is filled in where the app is
// put together (hudActions), since the code that does it is built on this.
export const hudActions = { pickRoom: (_id: string): void => {}, pickCharacter: (_id: string): void => {}, importScan: (_file: File): void => {}, reset: (): void => {} };
export const hud = createHud({
  rooms: LISTED_SCANS.map((s) => ({ id: s.file, label: s.label })),
  importTypes: SCAN_FILE_TYPES,
  onPickRoom: (id) => hudActions.pickRoom(id),
  characters: CHARACTERS.map((c) => ({ id: c.id, label: c.label, image: `${import.meta.env.BASE_URL}${c.thumb}` })),
  onPickCharacter: (id) => hudActions.pickCharacter(id),
  onImport: (file) => hudActions.importScan(file),
  onReset: () => hudActions.reset(),
});

export const renderer = new WebGPURenderer({ antialias: false }); // no MSAA: every splat would be blended at several samples a pixel, which a soft splat gains nothing from (context/frame-time.md)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
app.appendChild(renderer.domElement);

export const scene = new THREE.Scene();
// What is seen around a scan. While the figurine waits it is the open air of the paper
// world (the UI's --sky token; index.html paints it before the first frame). As the room
// arrives it darkens to --beyond, which a scan's gaps and edges recede into. It follows
// how much of the room is in place, both ways, so it is never a cut.
export const SURROUND = {
  sky: new THREE.Color(hud.token('--sky')), beyond: new THREE.Color(hud.token('--beyond')),
  darken: [HANDOVER, 0.8], // the part of the arrival it takes: from when the dots lift off, to a little before the last land, so the arrival ends on the room alone
};
export const surround = new THREE.Color().copy(SURROUND.sky);
scene.background = surround;

/** The camera the screen shows: where the follow camera puts it each frame (figurine/camera.ts). */
export const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.001, 200);
/** Where the player has asked to look from: OrbitControls' own camera, moved by nothing
 *  else. It is never drawn from. The follow camera reads the player's angle and zoom off
 *  it and shows them, pulled in where something is in the way. Kept apart from `camera`
 *  because OrbitControls reads its camera's distance as the zoom whenever input arrives,
 *  not only when the frame asks it to: sharing one camera, a scroll made while the view
 *  was pulled in zoomed from the pulled-in distance and was then undone. */
export const orbitCamera = new THREE.PerspectiveCamera();

// Orbit-follow camera: user drags to orbit / scrolls to zoom, and its pivot is
// glued to the figurine each frame so it follows while you look around.
export const orbit = new OrbitControls(orbitCamera, renderer.domElement);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;
orbit.enablePan = false; // pivot tracks the figurine; panning it away would fight that
orbit.maxPolarAngle = Math.PI * 0.49; // don't drop below the floor

// The scan is auto-leveled at load (RANSAC floor fit) — Y-up, floor at y=0.
// No per-scan constants: any scan (a demo, or the user's own) levels the same way.
export const room = new THREE.Group();
scene.add(room);

export const player = new THREE.Group();
scene.add(player);

/** The climb's and the camera's tunables. How the figurine walks, sprints and jumps is MOVE
 *  (figurine/movement.ts). */
export const TUNE = { climbSpeed: 1.2, climbTurn: 6, turnLerp: 12, camIn: 20, camOut: 3, camSwing: 4 };

export const move = { f: 0, b: 0, l: 0, r: 0, run: false, jump: false }; // the keys held: directions, Shift (sprint), Space (jump)
export const velocity = new THREE.Vector3(); // world units a second: the figurine's speed, horizontal (with momentum) and vertical (jumping, falling)
/** How the figurine is moving: written by the controller, the climb and a respawn alike. */
export const figurine = {
  state: 'ground' as 'ground' | 'air' | 'climb',
  supportY: 0,        // height of the platform the player is standing on
  smoothFeetY: 0,     // damped feet height for RENDER only (physics stays crisp)
  wasGrounded: false,
  mantleLeft: 0,      // seconds of a climb-up still playing: keys wait and the mantle move shows (climb.ts)
  drawnLeft: 0,       // seconds of the drawn figure still catching up with the body after a move over a top (climb.ts)
  drawnFrom: new THREE.Vector3(), // where the body was, from where it then stood, when that move began (world)
  drawn: new THREE.Vector3(),     // where the drawn figure is now, from the body (world): the model and the camera follow it
};
export const WORLD_UP = new THREE.Vector3(0, 1, 0), WORLD_DOWN = new THREE.Vector3(0, -1, 0);
