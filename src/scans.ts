// The example scans and where they are fetched from. Data only, with no side effects,
// so scripts/upload-scans.mjs can read the same list the app shows (context/deploy.md).
import type { VoxelOptions } from './voxelize-core';

export interface ScanEntry {
  file: string;
  label: string;
  /** Shown in the Scans card and uploaded to the scan host. Unlisted scans are local test scans. */
  listed: boolean;
  /** The scan's own collision settings, set by hand where the defaults do not suit it (useScanSettings in main.ts). */
  collision?: VoxelOptions;
}

// Known scans — config, not logic (each auto-levels at load). The listed ones are the
// scans in the switcher, and the first of them opens by default; an unlisted scan is a
// local test scan, loaded only by `?scan=` (CLAUDE.md, "Which scans ship").
export const SCANS: ScanEntry[] = [
  { file: 'kitchen-clean.ply', label: 'Kitchen', listed: true }, // Mip-NeRF 360, floater-stripped (scripts/clean-scan.mjs)
  { file: 'livingroom-clean.ply', label: 'Living Room', listed: true },
  { file: 'counter-clean.ply', label: 'Counter', listed: true },
  { file: 'Marishka-clean.ply', label: 'Curled Up Dog', listed: true }, // a scan of our own: a dog on a blanket, the kind of capture a visitor brings
  { file: 'room2.ply', label: 'Playroom', listed: false, collision: { floorFlat: 2 } }, // not shipped: its licence is unclear. Kept for the checks that measure on it. Already tightly bounded — no cleanup needed. Its rug is uneven: ridges of it stand above the usual 1.5 grains and were left as bumps on the floor
];

export const LISTED_SCANS = SCANS.filter((s) => s.listed);

// Scans are not part of the app's bundle. Locally the dev and preview servers serve the
// gitignored scans/ folder at /scans/ (vite.config.ts); a public build sets
// VITE_SCAN_BASE to the scan host.
const base = import.meta.env.VITE_SCAN_BASE || `${import.meta.env.BASE_URL}scans/`;
const SCAN_BASE = base.endsWith('/') ? base : `${base}/`;

/** Where the example scan `file` is fetched from. */
export const scanURL = (file: string) => `${SCAN_BASE}${encodeURIComponent(file)}`;
