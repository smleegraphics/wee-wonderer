// What a theme is: a rule the room is played by, which rooms it suits, and what it puts in
// them (context/game.md). The game (game.ts) picks one per room and runs it.

import type * as THREE from 'three';
import type { RoomShape } from './room-shape';

export interface Theme {
  id: string;
  /** Said once, as the room arrives. */
  intro: string;
  /** Why the room does not suit this theme, or null if it does. */
  unsuited(shape: RoomShape): string | null;
  begin(shape: RoomShape): ThemeRun;
}

/** A theme being played in one room. */
export interface ThemeRun {
  object: THREE.Object3D;          // what it adds to the scene (the game shows it once the room has arrived)
  start: THREE.Vector3 | null;     // where the figurine starts, if not the room's own spawn
  goal: string;                    // the goal card's text: set when it changes (read every frame)
  update(dt: number): void;        // per frame, while the room is there to play in
  progress: number;                // goes up each time the player gets closer to the goal: the hint (hint.ts) waits for it to stop
  /** Where the hint should point now, into `out`; false for nowhere (the goal is reached). */
  hintTarget(out: THREE.Vector3): boolean;
  /** ?tel=1: what a headless check needs to know about it (where its things are, how far along it is). */
  debug(): Record<string, unknown>;
  dispose(): void;
}

/** The world position of walkable cell `i`. */
export function cellPosition(shape: RoomShape, i: number, out: THREE.Vector3): THREE.Vector3 {
  const P = shape.walk.positions;
  return out.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
}

/** Dispose every geometry and material under `root`. */
export function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    for (const mat of Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) mat.dispose();
  });
}
