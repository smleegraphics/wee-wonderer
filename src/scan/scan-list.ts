// The example scans, as data only: no side effects and no import.meta.env, so the Vite
// config (vite.config.ts) and scripts/upload-scans.mjs can read it as well as the app.
// Where a scan is fetched from is decided in scans.ts (context/deploy.md).
import type { VoxelOptions } from '../collision/voxelize-core';

export interface ScanEntry {
  /** A plain file name: scans are kept flat, in scans/ and on the scan host alike. */
  file: string;
  label: string;
  /** Shown in the Scans card and uploaded to the scan host. Unlisted scans are local test scans. */
  listed: boolean;
  /** The scan's own collision settings, set by hand where the defaults do not suit it (useScanSettings in collision/room-collision.ts). */
  collision?: VoxelOptions;
  /** false: its collision is built from every splat, not only those the floater filters keep
   *  (clean-scan-core.ts). For a scan whose room is what those filters take for floaters. */
  floaterFilter?: boolean;
}

/** The scan files the app reads, by name: what an import offers and accepts. (Which format a
 *  file is, is decided from its bytes: parse-scan.ts.) */
export const SCAN_FILE_TYPES = ['.ply', '.spz'];

/** The folder the scans are kept in locally, and the path the dev and preview servers serve it at. */
export const SCAN_DIR = 'scans';

// Known scans — config, not logic (each auto-levels at load). The listed ones are the
// scans in the switcher, and the first of them opens by default; an unlisted scan is a
// local test scan, loaded only by `?scan=` (CLAUDE.md, "Which scans ship").
export const SCANS: ScanEntry[] = [
  // Shipped as SPZ, converted from the .ply cropped to the room (scripts/clean-scan.mjs; context/deploy.md,
  // "Scan files"). Every splat in the room is kept and drawn; the collision is built from those the
  // floater filters keep, worked out at load (context/collision.md, "Scan cleanup").
  { file: 'kitchen-crop.spz', label: 'Kitchen', listed: true }, // Mip-NeRF 360
  { file: 'livingroom-crop.spz', label: 'Living Room', listed: true },
  { file: 'counter-crop.spz', label: 'Counter', listed: true },
  { file: 'record-player-table-crop.spz', label: 'Record Player Table', listed: true }, // our own, made with SpAItial: a sideboard with a record player, plants and a guitar
  { file: 'Marishka-clean.spz', label: 'Curled Up Dog', listed: false, floaterFilter: false }, // our own capture: a dog on a blanket, the kind of capture a visitor brings. No longer shipped (Record Player Table took its place); kept for the checks that measure on it (a soft scan with no flat ground). Its file is the old floater-stripped one, so its collision is built from every splat in it: filtering again is not a no-op (the size cap is a multiple of the median, which the first pass lowered) and moved its collision (holes in its spawn surface 1.1% to 5.8%)
  { file: 'room2.ply', label: 'Playroom', listed: false, collision: { floorFlat: 2 }, floaterFilter: false }, // not shipped: its licence is unclear. Kept for the checks that measure on it. Already tightly bounded — no cleanup needed. Its rug is uneven: ridges of it stand above the usual 1.5 grains and were left as bumps on the floor. Its walls, cabinets and floor are a few large faint splats each, which the floater filters take for floaters: its collision is built from every splat (context/collision.md, "Playroom cannot be cleaned by the floater cleaner")
];

export const LISTED_SCANS = SCANS.filter((s) => s.listed);
