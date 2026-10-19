// Looping clips of the voxel overlays for the write-up (CLAUDE.md, "Making media"), made by
// moving the Debug card's overlay sliders a frame at a time. Needs the dev server and ffmpeg.
//
//   node scripts/media/voxel-loops.mjs [density|cleanup]   (both, if neither is named)
//
// density: the bulldozer in Kitchen; the threshold sweeps down from the densest voxel to the
//          isovalue, so voxels grow in densest first.
// cleanup: the Kitchen table, cubes only; what cleanup removes (orange) shrinks away, then what
//          it fills in (purple) grows, each stage labelled and held long enough to read.
// Writes media-out/voxel-density.mp4 and media-out/voxel-cleanup.mp4 (and their frames).

import { mkdirSync } from 'node:fs';
import { encodeLoop, FPS, needFfmpeg, open, pool } from './capture.mjs';

const OUT = 'media-out';
const ease = (t) => t * t * (3 - 2 * t);

async function density() {
  const g = await open('kitchen-clean.spz', { outDir: `${OUT}/voxel-density` });
  try {
    await g.ready(); await g.pause();
    await g.turn(20); // the follow camera's view of the bulldozer, as in the trailer
    const built = g.console('voxel overlays');
    await g.toggle('Density voxels');
    const densest = Math.ceil(Number(/densest ([0-9.]+)/.exec(await built)[1]));
    await g.slider('Density shown from (× isovalue)', densest);
    await g.toggle('Density voxels');                           // hidden while the scan holds
    await g.hideUI();
    await g.play([], 1);
    await g.toggle('Density voxels');
    const sweep = 3 * FPS;
    for (let i = 0; i <= sweep; i++) {                           // falls evenly in ratio: the dense core and the faint bulk each get time
      await g.slider('Density shown from (× isovalue)', densest ** (1 - ease(i / sweep)));
      await g.play([], 1 / FPS);
    }
    await g.play([], 1.5);
    encodeLoop(`${OUT}/voxel-density`, g.frames(), `${OUT}/voxel-density.mp4`);
    console.log(`density: ${g.frames()} frames`);
  } finally { await g.close(); }
}

// The cleanup clip's stages, with the label each shows: `move` the Cleanup progress slider from and to over
// `frames`, then `hold` frames still. The holds are long enough to read the label.
const ORANGE = '#f07846', PURPLE = '#7c3aed';
const STAGES = [
  { title: 'Before cleanup', dot: ORANGE, note: 'orange: stray clumps it will remove', hold: 75 },
  { title: 'Removing stray clumps', dot: ORANGE, move: [0, 1], frames: 45, hold: 30 },
  { title: 'Filling holes', dot: PURPLE, note: 'purple: voxels it fills in', move: [1, 2], frames: 45, hold: 15 },
  { title: 'After cleanup', hold: 75 },
];
const LABEL_FADE = 6; // frames a label takes to give way to the next

async function cleanup() {
  const g = await open('kitchen-clean.spz', { outDir: `${OUT}/voxel-cleanup`, params: '&meshonly=1&az=2.4&el=0.7&dist=0.7&cx=0&cy=0.35&cz=-0.3' });
  try {
    await g.ready(); await g.pause();
    const built = g.console('voxel overlays');
    await g.toggle('Cleanup voxels');
    await built;
    await g.page.mouse.click(5, 540); // the page takes the keys
    await g.page.keyboard.press('KeyV'); await g.page.keyboard.press('KeyV'); // V toggles the wireframe flag, off at first: twice hides the solid mesh
    await g.hideUI();
    await addLabels(g.page);
    await g.slider('Cleanup progress', 0);
    for (let s = 0; s < STAGES.length; s++) {
      const st = STAGES[s];
      const total = (st.frames ?? 0) + st.hold;
      for (let i = 0; i < total; i++) {
        if (st.move && i < st.frames) await g.slider('Cleanup progress', st.move[0] + (st.move[1] - st.move[0]) * ease((i + 1) / st.frames));
        await showLabel(g.page, s, s === 0 ? 1 : Math.min(1, (i + 1) / LABEL_FADE)); // (the first comes in with the loop's own fade)
        await g.play([], 1 / FPS);
      }
    }
    encodeLoop(`${OUT}/voxel-cleanup`, g.frames(), `${OUT}/voxel-cleanup.mp4`);
    console.log(`cleanup: ${g.frames()} frames`);
  } finally { await g.close(); }
}

/** One label per stage, stacked in the top-left corner, all hidden at first. */
function addLabels(page) {
  return page.evaluate((stages) => {
    const css = document.createElement('style');
    css.textContent = `.media-label { position: fixed; top: 44px; left: 48px; z-index: 99; padding: 14px 34px 16px; border-radius: 18px;
      background: rgba(255,255,255,0.92); color: #1f2937; font: 700 46px/1.1 Arial, Helvetica, sans-serif; opacity: 0; }
      .media-label i { display: inline-block; width: 28px; height: 28px; border-radius: 50%; margin: 0 12px 0 -6px; vertical-align: -1px; }
      .media-label small { display: block; margin-top: 8px; font: 400 30px/1 Arial, Helvetica, sans-serif; color: #6b7280; }`;
    document.head.append(css);
    for (const st of stages) {
      const el = document.createElement('div');
      el.className = 'media-label';
      el.innerHTML = `${st.dot ? `<i style="background:${st.dot}"></i>` : ''}${st.title}${st.note ? `<small>${st.note}</small>` : ''}`;
      document.body.append(el);
    }
  }, STAGES);
}

/** Show stage `s`'s label at `alpha`, and the one before it at what is left of it. */
function showLabel(page, s, alpha) {
  return page.evaluate(([s, alpha]) => {
    document.querySelectorAll('.media-label').forEach((el, i) => { el.style.opacity = String(i === s ? alpha : i === s - 1 ? 1 - alpha : 0); });
  }, [s, alpha]);
}

needFfmpeg();
mkdirSync(OUT, { recursive: true });
const named = process.argv.slice(2);
const jobs = { density, cleanup };
const which = named.length ? named : Object.keys(jobs);
for (const w of which) if (!jobs[w]) { console.error(`no clip "${w}": density, cleanup`); process.exit(1); }
await pool(which.map((w) => jobs[w]));
