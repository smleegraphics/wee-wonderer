// The paper dots the figurine waits among: a flat, rippling sheet of hole-punch dots.
// One set of formulas, used twice: by the stand-in dots drawn before a scan has loaded
// (loading-scene.ts), and as where and what the scan's own points start out as when it
// arrives (room-reveal.ts). Being the same formulas is what makes the two read as one.

import { cos, float, floor, sin, smoothstep, time, vec2, vec3 } from 'three/tsl';

// lengths in figurine heights
export const BITS = {
  count: 7000,          // how many dots the sheet has, whoever is drawing it
  radius: 9,            // how far out from the figurine the sheet spreads
  edge: 0.7,            // dots fade out from this fraction of the radius to the rim
  quadPx: 7,            // half the side, on screen, of the square each dot is drawn in
};

const SHEET = { ripple: 0.13, wave: 0.9, rate: 0.8 }; // wave height · waves per body height (radians) · radians per second

/** The side of one cell of the sheet's grid: the grid that fits BITS.count dots into the sheet's span. */
export const SHEET_CELL = (2 * BITS.radius) / Math.ceil(Math.sqrt(BITS.count));

// A dot is drawn in a square that runs from -2 to 2 each way (a splat's own quad), of
// which only a disc of radius 2 can be drawn on (the splat throws the corners away).
const PUNCH = 1.2; // the dot's radius in that square

/** The radius, on screen, of a dot: for anything else drawn in the same dots. */
export const PUNCH_PX = BITS.quadPx * PUNCH / 2;

/** How high the sheet is at `xz` (relative to the figurine) as it ripples. */
export function sheetHeight(xz: any, bodyHeight: any): any {
  const at = xz.div(bodyHeight).mul(SHEET.wave), beat = time.mul(SHEET.rate);
  return sin(at.x.add(beat)).mul(cos(at.y.mul(0.7).add(beat.mul(0.7)))).mul(SHEET.ripple).mul(bodyHeight);
}

/** Where stand-in dot number `n` (a float node, 0..BITS.count) sits on the sheet's grid. */
export function sheetPosition(n: any, bodyHeight: any): any {
  const perRow = Math.ceil(Math.sqrt(BITS.count));
  const xz = vec2(n.mod(perRow), floor(n.div(perRow))).sub(perRow / 2).mul(SHEET_CELL).mul(bodyHeight);
  return vec3(xz.x, sheetHeight(xz, bodyHeight), xz.y);
}

/** How visible a waiting dot at `position` (relative to the figurine) is: 1 in the middle, 0 at the rim. */
export function rimFade(position: any, bodyHeight: any): any {
  const rim = bodyHeight.mul(BITS.radius);
  return smoothstep(rim, rim.mul(BITS.edge), position.xz.length());
}

/** How much of a dot covers the point `q` of its square (-2..2 each way). */
export function dotShape(q: any): any {
  return q.length().lessThan(PUNCH).select(float(1), float(0));
}
