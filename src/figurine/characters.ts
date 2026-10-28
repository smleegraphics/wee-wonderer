// The characters, as plain data (like the scans in scan-list.ts): the model, which of its
// clips plays each move, what it can do, and how it moves where that differs from the
// defaults. Code asks for a move (`walk`, `airJump`) and what the character in play can do,
// never which character it is (context/movement.md).

import type { MoveSettings } from './movement';

/** The moves a character animates. */
export type Move = 'idle' | 'walk' | 'sprint' | 'jumpStart' | 'rise' | 'fall' | 'land' | 'airJump' | 'climb' | 'ledgeHang' | 'mantle';

/** How a move plays a clip: the whole clip by name, or one frame of it held as a pose (`hold`:
 *  seconds into the clip), for a move the model has no clip of its own for. */
export type ClipUse = string | { clip: string; hold: number };

/** How each move plays: looping, or once (then holding its last frame). A held frame is held either way. */
export const MOVE_PLAYS: Record<Move, 'loop' | 'once'> = {
  idle: 'loop', walk: 'loop', sprint: 'loop', climb: 'loop', ledgeHang: 'loop',
  jumpStart: 'once', rise: 'once', fall: 'once', land: 'once', airJump: 'once', mantle: 'once',
};

/** A move with no clip given plays this one instead (and so on down the chain). */
export const MOVE_FALLBACK: Partial<Record<Move, Move>> = { sprint: 'walk', airJump: 'jumpStart', rise: 'fall', fall: 'idle', land: 'idle', jumpStart: 'rise', ledgeHang: 'climb', mantle: 'climb' };

export interface CharacterEntry {
  id: string;
  label: string;                             // its name, for screen readers and as a tooltip: the Characters card shows its picture
  model: string;                             // under public/
  thumb: string;                             // its picture in the Characters card, under public/, made by scripts/character-thumbs.mjs
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
    // Mixamo animations retargeted onto it (context/character-README.md); its landing is our own,
    // keyed in Blender (art/characters/chibi/). It has no clip for rising (its one-frame jump_loop
    // shows rising and falling).
    id: 'chibi',
    label: 'Chibi',
    model: 'characters/chibi.glb',
    thumb: 'characters/chibi.webp',
    height: 0.45,
    radius: 0.22,
    clips: { idle: 'idle', walk: 'walk', sprint: 'run', jumpStart: 'jump_start', fall: 'jump_loop', land: 'land', climb: 'climb', ledgeHang: 'hang', mantle: 'mantle' },
    climbs: true,
    abilities: ['doubleJump'],
    tune: {},
  },
  {
    // Skeleton_Minion from "KayKit: Skeletons Character Pack" 1.0 by Kay Lousberg, CC0 1.0
    // (CREDITS.md), cut down to the clips below (context/movement.md, "Adding a character").
    // Its take-off, in-air and landing clips stay in place. Its climb is our own, keyed in Blender
    // (art/characters/skeleton/).
    id: 'skeleton',
    label: 'Skeleton',
    model: 'characters/skeleton.glb',
    thumb: 'characters/skeleton.webp',
    height: 0.45,
    radius: 0.14, // body width at mid height 0.36 of its height, against the chibi's 0.58 at radius 0.22
    clips: {
      idle: 'Idle', walk: 'Walking_A', sprint: 'Running_A', jumpStart: 'Jump_Start', fall: 'Jump_Idle', land: 'Jump_Land', climb: 'climb', ledgeHang: 'hang', mantle: 'mantle',
    },
    climbs: true,
    abilities: ['doubleJump'],
    tune: {},
  },
  {
    // character-female-f from "Mini Characters" 1.0 by Kenney, CC0 1.0 (CREDITS.md), cut down to
    // the clips below with its colour map embedded, and its walk and run hop taken down
    // (context/movement.md, "The mini's hop"). Her climb is our own, keyed in Blender
    // (art/characters/poppy/).
    id: 'mini',
    label: 'Poppy',
    model: 'characters/mini.glb',
    thumb: 'characters/mini.webp',
    height: 0.45,
    radius: 0.25, // body width at mid height 0.65 of its height (the big head and hair), against the chibi's 0.58 at radius 0.22
    clips: {
      idle: 'idle', walk: 'walk', sprint: 'sprint', jumpStart: 'jump', fall: 'fall', land: 'land', climb: 'climb', ledgeHang: 'hang', mantle: 'mantle',
    },
    climbs: true,
    abilities: ['doubleJump'],
    tune: { paceScale: 0.65 }, // her block legs never plant: measured by their sweep at the ground they cycled too slowly, by their average too fast; set by eye
  },
];
