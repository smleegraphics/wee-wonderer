// Frame-by-frame capture of the game for videos and stills (CLAUDE.md, "Making media").
// The game is driven through window.__step (?tel=1): each step moves it exactly one
// 1/30 s frame, then the frame is screenshotted, so a video plays smoothly however long
// the capture takes and the same route gives the same frames every time. Runs Chrome on
// the real graphics card; needs the dev server running and the scans in scans/.

import { chromium } from 'playwright';
import { mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export const FPS = 30;
export const W = 1920, H = 1080;
const GPU_ARGS = ['--enable-gpu', '--use-angle=metal', '--enable-unsafe-webgpu'];
/** Seconds to let the camera settle after a turn. It eases into a drag over the next
 *  frames, and W runs toward where the camera faces: a run started mid-turn swerves. */
const TURN_SETTLE = 1.5;
const MOVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD'];

/** Stop with a message if ffmpeg is missing: every video here is made with it. */
export function needFfmpeg() {
  if (spawnSync('ffmpeg', ['-version']).status !== 0) { console.error('ffmpeg is needed (brew install ffmpeg)'); process.exit(1); }
}

/** Run ffmpeg with these arguments, quietly; throws if it fails. */
export function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')}`);
}

/**
 * Open `scan` in its own browser, ready to capture into `outDir` (emptied first).
 * `params`: more of the page address (`&meshonly=1`, a parked camera `&az=…`).
 * `title`: open as a first visit, with the title screen up (otherwise it is dismissed).
 */
export async function open(scan, { outDir, params = '', title = false } = {}) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: GPU_ARGS });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  if (!title) await page.addInitScript(() => localStorage.setItem('ww.titleSeen', '1'));
  page.on('pageerror', (e) => console.log(`[${scan}] page error:`, e.message));
  await page.goto(`http://localhost:5173/?scan=${scan}&tel=1${params}`, { waitUntil: 'load', timeout: 60000 });
  if (outDir) { rmSync(outDir, { recursive: true, force: true }); mkdirSync(outDir, { recursive: true }); }
  let n = 0;
  const step = (keys, seconds, jump = false) => page.evaluate(([k, s, j]) => window.__step(k, s, j), [keys, seconds, jump]);
  const s = {
    page, browser,
    frames: () => n,
    dbg: () => page.evaluate(() => window.__dbg),
    /** Wait until the room has arrived and the game is ready to step. */
    async ready() { await page.waitForFunction(() => window.__wwReady === true && window.__dbg?.reveal === 1, undefined, { timeout: 280000 }); },
    /** Screenshot the frame as it stands (after two animation frames, so it has been drawn). */
    async shot() {
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await page.screenshot({ path: `${outDir}/${String(n++).padStart(5, '0')}.jpg`, type: 'jpeg', quality: 92 });
    },
    /** Hold `keys` for `seconds`, a frame at a time, shooting each one (unless `capture` is false).
     *  `jump`: press jump on the first frame. `pan`: [dx, dy] of mouse drag spread over the frames;
     *  only while standing, since a pan with a movement key held steers the figurine. */
    async play(keys, seconds, { jump = false, capture = true, pan = null } = {}) {
      if (pan && keys.some((k) => MOVE_KEYS.includes(k))) throw new Error('pan with a movement key held steers the figurine');
      const count = Math.max(1, Math.round(seconds * FPS));
      if (pan) { await page.mouse.move(W / 2, H / 2); await page.mouse.down(); }
      for (let i = 0; i < count; i++) {
        if (pan) await page.mouse.move(W / 2 + (pan[0] * (i + 1)) / count, H / 2 + (pan[1] * (i + 1)) / count);
        await step(keys, 1 / FPS, jump && i === 0);
        if (capture) await s.shot();
      }
      if (pan) await page.mouse.up();
    },
    /** Turn the follow camera as a player dragging the mouse would, then let it settle (not shot). */
    async turn(dx, dy = 0) {
      await page.mouse.move(W / 2, H / 2);
      await page.mouse.down();
      for (let i = 1; i <= 12; i++) await page.mouse.move(W / 2 + (dx * i) / 12, H / 2 + (dy * i) / 12);
      await page.mouse.up();
      await s.play([], TURN_SETTLE, { capture: false });
    },
    /** Zoom the follow camera with the mouse wheel (negative: in), then let it settle. */
    async zoom(dy) { await page.mouse.move(W / 2, H / 2); await page.mouse.wheel(0, dy); await s.play([], TURN_SETTLE, { capture: false }); },
    /** Pause the game: from the first step on, it moves only when stepped. */
    async pause() { await step([], 1 / FPS); },
    /** Hide the on-screen UI (tiles, cards), for a picture of the room alone. */
    async hideUI() { await page.addStyleTag({ content: '.ww-ui { display: none !important; }' }); },
    /** Tick a Debug card checkbox by its label (works with the UI hidden). */
    async toggle(label) {
      await page.evaluate((name) => {
        const row = [...document.querySelectorAll('label')].find((l) => l.textContent.trim().startsWith(name));
        if (!row) throw new Error(`no Debug toggle "${name}"`);
        row.querySelector('input[type=checkbox]').click();
      }, label);
    },
    /** Set a Debug card slider by its label, as moving it by hand would. */
    async slider(label, v) {
      await page.evaluate(([name, v]) => {
        const el = document.querySelector(`input[aria-label="${name}"]`);
        if (!el) throw new Error(`no Debug slider "${name}"`);
        el.value = String(v); el.dispatchEvent(new Event('change'));
      }, [label, v]);
    },
    /** The next console line starting with `prefix` (start waiting before causing it). */
    console(prefix, timeout = 120000) { return page.waitForEvent('console', { predicate: (m) => m.text().startsWith(prefix), timeout }).then((m) => m.text()); },
    close: () => browser.close(),
  };
  return s;
}

/** Run `jobs` (functions returning promises) at most `limit` at a time: each opens its own browser,
 *  and more than three at once slows the graphics card for all of them (CLAUDE.md). */
export async function pool(jobs, limit = 3) {
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) { const i = next++; results[i] = await jobs[i](); }
  }));
  return results;
}

/** Encode a frames folder as a looping clip: the last half second fades into the first frame,
 *  so the loop does not jump. `width`: the clip's width (the height follows). */
export function encodeLoop(framesDir, frameCount, out, { width = 1600, crf = 22 } = {}) {
  const fade = 0.5, offset = (frameCount / FPS - fade).toFixed(3);
  ffmpeg(['-framerate', String(FPS), '-i', `${framesDir}/%05d.jpg`, '-loop', '1', '-framerate', String(FPS), '-t', String(fade), '-i', `${framesDir}/00000.jpg`,
    '-filter_complex', `[0]settb=1/${FPS},setpts=N/${FPS}/TB[a];[1]settb=1/${FPS},setpts=N/${FPS}/TB[b];[a][b]xfade=transition=fade:duration=${fade}:offset=${offset},scale=${width}:-2`,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', out]);
}
