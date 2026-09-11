# Project Charter — Wee Wonderer

*A browser toy where a tiny figurine explores a scan of your real space.*

## The pitch

Scan your room. Open a browser tab. A little creature spawns on your desk —
and runs, jumps, and climbs around your actual furniture. The user's own
space is the content; we build the magic loop, not the world.

## Why this idea won (from the original ideas doc)

- Tightest emotional hook with the smallest content problem — no dioramas
  or levels to author; every user brings their own environment.
- One perfect interaction loop (scan → drop in → explore) beats a library
  of content. Townscaper logic.
- Sits directly on existing strengths: Splotlight (browser Gaussian splat
  rendering, TypeScript/WebGPU) + character/animation pipeline experience.

## Design pillars (draft — challenge these)

1. **Cozy, not busy.** Smiski energy: quiet charm, discovery, smallness.
2. **Your space is the star.** The character exists to make you look at
   your own room differently.
3. **Zero-friction magic.** The distance from "I have a scan" to "he's
   walking on my couch" should be minutes, not an evening.
4. **Browser-native.** No installs. A link you can send someone.

## V1 scope — proposed, not final

**In:**
- Load a scan (format TBD — see open questions) in the browser
- Character with idle / walk / run / climb / jump (asset exists ✓)
- Walkable ground + at least one climbable/jumpable surface class
- A handful of gorgeous pre-made demo scans so the magic is instant
  before anyone captures their own

**Out (v1):**
- 4D splats / "walk into a polaroid" gallery (parked as v2 — natural
  upgrade once static traversal works)
- Multiplayer, persistence, accounts
- Mobile capture app of our own — lean on existing scan apps first

## Open questions (the real work — in rough priority order)

1. ~~**Toy or game?**~~ **DECIDED (July 2026): toy + light goal dusting.**
   V1 is a traversal toy with a thin goal layer — candidates: persistent
   placement ("he's where you left him," nearly free) and/or collectibles
   seeded into the scan (raises the placement/collision bar slightly).
   Explicitly OUT for v1: the "creature has opinions about surfaces"
   reaction family (bespoke animations + surface classification — the
   most expensive hook family; revisit in v2 if the toy earns it).
   Cheap goal-agnostic hooks stay in consideration: photo mode, basic
   idle life (sit, look around). Implications: charm > controllability
   still holds, but placement logic joins collision on the technical
   critical path.
2. ~~**Capture pipeline.**~~ **DECIDED (July 2026): bring-your-own splat.**
   Users capture with their own software (Polycam / Luma / Scaniverse etc.)
   and provide the Gaussian splat file (.ply / .splat / .spz). We do NOT
   ask for a companion mesh — a second file doubles onboarding friction
   and misaligned mesh/splat pairs are worse than no collision.
3. ~~**Collision from splats.**~~ **DECIDED (Aug 2026): generate client-side
   in the browser, no server.** Collision is derived from the splat at load
   time; nothing (scan or collision) touches a server — on-device generation
   is a feature, not just a cost saving ("your room never leaves your phone,"
   on-pillar). One swappable module behind a `generateCollision(splat) →
   {mesh, voxels}` interface, with two client-side implementations:
   - **Good path — WebGPU voxelizer** where `navigator.gpu` exists: voxelize
     (opacity-filtered) → filter-cluster → carve, then extract a collision
     mesh. Gets overhangs / under-furniture. Committed targets (iOS 26 /
     Android 12+ modern phones) all have WebGPU as of 2026.
   - **Universal fallback — 2.5D heightfield** (CPU) everywhere else: flat
     cells = walkable floor & furniture tops, sharp discontinuities =
     climbable faces. Known limitation: no overhangs (accepted v1). Note
     WebGL2 has no compute shaders, so the non-WebGPU fallback must be CPU,
     not a shader path.

   Input is **capped at a few million Gaussians** on import — this is the one
   lever that keeps the voxelizer inside mobile WebGPU buffer limits (no
   tiling needed) AND doubles as the scale-fit downsample for the 12 cm
   tenant. Voxelize from the decimated copy, render the full-res splat, so
   collision cost is decoupled from visual fidelity. Still required per scan:
   auto floor detection + user scale slider ("size your tenant"), since
   capture apps are only roughly metric.

   Explicitly NOT in v1: a collision-generation **backend** (option "D").
   Kept as a documented escape hatch only if on-device profiling proves the
   WebGPU path can't handle the allowed scan sizes on committed hardware —
   and even then, chunked WebGPU before a server. The old Splotlight
   depth-render fallback is superseded by the heightfield.

   **Sequencing (bias to ship):** heightfield first (universal; delivers the
   first milestone — figurine on a real scanned floor, hops onto one table),
   then upgrade the good path to the WebGPU voxelizer for overhangs. The
   hardest piece (voxelizer) stays off the critical path to the first demo.
4. **Original character.** The chibi is a licensed base (PolyOne, CC-BY) with
   smiski-adjacent styling — fine for prototyping, must become an original
   design before anything public. Character design is also where the toy's
   personality gets decided: what IS this little guy?
5. ~~**Toy name.**~~ **DECIDED (Aug 2026): "Wee Wonderer."** The toy's name
   is canonical. Still open: the *character's* own identity/name (folded into
   Q4 — what IS this little guy?). The "Smiski" constraint — it cannot appear
   anywhere public (Dreams Inc. trademark) — still applies to the character
   design regardless of the toy's name.

## Current status (July 2026)

- ✓ Character asset shipped: rigged chibi, 6 clips, documented animation
  contract (see character README)
- ✓ Test harness: three.js reference controller — locomotion, 3-phase jump,
  climb, toy collision, clip validation UI
- ◻ Splat rendering exists separately (Splotlight) — not yet integrated
- ◻ Everything else

## Working mode

Sam is driving design + build solo for now (Nima's bandwidth elsewhere;
may rejoin later — keep the animation contract and code handoff-clean).
Bias toward: small scope, shipped prototypes, decisions over deliberation.
