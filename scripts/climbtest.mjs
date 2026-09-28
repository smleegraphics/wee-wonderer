// Drive the figurine into walls and trace the climb (window.__ww) to see whether
// it visibly ascends, tops out, clings, or falls.
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:5173/?scan=room2.ply';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('console', (m) => { const t = m.text(); if (t.startsWith('CLIMB')) console.log('  ', t); });
await page.goto(url, { waitUntil: 'load', timeout: 20000 });
await page.waitForFunction(() => window.__wwReady === true, { timeout: 15000 }).catch(() => {});
await page.mouse.click(640, 400);
const read = () => page.evaluate(() => window.__ww);

for (const key of ['KeyW', 'KeyS', 'KeyA', 'KeyD']) {
  await page.keyboard.down(key);
  let climbFrames = 0, clingFrames = 0, yStart = null, yTopInClimb = -1e9, sawClimb = false, wallSample = null;
  for (let i = 0; i < 40; i++) { // ~6s at 150ms
    await page.waitForTimeout(150);
    const w = await read();
    if (!w) continue;
    if (yStart === null) yStart = w.y;
    if (w.state === 'climb') {
      sawClimb = true; climbFrames++;
      if (w.y > yTopInClimb) yTopInClimb = w.y;
      if (w.cling) clingFrames++;
      if (!wallSample) wallSample = w.dbg;
    }
  }
  await page.keyboard.up(key);
  await page.waitForTimeout(200);
  const rise = sawClimb ? (yTopInClimb - yStart).toFixed(2) : '-';
  console.log(`${key}: climb=${sawClimb} climbFrames=${climbFrames} clingFrames=${clingFrames} riseDuringClimb=${rise} wall@trigger=${wallSample ?? '-'}`);
}
await browser.close();
