// How sound each room's collision is as ground for a game, in numbers, and whether any
// of them has got worse than the saved baseline (context/collision.md). The measuring is
// in src/collision-health.ts, reached through window.__collisionHealth (?tel=1). Needs
// the dev server running and the demo scans in public/.
//
//   node scripts/collisioncheck.mjs [scan.ply ...]     compare with the baseline; exits 1 if a number got worse
//   node scripts/collisioncheck.mjs --save [scan ...]  make what is measured now the baseline
//   node scripts/collisioncheck.mjs --with fit=1 [...] try a setting: adds it to the page's address (the collision settings can
//                                                      all be given there: VOXEL_OPTS in src/main.ts). Compared, never saved.
//
// With no scans named, the four demo rooms and Marishka. Collision is seeded, so the numbers repeat
// exactly from run to run: any change is a change in the code or its settings.
//
// Before any room, the measuring itself is checked: it is run on a small made-up room
// whose every number is known by counting (selfTest below), and nothing is measured if
// one comes out wrong.

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASELINE = fileURLToPath(new URL('./collision-baseline.json', import.meta.url));
const args = process.argv.slice(2), save = args.includes('--save');
const trial = args.flatMap((a, i) => (args[i - 1] === '--with' ? [a] : [])); // settings to try, as key=value
if (save && trial.length) { console.log('--save and --with do not go together: a trial is not the baseline'); process.exit(1); }
const named = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--with');
const scans = named.length ? named : ['livingroom-clean.ply', 'counter-clean.ply', 'kitchen-clean.ply', 'room2.ply', 'Marishka-clean.ply']; // (Marishka: a dog on a blanket. Nothing in it is flat or hard-edged, which is what the rooms cannot test)

// What is shown, and what is guarded: `worse` is the direction that is a regression, and
// `slack` how far a number may move that way before it counts (shares are 0..1; offsets are voxels).
const METRICS = [
  { key: 'cells', label: 'walkable area (grains²)' }, // not guarded: clearing scraps lowers it, filling floor raises it
  { key: 'platforms', label: 'platforms' },
  { key: 'realPlatforms', label: 'real platforms' },
  { key: 'scrapShare', label: 'cells on small perches', share: true }, // not guarded: these are small tops of furniture, somewhere to climb to, not a defect (context/collision.md)
  { key: 'spawnShare', label: 'cells walkable from spawn', share: true, worse: 'down', slack: 0.01 },
  { key: 'jumpShare', label: '...and by jumping or dropping', share: true, worse: 'down', slack: 0.01 },
  { key: 'reachShare', label: '...and by climbing the mesh\'s faces', share: true, worse: 'down', slack: 0.01 },
  { key: 'reachBound', label: '...if every meeting had a face', share: true, worse: 'down', slack: 0.01 },
  { key: 'islands', label: 'real platforms no face could join', worse: 'up', slack: 0 },
  { key: 'climbSpots', label: 'area a climb can start from (grains²)', worse: 'down', slack: 20 },
  { key: 'holeShare', label: 'holes in the spawn surface', share: true, worse: 'up', slack: 0.01 },
  { key: 'edgeShare', label: 'spawn surface cells on an edge', share: true, worse: 'up', slack: 0.01 },
  { key: 'solidity', label: 'spawn surface fills its outline', share: true }, // shown, not guarded: it falls when the surface grows into a less regular shape, which is an improvement
  { key: 'roughness', label: 'spawn surface roughness (slope)', worse: 'up', slack: 0.01 },
  { key: 'triangles', label: 'triangles' },
  { key: 'pieces', label: 'mesh pieces' },
  { key: 'smallPieces', label: 'small mesh pieces' },
  { key: 'looseShare', label: 'triangles in small pieces', share: true, worse: 'up', slack: 0.005 },
  { key: 'bumpiness', label: 'mesh bumpiness', worse: 'up', slack: 0.005 },
  { key: 'offMedian', label: 'mesh to splats, median (grains)', worse: 'up', slack: 0.05 },
  { key: 'offP90', label: 'mesh to splats, 90th pct (grains)', worse: 'up', slack: 0.05 },
  { key: 'missedShare', label: 'opaque splats with no mesh near', share: true, worse: 'up', slack: 0.01 },
  { key: 'openShare', label: 'sight lines that meet no collision', share: true, worse: 'up', slack: 0.03 }, // the same solid meshed two ways reads up to 2% apart (the lookouts move with the walkable cells); a wall trimmed full of holes read 6 to 8% up
];
const show = (m, v) => (v === undefined ? '—' : m.share ? `${(100 * v).toFixed(1)}%` : Number.isInteger(v) ? v.toLocaleString() : v.toFixed(m.key === 'bumpiness' ? 3 : 2));

const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {};
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader'] });
const measured = {};
let failed = 0;

/** The measuring, run on a made-up room (voxel 1) where every answer can be counted by hand:
 *    surface 0: a 10 × 10 floor at y = 0 with a 2 × 2 hole in the middle (96 cells); the figurine starts on it
 *    surface 1: 3 cells at y = 2 along the floor's edge: too high to jump to (a jump rises 1), near enough to climb to, with a face to climb
 *    surface 3: the same along another edge, with no face: reached only if faces are not asked for
 *    surface 2: a 5 × 10 floor at y = 0, 21 cells away: too far to jump to (a level jump carries 4.7), and nothing to climb
 *    mesh: two separate triangles (and the two of the backstop plane)
 *    splats: one 1 voxel off the first triangle's centre, one 0.5 off the second's, one far from everything, one too faint to count */
async function selfTest(page) {
  const got = await page.evaluate(async () => {
    const { collisionHealth } = await import('/src/collision-health.ts');
    const pos = [], id = [];
    for (let x = 0; x < 10; x++) for (let z = 0; z < 10; z++) if (!(x >= 4 && x <= 5 && z >= 4 && z <= 5)) { pos.push(x, 0, z); id.push(0); }
    for (let z = 0; z < 3; z++) { pos.push(10, 2, z); id.push(1); }
    for (let x = 0; x < 3; x++) { pos.push(x, 2, -1); id.push(3); }
    for (let x = 30; x < 35; x++) for (let z = 0; z < 10; z++) { pos.push(x, 0, z); id.push(2); }
    return collisionHealth({
      walk: { positions: new Float32Array(pos), platformId: new Int32Array(id), platformCount: 4, sampleStep: 1 },
      mesh: { positions: [0, 0, 0, 3, 0, 0, 0, 0, 3, 19, 0, 19, 22, 0, 19, 19, 0, 22, -50, -1, -50, 50, -1, -50, 50, -1, 50, -50, -1, 50], index: [0, 1, 2, 3, 4, 5, 6, 7, 8, 6, 8, 9] },
      splats: { centers: [1, 1, 1, 20, 0.5, 20, 100, 100, 100, 1, 0, 1], opacity: [1, 1, 1, 0.05], count: 4, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
      spawn: [0, 0, 0], unit: 1, realCells: 40,
      move: { jumpVel: Math.sqrt(18), gravity: 9, runSpeed: 5, climbOver: 1 },
      climbable: (ax, ay, az, bx) => bx === 10, // only surface 1 has a face
      blocked: (ox, oy, oz, dx, dy) => dy > 0, eyeHeight: 1, // the upward half of all directions meets something
      climbStarts: (x, y, z, dx) => x === 9 && dx > 0.9, // a wall along the first floor's far edge: its 10 cells at x = 9
    });
  });
  const want = {
    cells: 152, platforms: 4, realPlatforms: 2, scrapShare: 6 / 152, spawnShare: 96 / 152, jumpShare: 96 / 152, reachShare: 99 / 152, reachBound: 102 / 152, islands: 1,
    climbSpots: 10, holeShare: 4 / 100, edgeShare: 44 / 96, solidity: 96 / 100, roughness: 0,
    triangles: 2, pieces: 2, smallPieces: 2, looseShare: 1, bumpiness: 0, offMedian: 1, offP90: 1, missedShare: 1 / 3, openShare: 0.5,
  };
  let wrong = 0;
  for (const [key, value] of Object.entries(want)) if (!(Math.abs(got[key] - value) < 1e-6)) { wrong++; console.log(`FAIL  self-test: ${key} is ${got[key]}, should be ${value}`); }
  for (const key of Object.keys(got)) if (!(key in want)) { wrong++; console.log(`FAIL  self-test: ${key} is measured but not checked`); }
  console.log(wrong ? '' : `self-test: all ${Object.keys(want).length} numbers right on the made-up room`);
  return wrong;
}

try {
  {
    const page = await browser.newPage();
    await page.addInitScript(() => localStorage.setItem('ww.titleSeen', '1'));
    await page.goto('http://localhost:5173/?scan=nope.ply', { waitUntil: 'load' }); // any page of the app will do: only its module server is used
    failed += await selfTest(page);
    await page.close();
  }
  for (const scan of failed ? [] : scans) {
    const page = await browser.newPage();
    page.on('pageerror', (e) => { failed++; console.log(`FAIL  ${scan}: page error — ${e.message}`); });
    await page.addInitScript(() => localStorage.setItem('ww.titleSeen', '1'));
    await page.goto(`http://localhost:5173/?scan=${scan}&tel=1${trial.map((t) => '&' + t).join('')}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__wwReady === true && window.__dbg?.reveal === 1, undefined, { timeout: 280000 });
    measured[scan] = await page.evaluate(() => window.__collisionHealth());
    await page.close();
    if (!measured[scan]) { failed++; console.log(`FAIL  ${scan}: no collision to measure`); }
  }
} finally { await browser.close(); }

const width = Math.max(...METRICS.map((m) => m.label.length));
console.log(`\n${''.padEnd(width)}  ${scans.map((s) => s.replace(/(-clean)?\.ply$/, '').padStart(12)).join('')}`);
for (const m of METRICS) console.log(`${m.label.padEnd(width)}  ${scans.map((s) => show(m, measured[s]?.[m.key]).padStart(12)).join('')}`);

if (save) {
  writeFileSync(BASELINE, JSON.stringify({ ...baseline, ...measured }, null, 2) + '\n');
  console.log(`\nsaved as the baseline: ${BASELINE}`);
} else {
  console.log('');
  for (const scan of scans) {
    const was = baseline[scan], now = measured[scan];
    if (!now) continue;
    if (!was) { console.log(`NOTE  ${scan}: not in the baseline (run with --save)`); continue; }
    for (const m of METRICS) {
      if (!m.worse) continue;
      const change = now[m.key] - was[m.key], bad = m.worse === 'up' ? change > m.slack : change < -m.slack, good = m.worse === 'up' ? change < -m.slack : change > m.slack;
      if (bad) { failed++; console.log(`FAIL  ${scan}: ${m.label} ${show(m, was[m.key])} → ${show(m, now[m.key])}`); }
      else if (good) console.log(`BETTER  ${scan}: ${m.label} ${show(m, was[m.key])} → ${show(m, now[m.key])}  (save it: --save)`);
    }
  }
  console.log(failed ? `\n${failed} FAILED` : '\nNOTHING WORSE');
}
process.exit(failed ? 1 : 0);
