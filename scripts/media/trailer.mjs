// The trailer: the title, then the figurine walking and climbing in each room, cut together
// with short crossfades (CLAUDE.md, "Making media"). Needs the dev server and ffmpeg.
//
//   node scripts/media/trailer.mjs                  capture every clip, then cut the trailer
//   node scripts/media/trailer.mjs --clip bulldozer capture one clip again (then cut)
//   node scripts/media/trailer.mjs --cut            cut again from the clips already captured
//   node scripts/media/trailer.mjs --aim <scan> '<segments>' <turn,turn,...>
//       try each camera turn before the segments and report whether the figurine climbs:
//       how a route is aimed at something to climb (turn amounts are mouse pixels)
//
// Writes media-out/trailer/: one folder of frames per clip, trailer-web.mp4 (for a page),
// trailer-master.mp4 (higher quality) and trailer-poster.jpg.

import { mkdirSync } from 'node:fs';
import { FPS, H, W, ffmpeg, needFfmpeg, open, pool } from './capture.mjs';

const OUT = 'media-out/trailer';
const WALK = 'KeyW', LEFT = 'KeyA';

// Each clip: the scan, the route, and the frames of it that go in the trailer.
// A route is a list of segments, run in order:
//   { keys, s, jump? }        hold the keys for s seconds (jump on the first frame), every frame shot
//   { turn, up? }             turn the camera (mouse pixels), then let it settle (not shot)
//   { keys, untilOnTop }      hold the keys until a climb has ended standing, and `untilOnTop` frames more
// Walk, don't run (no ShiftLeft): at a run the figurine's sway and the scan's bumps read as
// jitter. Aim with --aim: what a turn faces depends on the scan.
const CLIPS = [
  { name: 'title', scan: 'kitchen-clean.spz', title: true, frames: [0, 196] },
  { name: 'kitchen-walk', scan: 'kitchen-clean.spz', frames: [0, 75],         // along the table past the bulldozer
    route: [{ turn: 600 }, { keys: [WALK], s: 3 }, { keys: [WALK], s: 0.9, jump: true }, { keys: [WALK], s: 2 }] },
  { name: 'bulldozer', scan: 'kitchen-clean.spz', frames: [12, 127], poster: 110, // climbs on, and stops on top
    route: [{ keys: [], s: 0.5 }, { turn: 20 }, { keys: [WALK], s: 0.6 }, { keys: [WALK], s: 0.8, jump: true }, { keys: [WALK], untilOnTop: 6 }, { keys: [], s: 1.5 }] },
  { name: 'rug-walk', scan: 'livingroom-clean.spz', frames: [0, 140],         // sideways across the rug, past the slippers
    route: [{ turn: 600 }, { keys: [], s: 0.3 }, { keys: [LEFT], s: 2 }, { keys: [LEFT, WALK], s: 1.5 }, { keys: [LEFT], s: 2 }, { keys: [], s: 0.5 }] },
  { name: 'houseplant', scan: 'counter-clean.spz', frames: [0, 125],          // onto the pot and up the plant
    route: [{ keys: [], s: 0.4 }, { keys: [WALK], s: 3 }, { keys: [WALK], s: 0.8, jump: true }, { keys: [WALK], s: 1.2 }] },
  { name: 'dog-walk', scan: 'Marishka-clean.spz', frames: [0, 179],           // along the dog's back; the camera raised
    route: [{ turn: 0, up: 50 }, { keys: [LEFT], s: 4.5 }, { keys: [], s: 1.2 }] }, // to see over it (lower, it pulls in close)
];
const FADE = 0.33; // seconds of crossfade between clips

/** Run a route's segments, shooting each frame (`capture`: false for --aim). */
async function runRoute(g, route, { capture = true, onFrame = null } = {}) {
  for (const seg of route) {
    if (seg.turn !== undefined) { await g.turn(seg.turn, seg.up ?? 0); continue; }
    if (seg.untilOnTop !== undefined) {
      let climbed = false, after = 0;
      for (let i = 0; i < 10 * FPS && after < seg.untilOnTop; i++) {
        await g.play(seg.keys, 1 / FPS, { capture });
        const d = await g.dbg(); onFrame?.(d);
        if (d.state === 'climb') climbed = true; else if (climbed && d.state === 'ground') after++;
      }
      if (!climbed) console.log('  (no climb: the route no longer reaches the wall)');
      continue;
    }
    if (onFrame) for (let i = 0; i < Math.round(seg.s * FPS); i++) { await g.play(seg.keys, 1 / FPS, { capture, jump: !!seg.jump && i === 0 }); onFrame(await g.dbg()); }
    else await g.play(seg.keys, seg.s, { capture, jump: !!seg.jump });
  }
}

async function captureClip(clip) {
  const g = await open(clip.scan, { outDir: `${OUT}/${clip.name}`, title: clip.title });
  try {
    if (clip.title) await captureTitle(g);
    else { await g.ready(); await runRoute(g, clip.route); }
    console.log(`${clip.name}: ${g.frames()} frames`);
  } finally { await g.close(); }
}

/** The title screen, Begin pressed, then the room arriving. The scan usually loads before
 *  the title could be held, so the game is paused as soon as it is ready and the title is
 *  shot over that still frame. */
async function captureTitle(g) {
  await g.page.waitForFunction(() => window.__wwReady === true && window.__step, undefined, { timeout: 120000 });
  await g.pause();
  for (let i = 0; i < 48; i++) await g.shot();
  const begin = g.page.locator('.ww-begin');
  const box = await begin.boundingBox();
  await g.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 12; i++) await g.shot();   // hovering on Begin
  await begin.click();
  await g.page.mouse.move(W - 1, H - 1);
  let d, waited = 0;
  while ((d = await g.dbg()).reveal === 0 && waited++ < 3000) await g.play([], 1 / FPS, { capture: false });
  for (let n = 0; (d = await g.dbg()).reveal < 1 && n < 600; n++) await g.play([], 1 / FPS);
  await g.play([], 1.0);
}

/** Cut the trailer from the captured clips: each clip's frames, crossfaded into the next. */
function cut() {
  const segs = CLIPS.map((c) => {
    const seg = `${OUT}/${c.name}.mp4`, [a, b] = c.frames;
    ffmpeg(['-framerate', String(FPS), '-start_number', String(a), '-i', `${OUT}/${c.name}/%05d.jpg`, '-frames:v', String(b - a + 1),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16', seg]);
    return { seg, dur: (b - a + 1) / FPS };
  });
  const inputs = segs.flatMap((s) => ['-i', s.seg]), chain = [];
  let t = segs[0].dur, prev = '[0:v]';
  for (let i = 1; i < segs.length; i++) {
    chain.push(`${prev}[${i}:v]xfade=transition=fade:duration=${FADE}:offset=${(t - FADE).toFixed(3)}[v${i}]`);
    t += segs[i].dur - FADE; prev = `[v${i}]`;
  }
  for (const [file, crf] of [['trailer-web.mp4', 25], ['trailer-master.mp4', 17]])
    ffmpeg([...inputs, '-filter_complex', chain.join(';'), '-map', prev, '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf),
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', `${OUT}/${file}`]);
  const p = CLIPS.find((c) => c.poster !== undefined);
  if (p) ffmpeg(['-i', `${OUT}/${p.name}/${String(p.poster).padStart(5, '0')}.jpg`, '-q:v', '3', `${OUT}/trailer-poster.jpg`]);
  console.log(`${OUT}/trailer-web.mp4: ${t.toFixed(1)} s`);
}

/** For each turn: a fresh room, the turn, the route without shooting; the states it went through and how high it got. */
async function aim(scan, route, turns) {
  const g = await open(scan);
  try {
    for (const t of turns) {
      await g.page.reload({ waitUntil: 'load' });
      await g.ready();
      await g.turn(t);
      const states = new Set(); let top = -Infinity, d = null;
      await runRoute(g, route, { capture: false, onFrame: (x) => { d = x; states.add(x.state); top = Math.max(top, x.py); } });
      console.log(`turn ${String(t).padStart(5)}  ${[...states].join(', ').padEnd(32)} highest ${top.toFixed(3)}  ends ${d?.state} at ${d?.py.toFixed(3)}`);
    }
  } finally { await g.close(); }
}

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
needFfmpeg();
mkdirSync(OUT, { recursive: true });
if (args.includes('--aim')) {
  const i = args.indexOf('--aim');
  await aim(args[i + 1], JSON.parse(args[i + 2]), args[i + 3].split(',').map(Number));
} else {
  if (!args.includes('--cut')) {
    const only = arg('--clip');
    const clips = only ? CLIPS.filter((c) => c.name === only) : CLIPS;
    if (!clips.length) { console.error(`no clip "${only}": ${CLIPS.map((c) => c.name).join(', ')}`); process.exit(1); }
    await pool(clips.map((c) => () => captureClip(c)));
  }
  cut();
}
