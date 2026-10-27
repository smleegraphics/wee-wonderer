// The room's shape as the game reads it: its walkable surfaces, which of them are the
// ground, which the figurine can get to from where it starts, the longest route over the
// raised ones, and where something is overhead. Worked out from the walkable cells and the
// movement model (reach-graph.ts) once a room's collision is built. The themes decide from
// this whether a room suits them and where their things go (context/game.md).
//
// Three-free. Heights are in body heights (charH) above the ground.

import type { PlatformField } from '../collision/collision';
import { FACE, JUMP, type ReachGraph, type ReachInput, reachFrom, reachGraph } from '../collision/reach-graph';

/** A surface within this many body heights of the ground's level is part of the ground: a
 *  rug, a mat, a low board. At 1 instead, Kitchen's lava route loses two of its four tops
 *  (measured): low tops are what a lava course is made of. */
const GROUND_BAND = 0.5;
/** A walkable cell with collision this many body heights over it is covered: under a table,
 *  a chair, a shelf. Lower than a room's ceiling (Playroom's is about 17 up). */
const COVER_HEIGHT = 3;
/** How far, in body heights, past the edge of the surface the figurine starts on the room
 *  still reaches, seen from above: far enough to take in what stands on it (Kitchen's
 *  bulldozer stands where the table has no cells of its own) and what leans against it. */
const ROOM_MARGIN = 1;

export interface Surface {
  cells: number[];   // indices into the walkable cells
  height: number;    // its median height above the ground, in body heights
  real: boolean;     // big enough to be somewhere to be, not a scrap (realCells)
  spot: number;      // the cell nearest the middle of it, seen from above: where something put on it goes
}

export interface ShapeInput extends ReachInput {
  spawn: [number, number, number]; // where the figurine starts
  groundY: number | null;          // the ground's level (the voxelizer's), or null: the lowest cell then
  bodyHeight: number;              // charH, in world units
  realCells: number;               // a surface of at least this many cells is real (walk-fill.ts realCells)
  /** Is there collision within `max` straight above (x, y, z)? */
  overhead: (x: number, y: number, z: number, max: number) => boolean;
}

export interface RoomShape {
  walk: PlatformField;
  graph: ReachGraph;
  surfaces: Surface[];
  spawn: number;             // the surface the figurine starts on
  reachable: Uint8Array;     // per surface: can the figurine get there from the start, walking, jumping and climbing faces
  ground: Uint8Array;        // per surface: part of the ground (GROUND_BAND)
  /** Reachable cells with something overhead (COVER_HEIGHT). Worked out when first asked: one ray a cell, which only some themes need. */
  covered(): number[];
  /** Per cell: over the room, seen from above: within ROOM_MARGIN of the surface the figurine
   *  starts on. A scan is captured looking in at that, so out past it is the scan's thin edge
   *  (Kitchen's chairs and side table, the far side of Counter's worktop), not the room. */
  inRoom: Uint8Array;
  /** The most real raised surfaces the figurine can go between without touching the
   *  ground: where to start that route, its highest real surface, and how many real ones it has. */
  lavaRoute: { start: number; goal: number; tops: number } | null;
}

export function roomShape(input: ShapeInput): RoomShape {
  const { walk, bodyHeight, realCells, overhead } = input, P = walk.positions, n = walk.platformId.length;
  const graph = reachGraph(input);
  let lowest = Infinity;
  for (let i = 0; i < n; i++) lowest = Math.min(lowest, P[i * 3 + 1]);
  const groundY = input.groundY ?? lowest;

  const surfaces: Surface[] = graph.members.map((cells) => {
    const heights = cells.map((i) => P[i * 3 + 1]).sort((a, b) => a - b);
    let cx = 0, cz = 0;
    for (const i of cells) { cx += P[i * 3]; cz += P[i * 3 + 2]; }
    cx /= cells.length || 1; cz /= cells.length || 1;
    let spot = cells[0] ?? -1, best = Infinity;
    for (const i of cells) { const d = (P[i * 3] - cx) ** 2 + (P[i * 3 + 2] - cz) ** 2; if (d < best) { best = d; spot = i; } }
    return { cells, height: heights.length ? (heights[heights.length >> 1] - groundY) / bodyHeight : 0, real: cells.length >= realCells, spot };
  });

  let spawn = -1, nearest = Infinity;
  const [sx, sy, sz] = input.spawn;
  for (let i = 0; i < n; i++) {
    const d = (P[i * 3] - sx) ** 2 + (P[i * 3 + 1] - sy) ** 2 + (P[i * 3 + 2] - sz) ** 2;
    if (d < nearest) { nearest = d; spawn = walk.platformId[i]; }
  }
  const reachable = reachFrom(graph, spawn, JUMP | FACE);
  const ground = Uint8Array.from(surfaces, (s) => (s.height < GROUND_BAND ? 1 : 0));

  // the room's footprint: the start surface's columns, widened by ROOM_MARGIN
  const step = walk.sampleStep, margin = Math.ceil((ROOM_MARGIN * bodyHeight) / step);
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) { minX = Math.min(minX, P[i * 3]); maxX = Math.max(maxX, P[i * 3]); minZ = Math.min(minZ, P[i * 3 + 2]); maxZ = Math.max(maxZ, P[i * 3 + 2]); }
  const nx = Math.round((maxX - minX) / step) + 1, nz = Math.round((maxZ - minZ) / step) + 1;
  const column = (i: number) => [Math.round((P[i * 3] - minX) / step), Math.round((P[i * 3 + 2] - minZ) / step)];
  const footprint = new Uint8Array(nx * nz);
  for (const i of spawn >= 0 ? surfaces[spawn].cells : []) {
    const [x0, z0] = column(i);
    for (let x = Math.max(0, x0 - margin); x <= Math.min(nx - 1, x0 + margin); x++)
      for (let z = Math.max(0, z0 - margin); z <= Math.min(nz - 1, z0 + margin); z++) footprint[x * nz + z] = 1;
  }
  const inRoom = new Uint8Array(n);
  for (let i = 0; i < n; i++) { const [x, z] = column(i); inRoom[i] = footprint[x * nz + z]; }

  let coveredCells: number[] | null = null;
  const covered = () => {
    if (coveredCells) return coveredCells;
    coveredCells = [];
    for (let i = 0; i < n; i++)
      if (reachable[walk.platformId[i]] && overhead(P[i * 3], P[i * 3 + 1] + bodyHeight * 0.5, P[i * 3 + 2], bodyHeight * COVER_HEIGHT)) coveredCells.push(i);
    return coveredCells;
  };

  // The lava route: from each raised real surface the figurine can get to, what it can get to
  // in turn without setting foot on the ground (scraps count as stepping stones). The start
  // with the most real surfaces wins; of two equal ones the larger, which is open to stand
  // and look around on (a seat, a table): the lowest was the top of Living Room's plant pot,
  // with the camera buried in its leaves.
  let lavaRoute: RoomShape['lavaRoute'] = null;
  surfaces.forEach((s, p) => {
    if (!s.real || ground[p] || !reachable[p]) return;
    const onRoute = reachFrom(graph, p, JUMP | FACE, (b) => !ground[b]);
    let tops = 0, goal = p;
    surfaces.forEach((t, q) => { if (onRoute[q] && t.real) { tops++; if (t.height > surfaces[goal].height) goal = q; } });
    if (!lavaRoute || tops > lavaRoute.tops || (tops === lavaRoute.tops && s.cells.length > surfaces[lavaRoute.start].cells.length)) lavaRoute = { start: p, goal, tops };
  });

  return { walk, graph, surfaces, spawn, reachable, ground, covered, inRoom, lavaRoute };
}
