// The spilled pack: the Wonderer's pack burst open on the way into the room, and its gear
// is scattered over the room's landmarks: the spyglass on the highest place, the lantern
// somewhere under something, the rest on the other surfaces it can get to, as far apart
// as they go within the room (RoomShape.inRoom). Walk into a piece to pick it up. It suits any room (context/game.md).

import * as THREE from 'three';
import { hud, player } from '../app';
import { charH } from '../figurine/character';
import type { RoomShape } from './room-shape';
import { cellPosition, type Theme, type ThemeRun } from './theme';

/** count: how many pieces a room gets, from how many landmarks it has, within these.
 *  apart: body heights kept between pieces, and from the start, so no two are found at once.
 *  high: body heights above the ground the highest surface must be for the spyglass to go
 *  there (Kitchen's is 2, Counter's 3.2): lower, it is just another surface. */
export const PACK = { fewest: 4, most: 6, apart: 2, high: 1 };
const PICK_REACH = 0.6; // body heights, across: walking into a piece picks it up...
const PICK_RISE = 0.8;  // ...if it is within this of the feet, up or down

/** The gear, in the order it is placed: the first two have a place of their own. */
const GEAR = ['spyglass', 'lantern', 'compass', 'map', 'journal', 'rope'] as const;
type Gear = typeof GEAR[number];

export const spilledPackTheme: Theme = {
  id: 'pack',
  intro: 'Your pack burst open on the way in. Your gear is scattered across the room.',
  unsuited: () => null,
  begin(shape) { return new PackRun(shape); },
};

interface Piece { gear: Gear; object: THREE.Object3D; found: boolean }

class PackRun implements ThemeRun {
  object = new THREE.Group();
  start = null;
  goal = '';
  progress = 0; // pieces found
  private readonly pieces: Piece[];
  private clock = 0;

  constructor(shape: RoomShape) {
    this.pieces = placeGear(shape).map(({ gear, cell }) => {
      const object = makeGear(gear);
      cellPosition(shape, cell, object.position);
      object.userData.y = object.position.y;
      this.object.add(object);
      return { gear, object, found: false };
    });
    this.goal = this.tally();
  }

  update(dt: number): void {
    this.clock += dt;
    const p = player.position;
    for (let i = 0; i < this.pieces.length; i++) {
      const piece = this.pieces[i], o = piece.object;
      if (piece.found) continue;
      o.rotation.y = this.clock * 1.2 + i;                                        // turning, so it catches the light...
      o.position.y = o.userData.y + charH * (0.25 + 0.06 * Math.sin(this.clock * 2 + i)); // ...and bobbing over its spot
      if (Math.hypot(p.x - o.position.x, p.z - o.position.z) < charH * PICK_REACH && Math.abs(p.y - o.userData.y) < charH * PICK_RISE) {
        piece.found = true;
        o.visible = false;
        this.progress++;
        this.goal = this.tally();
        const left = this.pieces.filter((q) => !q.found).length;
        hud.status(left ? `Found the ${piece.gear}.` : 'Pack\'s full. Onward.', 'done');
      }
    }
  }

  /** The nearest piece not yet found, as the crow flies. */
  hintTarget(out: THREE.Vector3): boolean {
    const p = player.position;
    let best = Infinity;
    for (const q of this.pieces) {
      if (q.found) continue;
      const o = q.object.position, d = (o.x - p.x) ** 2 + (q.object.userData.y - p.y) ** 2 + (o.z - p.z) ** 2;
      if (d < best) { best = d; out.set(o.x, q.object.userData.y, o.z); }
    }
    return best < Infinity;
  }

  private tally(): string {
    const found = this.pieces.filter((q) => q.found).length;
    return found === this.pieces.length ? 'Pack\'s full' : `Gear found: ${found} of ${this.pieces.length}`;
  }

  debug() {
    return { pieces: this.pieces.map((q) => ({ gear: q.gear, at: [q.object.position.x, q.object.userData.y, q.object.position.z], found: q.found })) };
  }

  dispose(): void { /* the game disposes the object's meshes */ }
}

/** Where each piece goes: a walkable cell the figurine can get to from the start. */
function placeGear(shape: RoomShape): { gear: Gear; cell: number }[] {
  const P = shape.walk.positions, ids = shape.walk.platformId, apart = (charH * PACK.apart) ** 2;
  const taken: number[] = [shape.surfaces[shape.spawn].spot]; // the start counts as taken: nothing is found by standing still
  const far = (i: number) => Math.min(...taken.map((j) => (P[i * 3] - P[j * 3]) ** 2 + (P[i * 3 + 1] - P[j * 3 + 1]) ** 2 + (P[i * 3 + 2] - P[j * 3 + 2]) ** 2));
  const placed: { gear: Gear; cell: number }[] = [];
  const put = (gear: Gear, cell: number) => { placed.push({ gear, cell }); taken.push(cell); };

  // Landmarks: the middle of every real surface the figurine can get to, other than the one it
  // starts on, in the room (RoomShape.inRoom): furthest-first otherwise finds the scan's thin edge.
  const landmarks = shape.surfaces.flatMap((s, p) => (s.real && shape.reachable[p] && p !== shape.spawn && shape.inRoom[s.spot] ? [s.spot] : []));
  const onReal = (i: number) => shape.inRoom[i] && shape.surfaces[ids[i]].real; // (a scrap is as often the scan's noise as somewhere to be)
  const covered = shape.covered().filter(onReal);
  const count = Math.min(PACK.most, Math.max(PACK.fewest, landmarks.length + (covered.length ? 1 : 0)));

  // the spyglass: on the highest of the landmarks, if it is high enough to look out from
  let top = -1;
  for (const i of landmarks) if (top < 0 || P[i * 3 + 1] > P[top * 3 + 1]) top = i;
  if (top >= 0 && shape.surfaces[ids[top]].height >= PACK.high) put('spyglass', top);
  // the lantern: the covered cell furthest from what is taken
  let lantern = -1, best = apart;
  for (const i of covered) { const d = far(i); if (d >= best) { best = d; lantern = i; } }
  if (lantern >= 0) put('lantern', lantern);

  // The rest, furthest first: the landmarks, then (in a room with too few) cells of the real
  // surfaces it can get to, every few so the search stays small.
  const stride = Math.max(1, Math.round(Math.sqrt(ids.length / 400)));
  const fallback: number[] = [];
  for (let i = 0; i < ids.length; i += stride) if (shape.reachable[ids[i]] && onReal(i)) fallback.push(i);
  for (const gear of GEAR) {
    if (placed.length >= count) break;
    if (placed.some((q) => q.gear === gear)) continue;
    let cell = -1, d = apart;
    for (const pool of [landmarks, fallback]) {
      for (const i of pool) { const f = far(i); if (f >= d) { d = f; cell = i; } }
      if (cell >= 0) break;
    }
    if (cell < 0) break; // nowhere left far enough from the others
    put(gear, cell);
  }
  return placed;
}

/** Placeholder gear: a simple shape each, about a third of the figurine's height, lit by
 *  the scan. Swapped for modelled pieces later. */
function makeGear(gear: Gear): THREE.Group {
  const g = new THREE.Group(), u = charH;
  const mat = (color: number, glow = 0) => new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.2, emissive: color, emissiveIntensity: 0.25 + glow });
  const add = (geom: THREE.BufferGeometry, m: THREE.Material, y = 0, rx = 0, rz = 0) => {
    const mesh = new THREE.Mesh(geom, m);
    mesh.position.y = y; mesh.rotation.set(rx, 0, rz);
    g.add(mesh);
  };
  switch (gear) {
    case 'spyglass': add(new THREE.CylinderGeometry(u * 0.05, u * 0.07, u * 0.4, 10), mat(0xc9a14a), 0, 0, Math.PI / 2); break;
    case 'lantern':
      add(new THREE.BoxGeometry(u * 0.16, u * 0.22, u * 0.16), mat(0xffd27a, 1.2), u * 0.11);
      add(new THREE.ConeGeometry(u * 0.13, u * 0.08, 4), mat(0x3b3b3b), u * 0.26);
      break;
    case 'compass': add(new THREE.CylinderGeometry(u * 0.15, u * 0.15, u * 0.05, 18), mat(0xb88a3c), u * 0.025); break;
    case 'map': add(new THREE.BoxGeometry(u * 0.32, u * 0.01, u * 0.24), mat(0xe8d9a8), 0.005); break;
    case 'journal': add(new THREE.BoxGeometry(u * 0.22, u * 0.07, u * 0.28), mat(0x7a3b2a), u * 0.035); break;
    case 'rope': add(new THREE.TorusGeometry(u * 0.12, u * 0.035, 8, 20), mat(0xa88a5a), u * 0.035, Math.PI / 2); break;
  }
  return g;
}
