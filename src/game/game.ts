// The game a room is played as: its shape is read once its walkable cells are built, a
// theme that suits it is picked, and that theme runs while the room is there to play in
// (context/game.md).

import * as THREE from 'three';
import { hud, scene, WORLD_UP } from '../app';
import { collision, groundY, navField, navVersion } from '../collision/room-collision';
import { charH, charLoaded, placeFigurine, resetToSpawn, roomSpawn } from '../figurine/character';
import { reachModel } from '../figurine/climb';
import { loadingViewOn, revealProgress } from '../scan/room';
import { realCells } from '../scan/walk-fill';
import { Hint } from './hint';
import { lavaTheme } from './lava';
import { type RoomShape, roomShape } from './room-shape';
import { spilledPackTheme } from './spilled-pack';
import { disposeTree, type Theme, type ThemeRun } from './theme';

/** lava: play the floor is lava wherever the room suits it (the Debug card). */
export const GAME = { lava: true };
/** Every theme, in the order they are preferred. The last suits any room. */
const THEMES: Theme[] = [lavaTheme, spilledPackTheme];

let shape: RoomShape | null = null;
let theme: Theme | null = null;
let run: ThemeRun | null = null;
let builtFor = -1;   // the navVersion the game was set up for
let introduced = false;
let goalShown: string | null = null;
let hint: Hint | null = null;     // made with the first game: it needs the figurine's height
let progressSeen = 0;             // the run's progress when the hint last heard of it
const hintAt = new THREE.Vector3();

/** Per frame. Sets the game up again whenever the walkable cells are rebuilt (a new room,
 *  the figurine's real height, a Debug slider), and plays it once the room has arrived. */
export function updateGame(dt: number): void {
  if (!collision || !navField || !charLoaded) { if (run) end(); return; } // no room (it has been taken away), or no figurine yet
  if (navVersion !== builtFor) begin();
  if (!run || !theme) return;
  const arrived = revealProgress >= 1 && !loadingViewOn(); // (leaving, the room goes back into the sheet: below 1)
  run.object.visible = arrived;
  showGoal(arrived ? run.goal : null);
  if (!arrived) { hint?.hide(); return; }
  if (!introduced) { hud.status(theme.intro, 'done'); introduced = true; }
  run.update(dt);
  if (!hint) { hint = new Hint(); scene.add(hint.object); }
  if (run.progress !== progressSeen) { progressSeen = run.progress; hint.reset(); }
  hint.update(dt, run.hintTarget(hintAt) ? hintAt : null);
}

/** Back to the start of the room's game (the Back to the start tile). Progress is kept. */
export function restartGame(): void {
  if (run?.start) placeFigurine(run.start, true);
  else resetToSpawn();
}

/** Set the game up again on the next frame (a Debug setting changed). */
export function replayGame(): void { builtFor = -1; }

/** Why each theme does or does not suit the current room, for the Debug card. */
export function themeFit(): string {
  if (!shape) return 'No room yet.';
  return THEMES.map((t) => `${t.id}: ${t.unsuited(shape!) ?? 'suits'}`).join('; ');
}

/** ?tel=1: the game's state, for headless checks. */
export function gameDebug(): Record<string, unknown> | null {
  return run && theme && shape ? { theme: theme.id, goal: run.goal, fit: themeFit(), progress: run.progress, hint: hint?.debug() ?? null, ...run.debug() } : null;
}

const upFrom = new THREE.Vector3(), spawnAt = new THREE.Vector3();
function begin(): void {
  end();
  builtFor = navVersion;
  const t0 = performance.now();
  const p = roomSpawn(spawnAt); // what can be reached is worked out from the room's own start
  shape = roomShape({
    ...reachModel(navField!),
    spawn: [p.x, p.y, p.z], groundY, bodyHeight: charH, realCells: realCells(),
    overhead: (x, y, z, max) => collision!.rayDistance(upFrom.set(x, y, z), WORLD_UP, max) < max,
  });
  theme = THEMES.find((t) => (t !== lavaTheme || GAME.lava) && t.unsuited(shape!) === null) ?? THEMES[THEMES.length - 1];
  run = theme.begin(shape);
  run.object.visible = false;
  scene.add(run.object);
  placeFigurine(run.start ?? p, true);
  introduced = false;
  progressSeen = run.progress;
  hint?.reset(); // a new game starts its count afresh
  console.log(`game: ${theme.id} in ${(performance.now() - t0).toFixed(0)}ms (${themeFit()})`);
}

function end(): void {
  if (run) { scene.remove(run.object); disposeTree(run.object); run.dispose(); }
  run = null; theme = null; shape = null;
  showGoal(null);
  hint?.hide();
}

function showGoal(text: string | null): void {
  if (text === goalShown) return;
  goalShown = text;
  hud.setGoal(text);
}
