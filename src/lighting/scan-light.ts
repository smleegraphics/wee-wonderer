// Lighting the figurine from the scan: a light probe captured at the figurine, a
// cross-fade between captures, and the probe's debug view (context/lighting.md).

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { splatInternals } from '../three-internals';
import { revealPaused } from '../loading/room-reveal';
import { uniform, mix, pmremTexture, uv, PI, vec3, cos, sin, float } from 'three/tsl';
import { camera, MESHONLY, player, renderer, room, scene, SURROUND, TARGET_RADIUS, TEL } from '../app';
import { collision, collisionDebug, platformDebug } from '../collision/room-collision';
import { charH, charLoaded } from '../figurine/character';
import { shadowDark } from './contact-shadow';
import { currentSplat, loadingScene, paperFigurine } from '../scan/room';

const hemi = new THREE.HemisphereLight(0x8899bb, 0x22201c, 0.9); // fixed ambient fill...
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff4e0, 2.4);            // ...and fixed key light. Both are the fallback: off while the scan lights the scene (applyScanLight)
sun.position.set(3, 6, 4);
scene.add(sun);

// The scan's lighting is baked into its splat colours, so the figurine can only match
// it by looking at the scan: render the splats into a cubemap from where the figurine
// is, prefilter it, and use that as the scene's environment light in place of the
// fixed lights. One probe, captured at the figurine — `follow` re-captures as it
// moves, which is the cheapest possible "dynamic" probe.
//   There are two captures, not one: a new capture goes into whichever isn't showing,
// and the light cross-fades over to it, so a re-capture never swaps in a single frame.
export const SCAN_LIGHT = { on: true, intensity: 2, follow: false, blend: 0.4, fill: true, debug: false }; // blend: seconds to cross-fade to a new capture; fill: see scanFill
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
export const scanFill = new THREE.Color();
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
export function requestScanLight(): void { scanLightWanted = true; }

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
  // The probe must see the whole room, however far the reveal has got: drawn as fully
  // arrived, and drawn at all. Until its arrival starts the room is hidden (the render
  // loop shows it only once some of it is in place), and the first capture is taken
  // then, while the figurine is still paper, so it would see nothing but the fill.
  const resumeReveal = revealPaused(), roomShown = room.visible;
  room.visible = true;
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
    resumeReveal(); room.visible = roomShown;
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

const linear = new THREE.Color(); // (estimateScanFill's scratch)

/** Estimate the colour of what the scan is missing overhead: the average colour of its
 *  upper half — the splats above the scan's median height, where "median" and
 *  "average" are both weighted by how much each splat shows (opacity × size). In a
 *  room that is the upper walls, which a ceiling usually resembles; in a tabletop scan
 *  it is the upper part of whatever was captured. Colours are averaged in linear light, as
 *  the splats are drawn (the scan stores sRGB: room.ts, colourFromSRGB), which is also how
 *  the probe's own blur averages them. */
export function estimateScanFill(centers: THREE.BufferAttribute, color: THREE.BufferAttribute, cov: Float32Array | null, world: THREE.Matrix4, out: THREE.Color): void {
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
    const c = linear.setRGB(color.getX(i), color.getY(i), color.getZ(i), THREE.SRGBColorSpace); // (to the working space: linear)
    r += c.r * w; g += c.g * w; b += c.b * w; sum += w;
  }
  if (sum > 0) out.setRGB(r / sum, g / sum, b / sum); else out.copy(SURROUND.beyond);
  if (TEL) console.log(`SCANFILL rgb=${out.r.toFixed(2)},${out.g.toFixed(2)},${out.b.toFixed(2)} from splats above y=${median.toFixed(2)} (scan spans ${y0.toFixed(2)}..${y1.toFixed(2)})`);
}

/** Scan lighting replaces both fixed lights; with it off, or with no capture to use
 *  (before the first one, and always in the mesh-only view, which has no scan to
 *  capture), the fixed fill and sun light the scene as before. */
export function applyScanLight(): void {
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
export let scanDebugThumb: THREE.Mesh | null = null;
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
 *  top-left corner of the view (the one corner the HUD leaves free). */
export function updateScanDebug(): void {
  if (!scanDebugBalls || !scanDebugThumb || !scanDebugBalls.visible) return;
  scanDebugBalls.scale.setScalar(charH * SCAN_DEBUG.ballRadius);
  scanDebugBalls.position.set(player.position.x, player.position.y + charH * SCAN_DEBUG.ballHeight, player.position.z);
  scanDebugBalls.quaternion.copy(camera.quaternion); // the row runs across the screen
  const d = charH, halfH = d * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2), halfW = halfH * camera.aspect;
  const h = halfH * 2 * SCAN_DEBUG.thumbHeight, margin = halfH * 2 * SCAN_DEBUG.thumbMargin; // the panorama is twice as wide as tall
  scanDebugThumb.scale.setScalar(h);
  scanDebugThumb.position.set(-halfW + margin + h, halfH - margin - h / 2, -d);
}

/** Where updateScanDebug puts the panorama, in CSS pixels from the top left (for ?tel=1). */
export function scanDebugThumbRect(): { x: number; y: number; w: number; h: number } {
  const H = renderer.domElement.clientHeight, h = H * SCAN_DEBUG.thumbHeight, margin = H * SCAN_DEBUG.thumbMargin;
  return { x: margin, y: margin, w: 2 * h, h };
}

/** Per frame: advance the cross-fade, then take a capture if one is due — because it
 *  was asked for, or because follow mode is on and the figurine has moved on. */
export function updateScanLight(dt: number): void {
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
