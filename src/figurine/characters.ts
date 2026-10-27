// The characters, as plain data (like the scans in scan-list.ts): the model, which of its
// clips plays each move, what it can do, and how it moves where that differs from the
// defaults. Code asks for a move (`walk`, `airJump`) and what the character in play can do,
// never which character it is (context/movement.md).

import type { MoveSettings } from './movement';

/** The moves a character animates. */
export type Move = 'idle' | 'walk' | 'sprint' | 'jumpStart' | 'rise' | 'fall' | 'land' | 'airJump' | 'climb';

/** How a move plays a clip: the whole clip by name, or one frame of it held as a pose (`hold`:
 *  seconds into the clip), for a move the model has no clip of its own for. */
export type ClipUse = string | { clip: string; hold: number };

/** How each move plays: looping, or once (then holding its last frame). A held frame is held either way. */
export const MOVE_PLAYS: Record<Move, 'loop' | 'once'> = {
  idle: 'loop', walk: 'loop', sprint: 'loop', climb: 'loop',
  jumpStart: 'once', rise: 'once', fall: 'once', land: 'once', airJump: 'once',
};

/** A move with no clip given plays this one instead (and so on down the chain). */
export const MOVE_FALLBACK: Partial<Record<Move, Move>> = { sprint: 'walk', airJump: 'jumpStart', rise: 'fall', fall: 'idle', land: 'idle', jumpStart: 'rise' };

export interface CharacterEntry {
  id: string;
  label: string;
  model: string;                             // under public/
  height: number;                            // world units, feet to top: the model is scaled to it
  clips: Partial<Record<Move, ClipUse>>;     // move → how this model shows it
  climbs: boolean;                           // jumping into a wall grabs it
  abilities: string[];                       // ids in ABILITIES (abilities.ts)
  tune: Partial<MoveSettings>;               // only what differs from MOVE_DEFAULTS
}

export const CHARACTERS: CharacterEntry[] = [
  {
    // The figurine: "Free Pack – Chibi Base Mesh (Rigged)" by PolyOne Studio, CC BY 4.0, with
    // Mixamo animations retargeted onto it (context/character-README.md). It has no clip for
    // rising (its one-frame jump_loop shows rising and falling) or for landing.
    id: 'chibi',
    label: 'Chibi',
    model: 'characters/chibi.glb',
    height: 0.45,
    clips: { idle: 'idle', walk: 'walk', sprint: 'run', jumpStart: 'jump_start', fall: 'jump_loop', climb: 'climb' },
    climbs: true,
    abilities: ['doubleJump'],
    tune: {},
  },
];
