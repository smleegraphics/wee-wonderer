// The paper bits the figurine waits among, and the arrangements they wait in. Each is
// one set of formulas, used twice: by the stand-in bits drawn before a scan has loaded
// (loading-scene.ts), and as where and what the scan's own points start out as when it
// arrives (room-reveal.ts). Being the same formulas is what makes the two read as one.

import { cos, float, floor, hash, mix, sin, smoothstep, time, vec2, vec3 } from 'three/tsl';

// lengths in figurine heights
export const BITS = {
  count: 7000,          // how many bits a waiting arrangement has, whoever is drawing it
  radius: 9,            // how far out from the figurine an arrangement spreads
  edge: 0.7,            // bits fade out from this fraction of the radius to the rim
  quadPx: 7,            // half the side, on screen, of the square each bit is drawn in
};

/** What a bit looks like. */
export const LOOK = { scrap: 0, punch: 1 } as const; // a tumbling cut scrap of paper · a crisp hole-punch disc

/** How the bits are arranged while they wait. */
export const ARRANGE = { field: 0, sheet: 1, snow: 2, pages: 3 } as const;

const FIELD = { low: -0.4, high: 3.4, wind: 0.22, bob: 0.14, bobRate: 1.3 }; // a shallow layer of dust drifting sideways
const SHEET = { ripple: 0.13, wave: 0.9, rate: 0.8 };                         // a flat sheet of dots: wave height · waves per body height (radians) · radians per second
const SNOW = { low: -0.6, tall: 7, fall: 0.9, sway: 0.35, swayRate: 1.1 };    // bits falling through a tall column: fall in heights per second
const PAGES = { count: 5, wide: 9, long: 6, fan: 0.5, rise: 0.04, flutter: 0.1, flutterRate: 1.2 }; // a loose stack of big flat pages: fan = radians between one page and the next

/** The side of one cell of the sheet's grid: the grid that fits BITS.count dots into the arrangement's span. */
export const SHEET_CELL = (2 * BITS.radius) / Math.ceil(Math.sqrt(BITS.count));

// A bit is drawn in a square that runs from -2 to 2 each way (a splat's own quad), of
// which only a disc of radius 2 can be drawn on (the splat throws the corners away).
const SHAPE = {
  cut: 1.2,             // scrap: half its side. punch: its radius
  skew: 0.4,            // scrap: how far from square a cut may lean, so no two are the same quadrilateral
};
/** The radius, on screen, of a hole-punch dot: for anything else drawn in the same dots. */
export const PUNCH_PX = BITS.quadPx * SHAPE.cut / 2;
const TUMBLE = {
  spin: 1.4,            // radians per second, either way: turning flat, like a leaf
  flip: 2.2,            // radians per second: turning over
  thin: 0.18,           // how narrow a scrap gets edge-on, as a part of its width (never to nothing)
};
const PALETTE = { accent: 0.1, ink: 0.07, underside: 0.22 }; // shares of scraps in each colour · how much darker a scrap's underside is

/** The drifting field: where bit `seed` (an unsigned integer node) is, relative to the figurine. */
export function fieldPosition(seed: any, bodyHeight: any): any {
  const h1 = hash(seed.add(1)), h2 = hash(seed.add(2)), h3 = hash(seed.add(3));
  const span = BITS.radius * 2;
  // the wind carries each bit across and back in at the far side; rimFade hides the jump
  const x = h1.mul(span).add(time.mul(FIELD.wind)).mod(span).sub(BITS.radius);
  const z = h2.mul(span).sub(BITS.radius);
  const y = mix(FIELD.low, FIELD.high, h3).add(sin(time.mul(FIELD.bobRate).add(h1.mul(Math.PI * 2))).mul(FIELD.bob));
  return vec3(x, y, z).mul(bodyHeight);
}

/** The snowfall: where bit `seed` is, relative to the figurine. Each falls the column and starts again at the top. */
export function snowPosition(seed: any, bodyHeight: any): any {
  const h1 = hash(seed.add(1)), h2 = hash(seed.add(2)), h3 = hash(seed.add(3));
  const x = h1.mul(2).sub(1).mul(BITS.radius).add(sin(time.mul(SNOW.swayRate).add(h2.mul(Math.PI * 2))).mul(SNOW.sway));
  const z = h2.mul(2).sub(1).mul(BITS.radius);
  const fallen = time.mul(SNOW.fall).mul(h1.mul(0.8).add(0.6)); // no two fall at quite the same speed
  const y = h3.mul(SNOW.tall).sub(fallen).mod(SNOW.tall).add(SNOW.low);
  return vec3(x, y, z).mul(bodyHeight);
}

/** The sheet: how high it is at `xz` (relative to the figurine) as it ripples. */
export function sheetHeight(xz: any, bodyHeight: any): any {
  const at = xz.div(bodyHeight).mul(SHEET.wave), beat = time.mul(SHEET.rate);
  return sin(at.x.add(beat)).mul(cos(at.y.mul(0.7).add(beat.mul(0.7)))).mul(SHEET.ripple).mul(bodyHeight);
}

/** The sheet: where stand-in dot number `n` (a float node, 0..BITS.count) sits on its grid. */
export function sheetPosition(n: any, bodyHeight: any): any {
  const perRow = Math.ceil(Math.sqrt(BITS.count));
  const xz = vec2(n.mod(perRow), floor(n.div(perRow))).sub(perRow / 2).mul(SHEET_CELL).mul(bodyHeight);
  return vec3(xz.x, sheetHeight(xz, bodyHeight), xz.y);
}

/** The pages: where stand-in dot number `n` lies, on one of a loose stack of pages whose far edges lift a little. */
export function pagesPosition(n: any, seed: any, bodyHeight: any): any {
  const page = n.mod(PAGES.count);
  const across = hash(seed.add(1)).sub(0.5).mul(PAGES.wide), along = hash(seed.add(2)).mul(PAGES.long);
  const yaw = page.sub((PAGES.count - 1) / 2).mul(PAGES.fan);
  const x = across.mul(cos(yaw)).add(along.mul(sin(yaw))), z = along.mul(cos(yaw)).sub(across.mul(sin(yaw)));
  const lift = sin(time.mul(PAGES.flutterRate).add(page)).mul(0.5).add(0.5).mul(PAGES.flutter).mul(along.div(PAGES.long).pow(2));
  return vec3(x, page.mul(PAGES.rise).add(lift), z).mul(bodyHeight);
}

/** How visible a waiting bit at `position` (relative to the figurine) is: 1 in the middle, 0 at the rim. */
export function rimFade(position: any, bodyHeight: any): any {
  const rim = bodyHeight.mul(BITS.radius);
  return smoothstep(rim, rim.mul(BITS.edge), position.xz.length());
}

/** How scrap `seed` is turned right now: `angle` flat on the screen, `width` as a part
 *  of its full width (it narrows as it turns over), `faceUp` which side is showing. */
export function scrapTumble(seed: any): { angle: any; width: any; faceUp: any } {
  const h5 = hash(seed.add(5)), h6 = hash(seed.add(6));
  const over = cos(time.mul(TUMBLE.flip).mul(h6.add(0.5)).add(h5.mul(Math.PI * 2)));
  return {
    angle: h5.mul(Math.PI * 2).add(time.mul(mix(-TUMBLE.spin, TUMBLE.spin, h6))),
    width: over.abs().max(TUMBLE.thin),
    faceUp: over.greaterThanEqual(0),
  };
}

/** Scrap `seed`'s colour: mostly paper, a few in the accent and the ink, darker on the underside. */
export function scrapColour(seed: any, faceUp: any, paper: any, accent: any, ink: any): any {
  const pick = hash(seed.add(7));
  const face = pick.lessThan(PALETTE.accent).select(accent, pick.lessThan(PALETTE.accent + PALETTE.ink).select(ink, paper));
  return mix(face, ink, faceUp.select(float(0), float(PALETTE.underside)));
}

/** How much of a bit covers the point `q` of its square (-2..2 each way), for each look. */
export function bitShape(look: any, q: any, seed: any): any {
  const lean = vec2(hash(seed.add(8)), hash(seed.add(9))).sub(0.5).mul(2 * SHAPE.skew);
  const scrap = q.x.add(lean.x.mul(q.y)).abs().lessThan(SHAPE.cut).and(q.y.add(lean.y.mul(q.x)).abs().lessThan(SHAPE.cut)).select(float(1), float(0));
  const punch = q.length().lessThan(SHAPE.cut).select(float(1), float(0));
  return look.equal(LOOK.scrap).select(scrap, punch);
}
