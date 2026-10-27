// Abilities: moves beyond walking, jumping and climbing, which a character has on its own or
// gets from an accessory (the double jump now; gliding or flying later). Each hooks into the
// controller through the same few calls, and the loadout in play is the list the character
// and its accessories give (context/movement.md).

import { MOVE } from './movement';

/** What an ability can ask of the controller when it acts. */
export interface AirMove {
  /** Launch upward to rise `height` body heights, keeping the horizontal speed. */
  launch(height: number): void;
}

export interface Ability {
  /** Space pressed in the air, with no jump from the ground left to make. True if it acted. */
  airJump?(move: AirMove): boolean;
  /** Touched down: anything spent in the air is back. */
  landed?(): void;
  /** The heights (body heights) of the jumps it makes in the air, for the movement model (collision-health.ts). */
  airJumps?(): number[];
}

/** The air jump: `count` more jumps in the air before landing again. */
class AirJump implements Ability {
  private left: number;
  constructor(private readonly count: number, private readonly height: () => number) { this.left = count; }
  airJump(move: AirMove): boolean {
    if (this.left <= 0) return false;
    this.left--;
    move.launch(this.height());
    return true;
  }
  landed(): void { this.left = this.count; }
  airJumps(): number[] { return Array(this.count).fill(this.height()); }
}

/** Every ability, by the id a character or accessory lists it under. */
export const ABILITIES: Record<string, () => Ability> = {
  doubleJump: () => new AirJump(1, () => MOVE.airJumpHeight),
};

/** The abilities in play, made from the ids the character and its accessories list. */
export function loadout(ids: string[]): Ability[] {
  return ids.flatMap((id) => (ABILITIES[id] ? [ABILITIES[id]()] : []));
}
