// How much of the view is see-through, and what lies behind the gaps. For 16 fixed
// cameras inside the room, the scan is shot over two backdrops (the difference gives
// each pixel's opacity), with the gap fill off and on, then the collision mesh is shot
// solid, with and without its backstop plane. A pixel where the scan is under half
// opaque is a hole, and is counted by what is behind it: the mesh, only the backstop
// plane (floor level), or nothing. Uses window.__matte (telemetry.ts, ?tel=1).
//
//   node scripts/holes.mjs <scan.ply> [outDir]
//
// With outDir, three images are saved per view: -raw (fill on, over magenta), and -off
// and -on with the holes tinted red (mesh behind), yellow (plane only) or blue (nothing).

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const scan = process.argv[2] ?? 'room2.ply';
const outDir = process.argv[3];
if (outDir) mkdirSync(outDir, { recursive: true });

const A = [1, 0, 1], B = [0, 1, 0];
const views = [];
for (const el of [0.15, 0.6]) for (let i = 0; i < 8; i++) views.push({ az: (i * Math.PI) / 4, el, dist: 0.35, cx: 0, cy: 0.6, cz: 0 });

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 600 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.addInitScript(() => localStorage.setItem('ww.titleSeen', '1'));
  await page.goto(`http://localhost:5173/?scan=${scan}&tel=1&az=0`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__wwReady === true && window.__dbg?.reveal === 1, undefined, { timeout: 280000 });
  await page.addStyleTag({ content: 'body *{visibility:hidden!important} canvas{visibility:visible!important}' });
  await page.waitForTimeout(1500);

  const shot = async (mode, bg, cam, fill) => {
    await page.evaluate((h) => { window.__matte = h; }, { mode, bg, cam, fill });
    await page.waitForTimeout(450); // camera applies a frame late; the splats re-sort
    return (await page.screenshot()).toString('base64');
  };

  const total = { n: 0, off: {}, on: {} };
  for (const [vi, cam] of views.entries()) {
    const imgs = [
      await shot('splat', A, cam, 0), await shot('splat', B, cam, 0),
      await shot('splat', A, cam, 1), await shot('splat', B, cam, 1),
      await shot('mesh', A, cam, 1), await shot('mesh', B, cam, 1),
      await shot('meshNoPlane', A, cam, 1), await shot('meshNoPlane', B, cam, 1),
    ];
    const r = await page.evaluate(async ({ imgs, wantImage }) => {
      const load = async (b64) => {
        const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
        const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d');
        g.drawImage(bmp, 0, 0);
        return g.getImageData(0, 0, bmp.width, bmp.height);
      };
      const [oa, ob, fa, fb, ma, mb, na, nb] = await Promise.all(imgs.map(load));
      const n = oa.width * oa.height;
      const diff = (p, q, i) => (Math.abs(p.data[i] - q.data[i]) + Math.abs(p.data[i + 1] - q.data[i + 1]) + Math.abs(p.data[i + 2] - q.data[i + 2])) / 3;
      // the two backdrops differ by `full` where nothing is drawn (taken from the mesh shots)
      let full = 0;
      for (let p = 0; p < n; p++) full = Math.max(full, diff(na, nb, p * 4));
      if (full < 200) return { skip: true }; // the camera is inside something solid
      const tally = (sa, sb, wantImage) => {
        const bins = {}, out = wantImage ? new ImageData(sa.width, sa.height) : null;
        for (let p = 0; p < n; p++) {
          const i = p * 4;
          const alpha = 1 - Math.min(1, diff(sa, sb, i) / full);
          const mesh = diff(na, nb, i) < full * 0.5, plane = diff(ma, mb, i) < full * 0.5;
          const a = alpha < 0.2 ? 'a<.2' : alpha < 0.5 ? 'a.2-.5' : alpha < 0.8 ? 'a.5-.8' : 'a>.8';
          const m = mesh ? 'mesh' : plane ? 'plane' : 'none';
          bins[`${a}|${m}`] = (bins[`${a}|${m}`] ?? 0) + 1;
          if (out) {
            // the splats over black; holes tinted red where the mesh covers them, yellow for the plane only, blue for nothing
            const t = 1 - alpha, k = mesh ? [255, 40, 40] : plane ? [255, 220, 0] : [40, 90, 255];
            for (let ch = 0; ch < 3; ch++) out.data[i + ch] = Math.min(sa.data[i + ch], sb.data[i + ch]) * alpha + k[ch] * t;
            out.data[i + 3] = 255;
          }
        }
        return { bins, out };
      };
      const png = async (out) => {
        const c = new OffscreenCanvas(out.width, out.height);
        c.getContext('2d').putImageData(out, 0, 0);
        const buf = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
        let s = ''; for (let j = 0; j < buf.length; j += 0x8000) s += String.fromCharCode(...buf.subarray(j, j + 0x8000));
        return btoa(s);
      };
      const off = tally(oa, ob, wantImage), on = tally(fa, fb, wantImage);
      return { n, off: off.bins, on: on.bins, offPng: off.out && await png(off.out), onPng: on.out && await png(on.out) };
    }, { imgs, wantImage: !!outDir });
    if (r.skip) { console.log(`v${vi} skipped: camera inside something solid`); continue; }
    const name = `${outDir}/${scan.replace('.ply', '')}-v${vi}`;
    if (r.offPng) { writeFileSync(`${name}-off.png`, Buffer.from(r.offPng, 'base64')); writeFileSync(`${name}-on.png`, Buffer.from(r.onPng, 'base64')); writeFileSync(`${name}-raw.png`, Buffer.from(imgs[2], 'base64')); }
    total.n += r.n;
    for (const w of ['off', 'on']) for (const [k, v] of Object.entries(r[w])) total[w][k] = (total[w][k] ?? 0) + v;
  }
  const hole = (bins, m) => (100 * ((bins[`a<.2|${m}`] ?? 0) + (bins[`a.2-.5|${m}`] ?? 0)) / total.n).toFixed(1).padStart(5);
  console.log(`\n${scan}: hole pixels (splats under half opaque) as a share of all pixels`);
  for (const w of ['off', 'on']) console.log(`  fill ${w.padEnd(3)}  mesh behind ${hole(total[w], 'mesh')}%   plane only ${hole(total[w], 'plane')}%   nothing ${hole(total[w], 'none')}%`);
} finally {
  await browser.close();
}
