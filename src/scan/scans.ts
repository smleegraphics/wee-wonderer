// Where the example scans (scan-list.ts) are fetched from. Scans are not part of the
// app's bundle: locally the dev and preview servers serve the gitignored scans/ folder
// (vite.config.ts); a public build sets VITE_SCAN_BASE to the scan host (context/deploy.md).
import { SCAN_DIR } from './scan-list';

export { SCANS, LISTED_SCANS, SCAN_FILE_TYPES, type ScanEntry } from './scan-list';

const base = import.meta.env.VITE_SCAN_BASE || `${import.meta.env.BASE_URL}${SCAN_DIR}/`;
const SCAN_BASE = base.endsWith('/') ? base : `${base}/`;

/** Where the example scan `file` is fetched from. A `/` in the name is encoded, so it
 *  names no folder: the dev server and the scan host both refuse it (scans are flat). */
export const scanURL = (file: string) => `${SCAN_BASE}${encodeURIComponent(file)}`;
