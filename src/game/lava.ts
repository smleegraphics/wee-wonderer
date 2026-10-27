// The floor is lava: the room's ground glows and may not be stood on. Touch it and the
// figurine is back on the last raised surface it stood on. The goal is a flag on the
// highest surface of the longest route over the raised ones (context/game.md).

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { float, mix, mx_fractal_noise_float, positionWorld, smoothstep, time, uniform, vec3 } from 'three/tsl';
import { figurine, hud, player } from '../app';
import { navGrid, PLATFORM_OPTS } from '../collision/room-collision';
import { charH, placeFigurine } from '../figurine/character';
import { FACE, JUMP } from '../collision/reach-graph';
import type { RoomShape } from './room-shape';
import { cellPosition, type Theme, type ThemeRun } from './theme';

/** minTops: the fewest real raised surfaces a room's lava route needs. Measured routes:
 *  Living Room 23, Playroom 36, Curled Up Dog 5, Kitchen 4, Counter 1. Below 6 the course
 *  is a hop or two, which the flag alone (Volcano, not built yet) would suit better.
 *  lift: body heights the lava lies above the walkable cells. The visible ground is not
 *  where the feet are (medians of -0.17 to +0.18, context/lighting.md), and splats above
 *  the lava draw over it, so it is lifted to cover the ground's own splats. */
export const LAVA = { minTops: 6, lift: 0.15 };
const FLAG_REACH = 0.8;   // body heights from the flag's foot that count as reaching it
const FLAG_HEIGHT = 1.3;  // body heights: taller than the figurine, so it shows from below

const GOAL = 'The floor is lava: reach the flag';
const REACHED = 'You reached the top';

export const lavaTheme: Theme = {
  id: 'lava',
  intro: 'The floor is lava. Reach the flag at the top.',
  unsuited(shape) {
    const tops = shape.lavaRoute?.tops ?? 0;
    return tops < LAVA.minTops ? `${tops} raised surfaces can be crossed without touching the ground (needs ${LAVA.minTops})` : null;
  },
  begin(shape) { return new LavaRun(shape); },
};

const at = new THREE.Vector3();
class LavaRun implements ThemeRun {
  object = new THREE.Group();
  start: THREE.Vector3;
  goal = GOAL;
  private readonly flag: THREE.Object3D;
  private readonly lastSafe = new THREE.Vector3();
  private readonly route: NonNullable<RoomShape['lavaRoute']>;
  private respawns = 0;
  private reached = false;
  progress = 0;
  /** Per surface: the fewest jumps and climbs from it to the flag's surface over raised ones
   *  (Infinity: none). Progress is standing on a surface fewer hops away than any so far;
   *  the hint points one hop on. Hops, not height or distance: the way up often goes
   *  sideways or down first. */
  private readonly hops: Float64Array;
  private best: number;
  private on = -1;          // the raised surface the figurine last stood on
  private next = -1;        // the cell the hint points at from there (-1: worked out when asked)

  constructor(private readonly shape: RoomShape) {
    this.route = shape.lavaRoute!;
    this.start = cellPosition(shape, shape.surfaces[this.route.start].spot, new THREE.Vector3());
    this.lastSafe.copy(this.start);
    this.object.add(lavaSheet(shape));
    this.flag = makeFlag(hud.token('--accent'), hud.token('--ink'));
    cellPosition(shape, shape.surfaces[this.route.goal].spot, this.flag.position);
    this.object.add(this.flag);
    this.hops = hopsTo(shape, this.route.goal);
    this.on = this.route.start;
    this.best = this.hops[this.route.start];
  }

  update(): void {
    if (!navGrid || (figurine.state !== 'ground' && figurine.state !== 'land')) return;
    const p = player.position;
    const on = navGrid.platformAt(p.x, p.z, figurine.supportY, charH * PLATFORM_OPTS.stepFactor);
    if (on < 0) return;
    if (this.shape.ground[on]) {
      this.respawns++;
      placeFigurine(at.copy(this.lastSafe), false);
      hud.status('Too hot! Back to safe ground.', 'done');
      return;
    }
    this.lastSafe.copy(p);
    if (on !== this.on) { this.on = on; this.next = -1; }
    if (this.hops[on] < this.best) { this.best = this.hops[on]; this.progress++; }
    if (!this.reached && on === this.route.goal && Math.hypot(p.x - this.flag.position.x, p.z - this.flag.position.z) < charH * FLAG_REACH) {
      this.reached = true;
      this.progress++;
      this.goal = REACHED;
      hud.status('You made it to the top without touching the lava!', 'done');
    }
  }

  hintTarget(out: THREE.Vector3): boolean {
    if (this.reached) return false;
    if (this.on === this.route.goal || !Number.isFinite(this.hops[this.on])) { // on the flag's surface, or off the route: the flag, or back to the start
      out.copy(this.on === this.route.goal ? this.flag.position : this.start);
      return true;
    }
    if (this.next < 0) this.next = this.nextStep();
    if (this.next < 0) return false;
    cellPosition(this.shape, this.next, out);
    return true;
  }

  /** The cell to head for from the surface the figurine is on: on a raised surface one hop
   *  nearer the flag, the one nearest the figurine (where the jump or climb onto it is). */
  private nextStep(): number {
    const { shape, hops } = this, P = shape.walk.positions, p = player.position;
    let cell = -1, best = Infinity;
    for (const [b, how] of shape.graph.edges[this.on]) {
      if (!(how & (JUMP | FACE)) || shape.ground[b] || hops[b] !== hops[this.on] - 1) continue;
      for (const i of shape.surfaces[b].cells) {
        const d = (P[i * 3] - p.x) ** 2 + (P[i * 3 + 1] - p.y) ** 2 + (P[i * 3 + 2] - p.z) ** 2;
        if (d < best) { best = d; cell = i; }
      }
    }
    return cell;
  }

  debug() {
    const { route, shape } = this;
    return {
      tops: route.tops, start: this.start.toArray(), flag: this.flag.position.toArray(),
      goalHeight: +shape.surfaces[route.goal].height.toFixed(2), respawns: this.respawns, reached: this.reached,
      on: this.on, hops: this.hops[this.on], best: this.best,
    };
  }

  dispose(): void { /* the game disposes the object's meshes */ }
}

/** Per surface, the fewest jumps and climbs from it to surface `goal` without touching the
 *  ground (Infinity where it cannot get there): a search back from the goal over the
 *  movement model's moves. */
function hopsTo(shape: RoomShape, goal: number): Float64Array {
  const { edges } = shape.graph, hops = new Float64Array(edges.length).fill(Infinity), into: number[][] = edges.map(() => []);
  edges.forEach((out, a) => { if (!shape.ground[a]) for (const [b, how] of out) if (how & (JUMP | FACE)) into[b].push(a); });
  hops[goal] = 0;
  const queue = [goal];
  for (let h = 0; h < queue.length; h++)
    for (const a of into[queue[h]]) if (hops[a] === Infinity) { hops[a] = hops[queue[h]] + 1; queue.push(a); }
  return hops;
}

/** The lava: a sheet over every walkable cell of the ground, a cell-sized square each, lifted
 *  LAVA.lift. Unlit, so it glows the same in any room. */
function lavaSheet(shape: RoomShape): THREE.Mesh {
  const P = shape.walk.positions, ids = shape.walk.platformId, h = shape.walk.sampleStep / 2, lift = charH * LAVA.lift;
  const pos: number[] = [], index: number[] = [];
  for (let i = 0; i < ids.length; i++) {
    if (!shape.ground[ids[i]]) continue;
    const x = P[i * 3], y = P[i * 3 + 1] + lift, z = P[i * 3 + 2], v = pos.length / 3;
    pos.push(x - h, y, z - h, x + h, y, z - h, x + h, y, z + h, x - h, y, z + h);
    index.push(v, v + 2, v + 1, v, v + 3, v + 2);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geom.setIndex(index);
  const scale = uniform(1 / charH); // the pattern is sized to the figurine, whatever the scan
  const p = positionWorld.mul(scale);
  const flow = time.mul(0.1);
  // a dark crust, cracked by thin bright veins (where one noise crosses zero) and opening into
  // hot pools (where a second, broader one is high); both drift slowly
  const veins = float(1).sub(smoothstep(0, 0.07, mx_fractal_noise_float(vec3(p.x, p.z, flow), 3, 2, 0.5).abs()));
  const pools = smoothstep(0.2, 0.45, mx_fractal_noise_float(vec3(p.x.mul(0.35), p.z.mul(0.35), flow.mul(0.6)), 2, 2, 0.5));
  const heat = veins.max(pools);
  const material = new MeshBasicNodeMaterial();
  material.colorNode = mix(vec3(0.09, 0.02, 0.015), mix(vec3(0.85, 0.12, 0.02), vec3(1.0, 0.72, 0.2), pools), heat);
  return new THREE.Mesh(geom, material);
}

/** A placeholder flag: a pole and a pennant in the UI's accent colour, sized to the figurine. */
function makeFlag(cloth: string, pole: string): THREE.Group {
  const flag = new THREE.Group(), tall = charH * FLAG_HEIGHT;
  const stick = new THREE.Mesh(new THREE.CylinderGeometry(charH * 0.025, charH * 0.025, tall, 6), new THREE.MeshStandardMaterial({ color: pole, roughness: 0.8 }));
  stick.position.y = tall / 2;
  const shape = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(charH * 0.55, -charH * 0.17), new THREE.Vector2(0, -charH * 0.34)]);
  const pennant = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshStandardMaterial({ color: cloth, roughness: 0.9, side: THREE.DoubleSide }));
  pennant.position.y = tall;
  flag.add(stick, pennant);
  return flag;
}
