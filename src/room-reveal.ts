// How a room arrives when its scan has loaded: in 3D, out of what the figurine was
// waiting in, instead of switching on. It is part of how the scan draws itself: each
// splat is drawn somewhere else, as a bit of paper, until it has arrived. Once the
// reveal is over every splat is drawn exactly as it would be without this file.
// See context/ui.md.

import * as THREE from 'three';
import type { GaussianSplat } from 'three/addons/objects/GaussianSplat.js';
import { cameraProjectionMatrix, cameraViewMatrix, cos, float, floor, Fn, hash, If, instanceIndex, mix, modelWorldMatrix, positionGeometry, screenSize, sin, smoothstep, uniform, varyingProperty, vec2, vec3, vec4 } from 'three/tsl';
import { splatInternals } from './splat-internals';
import { ARRANGE, BITS, LOOK, SHEET_CELL, bitShape, fieldPosition, rimFade, scrapColour, scrapTumble, sheetHeight, snowPosition } from './paper-bits';

/** The styles: their names for the Debug card, how the waiting bits look and are
 *  arranged, and `dense`: how many of the scan's points start as bits, per waiting bit
 *  (arrangements where many points share a place need more to fill it). */
export const REVEAL_STYLES = {
  sheet: { name: 'Flat sheet rises', look: LOOK.punch, arrange: ARRANGE.sheet, dense: 8 },   // dots lift off a rippling sheet into the room's shape, spreading out from the figurine
  snow: { name: 'Paper snowfall', look: LOOK.scrap, arrange: ARRANGE.snow, dense: 1 },       // falling scraps land and pile up into the room, floor first
  pages: { name: 'Turning pages', look: LOOK.punch, arrange: ARRANGE.pages, dense: 8 },      // the room lies flat in slices, which swing up one after another like pages
  confetti: { name: 'Paper confetti', look: LOOK.scrap, arrange: ARRANGE.field, dense: 1 },  // drifting scraps fly straight home
  unfold: { name: 'Unfold', look: LOOK.scrap, arrange: ARRANGE.field, dense: 1 },            // no journey: the room appears outward from the figurine, as paper that takes its colour
} as const;
export type RevealStyle = keyof typeof REVEAL_STYLES;

export const REVEAL: { style: RevealStyle; seconds: number } = { style: 'sheet', seconds: 3.6 };

/** The part of the reveal over which the waiting bits give way to the scan's own. */
export const HANDOVER = 0.15;

// lengths in figurine heights; `spread` is the part of the journey's time by which the last bit sets off after the first
const CONFETTI = { spread: 0.3 };
const SHEET = { spread: 0.6 };                                  // nearest the figurine first
const SNOW = { spread: 0.6, tall: 6, across: 0.55 };            // lowest first, over a room this tall · the part of its fall in which a scrap drifts over its place
const PAGES = { spread: 0.7, thick: 1.2, each: 0.12, rise: 0.02 }; // a slice this thick · each page this much later than the one before · a page lies this much above the one under it
const UNFOLD = {
  edge: 3,         // how deep the band is in which a splat goes from absent to settled
  halfway: 0.5,    // the part of the reveal the front takes to cross the room; the rest sweeps out to everything beyond it
};

const unfolding = uniform(0);                  // 1 for the unfold style, 0 for the journeys
const look = uniform(LOOK.scrap), arrange = uniform(ARRANGE.field);
const centre = uniform(new THREE.Vector3());   // where the figurine stood when the reveal began
const progress = uniform(1);                   // 0 → 1 over the whole reveal
const front = uniform(1e9);                    // unfold: how far out from `centre` the reveal has reached
const reach = uniform(1);                      // how far from `centre` the room itself extends
const edge = uniform(1), bodyHeight = uniform(1);
const bitShare = uniform(1);                   // the part of the scan's splats that are bits from the start
const paper = uniform(new THREE.Color()), accent = uniform(new THREE.Color()), ink = uniform(new THREE.Color());
const splatUv = varyingProperty('vec2', 'vSplatUv');           // GaussianSplat's own: where in the splat's quad (-2..2) this pixel is
const shown = varyingProperty('float', 'vRevealShown');        // how much of the splat is there: 0 none, 1 all
const settled = varyingProperty('float', 'vRevealSettled');    // 0 = paper, 1 = its own colour
const asBit = varyingProperty('float', 'vRevealAsBit');        // 1 = drawn as a bit of paper, 0 = drawn as the splat it is
const bitColour = varyingProperty('vec3', 'vRevealBitColour'); // what colour of paper it is meanwhile
const bitSeed = varyingProperty('float', 'vRevealBitSeed');    // which bit it is, for the shape of its cut
let splatCount = 1;

/** Give a splat object its arrival. Call once per splat, before anything else wraps its colour. */
export function installReveal(splat: GaussianSplat, count: number): void {
  const internals = splatInternals(splat);
  const order = internals._sort?.orderRead, centreRead = internals._buffers?.centerRead;
  const material = splat.material as unknown as { colorNode: any; needsUpdate: boolean };
  if (!order || !centreRead || !material.colorNode) { console.warn('room reveal: this GaussianSplat does not expose its centres and draw order — rooms will appear at once'); return; }
  splatCount = count;

  // per splat (vertex stage): how far along its arrival it is, and where and as what to draw it meanwhile
  const arriving = (base: unknown) => Fn(() => {
    const clip = vec4(base as any).toVar();
    const index = order.element(instanceIndex);
    const world = modelWorldMatrix.mul(vec4(centreRead.element(index).xyz, 1)).xyz.toVar();
    const place = world.sub(centre).toVar(); // where the splat belongs, as seen from the figurine
    const here = float(1).toVar(), own = float(1).toVar();
    const at = vec3(place).toVar();  // where it is drawn, as seen from the figurine
    const size = float(1).toVar();   // 1 = the splat itself, 0 = a bit of paper
    const tumble = scrapTumble(index);
    const isScrap = look.equal(LOOK.scrap);
    If(unfolding.greaterThan(0.5), () => {
      const a = front.sub(place.length()).div(edge).clamp(0, 1); // 0 ahead of the front, 1 once it is `edge` behind it
      here.assign(smoothstep(0, 0.35, a));
      own.assign(smoothstep(0.35, 1, a));
    }).Else(() => {
      // The journeys' own clock, once the hand-over is done. A variable of its own (toVar), and
      // it has to be: a value used in several branches below but only computed where it is
      // first used is unset in every other branch, and those rooms then never arrive.
      const travel = progress.sub(HANDOVER).div(1 - HANDOVER).toVar();
      const leg = (setOff: any, spread: number) => travel.sub(setOff.mul(spread)).div(1 - spread).clamp(0, 1); // one bit's journey, 0 → 1, setting off at `setOff` (0..1) of the spread
      const waiting = vec3(0).toVar();  // where it waits
      const home = float(0).toVar();    // 0 waiting, 1 in place
      If(arrange.equal(ARRANGE.sheet), () => {
        // straight down from its place onto the nearest dot of the sheet's grid; then it rises, the ones nearest the figurine first
        const cell = bodyHeight.mul(SHEET_CELL);
        const onGrid = place.xz.div(cell).round().mul(cell);
        waiting.assign(vec3(onGrid.x, sheetHeight(onGrid, bodyHeight), onGrid.y));
        home.assign(smoothstep(0, 1, leg(place.xz.length().div(reach).min(1), SHEET.spread)));
        at.assign(mix(waiting, place, home));
      });
      If(arrange.equal(ARRANGE.snow), () => {
        // it falls from wherever it is in the snowfall: across to above its place first, then down onto it, the lowest first
        waiting.assign(snowPosition(index, bodyHeight));
        const fall = leg(place.y.div(bodyHeight.mul(SNOW.tall)).clamp(0, 1), SNOW.spread);
        home.assign(fall.mul(fall)); // gathering speed, like anything falling
        at.assign(vec3(mix(waiting.xz, place.xz, smoothstep(0, SNOW.across, fall)), mix(waiting.y, place.y, home)).xzy);
      });
      If(arrange.equal(ARRANGE.pages), () => {
        // The room is cut into slices across; each lies flat on the floor, top away from
        // the figurine, like a page laid down. They swing up one after another, nearest first.
        const thick = bodyHeight.mul(PAGES.thick);
        const page = floor(place.z.div(thick));
        const away = page.greaterThanEqual(0).select(float(1), float(-1));
        const nth = page.add(0.5).abs();
        home.assign(smoothstep(0, 1, leg(nth.mul(PAGES.each).min(1), PAGES.spread)));
        const down = home.oneMinus().mul(Math.PI / 2); // how far it is laid over: a quarter turn when flat
        waiting.assign(vec3(place.x, nth.mul(PAGES.rise).mul(bodyHeight), place.z.add(place.y.mul(away))));
        at.assign(vec3(place.x, place.y.mul(cos(down)).add(nth.mul(PAGES.rise).mul(bodyHeight).mul(sin(down))), place.z.add(place.y.mul(sin(down)).mul(away))));
      });
      If(arrange.equal(ARRANGE.field), () => {
        // straight home from wherever it is in the drifting field, each setting off at its own moment
        waiting.assign(fieldPosition(index, bodyHeight));
        home.assign(smoothstep(0, 1, leg(hash(index.add(4)), CONFETTI.spread)));
        at.assign(mix(waiting, place, home));
      });
      size.assign(smoothstep(0.55, 1, home));
      own.assign(smoothstep(0.5, 0.95, home)); // paper for the first half of the way
      // Some of the splats are bits from the start. All of them would be a solid mass, so
      // the rest stay unseen until they are nearly home.
      const fromStart = smoothstep(0, HANDOVER, progress).mul(mix(rimFade(waiting, bodyHeight), 1, home));
      const nearlyHome = smoothstep(0.5, 0.95, home);
      here.assign(hash(index).lessThan(bitShare).select(mix(fromStart, 1, nearlyHome), nearlyHome));
    });
    shown.assign(here);
    settled.assign(own);
    asBit.assign(size.oneMinus());
    bitColour.assign(isScrap.select(scrapColour(index, tumble.faceUp, paper, accent, ink), paper));
    bitSeed.assign(float(index));
    // moving a splat in the world moves its clip-space position by the same offset, projected
    const toClip = cameraProjectionMatrix.mul(cameraViewMatrix);
    const moved = toClip.mul(vec4(at.sub(place), 0));
    clip.addAssign(moved);
    If(size.lessThan(1), () => {
      // A bit of paper: the splat's quad redrawn as a small square of fixed size on screen
      // around the splat's centre, whatever shape and size the splat really is.
      const middle = toClip.mul(vec4(world, 1)).add(moved).toVar();
      const corner = positionGeometry.xy.sign().toVar(); // which corner of the quad this is
      corner.x.mulAssign(isScrap.select(tumble.width, float(1)));
      const angle = isScrap.select(tumble.angle, float(0));
      const turned = vec2(corner.x.mul(cos(angle)).sub(corner.y.mul(sin(angle))), corner.x.mul(sin(angle)).add(corner.y.mul(cos(angle))));
      const offset = turned.mul(BITS.quadPx * 2).div(screenSize);
      clip.assign(mix(vec4(middle.xy.add(offset.mul(middle.w)), middle.zw), clip, size));
    });
    return clip;
  })();
  internals._precomputedSphericalHarmonicsVertexNode &&= arriving(internals._precomputedSphericalHarmonicsVertexNode);
  internals._sphericalHarmonicsVertexNode &&= arriving(internals._sphericalHarmonicsVertexNode);

  const base = material.colorNode; // vec4: the splat's colour and coverage
  material.colorNode = Fn(() => {
    const c = vec4(base).toVar();
    c.rgb.assign(mix(bitColour, c.rgb, settled));
    c.a.assign(mix(c.a, bitShape(look, splatUv, bitSeed.toUint()), asBit).mul(shown));
    return c;
  })();
  material.needsUpdate = true;
}

let elapsed = -1;  // seconds into the reveal; negative when none is running

/** How the waiting bits should look and be arranged for the style in use. */
export function waitingBits(): { look: number; arrange: number } {
  return REVEAL_STYLES[REVEAL.style];
}

/** Start the room arriving around `from`. `roomReach`: how far the room extends from there. */
export function startReveal(from: THREE.Vector3, roomReach: number, charH: number, colours: { paper: string; accent: string; ink: string }): void {
  centre.value.copy(from);
  edge.value = UNFOLD.edge * charH;
  bodyHeight.value = charH;
  reach.value = roomReach;
  paper.value.set(colours.paper); accent.value.set(colours.accent); ink.value.set(colours.ink);
  elapsed = 0;
  setProgress(0);
}

/** Advance the reveal. Returns how far along it is: 0 at the start, 1 when there is none running. */
export function updateReveal(dt: number): number {
  if (elapsed < 0) return 1;
  elapsed += dt;
  const t = Math.min(1, elapsed / REVEAL.seconds);
  if (t >= 1) elapsed = -1;
  setProgress(t);
  return t;
}

/** Draw the room complete, whatever the reveal is doing: for anything that must see the
 *  whole scan mid-reveal (the light probe). Returns the call that puts the reveal back. */
export function revealPaused(): () => void {
  const was = progress.value;
  setProgress(1);
  return () => setProgress(was);
}

function setProgress(t: number): void {
  const now = REVEAL_STYLES[REVEAL.style];
  progress.value = t;
  unfolding.value = REVEAL.style === 'unfold' ? 1 : 0;
  look.value = now.look;
  arrange.value = now.arrange;
  bitShare.value = Math.min(1, now.dense * BITS.count / splatCount);
  // Unfold: the front crosses the room in the first `halfway` of the time and then runs
  // away to infinity, so the room is paced by its own size while far-off floaters cannot
  // hold the end up.
  const k = t / UNFOLD.halfway;
  front.value = t >= 1 ? 1e9 : (reach.value + edge.value) * k / Math.max(1e-4, 2 - k);
}
