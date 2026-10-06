// Regression check for climbing: random walking, jumping and climbing, sampling the
// rule that a climber is never inside something solid (window.__dbg.probe — see
// publishDebugState in src/main.ts). Needs the dev server running.
//
//   node scripts/climbfuzz.mjs [scan] [seconds] [seed] [loadWaitMs]
//   node scripts/climbfuzz.mjs counter-clean.ply 90 1
//
// Prints each violation with the climb events that led up to it, then a summary
// line, including how deep the climber's body sat in the mesh (`sunk`). Exits 1 if there were violations. Counter and Kitchen reach climbs from
// spawn; Playroom needs loadWaitMs ≈ 20000. Run a few seeds, a few at a time.
import { chromium } from 'playwright';

const scan = process.argv[2] ?? 'counter-clean.ply';
const seconds = Number(process.argv[3] ?? 90);
const seed0 = Number(process.argv[4] ?? 1);
const loadWait = Number(process.argv[5] ?? 4000);
const url = `http://localhost:5173/?scan=${scan}&tel=1`;

let seed = seed0;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296; // deterministic per seed

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const recent = []; // the last few climb events, for context on a violation
let errors = 0;
page.on('pageerror', (e) => { errors++; console.log('[pageerror]', e.message); });
page.on('console', (m) => {
  const t = m.text();
  if (t.startsWith('CLIMB')) { recent.push(t); if (recent.length > 6) recent.shift(); }
});
await page.goto(url, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__wwReady === true, { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(loadWait);
await page.mouse.click(640, 400);

let samples = 0, violations = 0, sunkSum = 0, sunkMax = 0, sunkDeep = 0;
const DEEP = 0.5; // radii: the body is half a capsule radius into something
const check = async () => {
  const d = await page.evaluate(() => window.__dbg);
  const p = d?.probe;
  if (!p) return; // not climbing
  samples++;
  if (typeof d.sunk === 'number') { sunkSum += d.sunk; sunkMax = Math.max(sunkMax, d.sunk); if (d.sunk > DEEP) sunkDeep++; }
  // `below` is not counted: flattening the floor leaves its top and underside
  // coincident, so a ray straight down can report either side of a floor it is above.
  if (![p.ahead, p.behind, p.above].some((v) => v.endsWith('B'))) return;
  violations++;
  console.log(`VIOLATION inside a solid: y=${d.py} cling=${d.cling} probe=${JSON.stringify(p)}\n   after: ${recent.join(' | ')}`);
};

const keys = ['KeyW', 'KeyA', 'KeyS', 'KeyD'];
const t0 = Date.now();
let held = [];
while (Date.now() - t0 < seconds * 1000) {
  for (const k of held) await page.keyboard.up(k);
  held = [keys[Math.floor(rnd() * 4)]];
  if (rnd() < 0.3) held.push(keys[Math.floor(rnd() * 4)]);
  if (rnd() < 0.5) held.push('ShiftLeft');
  for (const k of held) await page.keyboard.down(k);
  const hops = 2 + Math.floor(rnd() * 6);
  for (let i = 0; i < hops; i++) {
    if (rnd() < 0.7) await page.keyboard.press('Space');
    await page.waitForTimeout(200 + rnd() * 300);
    await check();
  }
}
console.log(`${scan} seed=${seed0}: ${samples} climb samples, ${violations} violations, ${errors} page errors | body sunk (radii): mean ${(samples ? sunkSum / samples : 0).toFixed(2)} max ${sunkMax.toFixed(2)}, ${sunkDeep} samples > ${DEEP}`);
await browser.close();
process.exit(violations || errors ? 1 : 0);
