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

**Live:** the app is https://wee.samanthamlee.com (Vercel project `wee-wonderer`, with
its `.vercel.app` alias removed). The scan host is
https://wee-scans.wee-scans-worker.workers.dev, with `ALLOWED_ORIGINS` set to
`https://wee.samanthamlee.com` alone. **Vercel's preview builds cannot load scans, on
purpose:** their addresses are not allowed, and they do not need scans. Do not widen
`ALLOWED_ORIGINS` without asking.

## Scan files

The shipped scans are SPZ (`*-clean.spz`), converted from the cleaned `.ply`:

```bash
npx -y @playcanvas/splat-transform@3.8.0 scans/<name>-clean.ply scans/<name>-clean.spz
```

That writes SPZ version 4 (zstd). Measured file sizes, `.ply` → `.spz`:

| Scan | Size |
|---|---|
| Kitchen | 40.3 → 3.1 MB |
| Living Room | 33.4 → 2.2 MB |
| Counter | 30.7 → 2.3 MB |
| Curled Up Dog | 30.9 → 2.8 MB |

Unpacking in the worker went from about 500 ms to about 45 ms. They look the same as the `.ply` side by side. SPZ rounds positions (by at most
1.2e-4 scan units here), which moves Kitchen's collision a little
(`context/collision.md`, "SPZ moves Kitchen's collision").

`load-scan.worker.ts` picks the parser by the file's bytes, not its name (an imported
scan's `blob:` URL has none): a file starting with the text `ply` is PLY, anything else
goes to three's `SPZLoader`, which reads SPZ versions 1 to 4 and throws on what is
neither. Importing a scan still takes `.ply` only: the cleanup worker parses PLY.

## Where scans come from

- **`src/scan-list.ts`** holds the list (`SCANS`, `LISTED_SCANS`) and `SCAN_DIR`, as
  plain data with no `import.meta.env`, so `vite.config.ts` and
  `scripts/upload-scans.mjs` read the same list and folder name as the app.
- **`src/scans.ts`** has `scanURL(file)`, the one place a scan's address is decided.
- **Scan names are flat** (no folders), locally and on the scan host alike: both refuse
  a name with a `/`, so what loads locally loads when deployed.
- **Locally**, scans live in the gitignored **`scans/`** folder, and a plugin in
  `vite.config.ts` serves it at `<base>scans/` on the dev and preview servers.
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
  (405), no names with `/`, and a malformed `%` escape is 404, not an error.
- **CORS:** only origins matching `ALLOWED_ORIGINS` get `Access-Control-Allow-Origin`.
  Any other page's fetch is refused by the browser, and the app shows its scan-load
  error ("scan load failed: Failed to fetch"). The app's fetch is a simple GET, so
  there is no preflight to answer. An entry may hold `*`, which matches letters, digits
  and hyphens but never a dot, for Vercel's per-build addresses
  (`https://wee-wonderer-*-<scope>.vercel.app`); a dot would let another domain match.
  A missing `ALLOWED_ORIGINS` allows nothing (no CORS header) rather than failing.
- **Headers:** `Content-Length` (the load progress is measured against it), and the
  `Content-Type` and `Cache-Control` stored with the object at upload.
- **Conditions and ranges are R2's:** the request's headers go to `get` as `onlyIf` and
  `range`, so a revalidating browser gets 304 and a range request 206. R2 reports a
  served range as `{ offset, length }`, a suffix range ("the last n bytes") included; its
  `suffix` key is present but undefined, so testing `'suffix' in range` is wrong.
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
(CLAUDE.md, "Which scans ship"). Wrangler is in the Worker's own package, so the app's
install and Vercel's builds do not carry it: `npm install --prefix deploy/scans-worker`
once.

- A scan already in the bucket is downloaded and compared byte for byte (R2 does not
  charge for downloads, and wrangler has no command that returns an object's hash):
  the same bytes are skipped, different bytes stop the upload with exit code 1.
- "Not in the bucket" is recognised by wrangler's message ("The specified key does not
  exist.", measured on the local bucket). If the real bucket words it otherwise, the
  script stops with the message rather than uploading over anything.

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
deploy/scans-worker/node_modules/.bin/wrangler dev -c deploy/scans-worker/wrangler.toml --port 8787 --var ALLOWED_ORIGINS:http://localhost:4173
VITE_SCAN_BASE=http://localhost:8787 npm run build && npx vite preview --port 4173
```

The local bucket is kept in `deploy/scans-worker/.wrangler/` (gitignored). Serving the
same build from another port (`--port 4174`) checks that a page not in
`ALLOWED_ORIGINS` gets the load error and not a hang.

## First-time setup (done by hand, once)

1. **Cloudflare:** make an account; under R2, create the bucket `wee-scans`. Then
   `npm install --prefix deploy/scans-worker`,
   `deploy/scans-worker/node_modules/.bin/wrangler login`, `node scripts/upload-scans.mjs`,
   and `npm run deploy --prefix deploy/scans-worker`. The deploy prints the Worker's address.
2. **Vercel:** import the repo as a new project (Vite is detected), set
   `VITE_SCAN_BASE` to the Worker's address **for both Production and Preview** (a build
   without it fetches `/scans/`, which Vercel does not have), and add the domain
   `wee.samanthamlee.com`. The DNS is already on Vercel, so the record is added there.
3. **Optionally, allow Vercel's own addresses** (not done for the live site; see "Live"
   above): once the project exists, its builds are served at
   `wee-wonderer-<id>-<scope>.vercel.app` (and the project at `<name>.vercel.app`). Add
   `https://wee-wonderer-*-<scope>.vercel.app` and the project's address to
   `ALLOWED_ORIGINS`, and deploy the Worker again. Same whenever the app's address changes.

## Known limitations

- A scan load that fails for CORS reads only "Failed to fetch": the browser does not
  tell the page why.
