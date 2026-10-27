// Makes each character's picture for the Characters card (its `thumb` in characters.ts) from its
// model, through thumbs.html (src/dev-pages/character-thumbs.ts). Run it after adding or changing
// a character. Needs the dev server running.
//
//   node scripts/character-thumbs.mjs
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { APP_URL } from './app-url.mjs';

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(`${APP_URL}/thumbs.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__thumbs, undefined, { timeout: 60000 });
  for (const { thumb, dataUrl } of await page.evaluate(() => window.__thumbs)) {
    const file = path.join('public', thumb);
    fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log(`${file}: ${Math.round(fs.statSync(file).size / 1024)} KB`);
  }
} finally {
  await browser.close();
}
