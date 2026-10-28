// How the figurine moves on the ground and in the air: the settings every character starts
// from, and the ones in play (a character's own on top: characters.ts). Speeds are in body
// heights a second, heights in body heights, times in seconds, so a bigger or smaller
// character moves the same way relative to itself (context/movement.md).

/** The defaults. The jump's rise and the sprint's top speed are the old controller's (a rise of
 *  0.57 and a run of 4.0); the movement model (collision-health.ts's reach) reads them, so changing
 *  them changes what it says can be reached (scripts/jumpcheck.mjs). */
export const MOVE_DEFAULTS = {
  walkSpeed: 1.6,     // walking pace: the walk clip reads right at this (character README)
  sprintSpeed: 4.0,   // top speed with Shift held: the run clip reads right at this
  sprintRamp: 0.6,    // seconds from a walk to a full sprint with Shift held, and back on letting go: a sprint builds, it does not switch
  accelTime: 0.12,    // seconds from standing to walking pace: short, so a tap moves at once, not instantly, so a start is not a jerk
  stopTime: 0.1,      // seconds from walking pace to standing on letting go
  airControl: 0.35,   // how much steering there is in the air, as a share of steering on the ground
  jumpHeight: 0.57,   // a jump held to the top rises this far
  airJumpHeight: 0.5, // the air jump rises this far from wherever it is made
  gravity: 9,         // body heights a second², rising
  fallGravity: 1,     // gravity falling, as a multiple of rising: above 1 drops faster than it rose (snappier), at a cost to how far a jump carries
  jumpCut: 0.45,      // letting go of Space while rising keeps this share of the upward speed: a tap is a hop
  coyoteTime: 0.1,    // seconds after walking off an edge that a jump still counts as from the ground
  jumpBuffer: 0.12,   // seconds before landing that a jump press is remembered and made on touching down
  turnRate: 12,       // how fast the figurine turns to face where it is going (per second, eased)
  paceScale: 1,       // the walk and run clips' measured pace is taken as this times itself: for legs that never plant, whose right pace is a matter of eye (clip-pace.ts); animation only
};
export type MoveSettings = typeof MOVE_DEFAULTS;

/** The settings in play: the defaults, then the character's own, then the Debug card's. */
export const MOVE: MoveSettings = { ...MOVE_DEFAULTS };
/** Settings changed in the Debug card this session: they hold whatever character is in play. */
export const moveSet: Partial<MoveSettings> = {};

/** Each setting's Debug slider: call to show a value on it. */
export const moveSliders: Partial<Record<keyof MoveSettings, (v: number) => void>> = {};

/** Make MOVE the defaults with `own` (a character's settings) and the session's on top, and show them on the sliders. */
export function useMoveSettings(own: Partial<MoveSettings>): void {
  Object.assign(MOVE, MOVE_DEFAULTS, own, moveSet);
  for (const key of Object.keys(MOVE) as (keyof MoveSettings)[]) moveSliders[key]?.(MOVE[key]);
}

/** The take-off speed (body heights a second) that rises `height` under MOVE.gravity. */
export const launchSpeed = (height: number) => Math.sqrt(2 * MOVE.gravity * height);
