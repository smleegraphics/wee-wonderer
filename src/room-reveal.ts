// How a room arrives when its scan has loaded: in 3D, out of the sheet of paper dots the
// figurine was waiting on, instead of switching on. It is part of how the scan draws
// itself: each splat is drawn as a dot on the sheet until it lifts off and travels to
// its place, the ones nearest the figurine first. Once the reveal is over every splat is
// drawn exactly as it would be without this file. See context/ui.md.

import * as THREE from 'three';
import type { GaussianSplat } from 'three/addons/objects/GaussianSplat.js';
import { cameraProjectionMatrix, cameraViewMatrix, Fn, hash, If, instanceIndex, mix, modelWorldMatrix, positionGeometry, screenSize, smoothstep, uniform, varyingProperty, vec3, vec4 } from 'three/tsl';
import { splatInternals } from './splat-internals';
import { BITS, SHEET_CELL, dotShape, rimFade, sheetHeight } from './paper-bits';

export const REVEAL = { seconds: 3.6 };

/** The part of the reveal over which the waiting dots give way to the scan's own. */
export const HANDOVER = 0.15;

const RISE = {
  spread: 0.6,  // the part of the journey's time by which the farthest dot sets off after the nearest
  dense: 8,     // how many of the scan's points start as dots, per waiting dot: many share each place on the sheet, and it takes this many to fill it as they part
};

const centre = uniform(new THREE.Vector3());   // where the figurine stood when the reveal began
const progress = uniform(1);                   // 0 → 1 over the whole reveal
const reach = uniform(1);                      // how far from `centre` the room extends
const bodyHeight = uniform(1);
const dotShare = uniform(1);                   // the part of the scan's splats that are dots from the start
const paper = uniform(new THREE.Color());
const splatUv = varyingProperty('vec2', 'vSplatUv');           // GaussianSplat's own: where in the splat's quad (-2..2) this pixel is
const shown = varyingProperty('float', 'vRevealShown');        // how much of the splat is there: 0 none, 1 all
const settled = varyingProperty('float', 'vRevealSettled');    // 0 = paper, 1 = its own colour
const asDot = varyingProperty('float', 'vRevealAsDot');        // 1 = drawn as a paper dot, 0 = drawn as the splat it is

/** Give a splat object its arrival. Call once per splat, before anything else wraps its colour. */
export function installReveal(splat: GaussianSplat, count: number): void {
  const internals = splatInternals(splat);
  const order = internals._sort?.orderRead, centreRead = internals._buffers?.centerRead;
  const material = splat.material as unknown as { colorNode: any; needsUpdate: boolean };
  if (!order || !centreRead || !material.colorNode) { console.warn('room reveal: this GaussianSplat does not expose its centres and draw order — rooms will appear at once'); return; }
  dotShare.value = Math.min(1, RISE.dense * BITS.count / count);

  // per splat (vertex stage): how far along its arrival it is, and where and as what to draw it meanwhile
  const arriving = (base: unknown) => Fn(() => {
    const clip = vec4(base as any).toVar();
    const index = order.element(instanceIndex);
    const world = modelWorldMatrix.mul(vec4(centreRead.element(index).xyz, 1)).xyz.toVar();
    const place = world.sub(centre).toVar(); // where the splat belongs, as seen from the figurine
    // it waits straight down from its place, on the nearest dot of the sheet's grid
    const cell = bodyHeight.mul(SHEET_CELL);
    const onGrid = place.xz.div(cell).round().mul(cell);
    const waiting = vec3(onGrid.x, sheetHeight(onGrid, bodyHeight), onGrid.y).toVar();
    // its journey, 0 → 1, once the hand-over is done; the farther from the figurine, the later it sets off
    const setOff = place.xz.length().div(reach).min(1).mul(RISE.spread);
    const leg = progress.sub(HANDOVER).div(1 - HANDOVER).sub(setOff).div(1 - RISE.spread).clamp(0, 1);
    const home = smoothstep(0, 1, leg).toVar(); // 0 waiting, 1 in place
    const size = smoothstep(0.55, 1, home).toVar(); // 0 = a paper dot, 1 = the splat itself
    const nearlyHome = smoothstep(0.5, 0.95, home).toVar();
    // Some of the splats are dots from the start. All of them would be a solid mass, so
    // the rest stay unseen until they are nearly home.
    const fromStart = smoothstep(0, HANDOVER, progress).mul(mix(rimFade(waiting, bodyHeight), 1, home));
    shown.assign(hash(index).lessThan(dotShare).select(mix(fromStart, 1, nearlyHome), nearlyHome));
    settled.assign(nearlyHome); // paper for the first half of the way
    asDot.assign(size.oneMinus());
    // moving a splat in the world moves its clip-space position by the same offset, projected
    const toClip = cameraProjectionMatrix.mul(cameraViewMatrix);
    const moved = toClip.mul(vec4(mix(waiting, place, home).sub(place), 0));
    clip.addAssign(moved);
    If(size.lessThan(1), () => {
      // A paper dot: the splat's quad redrawn as a small square of fixed size on screen
      // around the splat's centre, whatever shape and size the splat really is.
      const middle = toClip.mul(vec4(world, 1)).add(moved).toVar();
      const offset = positionGeometry.xy.sign().mul(BITS.quadPx * 2).div(screenSize); // sign: which corner of the quad this is
      clip.assign(mix(vec4(middle.xy.add(offset.mul(middle.w)), middle.zw), clip, size));
    });
    return clip;
  })();
  internals._precomputedSphericalHarmonicsVertexNode &&= arriving(internals._precomputedSphericalHarmonicsVertexNode);
  internals._sphericalHarmonicsVertexNode &&= arriving(internals._sphericalHarmonicsVertexNode);

  const base = material.colorNode; // vec4: the splat's colour and coverage
  material.colorNode = Fn(() => {
    const c = vec4(base).toVar();
    c.rgb.assign(mix(paper, c.rgb, settled));
    c.a.assign(mix(c.a, dotShape(splatUv), asDot).mul(shown));
    return c;
  })();
  material.needsUpdate = true;
}

let elapsed = -1;  // seconds into the reveal; negative when none is running

/** Start the room arriving around `from`. `roomReach`: how far the room extends from there. */
export function startReveal(from: THREE.Vector3, roomReach: number, charH: number, paperColour: string): void {
  centre.value.copy(from);
  bodyHeight.value = charH;
  reach.value = roomReach;
  paper.value.set(paperColour);
  elapsed = 0;
  progress.value = 0;
}

/** Advance the reveal. Returns how far along it is: 0 at the start, 1 when there is none running. */
export function updateReveal(dt: number): number {
  if (elapsed < 0) return 1;
  elapsed += dt;
  const t = Math.min(1, elapsed / REVEAL.seconds);
  if (t >= 1) elapsed = -1;
  progress.value = t;
  return t;
}

/** Draw the room complete, whatever the reveal is doing: for anything that must see the
 *  whole scan mid-reveal (the light probe). Returns the call that puts the reveal back. */
export function revealPaused(): () => void {
  const was = progress.value;
  progress.value = 1;
  return () => { progress.value = was; };
}
