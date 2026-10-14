# Deploying

The public build is two pieces that never share a server:

```
visitor ──► the app (Vercel: wee.samanthamlee.com, ~2 MB)
              │ fetches the scan the visitor picks
              ▼
           the scan host (Cloudflare Worker over an R2 bucket, a workers.dev address)
```

A scan a visitor imports never leaves their browser: it is read into memory, cleaned
in a worker, and loaded from a `blob:` URL (`importScan` in `main.ts`). Nothing about
hosting involves it.

## Where scans come from

- **`src/scans.ts`** holds the list (`SCANS`, `LISTED_SCANS`) and `scanURL(file)`, the
  one place a scan's address is decided. It has no side effects, so
  `scripts/upload-scans.mjs` reads the same list through Vite.
- **Locally**, scans live in the gitignored **`scans/`** folder, and a plugin in
  `vite.config.ts` serves it at `/scans/` on the dev and preview servers.
- **A public build** sets **`VITE_SCAN_BASE`** to the scan host's address. `vite build`
  warns when it is unset, because such a build fetches from `/scans/`, which only
  `vite preview` serves.
- **Why not `public/`:** Vite copies `public/` into every build whole, so scans there
  made `dist/` 1.3 GB. `public/*.ply` is still gitignored, so a scan dropped there by
  habit is not committed, but it would be copied into the build again.

## The scan host

`deploy/scans-worker/` is a Worker (`index.js`, `wrangler.toml`) that serves the R2
bucket `wee-scans`:

- **Read-only:** GET and HEAD of one object by name. No listing (`/` is 404), no writes
  (405), no paths with `/`.
- **CORS:** only the origins in `ALLOWED_ORIGINS` get `Access-Control-Allow-Origin`.
  Any other page's fetch is refused by the browser, and the app shows its scan-load
  error ("scan load failed: Failed to fetch"). The app's fetch is a simple GET, so
  there is no preflight to answer.
- **Headers:** `Content-Length` (the load progress is measured against it), and the
  `Content-Type` and `Cache-Control` stored with the object at upload.
- **Why a Worker and not the bucket's `r2.dev` address:** Cloudflare rate-limits
  `r2.dev` and says it is for testing. An R2 custom domain needs the domain's DNS on
  Cloudflare, and samanthamlee.com's DNS is on Vercel. Visitors never see the scan
  host's address, so a workers.dev one is enough.
- **Why not Vercel for the scans too:** the free plan's bandwidth runs out after a few
  thousand scan loads a month, and the scans are not in git for Vercel to build from.
  R2 does not charge for downloads.

## Uploading scans

`node scripts/upload-scans.mjs` uploads every **listed** scan from `scans/` (it stops if
one is missing). Unlisted scans are never uploaded: Playroom's licence is unclear
(CLAUDE.md, "Which scans ship").

- Uploads are `Cache-Control: public, max-age=31536000, immutable`. **A scan that
  changes gets a new file name**, never new bytes under the old one: browsers would
  keep the old file for a year, and the collision cache (`voxel-cache.ts`) is keyed
  by the name as well.
- A scan that is no longer listed stays in the bucket until deleted by hand
  (`npx wrangler r2 object delete wee-scans/<file> -c deploy/scans-worker/wrangler.toml --remote`).

## Testing it without an account

Wrangler emulates the bucket and the Worker locally:

```bash
node scripts/upload-scans.mjs --local
npx wrangler dev -c deploy/scans-worker/wrangler.toml --port 8787 --var ALLOWED_ORIGINS:http://localhost:4173
VITE_SCAN_BASE=http://localhost:8787 npm run build && npx vite preview --port 4173
```

The local bucket is kept in `deploy/scans-worker/.wrangler/` (gitignored). Serving the
same build from another port (`--port 4174`) checks that a page not in
`ALLOWED_ORIGINS` gets the load error and not a hang.

## First-time setup (done by hand, once)

1. **Cloudflare:** make an account; under R2, create the bucket `wee-scans`. Then
   `npx wrangler login`, `node scripts/upload-scans.mjs`, and
   `npx wrangler deploy -c deploy/scans-worker/wrangler.toml`. The deploy prints the
   Worker's address.
2. **Vercel:** import the repo as a new project (Vite is detected), set
   `VITE_SCAN_BASE` to the Worker's address, and add the domain `wee.samanthamlee.com`.
   The DNS is already on Vercel, so the record is added there.
3. If the app's address changes, update `ALLOWED_ORIGINS` and deploy the Worker again.

## Known limitations

- Scans are full-size `.ply` (31 to 40 MB). Smaller files (SPZ) are the next step.
- A scan load that fails for CORS reads only "Failed to fetch": the browser does not
  tell the page why.
