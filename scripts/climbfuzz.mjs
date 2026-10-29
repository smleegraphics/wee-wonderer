// Regression check for climbing: random walking, jumping and climbing, sampling the
// rule that a climber is never inside something solid (window.__dbg.inside, chestInside in
// src/figurine/climb.ts; `probe` says which way the surfaces are). Needs the dev server running.
//
//   node scripts/climbfuzz.mjs [scan] [seconds] [seed]
//   node scripts/climbfuzz.mjs counter-crop.spz 90 1
//
// Prints each violation with the climb events that led up to it, then a summary
// line, including how deep the climber's body sat in the mesh (`sunk`). Exits 1 if there were violations. Counter and Kitchen reach climbs from
// spawn. Run a few seeds, a few at a time.
//
// A run repeats exactly: the same scan, seed and code take the same path and report the
// same. It starts once the room has arrived, and drives the figurine through
// window.__step (?tel=1), which moves it only for the time asked for, in fixed frames,
// whatever the frame rate. `seconds` is that game time, not the time the run takes. The
// frames are not drawn (__step's `draw` false): the same run, about 11 times faster.
import { chromium } from 'playwright';
import { APP_URL } from './app-url.mjs';

const scan = process.argv[2] ?? 'counter-crop.spz';
const seconds = Number(process.argv[3] ?? 90);
const seed0 = Number(process.argv[4] ?? 1);
const url = `${APP_URL}/?scan=${scan}&tel=1`;

let seed = seed0;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296; // deterministic per seed

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
// a fresh browser profile would open on the title screen, which takes the keyboard until Begin is pressed
await page.addInitScript(() => localStorage.setItem('ww.titleSeen', '1'));
const recent = []; // the last few climb events, for context on a violation
let errors = 0;
page.on('pageerror', (e) => { errors++; console.log('[pageerror]', e.message); });
page.on('console', (m) => {
  const t = m.text();
  if (t.startsWith('CLIMB')) { recent.push(t); if (recent.length > 6) recent.shift(); }
});
await page.goto(url, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__wwReady === true && window.__dbg?.reveal === 1, undefined, { timeout: 280000 }); // the room has arrived: it is still loading until then, and keys do nothing

let samples = 0, violations = 0, sunkSum = 0, sunkMax = 0, sunkDeep = 0;
const DEEP = 0.5; // radii: the body is half a capsule radius into something
const check = async () => {
  const d = await page.evaluate(() => window.__dbg);
  const p = d?.probe;
  if (!p) return; // not climbing
  samples++;
  if (typeof d.sunk === 'number') { sunkSum += d.sunk; sunkMax = Math.max(sunkMax, d.sunk); if (d.sunk > DEEP) sunkDeep++; }
  // Inside a solid: most of six rays from the chest meet a surface from behind (chestInside in
  // climb.ts, the rule the climb itself keeps). One ray was fooled by holes in a scan's mesh: a ray
  // through a hole in the wall ahead meets the far side of the object from behind.
  if (!d.inside) return;
  violations++;
  console.log(`VIOLATION inside a solid: at ${d.px}, ${d.py}, ${d.pz} cling=${d.cling} probe=${JSON.stringify(p)}\n   after: ${recent.join(' | ')}`);
};

const keys = ['KeyW', 'KeyA', 'KeyS', 'KeyD'];
let played = 0; // game seconds
while (played < seconds) {
  const held = [keys[Math.floor(rnd() * 4)]];
  if (rnd() < 0.3) held.push(keys[Math.floor(rnd() * 4)]);
  if (rnd() < 0.5) held.push('ShiftLeft');
  const hops = 2 + Math.floor(rnd() * 6);
  for (let i = 0; i < hops; i++) {
    const jump = rnd() < 0.7, wait = 0.2 + rnd() * 0.3;
    await page.evaluate(([k, s, j]) => window.__step(k, s, j, false), [held, wait, jump]);
    played += wait;
    await check();
  }
}
console.log(`${scan} seed=${seed0}: ${samples} climb samples, ${violations} violations, ${errors} page errors | body sunk (radii): mean ${(samples ? sunkSum / samples : 0).toFixed(2)} max ${sunkMax.toFixed(2)}, ${sunkDeep} samples > ${DEEP}`);
await browser.close();
process.exit(violations || errors ? 1 : 0);
