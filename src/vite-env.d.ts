/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Where the example scans are fetched from in a public build (context/deploy.md). Unset: /scans/ on the same server. */
  readonly VITE_SCAN_BASE?: string;
}
