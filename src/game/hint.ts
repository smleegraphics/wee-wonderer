// The hint: an arrow over the figurine's head, pointing where to go next, shown once the
// player has gone HINT.after seconds without making progress in the room's theme and
// hidden again the moment they do. The theme says what progress is and where to point
// (ThemeRun.progress, hintTarget); this only times it and draws it (context/game.md).

import * as THREE from 'three';
import { hud, player } from '../app';
import { charH } from '../figurine/character';

/** after: seconds without progress before the arrow shows. A first guess: long enough to
 *  look around a room, short enough not to give up in it. */
export const HINT = { after: 20 };
const OVER_HEAD = 1.45; // body heights above the feet the arrow floats at
const LENGTH = 0.4;     // body heights, tip to tail

export class Hint {
  readonly object = new THREE.Group(); // in the world; turned to the target each frame
  private idle = 0;
  private clock = 0;
  private readonly target = new THREE.Vector3(); // where it last pointed (telemetry)

  constructor() {
    const mat = new THREE.MeshStandardMaterial({ color: hud.token('--accent'), roughness: 0.6, emissive: hud.token('--accent'), emissiveIntensity: 0.35 });
    const len = charH * LENGTH, head = len * 0.45;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(len * 0.09, len * 0.09, len - head, 10), mat);
    shaft.rotation.x = Math.PI / 2; // along +Z, which lookAt turns to the target
    shaft.position.z = -head / 2;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(len * 0.22, head, 14), mat);
    tip.rotation.x = Math.PI / 2;
    tip.position.z = (len - head) / 2;
    this.object.add(shaft, tip);
    this.object.visible = false;
  }

  /** The player has just made progress: hide the arrow and start counting again. */
  reset(): void { this.idle = 0; }

  /** Per frame while playing. `target`: where the arrow points, or null for nowhere (it hides). */
  update(dt: number, target: THREE.Vector3 | null): void {
    this.idle += dt;
    this.clock += dt;
    const show = target !== null && this.idle >= HINT.after;
    this.object.visible = show;
    if (!show) return;
    const p = player.position;
    this.object.position.set(p.x, p.y + charH * (OVER_HEAD + 0.05 * Math.sin(this.clock * 3)), p.z);
    this.object.lookAt(target); // tilts up or down too, so a climb reads as one
    this.target.copy(target);
  }

  /** Hide it (the room is not there to play in). The count carries on from where it was. */
  hide(): void { this.object.visible = false; }

  /** ?tel=1: whether it shows, where it points, and how long it has been without progress. */
  debug() { return { shown: this.object.visible, at: this.target.toArray(), idle: +this.idle.toFixed(1) }; }
}
