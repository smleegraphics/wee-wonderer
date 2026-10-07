// Behaviour checks for the on-screen UI and the loading view (context/ui.md), headless
// in the system Chrome. Needs the dev server running and the demo scans in public/.
//
//   node scripts/uicheck.mjs [baseUrl]
//
// Prints PASS/FAIL per check and exits non-zero if any failed. Each wait is for the
// thing being checked (with a time limit), not a fixed sleep: headless frames are slow
// and uneven, and a fixed sleep fails at random.

import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:5173/';
const FIRST = { file: 'kitchen-clean.ply', label: 'Kitchen' }, SECOND = { file: 'counter-clean.ply', label: 'Counter' };
const LOAD_MS = 90000, SOON_MS = 5000;

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader'] });
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => { failed++; console.log('FAIL  page error —', e.message); });
  const dbg = () => page.evaluate(() => window.__dbg);
  const pos = async () => { const d = await dbg(); return [d.px, d.py, d.pz].join(','); };
  /** Wait until `fn` (run in the page) is true; false if it is not within `ms`. */
  const soon = (fn, arg, ms = SOON_MS) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);
  const loading = () => page.evaluate(() => document.querySelector('.ww-loading').dataset.on);
  const loaded = () => soon(() => document.querySelector('.ww-loading').dataset.on === 'false', null, LOAD_MS);
  const arrived = () => soon(() => window.__dbg?.reveal === 1, null, LOAD_MS);
  const progress = () => page.evaluate(() => Number(document.querySelector('.ww-progress').getAttribute('aria-valuenow')));

  // --- first visit: the loading view, then the title holds the keyboard
  await page.goto(`${base}?scan=${FIRST.file}&tel=1`, { waitUntil: 'load' });
  check('the loading view is up from the start', await soon(() => window.__dbg !== undefined, null, LOAD_MS) && (await loading()) === 'true' && (await dbg()).reveal === 0);
  check('the loading view ends once the room is built', await loaded() && logs.some((l) => l.startsWith('collision')));
  check('the progress bar ends full', (await progress()) === 100, `${await progress()}%`);
  check('the room arrives gradually', (await dbg()).reveal < 1 && await arrived());
  check('the title shows on a first visit', await page.evaluate(() => !document.querySelector('.ww-title').hidden));
  await page.mouse.click(200, 200); // the title's backdrop, away from Begin
  const spawn = await pos();
  await page.keyboard.down('KeyW'); await page.waitForTimeout(700); await page.keyboard.up('KeyW');
  check('W does nothing while the title is up', (await pos()) === spawn, `${spawn} -> ${await pos()}`);
  await page.getByRole('button', { name: 'Begin' }).click();
  check('Begin closes the title and remembers it', await page.evaluate(() => document.querySelector('.ww-title').hidden && localStorage.getItem('ww.titleSeen') === '1'));
  await page.keyboard.down('KeyW');
  const walked = await soon((p) => [window.__dbg.px, window.__dbg.py, window.__dbg.pz].join(',') !== p, spawn);
  await page.keyboard.up('KeyW');
  check('W walks after Begin, with no extra click', walked, `${spawn} -> ${await pos()}`);

  // --- a control clicked with the mouse does not keep the keyboard
  await page.getByRole('button', { name: 'Back to the start' }).click();
  check('Back to the start returns to the spawn point', await soon((p) => [window.__dbg.px, window.__dbg.py, window.__dbg.pz].join(',') === p, spawn), await pos());
  await page.keyboard.press('Space');
  check('Space jumps after clicking a tile', await soon(() => window.__dbg.state === 'jump_start' || window.__dbg.state === 'air'), `state=${(await dbg()).state}`);
  await soon(() => window.__dbg.state === 'ground');

  // --- the Debug card
  await page.keyboard.press('Backquote');
  check('` opens Debug', await page.evaluate(() => !document.querySelector('.ww-debug').hidden));
  await page.evaluate(() => document.querySelectorAll('.ww-debug details').forEach((d) => { d.open = true; }));
  await page.getByText('Voxel wireframe (V)', { exact: true }).hover();
  const helpShown = await soon(() => document.querySelector('.ww-debug-help [data-on]').textContent.startsWith('Draw the collision mesh'));
  const help = await page.evaluate(() => { const r = document.querySelector('.ww-debug-help').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, window: innerHeight }; });
  check('help for the top control is on screen with every section open', helpShown && help.top >= 0 && help.bottom <= help.window, JSON.stringify(help));
  await page.getByLabel('Voxel wireframe (V)', { exact: true }).check();
  await page.keyboard.press('KeyV');
  check('the V key unticks the wireframe box', !(await page.getByLabel('Voxel wireframe (V)', { exact: true }).isChecked()));
  const builds = logs.filter((l) => l.startsWith('collision')).length;
  await page.getByLabel('Isovalue (fill)', { exact: true }).evaluate((el) => { el.value = '0.4'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
  const rebuiltBy = Date.now() + LOAD_MS;
  while (logs.filter((l) => l.startsWith('collision')).length === builds && Date.now() < rebuiltBy) await page.waitForTimeout(100);
  check('a collision slider rebuilds collision', logs.filter((l) => l.startsWith('collision')).length > builds);
  await page.keyboard.press('Escape');
  check('Escape folds the card', await page.evaluate(() => document.querySelector('.ww-debug').hidden));

  // --- switching rooms: the old one leaves gradually, the new one arrives
  await page.getByRole('button', { name: 'Rooms', exact: true }).click();
  await page.locator('.ww-rooms').getByRole('button', { name: SECOND.label, exact: true }).click();
  const leaving = await soon(() => window.__dbg.reveal > 0 && window.__dbg.reveal < 1);
  check('the old room leaves gradually, with the loading note up', leaving && (await loading()) === 'true', `reveal=${(await dbg()).reveal}`);
  await page.keyboard.press('Backquote');
  check('` opens Debug while a room loads', await page.evaluate(() => !document.querySelector('.ww-debug').hidden));
  await page.keyboard.press('Escape');
  check(`${SECOND.label} loads and arrives`, await loaded() && await arrived() && logs.some((l) => l.startsWith(`loaded ${SECOND.file}`)));
  await page.getByRole('button', { name: 'Rooms', exact: true }).click();
  check(`${SECOND.label} is marked current`, await page.evaluate(() => [...document.querySelectorAll('.ww-rooms [aria-current="true"]')].map((b) => b.textContent).join()) === SECOND.label);

  // --- picking a second room before the first has loaded: only the last one arrives
  const loadedLogs = () => logs.filter((l) => l.startsWith('loaded '));
  const loadedBefore = loadedLogs().length;
  await page.locator('.ww-rooms').getByRole('button', { name: FIRST.label, exact: true }).click();
  await page.getByRole('button', { name: 'Rooms', exact: true }).click();
  await page.locator('.ww-rooms').getByRole('button', { name: SECOND.label, exact: true }).click();
  const settled = await loaded() && await arrived();
  const since = loadedLogs().slice(loadedBefore).map((l) => l.split(':')[0]);
  check('of two rooms picked in a row, only the last loads', settled && since.join() === `loaded ${SECOND.file}`, since.join(' | '));

  // --- a load that fails says so and does not leave the loading view up
  await page.goto(`${base}?scan=nope.ply`, { waitUntil: 'load' });
  const failedLoad = await soon(() => document.querySelector('.ww-status').dataset.kind === 'error' && document.querySelector('.ww-loading').dataset.on === 'false', null, LOAD_MS);
  check('a missing scan shows an error and ends the loading view', failedLoad, await page.evaluate(() => document.querySelector('.ww-status').textContent.slice(0, 80)));
  check('the title is not shown a second time', await page.evaluate(() => document.querySelector('.ww-title').hidden));
} finally { await browser.close(); }
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
