// Which walkable surface the figurine can get to from which: a model of its movement over
// the platforms (PlatformField), shared by the collision health numbers (collision-health.ts)
// and the room's shape for the game (game/room-shape.ts), so both judge "can it get there" the
// same way.
//
// Three-free. A model, not the controller itself. From any cell it can reach a cell of
// another surface by jumping or dropping, if that cell is no higher than a jump rises and no
// further off than it travels at a run in the time the jump (or the fall) takes. That is
// measured against the game: a jump rises 0.24 and carries about 1.3 at a run (Playroom),
// against 0.26 and 1.29 by this arithmetic. Walls in the way of a jump are not considered.
// A higher surface is climbed to from a cell within a climb's step over a lip of it, seen
// from above: with a face to climb in the mesh between the two (FACE), or face or no face (MEET).

import type { PlatformField } from './collision';

export interface ReachInput {
  walk: PlatformField;
  unit: number; // a grain (GRAIN): a climb reaches this much further over a lip than its own step
  move: { jumpVel: number; gravity: number; runSpeed: number; climbOver: number }; // world units: take-off speed, gravity (positive), speed in the air, and how far over a lip a climb steps
  /** Is there a face the figurine could climb from standing at (ax, ay, az) up to the surface at (bx, by, bz)? Asked of the collision mesh itself. */
  climbable: (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => boolean;
}

/** How one surface leads to another. */
export const JUMP = 1, FACE = 2, MEET = 4;

export interface ReachGraph {
  /** Each platform's cells, as indices into the field. */
  members: number[][];
  /** Per platform: the platforms it leads to, and how (JUMP | FACE | MEET bits). */
  edges: Map<number, number>[];
}

export function reachGraph({ walk, unit, move, climbable }: ReachInput): ReachGraph {
  const P = walk.positions, ids = walk.platformId, cells = ids.length, step = walk.sampleStep;
  const members: number[][] = Array.from({ length: walk.platformCount }, () => []);
  const edges: Map<number, number>[] = Array.from({ length: walk.platformCount }, () => new Map());
  if (!cells) return { members, edges };
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity, minY = Infinity;
  for (let i = 0; i < cells; i++) {
    if (P[i * 3] < minX) minX = P[i * 3]; if (P[i * 3] > maxX) maxX = P[i * 3];
    if (P[i * 3 + 2] < minZ) minZ = P[i * 3 + 2]; if (P[i * 3 + 2] > maxZ) maxZ = P[i * 3 + 2];
    if (P[i * 3 + 1] < minY) minY = P[i * 3 + 1];
  }
  const nx = Math.round((maxX - minX) / step) + 1, nz = Math.round((maxZ - minZ) / step) + 1;
  const col = (i: number) => Math.round((P[i * 3] - minX) / step) * nz + Math.round((P[i * 3 + 2] - minZ) / step);
  const head = new Int32Array(nx * nz).fill(-1), next = new Int32Array(cells);
  for (let i = 0; i < cells; i++) { const c = col(i); next[i] = head[c]; head[c] = i; members[ids[i]].push(i); }
  const rise = (move.jumpVel * move.jumpVel) / (2 * move.gravity);
  /** How far a jump carries by the time it is `dy` above where it left (below, if negative). */
  const carry = (dy: number) => move.runSpeed * (move.jumpVel + Math.sqrt(Math.max(0, move.jumpVel * move.jumpVel - 2 * move.gravity * dy))) / move.gravity;
  const over = move.climbOver + unit;

  for (let a = 0; a < walk.platformCount; a++) {
    const out = edges[a];
    for (const i of members[a]) {
      const ya = P[i * 3 + 1], span = Math.ceil(Math.max(carry(minY - ya), over) / step);
      const ax = Math.round((P[i * 3] - minX) / step), az = Math.round((P[i * 3 + 2] - minZ) / step);
      for (let x = Math.max(0, ax - span); x <= Math.min(nx - 1, ax + span); x++)
        for (let z = Math.max(0, az - span); z <= Math.min(nz - 1, az + span); z++)
          for (let j = head[x * nz + z]; j !== -1; j = next[j]) {
            const b = ids[j];
            if (b === a) continue;
            const has = out.get(b) ?? 0;
            if (has & JUMP) continue; // a jump is the most any pair of cells can add
            const dy = P[j * 3 + 1] - ya, away = Math.hypot(P[j * 3] - P[i * 3], P[j * 3 + 2] - P[i * 3 + 2]);
            if (dy <= rise && away <= carry(dy)) { out.set(b, has | JUMP); continue; }
            if (dy <= 0 || away > over) continue;
            let now = has | MEET;
            if (!(has & FACE) && climbable(P[i * 3], ya, P[i * 3 + 2], P[j * 3], P[j * 3 + 1], P[j * 3 + 2])) now |= FACE;
            out.set(b, now);
          }
    }
  }
  return { members, edges };
}

/** The platforms reachable from `start` by the moves in `ways` (JUMP | FACE | MEET bits),
 *  through only the platforms `allowed` lets through (the start always counts). */
export function reachFrom(graph: ReachGraph, start: number, ways: number, allowed: (p: number) => boolean = () => true): Uint8Array {
  const reached = new Uint8Array(graph.members.length);
  if (start < 0) return reached;
  const queue = [start];
  reached[start] = 1;
  for (let h = 0; h < queue.length; h++)
    for (const [b, how] of graph.edges[queue[h]])
      if (!reached[b] && how & ways && allowed(b)) { reached[b] = 1; queue.push(b); }
  return reached;
}
