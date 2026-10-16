// The example scans, as data only: no side effects and no import.meta.env, so the Vite
// config (vite.config.ts) and scripts/upload-scans.mjs can read it as well as the app.
// Where a scan is fetched from is decided in scans.ts (context/deploy.md).
import type { VoxelOptions } from './voxelize-core';

export interface ScanEntry {
  /** A plain file name: scans are kept flat, in scans/ and on the scan host alike. */
  file: string;
  label: string;
  /** Shown in the Scans card and uploaded to the scan host. Unlisted scans are local test scans. */
  listed: boolean;
  /** The scan's own collision settings, set by hand where the defaults do not suit it (useScanSettings in main.ts). */
  collision?: VoxelOptions;
}

/** The folder the scans are kept in locally, and the path the dev and preview servers serve it at. */
export const SCAN_DIR = 'scans';

// Known scans — config, not logic (each auto-levels at load). The listed ones are the
// scans in the switcher, and the first of them opens by default; an unlisted scan is a
// local test scan, loaded only by `?scan=` (CLAUDE.md, "Which scans ship").
export const SCANS: ScanEntry[] = [
  // Shipped as SPZ, converted from the cleaned .ply (context/deploy.md, "Scan files").
  { file: 'kitchen-clean.spz', label: 'Kitchen', listed: true }, // Mip-NeRF 360, floater-stripped (scripts/clean-scan.mjs)
  { file: 'livingroom-clean.spz', label: 'Living Room', listed: true },
  { file: 'counter-clean.spz', label: 'Counter', listed: true },
  { file: 'Marishka-clean.spz', label: 'Curled Up Dog', listed: true }, // a scan of our own: a dog on a blanket, the kind of capture a visitor brings
  { file: 'room2.ply', label: 'Playroom', listed: false, collision: { floorFlat: 2 } }, // not shipped: its licence is unclear. Kept for the checks that measure on it. Already tightly bounded — no cleanup needed. Its rug is uneven: ridges of it stand above the usual 1.5 grains and were left as bumps on the floor
];

export const LISTED_SCANS = SCANS.filter((s) => s.listed);
