// The BVH diagram for the write-up (CLAUDE.md, "Making media"): a top-down room of
// triangles, a real median-split BVH over them three levels deep, the reach of a check near
// the figurine, and the same boxes as a tree with the ones the check opens highlighted.
//
//   node scripts/media/bvh-diagram.mjs [seed]     writes media-out/bvh-diagram.svg
//
// The furniture is scattered at random from `seed` (default 2, the clearest of the first dozen); the figurine is stood where
// its check reaches into one smallest box only, which is the point the diagram makes.

import { mkdirSync, writeFileSync } from 'node:fs';

const seed = Number(process.argv[2] ?? 2);
const ACC = '#7c3aed', ACC_L = '#a78bfa', ACC_LL = '#ede9fe', INK = '#1f2937', MUTE = '#9ca3af', LINE = '#d1d5db', BG = '#ffffff', FIG = '#84bc78';
const W = 1200, H = 600;
const RX = 40, RY = 70, RW = 560, RH = 480; // the room panel

// mulberry32: a small seeded generator, so a seed always draws the same room
let state = seed >>> 0;
const rand = () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const gauss = (mean, sd) => mean + sd * Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
const clamp = (v) => Math.min(0.97, Math.max(0.03, v));

// furniture: clusters of small triangles, [x, y, count, spread] in the room's 0..1 square
const CLUSTERS = [[0.16, 0.20, 24, 0.06], [0.50, 0.16, 20, 0.05], [0.84, 0.24, 24, 0.06], [0.20, 0.78, 26, 0.07], [0.55, 0.62, 22, 0.06], [0.86, 0.80, 24, 0.06]];
const tris = [];
for (const [cx, cy, n, s] of CLUSTERS)
  for (let k = 0; k < n; k++) {
    const x = clamp(gauss(cx, s)), y = clamp(gauss(cy, s)), a = rand() * 2 * Math.PI, r = 0.018;
    tris.push({ c: [x, y], pts: [0, 1, 2].map((j) => [x + r * Math.cos(a + (j * 2 * Math.PI) / 3), y + r * Math.sin(a + (j * 2 * Math.PI) / 3)]) });
  }

const bounds = (ts) => {
  const xs = ts.flatMap((t) => t.pts.map((p) => p[0])), ys = ts.flatMap((t) => t.pts.map((p) => p[1]));
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};
/** Split at the median along the box's longer side, three levels deep (eight smallest boxes). */
const build = (ts, depth) => {
  const b = bounds(ts), node = { b, tris: ts, kids: [] };
  if (depth < 3) {
    const axis = b[2] - b[0] >= b[3] - b[1] ? 0 : 1;
    const sorted = [...ts].sort((p, q) => p.c[axis] - q.c[axis]), m = sorted.length >> 1;
    node.kids = [build(sorted.slice(0, m), depth + 1), build(sorted.slice(m), depth + 1)];
  }
  return node;
};
const root = build(tris, 0);
const leaves = (n) => (n.kids.length ? n.kids.flatMap(leaves) : [n]);

// the figurine, and how far its check reaches
const reach = 0.06;
let fx = 0, fy = 0;
const touches = (b) => { const nx = Math.min(Math.max(fx, b[0]), b[2]), ny = Math.min(Math.max(fy, b[1]), b[3]); return (nx - fx) ** 2 + (ny - fy) ** 2 <= reach * reach; };
const area = (l) => (l.b[2] - l.b[0]) * (l.b[3] - l.b[1]);
for (const leaf of [...leaves(root)].sort((p, q) => area(q) - area(p))) {
  [fx, fy] = [(leaf.b[0] + leaf.b[2]) / 2, (leaf.b[1] + leaf.b[3]) / 2];
  if (leaves(root).filter((l) => touches(l.b)).length === 1) break;
}
const mark = (n, parentOpen = true) => { n.open = parentOpen && touches(n.b); n.kids.forEach((k) => mark(k, n.open)); };
mark(root);

const P = (x, y) => [RX + x * RW, RY + y * RH];
const f1 = (v) => v.toFixed(1);
const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif">`,
  `<rect width="${W}" height="${H}" rx="16" fill="${BG}"/>`,
  `<text x="${RX}" y="44" font-size="20" font-weight="600" fill="${INK}">The room, from above</text>`,
  `<rect x="${RX}" y="${RY}" width="${RW}" height="${RH}" rx="8" fill="#f9fafb" stroke="${LINE}"/>`];
const boxes = (n, d) => {
  const [x0, y0] = P(n.b[0], n.b[1]), [x1, y1] = P(n.b[2], n.b[3]), pad = 10 - d * 3;
  const fill = n.open && !n.kids.length ? ACC_LL : 'none';
  out.push(`<rect x="${f1(x0 - pad)}" y="${f1(y0 - pad)}" width="${f1(x1 - x0 + 2 * pad)}" height="${f1(y1 - y0 + 2 * pad)}" rx="4" fill="${fill}" fill-opacity="0.8" stroke="${n.open ? ACC : MUTE}" stroke-width="${(2.2 - d * 0.35).toFixed(2)}"${n.open ? '' : ' stroke-dasharray="5 4"'}/>`);
  n.kids.forEach((k) => boxes(k, d + 1));
};
boxes(root, 0);
for (const leaf of leaves(root))
  for (const t of leaf.tris)
    out.push(`<polygon points="${t.pts.map((p) => P(...p).map(f1).join(',')).join(' ')}" fill="${leaf.open ? ACC : '#cbd5e1'}" fill-opacity="${leaf.open ? 0.9 : 0.8}"/>`);
const [cx, cy] = P(fx, fy);
out.push(`<circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(reach * RW)}" fill="${ACC_L}" fill-opacity="0.18" stroke="${ACC_L}" stroke-width="2"/>`,
  `<circle cx="${f1(cx)}" cy="${f1(cy - 6)}" r="7" fill="${FIG}"/><rect x="${f1(cx - 6)}" y="${f1(cy)}" width="12" height="11" rx="5" fill="${FIG}"/>`);

// the tree
const TX = 650, TY = 70, TW = 510;
out.push(`<text x="${TX}" y="44" font-size="20" font-weight="600" fill="${INK}">The same boxes, as a tree</text>`);
const levels = [[root]];
for (let d = 0; d < 3; d++) levels.push(levels[d].flatMap((n) => n.kids));
const pos = new Map();
levels.forEach((lv, d) => lv.forEach((n, i) => pos.set(n, [TX + ((i + 0.5) * TW) / lv.length, TY + 40 + d * 105])));
for (const lv of levels.slice(0, -1))
  for (const n of lv)
    for (const k of n.kids) {
      const [x0, y0] = pos.get(n), [x1, y1] = pos.get(k);
      out.push(`<line x1="${f1(x0)}" y1="${f1(y0 + 16)}" x2="${f1(x1)}" y2="${f1(y1 - 16)}" stroke="${k.open ? ACC : LINE}" stroke-width="${k.open ? 2.5 : 1.5}"/>`);
    }
levels.forEach((lv, d) => lv.forEach((n) => {
  const [x, y] = pos.get(n), w = d < 3 ? 54 : 44;
  out.push(`<rect x="${f1(x - w / 2)}" y="${f1(y - 16)}" width="${w}" height="32" rx="6" fill="${n.open ? ACC : BG}" stroke="${n.open ? ACC : MUTE}" stroke-width="1.6"${n.open ? '' : ' stroke-dasharray="5 4"'}/>`);
  if (!n.kids.length) out.push(`<text x="${f1(x)}" y="${f1(y + 5)}" font-size="13" text-anchor="middle" fill="${n.open ? '#fff' : MUTE}">${n.tris.length}</text>`);
}));
const tested = leaves(root).filter((l) => l.open).reduce((s, l) => s + l.tris.length, 0);
const ly = TY + 40 + 3 * 105 + 50;
out.push(`<text x="${TX}" y="${ly}" font-size="14" fill="${MUTE}">Numbers: triangles in each smallest box</text>`,
  `<rect x="${TX}" y="${ly + 22}" width="18" height="14" rx="3" fill="${ACC}"/><text x="${TX + 26}" y="${ly + 34}" font-size="15" fill="${INK}">opened by the check</text>`,
  `<rect x="${TX + 200}" y="${ly + 22}" width="18" height="14" rx="3" fill="${BG}" stroke="${MUTE}" stroke-dasharray="4 3"/><text x="${TX + 226}" y="${ly + 34}" font-size="15" fill="${INK}">skipped</text>`,
  `<text x="${RX}" y="${RY + RH + 34}" font-size="15" fill="${INK}">The check near the figurine tests <tspan font-weight="600" fill="${ACC}">${tested}</tspan> of ${tris.length} triangles.</text>`,
  '</svg>');
mkdirSync('media-out', { recursive: true });
writeFileSync('media-out/bvh-diagram.svg', out.join('\n'));
console.log(`media-out/bvh-diagram.svg: the check tests ${tested} of ${tris.length} triangles`);
