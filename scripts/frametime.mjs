// How long a frame takes while the figurine walks and turns, per scan (context/frame-time.md).
// Runs Chrome on the machine's real graphics card, so the numbers are this machine's: compare
// runs on one machine, before and after a change. Needs the dev server running and the scans
// in public/.
//
//   node scripts/frametime.mjs [scan.ply ...] [--ratio 2] [--seconds 8]
//
// With no scans named, Kitchen and Playroom (the lightest and heaviest demo rooms).

import { chromium } from 'playwright';

const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : def; };
const ratio = flag('--ratio', 2), seconds = flag('--seconds', 8);
const named = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const scans = named.length ? named : ['kitchen-clean.ply', 'room2.ply'];

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu', '--use-angle=metal', '--enable-unsafe-webgpu'] });
try {
  for (const scan of scans) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: ratio });
    const page = await context.newPage();
    await page.addInitScript(() => localStorage.setItem('ww.titleSeen', '1'));
    await page.goto(`http://localhost:5173/?scan=${scan}&tel=1`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__wwReady === true && window.__dbg?.reveal === 1, undefined, { timeout: 280000 });
    await page.waitForTimeout(3000); // past the first frames after arrival
    const gpu = await page.evaluate(async () => { const a = await navigator.gpu?.requestAdapter(); return a ? `${a.info?.vendor} ${a.info?.architecture}` : 'no WebGPU adapter'; });
    await page.keyboard.down('KeyW'); await page.keyboard.down('KeyD'); // walk and turn: the camera moves every frame
    const ms = await page.evaluate((s) => new Promise((done) => {
      let frames = 0;
      const start = performance.now();
      const tick = (now) => { frames++; if (now - start < s * 1000) requestAnimationFrame(tick); else done((now - start) / frames); };
      requestAnimationFrame(tick);
    }), seconds);
    console.log(`${scan.padEnd(24)} ${ms.toFixed(1).padStart(6)} ms a frame  ${(1000 / ms).toFixed(0).padStart(3)} fps   (1440 × 900 at ratio ${ratio}, ${gpu})`);
    await context.close();
  }
} finally { await browser.close(); }
