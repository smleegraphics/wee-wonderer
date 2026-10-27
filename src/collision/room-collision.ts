// The current room's collision: its settings (VOXEL_OPTS: the defaults, the scan's own,
// then the session's), building it in a worker (cached), rebuilding it from the Debug
// sliders, the walkable cells (NavGrid) and the two debug overlays (context/collision.md).

import * as THREE from 'three';
import { type VoxelOptions, type VoxelSurface, surfaceToGeometry } from './voxelize';
import { type Collision, type NavGrid, type PlatformField, MeshCollision } from './collision';
import { voxelCacheKey, voxelCacheGet, voxelCachePut } from './voxel-cache';
import { workerCaller } from '../worker-call';
import { SCANS } from '../scan/scans';
import { GRAIN, hud, MESHONLY, num, q, scene, TARGET_RADIUS, VOXEL_SIZE } from '../app';
import { charH } from '../figurine/character';
import { isImported, currentFile, lastCenters, lastCov, lastMatrix, lastOpacity, loadToken, newLoadToken, scanLoading } from '../scan/room';
import { refillWalkable } from '../scan/walk-fill';

/** The spacing of the walkable cells: a grain, however fine the collision grid is. (Coarser
 *  only if the grid itself had to be: a scan too large for it.) Where the figurine can
 *  stand is sampled from the mesh at this spacing; making it finer as well changes what
 *  counts as a step and what as a slope, and is a separate question from the mesh's detail. */
export const navStep = () => Math.max(GRAIN, lastVoxelSize);
/** How many walkable cells go to a grain (1, unless the cells had to be coarser). */
export const cellsPerGrain = () => GRAIN / navStep();
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
export type VoxelSettings = typeof VOXEL_DEFAULTS;
const VOXEL_KEYS = Object.keys(VOXEL_DEFAULTS) as (keyof VoxelSettings)[];
/** Settings given for this session, which hold whatever scan is loaded: in the address (the
 *  setting's name in lower case: ?floorflat=2&iso=0.2), and after that by a Debug slider. */
export const voxelSet: Partial<VoxelSettings> = {};
for (const key of VOXEL_KEYS) if (q.has(key.toLowerCase())) voxelSet[key] = Number(q.get(key.toLowerCase()));
/** The settings collision is built with now (useScanSettings). */
export const VOXEL_OPTS: VoxelSettings = { ...VOXEL_DEFAULTS, ...voxelSet };
export const voxelSliders: Partial<Record<keyof VoxelSettings, (v: number) => void>> = {}; // each setting's Debug slider: call to show a value on it
/** Make the collision settings those of scan `id`: the defaults, then what the scan list
 *  gives for that scan, then whatever has been set for the session. An uploaded scan has
 *  no entry in the list, so it gets the defaults. (This is the one place a scan's settings
 *  are decided: settings measured from a scan would go between the defaults and the list's.) */
export function useScanSettings(id: string): void {
  Object.assign(VOXEL_OPTS, VOXEL_DEFAULTS, SCANS.find((s) => s.file === id)?.collision, voxelSet);
  for (const key of VOXEL_KEYS) voxelSliders[key]?.(VOXEL_OPTS[key]);
}
// Walkable surfaces are de-quantized to the real splat height in the voxelizer,
// so no ground offset is needed; ?sink stays as a manual override (default 0).
const GROUND_OFFSET = num('sink', 0);
export let showVoxels = q.get('voxel') === '1';
export let collisionDebug: THREE.Mesh | null = null;
// Spike 1: platform-decomposition overlay (colored walkable surfaces). stepFactor
// = max step (in char-heights) two cells can differ and still be one platform;
// minCells drops floater specks. Tuned live to see how scans decompose.
export let showPlatforms = q.get('platforms') === '1';
export let platformDebug: THREE.InstancedMesh | null = null;
/** The Debug card's checkboxes for the two overlays, kept in step when a key (V, P) changes them. */
export const overlayBoxes: { voxel: HTMLInputElement | null; platform: HTMLInputElement | null } = { voxel: null, platform: null };
export let lastVoxelSize = GRAIN;
export let groundY: number | null = null; // the height of the ground the figurine plays on in this scan (the voxelizer's), or null
export const PLATFORM_OPTS = { stepFactor: 0.35, minCells: 6, climbDeg: 70, grabBelow: 10, bridge: 2, fill: 3 }; // climbDeg: surfaces steeper than this (from horizontal) are walls, gentler ones are ground to walk. grabBelow: a jump grabs surfaces down to this many degrees gentler than climbDeg (context/climb.md, rule 9). minCells: an area, in grains². bridge, fill: how wide a gap in a surface is bridged, and how wide a hole in it filled, in grains
/** Walk it or not — the "Climb threshold" slider: a surface steeper than that is a wall, and
 *  the NavGrid will not stand on it (this is its `slopeMin`). Returned as the largest |normal.y|
 *  a wall may have. */
export function wallSlopeMax(): number {
  return Math.cos(THREE.MathUtils.degToRad(PLATFORM_OPTS.climbDeg));
}
/** Grab it or not: a surface steeper than the climb threshold less `grabBelow` can be climbed,
 *  jumped into (isWall). Never steeper than the walking cutoff, so no surface is neither: between
 *  the two it is both, ground to walk up or a face to jump at. One cutoff for both (the old rule)
 *  could not keep Curled Up Dog's 60°-70° flanks walkable and Kitchen's bulldozer's 62°-68°
 *  sides grabbable (context/climb.md, rule 9). As the largest |normal.y| a climbable face may have. */
export function grabSlopeMax(): number {
  return Math.cos(THREE.MathUtils.degToRad(Math.max(0, PLATFORM_OPTS.climbDeg - PLATFORM_OPTS.grabBelow)));
}
// Spike 2: the reliable ground. The controller stands on the NavGrid (no
// fall-through), is confined to it (no walking off), and recovers to `lastGood`.
export let navGrid: NavGrid | null = null;
export let navField: PlatformField | null = null; // navGrid's cells as a list, for the overlay and the gap fill
export let navVersion = 0;                       // goes up each time the walkable cells are rebuilt
export let collision: Collision | null = null; // BVH over the voxel surface, rebuilt per scan
export let collisionKey = ''; // the settings (voxelCacheKey) the collision there is was built with

/** Take the room's collision, and its debug overlays, out of the scene. */
export function disposeCollision(): void {
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
export async function buildCollision(file: string, token: number, centers: THREE.BufferAttribute, opacity: Float32Array, cov: Float32Array | null, matrixWorld: THREE.Matrix4): Promise<void> {
  const t0 = performance.now();
  // imports aren't cached: re-cleaning changes the splat under a stable id, so the
  // key wouldn't reflect it — always re-voxelize an import.
  const useCache = !isImported(file);
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
export function rebuildCollision(): void {
  if (scanLoading || !lastCenters || !lastOpacity) return;
  disposeCollision();
  buildCollision(currentFile, newLoadToken(), lastCenters, lastOpacity, lastCov, lastMatrix)
    .catch((err: unknown) => hud.status(err instanceof Error ? err.message : String(err), 'error'));
}

/** Show/hide the voxel collision overlay, keeping key + checkbox in sync. */
export function setVoxelOverlay(on: boolean): void {
  showVoxels = on;
  if (collisionDebug) collisionDebug.visible = on;
  if (overlayBoxes.voxel) overlayBoxes.voxel.checked = on;
}

export function setPlatformOverlay(on: boolean): void {
  showPlatforms = on;
  if (platformDebug) platformDebug.visible = on;
  if (overlayBoxes.platform) overlayBoxes.platform.checked = on;
}

// Spike 1 overlay: decompose the current collision into walkable platforms and
// draw one flat colored tile per cell, colored by platform (golden-ratio hues so
// neighbors are distinct). Rebuilt on scan swap or when a platform slider moves.
const platformTmp = new THREE.Object3D();
const platformColor = new THREE.Color();
export function rebuildPlatformOverlay(): void {
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
