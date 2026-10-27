// Headless screenshot of the running app, for visual feedback during dev.
// Drives the system Google Chrome (real WebGPU backend) via Playwright.
//
//   node scripts/shot.mjs [url] [outPath] [extraWaitMs]
//
// Optional camera query params the app understands (see FREECAM_OPTS in app.ts): az, el, dist.
// Example: node scripts/shot.mjs "http://localhost:5173/?az=1.2&el=0.3" shot.png (the default address is WW_URL, scripts/app-url.mjs)

import { chromium } from 'playwright';
import { APP_URL } from './app-url.mjs';

const url = process.argv[2] ?? `${APP_URL}/`;
const out = process.argv[3] ?? 'shot.png';
const extraWait = Number(process.argv[4] ?? 0);

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-swiftshader'], // WebGPU fallback if no HW adapter
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  page.on('console', (m) => console.log('[page]', m.type(), m.text()));
  // a fresh browser profile would open on the title screen, which takes the keyboard until Begin is pressed
  await page.addInitScript(() => localStorage.setItem('ww.titleSeen', '1'));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));

  await page.goto(url, { waitUntil: 'load', timeout: 15000 });
  await page
    .waitForFunction(() => window.__wwReady === true, undefined, { timeout: 10000 })
    .catch(() => console.log('[shot] __wwReady never set — capturing anyway'));
  if (extraWait) await page.waitForTimeout(extraWait);
  await page.waitForTimeout(300); // let a couple more frames land

  await page.screenshot({ path: out });
  console.log('[shot] saved', out);
} finally {
  await browser.close();
}
