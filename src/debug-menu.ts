// The Debug card's tunables (the wrench tile, or the ` key).

import { hud } from './app';
import { applyVoxelView, overlayBoxes, PLATFORM_OPTS, rebuildCollision, rebuildPlatformOverlay, setCleanupOverlay, setDensityOverlay, setPlatformOverlay, setVoxelOverlay, showCleanup, showDensity, showPlatforms, showVoxels, VOXEL_OPTS, VOXEL_VIEW, voxelSet, type VoxelSettings, voxelSliders } from './collision/room-collision';
import { GOD_CAM, setGodCam } from './figurine/camera';
import { CLIMB_TILT } from './figurine/climb';
import { MOVE, moveSet, type MoveSettings, moveSliders } from './figurine/movement';
import { CONTACT_SHADOW } from './lighting/contact-shadow';
import { applyScanLight, requestScanLight, SCAN_LIGHT } from './lighting/scan-light';
import { CLEAN_OPTS, recleanUpload } from './scan/import';
import { applyFillView, FILL_VIEW, refillWalkable, WALK_FILL } from './scan/walk-fill';

// The Debug card (the wrench tile, or the ` key). Put new debug tunables here, in
// the section they belong to, rather than reaching for URL params.
export function setupDebugMenu(): void {
  const overlays = hud.debug.section('Overlays', true);
  overlayBoxes.voxel = overlays.addToggle('Voxel wireframe (V)', showVoxels, setVoxelOverlay,
    'Draw the collision mesh over the scan as a wireframe.');
  overlays.addToggle('Free camera', GOD_CAM.on, setGodCam,
    'Let the camera off the figurine: drag to orbit, right-drag to pan, scroll to zoom, as far as you like.');
  overlayBoxes.platform = overlays.addToggle('Platforms (P)', showPlatforms, setPlatformOverlay,
    'Spike 1: color the walkable surfaces the collision decomposes into — floor, ' +
    'couch, counter. Distinct colors = distinct platforms (reached by climbing/jumping).');
  overlayBoxes.density = overlays.addToggle('Density voxels', showDensity, setDensityOverlay,
    'Draw the density grid the collision is made from, before cleanup: a cube for each voxel dense enough to be solid ' +
    '(the outside ones), pale blue when just over the isovalue, deep blue when far over it. Builds it the first time it is shown.');
  overlayBoxes.cleanup = overlays.addToggle('Cleanup voxels', showCleanup, setCleanupOverlay,
    'Draw the voxel grid after cleanup, coloured by what cleanup did: grey where it kept the voxel, purple where it filled ' +
    'one in (holes closed, floor and panels filled), orange where it took one away (small stray clumps; see Cleanup progress).');
  overlays.addSlider('Density shown from (× isovalue)', VOXEL_VIEW.densityFrom, 1, 200, 0.01, (v) => { VOXEL_VIEW.densityFrom = v; applyVoxelView(); },
    'Density voxels: draw only the voxels at least this dense, as a multiple of the isovalue (1 = every solid one). ' +
    'Raise it to see which parts of the scan are barely solid: they go first.');
  overlays.addSlider('Cleanup progress', VOXEL_VIEW.cleanup, 0, 2, 0.01, (v) => { VOXEL_VIEW.cleanup = v; applyVoxelView(); },
    'Cleanup voxels: 0 = before cleanup, with what it will remove in orange; to 1 those shrink away; to 2 what it fills in ' +
    '(purple) grows in; 2 = after.');

  const moving = hud.debug.section('Movement');
  /** A slider for one movement setting: it holds for the session, whatever character is in play (moveSet). */
  const moveSlider = (key: keyof MoveSettings, label: string, min: number, max: number, step: number, help: string) => {
    moveSliders[key] = moving.addSlider(label, MOVE[key], min, max, step, (v) => { moveSet[key] = MOVE[key] = v; }, help);
  };
  moveSlider('walkSpeed', 'Walk speed', 0.5, 4, 0.1, 'Walking pace, in body heights a second.');
  moveSlider('sprintSpeed', 'Sprint speed', 1, 8, 0.1, 'Top speed with Shift held, in body heights a second.');
  moveSlider('sprintRamp', 'Sprint build-up (s)', 0.05, 2, 0.05, 'Seconds from a walk to a full sprint with Shift held, and back down on letting go.');
  moveSlider('accelTime', 'Start-up (s)', 0.01, 0.5, 0.01, 'Seconds from standing to walking pace. Lower = snappier starts.');
  moveSlider('stopTime', 'Stopping (s)', 0.01, 0.5, 0.01, 'Seconds from walking pace to standing on letting go. Lower = stops on a dime.');
  moveSlider('airControl', 'Air control', 0, 1, 0.05, 'How much you can steer in the air, as a share of on the ground. 0 = a jump goes where it was aimed.');
  moveSlider('jumpHeight', 'Jump height', 0.2, 2, 0.05, 'How high a full jump rises, in body heights. Changes what the game thinks can be reached (lava routes, hints).');
  moveSlider('airJumpHeight', 'Air jump height', 0.1, 2, 0.05, 'How high the double jump rises from where it is made, in body heights.');
  moveSlider('gravity', 'Gravity', 2, 30, 0.5, 'How strongly a jump is pulled down, in body heights a second². Higher = quicker, snappier jumps (keep the height by raising Jump height).');
  moveSlider('fallGravity', 'Fall gravity ×', 1, 3, 0.05, 'Gravity while falling, as a multiple of rising. Above 1 drops faster than it rose: a snappier, less floaty jump.');
  moveSlider('jumpCut', 'Short-hop cut', 0.1, 1, 0.05, 'Letting go of Space while rising keeps this share of the upward speed: lower = a tap is a smaller hop. 1 = every jump is full height.');
  moveSlider('coyoteTime', 'Late jump grace (s)', 0, 0.3, 0.01, 'Seconds after walking off an edge that Space still jumps as if from the ground.');
  moveSlider('jumpBuffer', 'Early jump grace (s)', 0, 0.3, 0.01, 'Seconds before landing that a press of Space is remembered and jumps on touching down.');
  moveSlider('turnRate', 'Turning', 2, 30, 1, 'How quickly the figurine turns to face where it is going.');
  moveSlider('paceScale', 'Clip pace ×', 0.3, 2, 0.05, 'The walk and run clips play as if made for this times their measured pace: lower = legs cycle faster. For a character whose legs never plant, set by eye, then written into its tune.');

  const climbing = hud.debug.section('Climbing');
  climbing.addToggle('Tilt with the wall', CLIMB_TILT.on, (on) => { CLIMB_TILT.on = on; },
    'While climbing, lean the figure with the wall: into a face that leans away, back under one that leans over it. The figure only: the body that collides stays upright.');
  climbing.addSlider('Most tilt (deg)', CLIMB_TILT.max, 0, 90, 1, (v) => { CLIMB_TILT.max = v; },
    'The furthest the figure leans either way while climbing.');

  const light = hud.debug.section('Lighting and shadow');
  light.addToggle('Contact shadow', CONTACT_SHADOW.on, (on) => { CONTACT_SHADOW.on = on; },
    'Darken the scan in a soft patch where the figurine touches it (the floor under its feet, or the wall it is climbing).');
  light.addSlider('Shadow darkness', CONTACT_SHADOW.darkness, 0, 1, 0.05, (v) => { CONTACT_SHADOW.darkness = v; },
    'How dark the contact shadow gets at its centre.');
  light.addSlider('Shadow size', CONTACT_SHADOW.size, 0.2, 1.5, 0.05, (v) => { CONTACT_SHADOW.size = v; },
    'Radius of the shadow, in figurine heights.');
  light.addToggle('Scan lighting', SCAN_LIGHT.on, (on) => { SCAN_LIGHT.on = on; applyScanLight(); },
    'Light the figurine from the scan itself (a cubemap of the splats, captured at the figurine) instead of the fixed ambient fill.');
  light.addToggle('Follow figurine', SCAN_LIGHT.follow, (on) => { SCAN_LIGHT.follow = on; if (on) requestScanLight(); },
    'Re-capture the light as the figurine moves, so it changes from place to place. Off = captured once at the spawn point.');
  light.addToggle('Fill gaps', SCAN_LIGHT.fill, (on) => { SCAN_LIGHT.fill = on; requestScanLight(); },
    'Where the scan has nothing (usually the ceiling), light the figurine with the average colour of the scan\'s upper half instead of darkness.');
  light.addToggle('Light debug view', SCAN_LIGHT.debug, (on) => { SCAN_LIGHT.debug = on; applyScanLight(); },
    'Show what the light probe captured (panorama, top-left: up is at the top) and three balls lit by it: mirror, half-rough metal, matte white.');
  light.addSlider('Light strength', SCAN_LIGHT.intensity, 0, 3, 0.05, (v) => { SCAN_LIGHT.intensity = v; applyScanLight(); },
    'How strongly the scan lights the figurine.');
  light.addSlider('Light blend (s)', SCAN_LIGHT.blend, 0, 2, 0.1, (v) => { SCAN_LIGHT.blend = v; },
    'Seconds to cross-fade from one light capture to the next in follow mode. 0 = swap instantly.');

  const fill = hud.debug.section('Patch splat holes');
  fill.addToggle('Patch holes', WALK_FILL.on, (on) => { WALK_FILL.on = on; applyFillView(); },
    'Where the ground the figurine can stand on lets the backdrop through, draw flat splats coloured from the ground around the gap.');
  fill.addToggle('Highlight fill', FILL_VIEW.highlight, (on) => { FILL_VIEW.highlight = on; applyFillView(); },
    'Draw the added splats in bright pink, to see where they are. They lie just under the ground\'s own splats, so pink shows only where the scan lets it through.');
  fill.addToggle('Fill only', FILL_VIEW.only, (on) => { FILL_VIEW.only = on; applyFillView(); },
    'Hide the scan\'s own splats and draw just the added ones. Compare with the Platforms overlay: the fill covers the same ground.');
  fill.addSlider('Fill opacity', FILL_VIEW.opacity, 0, 1, 0.05, (v) => { FILL_VIEW.opacity = v; applyFillView(); },
    'Fade the added splats, to compare with the bare scan.');
  fill.addSlider('Fill where under (opacity)', WALK_FILL.under, 0.1, 0.95, 0.05, (v) => { WALK_FILL.under = v; void refillWalkable(true); },
    'Fill a spot when the scan\'s ground there is less opaque than this. Higher fills thinner patches too, and starts to blur ground that was fine (a rug\'s seams). Works the fill out again.');
  fill.addSlider('Smallest level patch (cells)', WALK_FILL.patch, 1, 200, 1, (v) => { WALK_FILL.patch = v; void refillWalkable(true); },
    'Fill only level ground of at least this many walkable cells. Lower takes in small tops (a box, a toy), where a flat sheet fits badly. Works the fill out again.');
  fill.addSlider('Fill spacing (voxels)', WALK_FILL.cell, 0.25, 1, 0.25, (v) => { WALK_FILL.cell = v; void refillWalkable(true); },
    'Distance between the added splats, in collision voxels. Smaller = more, smaller splats. Works the fill out again.');

  const ground = hud.debug.section('Ground and platforms');
  ground.addSlider('Step limit', PLATFORM_OPTS.stepFactor, 0.1, 1, 0.05, (v) => {
    PLATFORM_OPTS.stepFactor = v; rebuildPlatformOverlay();
  }, 'Max height (in char-heights) two neighboring cells can differ and still be ONE ' +
     'platform. Higher = merges steps/bumps into one surface; lower = splits into more platforms.');
  ground.addSlider('Min platform size', PLATFORM_OPTS.minCells, 1, 40, 1, (v) => {
    PLATFORM_OPTS.minCells = v; rebuildPlatformOverlay();
  }, 'Drop platforms smaller than this many cells (floater/noise rejection). Higher = only big surfaces survive.');
  ground.addSlider('Climb threshold (deg)', PLATFORM_OPTS.climbDeg, 30, 89, 1, (v) => { PLATFORM_OPTS.climbDeg = v; rebuildPlatformOverlay(); },
    'Surfaces steeper than this angle (from the ground) are walls you CLIMB; gentler ones are ' +
    'ground you walk on. Lower = more things count as walls; higher = only near-vertical faces.');
  ground.addSlider('Grab below threshold (deg)', PLATFORM_OPTS.grabBelow, 0, 30, 1, (v) => { PLATFORM_OPTS.grabBelow = v; },
    'A jump grabs surfaces this many degrees gentler than the Climb threshold, so a slope between the two is both: ' +
    'ground you walk up, and a face you can jump at. 0 = one cutoff for both. Small scanned objects come out with sloped ' +
    'sides in the collision mesh (Kitchen\'s bulldozer: 62° to 68°).');

  const surface = hud.debug.section('Collision surface');
  /** A slider for one collision setting. Moving it sets that for the session (voxelSet) and rebuilds. */
  const voxelSlider = (key: keyof VoxelSettings, label: string, min: number, max: number, step: number, help: string) => {
    voxelSliders[key] = surface.addSlider(label, VOXEL_OPTS[key], min, max, step, (v) => {
      voxelSet[key] = VOXEL_OPTS[key] = v;
      rebuildCollision();
    }, help);
  };
  voxelSlider('iso', 'Isovalue (fill)', 0.15, 0.7, 0.05, 'Surface threshold as a fraction of median density. LOWER fills faint flat ' +
     'panels (cabinet doors, distant walls) but eventually admits floater haze; ' +
     'higher hugs only well-scanned surfaces. Default 0.35 suits casual scans.');
  voxelSlider('close', 'Surface hole-fill', 0, 5, 1, 'Bridges holes in the collision mesh (walls / climbable faces / floor) by ' +
     'closing gaps up to ~2× this many voxels. Higher fills bigger holes but welds ' +
     'objects to the floor / webs surfaces (a looser "seal"); big holes are better ' +
     'handled by the floor/panel fills. Default 1 keeps the seal tight.');
  voxelSlider('refine', 'Mesh detail (up to)', 1, 3, 1, 'What is solid is decided on the coarse collision grid, where a thinly scanned wall still adds up to a wall. ' +
     'The mesh can then be built on a grid 2 or 3 times finer and trimmed in to the splats. Each scan gets as fine a ' +
     'grid as it has splats for, up to this: a sparse scan stays at 1 whatever is set here, since a finer grid would ' +
     'only read its noise. The console line for each build says which detail it got.');
  voxelSlider('fillFloor', 'Ground gap fill (voxels)', 0, 40, 1, 'Makes bare stretches of the ground walkable when nothing this many voxels wide could get into them from outside, ' +
     'past the floor, walls and furniture round them (the figurine is about 5 voxels tall). Higher closes wider-mouthed ' +
     'bays; 1 fills only holes with floor all round; 0 = off. Only the ground: a worktop or table keeps its edges.');
  voxelSlider('panelFill', 'Panel fill (area)', 0, 4, 0.25, 'Fills enclosed holes in flat vertical panels (blank cabinet doors / walls that ' +
     'splatting captured too faintly) up to this area, in normalized scan units² ' +
     '(~room-relative — not metres). Bigger fills larger blank panels but can start ' +
     'closing real openings (doorways/windows); 0 = off. Default 2.5.');
  voxelSlider('floorFlat', 'Floor flatten (grains)', 0, 3, 0.25, 'The collision within this many grains of the ground is flattened onto the level the ground is drawn at ' +
     '(a grain is about a fifth of the figurine). Higher = flatter, and more low clutter (a rug, a board, the foot ' +
     'of a toy) becomes floor; lower leaves the top of the floor uneven. Only ground that is flat is flattened: ' +
     'a blanket is left as it is. 0 = off.');

  // cleanup tunables for imported scans (re-clean + reload the active upload)
  const cleanup = hud.debug.section('Import cleanup');
  cleanup.addSlider('Opacity floor (room box)', CLEAN_OPTS.alphaMin ?? 0.35, 0, 0.9, 0.05, (v) => { CLEAN_OPTS.alphaMin = v; void recleanUpload(); },
    'For imported scans: the box round the room (what is drawn) is worked out from splats at least this opaque, so far-off faint spray does not stretch it. Not the collision.');
  cleanup.addSlider('Density (room box)', CLEAN_OPTS.minMass ?? 4, 0, 12, 0.5, (v) => { CLEAN_OPTS.minMass = v; void recleanUpload(); },
    'For imported scans: the box round the room (what is drawn) is worked out from splats in voxels with at least this much opacity. Not the collision.');
  cleanup.addToggle('Crop to room', CLEAN_OPTS.crop ?? true, (on) => { CLEAN_OPTS.crop = on; void recleanUpload(); },
    'For imported scans: auto-level and crop to the room box (removes far background spray).');
}
