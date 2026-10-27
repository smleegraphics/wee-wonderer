// Filling the see-through ground the figurine can stand on with flat splats, and the
// switches for looking at the fill (context/splat-fill.md).

import * as THREE from 'three';
import { GaussianSplat } from 'three/addons/objects/GaussianSplat.js';
import type { WalkableFillOptions, Walkable } from './fill-scan-core';
import type { FilledScan } from './fill-scan.worker';
import { workerCaller } from '../worker-call';
import { scanBuffers, type ParsedScan } from './parse-scan';
import { splatInternals } from '../three-internals';
import { uniform, varying, float, instanceIndex, uint, Fn, vec4, mix } from 'three/tsl';
import { GRAIN, hud, MESHONLY, TEL } from '../app';
import { cellsPerGrain, navField, navStep, navVersion } from '../collision/room-collision';
import { requestScanLight } from '../lighting/scan-light';
import { currentFile, currentScan, currentSplat, disposeSplat, lastMatrix, lastOpacity, loadToken, showSplat } from './room';

// Sizes are in grains (GRAIN).
export const WALK_FILL = {
  on: true,
  cell: 0.5,     // spacing of the fill splats
  band: 1.5,     // the splats within this height of a walkable cell are the ones that draw its ground
  drop: 0.5,     // how far under those splats the fill lies
  patch: 40,     // fill only level ground of at least this area, in grains²: a tabletop, not the top of a toy...
  level: 0.25,   // ...where neighbouring walkable cells are level when the slope between them is within this
  under: 0.75,   // fill a spot when the scan's ground there is less opaque than this. At 0.9 the ordinary thin places in a well-captured floor are filled and show; at 0.5 the speckle in Kitchen's table is left
};
/** The size, in walkable cells, from which a surface is somewhere to be rather than a scrap: the
 *  level patch the fill starts at (WALK_FILL.patch). The collision health numbers and the room's
 *  shape for the game draw the same line. */
export const realCells = () => Math.round(WALK_FILL.patch * cellsPerGrain() ** 2);
export function walkFillOptions(): WalkableFillOptions {
  const { cell, band, drop, level, under } = WALK_FILL;
  return { cell: cell * GRAIN, band: band * GRAIN, drop: drop * GRAIN, patch: realCells(), level: level * navStep(), under };
}
/** Where the figurine can stand right now, for the fill; null if nowhere, or the scan is not being drawn (the mesh-only view). */
export function walkableNow(): Walkable | null {
  if (MESHONLY || !navField || !navField.platformId.length) return null;
  return { positions: navField.positions, platformId: navField.platformId, step: navField.sampleStep };
}
/** Say how a fill went: a warning if it could not be worked out (the scan is then shown without one), and the numbers under ?tel=1. */
export function reportWalkFill(id: string, filled: FilledScan, since: number): void {
  if (filled.failed) console.warn(`walkable fill: ${id} is shown without it — ${filled.failed}`);
  else if (TEL) console.log(`WALKFILL ${id}: ${filled.scan.centers.length / 3 - filled.own} splats added to ${filled.own} in ${(performance.now() - since).toFixed(0)}ms; ` +
    `${filled.seeThrough} of ${filled.cells} walkable cells were over half see-through`);
}
// How the fill is drawn, for looking at it (the Debug card). These are shader switches:
// nothing about the scan is rebuilt.
export const FILL_VIEW = {
  opacity: 1,        // how much of the fill splats' opacity is drawn
  highlight: false,  // draw them in FILL_TINT instead of their own colour
  only: false,       // hide the scan's own splats
};
const FILL_TINT = new THREE.Color(1, 0, 1);
const fillShown = uniform(1), fillTinted = uniform(0), scanShown = uniform(1);
export function applyFillView(): void {
  fillShown.value = WALK_FILL.on ? FILL_VIEW.opacity : 0;
  fillTinted.value = FILL_VIEW.highlight ? 1 : 0;
  scanShown.value = FILL_VIEW.only ? 0 : 1;
}
applyFillView();

export const fillScan = workerCaller<{ scan: ParsedScan; matrix: number[]; walk: Walkable; opts: WalkableFillOptions }, FilledScan>(
  new Worker(new URL('./fill-scan.worker.ts', import.meta.url), { type: 'module' }), 'walkable fill');

/** Let FILL_VIEW decide how the splats after the scan's first `own`, which are the fill, and the scan's own are drawn. */
export function installFillView(splat: GaussianSplat, own: number): void {
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
export async function refillWalkable(changed = false): Promise<void> {
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
