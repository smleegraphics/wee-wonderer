// Drive the app with keyboard input for controller verification.
//   node scripts/drive.mjs <url> <step> [step...]
// steps: down:KeyW  up:KeyW  press:Space  wait:1500  shot:/tmp/x.png
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:5173/';
const steps = process.argv.slice(3);

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  page.on('console', (m) => console.log('[page]', m.type(), m.text()));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(url, { waitUntil: 'load', timeout: 15000 });
  await page.waitForFunction(() => window.__wwReady === true, { timeout: 10000 }).catch(() => {});
  await page.mouse.click(640, 400); // focus so key events land

  for (const s of steps) {
    const i = s.indexOf(':');
    const op = s.slice(0, i);
    const arg = s.slice(i + 1);
    if (op === 'down') await page.keyboard.down(arg);
    else if (op === 'up') await page.keyboard.up(arg);
    else if (op === 'press') await page.keyboard.press(arg);
    else if (op === 'wait') await page.waitForTimeout(Number(arg));
    else if (op === 'drag') {
      const [dx, dy] = arg.split(',').map(Number);
      await page.mouse.move(640, 400);
      await page.mouse.down();
      for (let s = 1; s <= 10; s++) await page.mouse.move(640 + (dx * s) / 10, 400 + (dy * s) / 10);
      await page.mouse.up();
    } else if (op === 'click') {
      const [x, y] = arg.split(',').map(Number);
      await page.mouse.click(x, y);
    } else if (op === 'clickText') {
      await page.getByText(arg, { exact: true }).click();
    } else if (op === 'select') {
      await page.locator('select').selectOption(arg); // arg = option value (scan file)
    } else if (op === 'range') {
      const [nth, value] = arg.split('='); // "0=1.5" → nth range input, set value (fires change)
      await page.locator('input[type=range]').nth(Number(nth)).fill(value);
    } else if (op === 'file') {
      await page.setInputFiles('input[type=file]', arg); // arg = path to upload
      await page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur()); // release focus so keys land on window
    } else if (op === 'shot') { await page.screenshot({ path: arg }); console.log('[drive] shot', arg); }
  }
} finally {
  await browser.close();
}
