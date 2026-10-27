// The characters, as plain data (like the scans in scan-list.ts): the model, which of its
// clips plays each move, what it can do, and how it moves where that differs from the
// defaults. Code asks for a move (`walk`, `airJump`) and what the character in play can do,
// never which character it is (context/movement.md).

import type { MoveSettings } from './movement';

/** The moves a character animates. */
export type Move = 'idle' | 'walk' | 'sprint' | 'jumpStart' | 'rise' | 'fall' | 'land' | 'airJump' | 'climb' | 'ledgeHang';

/** How a move plays a clip: the whole clip by name, or one frame of it held as a pose (`hold`:
 *  seconds into the clip), for a move the model has no clip of its own for. */
export type ClipUse = string | { clip: string; hold: number };

/** How each move plays: looping, or once (then holding its last frame). A held frame is held either way. */
export const MOVE_PLAYS: Record<Move, 'loop' | 'once'> = {
  idle: 'loop', walk: 'loop', sprint: 'loop', climb: 'loop', ledgeHang: 'loop',
  jumpStart: 'once', rise: 'once', fall: 'once', land: 'once', airJump: 'once',
};

/** A move with no clip given plays this one instead (and so on down the chain). */
export const MOVE_FALLBACK: Partial<Record<Move, Move>> = { sprint: 'walk', airJump: 'jumpStart', rise: 'fall', fall: 'idle', land: 'idle', jumpStart: 'rise', ledgeHang: 'climb' };

export interface CharacterEntry {
  id: string;
  label: string;
  model: string;                             // under public/
  height: number;                            // world units, feet to top: the model is scaled to it
  radius: number;                            // the collision capsule's radius, in body heights (BODY.radius): how wide it is to walls
  clips: Partial<Record<Move, ClipUse>>;     // move → how this model shows it
  climbs: boolean;                           // jumping into a wall grabs it
  abilities: string[];                       // ids in ABILITIES (abilities.ts)
  tune: Partial<MoveSettings>;               // only what differs from MOVE_DEFAULTS
}

/** Every character, in the order the Characters card lists them; the first is the default. All
 *  are the old figurine's height, so the rooms and every setting in body heights are the same
 *  whichever is in play. Credits for each are in CREDITS.md and the Credits card. */
export const CHARACTERS: CharacterEntry[] = [
  {
    // The figurine: "Free Pack – Chibi Base Mesh (Rigged)" by PolyOne Studio, CC BY 4.0, with
    // Mixamo animations retargeted onto it (context/character-README.md). It has no clip for
    // rising (its one-frame jump_loop shows rising and falling) or for landing.
    id: 'chibi',
    label: 'Chibi',
    model: 'characters/chibi.glb',
    height: 0.45,
    radius: 0.22,
    clips: { idle: 'idle', walk: 'walk', sprint: 'run', jumpStart: 'jump_start', fall: 'jump_loop', climb: 'climb' },
    climbs: true,
    abilities: ['doubleJump'],
    tune: {},
  },
  {
    // RobotExpressive by Tomás Laulhé (Quaternius), CC0 1.0, from the three.js examples. No
    // clips for rising, falling or climbing: those hold frames of its Jump.
    id: 'robot',
    label: 'Robot',
    model: 'characters/robot.glb',
    height: 0.45,
    radius: 0.22, // the chibi's: it measures as wide (0.31 of its height across the trunk)
    clips: {
      idle: 'Idle', walk: 'Walking', sprint: 'Running', jumpStart: 'Jump',
      rise: { clip: 'Jump', hold: 0.3 }, fall: { clip: 'Jump', hold: 0.45 }, climb: { clip: 'Jump', hold: 0.3 },
    },
    climbs: true,
    abilities: ['doubleJump'],
    tune: {},
  },
  {
    // "Animated Human" by Quaternius, CC0 1.0 (OpenGameArt), converted from its FBX with its
    // ClothedLightSkin palette (CREDITS.md). No clips for rising, falling or climbing: those
    // hold frames of its Jump.
    id: 'human',
    label: 'Human',
    model: 'characters/human.glb',
    height: 0.45,
    radius: 0.16, // the chibi's 0.22 scaled by how much slimmer it measures: 0.23 of its height across the trunk against the chibi's 0.31
    clips: {
      idle: 'Idle', walk: 'Walk', sprint: 'Run', jumpStart: 'Jump',
      rise: { clip: 'Jump', hold: 0.35 }, fall: { clip: 'Jump', hold: 0.55 }, climb: { clip: 'Jump', hold: 0.35 },
    },
    climbs: true,
    abilities: ['doubleJump'],
    tune: {},
  },
];
