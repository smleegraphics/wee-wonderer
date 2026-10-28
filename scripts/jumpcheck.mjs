// Does the movement model (collision-health.ts's jumpArc: how high a jump rises and how far it
// carries) match the game? Real running jumps, made headless through window.__step, against the
// model itself, fed the same settings: a plain jump, and one with every air jump the
// figurine has made at the top of the one before (how the model assumes them). Exits 1 if a
// number is out by more than TOLERANCE. Needs the dev server running.
//
//   node scripts/jumpcheck.mjs [scan]       (default: Playroom, which has the most open floor to run on)
//
// Run it after changing how jumping works or the movement settings' defaults: what the
// collision health numbers and the game say can be reached rests on the model.

import { chromium } from 'playwright';
import { APP_URL } from './app-url.mjs';

const scan = process.argv[2] ?? 'room2.ply';
const TOLERANCE = 0.1; // a share of the model's number
const DT = 1 / 30;     // the frame __step moves in

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.addInitScript(() => localStorage.setItem('ww.titleSeen', '1'));
await page.goto(`${APP_URL}/?scan=${scan}&tel=1`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__wwReady === true && window.__dbg?.reveal === 1, undefined, { timeout: 280000 });

// The settings, the model's numbers for them, and the clearest straight line to run along from
// the start (the camera turned to look down it, since the keys move the way it looks).
const setup = await page.evaluate(async () => {
  const live = (p) => import(performance.getEntriesByType('resource').map((e) => e.name).find((u) => new URL(u).pathname === p));
  const app = await live('/src/app.ts'), ch = await live('/src/figurine/character.ts'), ctl = await live('/src/figurine/controller.ts');
  const mv = await live('/src/figurine/movement.ts'), rc = await live('/src/collision/room-collision.ts');
  const h = ch.charH, M = mv.MOVE, p = app.player.position.clone();
  const { jumpArc } = await import('/src/collision/collision-health.ts'); // the model itself, not a copy (it holds no state, so a fresh import is it)
  const model = (launches) => { // body heights: rise, and carry back down to take-off height
    const arc = jumpArc({ jumpVel: launches[0], airJumpVels: launches.slice(1), gravity: M.gravity, fallGravity: M.fallGravity, runSpeed: M.sprintSpeed, climbOver: 0 });
    return { rise: arc.rise, carry: arc.carry(0) };
  };
  // clear all the way up through the highest jump: something overhead in the air takes its speed
  const highest = model([mv.launchSpeed(M.jumpHeight), ...ctl.airJumpHeights().map((ah) => mv.launchSpeed(ah))]).rise + 1;
  let best = 0, dir = [1, 0];
  for (let k = 0; k < 32; k++) {
    const a = (k / 32) * Math.PI * 2, d = p.clone().set(Math.cos(a), 0, Math.sin(a)), o = p.clone();
    let clear = Infinity;
    const r = app.BODY.radius; // (the body's width, in body heights: rays along both its sides as well as its middle)
    for (const side of [-1, 0, 1])
      for (let up = 0.3; up <= highest + 1e-6; up += 0.35) {
        o.set(p.x - d.z * side * r * h, p.y + up * h, p.z + d.x * side * r * h);
        clear = Math.min(clear, rc.collision.rayDistance(o, d, 40 * h));
      }
    if (clear > best) { best = clear; dir = [d.x, d.z]; }
  }
  window.__aimRun = () => { // back to the start, the camera behind it looking down the line
    ch.resetToSpawn();
    app.orbitCamera.position.set(p.x - dir[0] * 3 * h, p.y + 1.2 * h, p.z - dir[1] * 3 * h);
    app.orbit.target.set(p.x, p.y + 0.5 * h, p.z);
    app.orbit.update();
  };
  const air = ctl.airJumpHeights().map((ah) => mv.launchSpeed(ah));
  return { h, clear: best / h, single: model([mv.launchSpeed(M.jumpHeight)]), double: model([mv.launchSpeed(M.jumpHeight), ...air]), airJumps: air.length };
});

/** A running jump from where the figurine stands: sprint to top speed, jump holding Space, an air
 *  jump at each top; the highest it rose and how far it went until back down to take-off height. */
async function runningJump(airJumps) {
  await page.evaluate(() => window.__aimRun());
  await page.evaluate(() => window.__step([], 1.2, false, false)); // the camera settles behind
  await page.evaluate(() => window.__step(['KeyW', 'ShiftLeft'], 1.5, false, false));
  const at = await page.evaluate(() => window.__dbg);
  const y0 = at.py;
  await page.evaluate(() => window.__step(['KeyW', 'ShiftLeft', 'Space'], 1 / 30, true, false));
  let top = y0, last = at, made = 0; const speeds = [];
  for (let t = 0; t < 4; t += DT) {
    const vyBefore = (await page.evaluate(() => window.__dbg)).vy;
    const press = made < airJumps && vyBefore <= 0; // at the top
    if (press) made++;
    await page.evaluate((p) => window.__step(['KeyW', 'ShiftLeft', 'Space'], 1 / 30, p, false), press);
    const d = await page.evaluate(() => window.__dbg);
    top = Math.max(top, d.py); speeds.push(d.speed);
    if (d.py <= y0 && t > 0.1) { // back down: where it crossed the take-off height, between the last two frames
      const f = (last.py - y0) / Math.max(1e-9, last.py - d.py);
      const x = last.px + (d.px - last.px) * f, z = last.pz + (d.pz - last.pz) * f;
      return { rise: (top - y0) / setup.h, carry: Math.hypot(x - at.px, z - at.pz) / setup.h, speed: at.speed, landed: d.state, air: t, speeds };
    }
    last = d;
  }
  return null;
}

let failed = 0;
const report = (name, got, want) => {
  if (!got) { failed++; console.log(`FAIL  ${name}: never came back down`); return; }
  for (const k of ['rise', 'carry']) {
    const off = Math.abs(got[k] - want[k]) / want[k];
    if (off > TOLERANCE) failed++;
    if (process.env.JUMP_DEBUG && k === 'carry') console.log(`   (took off at ${got.speed}, in the air ${got.air.toFixed(2)} s, speeds ${got.speeds.join(' ')})`);
    console.log(`${off > TOLERANCE ? 'FAIL' : 'ok  '}  ${name} ${k.padEnd(5)} ${got[k].toFixed(2)} body heights, model ${want[k].toFixed(2)} (${(100 * off).toFixed(0)}% off)`);
  }
};
console.log(`${scan}: running along ${setup.clear.toFixed(1)} body heights clear from the floor to above the highest jump; ${setup.airJumps} air jump(s)`);
if (setup.clear < 12) console.log('NOTE  less clear room than a run-up and a double jump take (about 12 body heights): a jump may hit something');
report('jump         ', await runningJump(0), setup.single);
if (setup.airJumps) report('jump+air jump', await runningJump(setup.airJumps), setup.double);
console.log(failed ? `\n${failed} FAILED` : '\nTHE MODEL MATCHES');
await browser.close();
process.exit(failed ? 1 : 0);
