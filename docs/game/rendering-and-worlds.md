# Cat Conga — 3DGS rendering & world generation

## Rendering stack (researched 2026-07-12)

**Primary: [Spark 2.x](https://github.com/sparkjsdev/spark)** (World Labs, MIT — renderer *and* LOD tooling) on top of Three.js.

- Spark 2.0 introduced a continuous **LOD tree (.RAD format + .RADC chunks)**: a per-frame splat budget of 500K–2.5M by device class, tree traversal independent of scene size, HTTP-Range streaming, the first 64K splats give an instant coarse picture.
- Open CLI: `npm run build-lod -- scene.ply --rad-chunked` (Rust).
- WebGL2 baseline (~98% of devices) — predictable on mid-range Androids where WebGPU is still a lottery.
- Native Three.js ecosystem — critical for avatars, instancing, joystick, custom netcode.
- Official recommended renderer for World Labs (Marble) splat assets — SPZ loads directly.

**Fallback: PlayCanvas Engine 2.19+ (MIT) + Streamed SOG** — objectively faster on WebGPU devices (published: iPhone 13 Pro Max 77.6 fps @1M splats; 24M-splat scenes stream on mobile), but a full engine paradigm and a heavier integration for our vanilla-JS stack. **SuperSplat** (the editor) is used for cleaning our own scans regardless of engine choice — it doesn't lock us in.

**Mandatory gate before building on Spark:** no independent mobile benchmarks exist. Phase A ends with a real-phone gate — a mid-range Android (~2021–22) + an iPhone must hold ≥25 fps for 10 minutes on the actual venue scene without a tab crash. Failure → switch to the PlayCanvas branch or ship 2D-first (the decision is isolated in one renderer module).

## World sources

**MVP: [World Labs Marble World API](https://docs.worldlabs.ai/api)** — the only option with a public price, an API, and native splat export:

- $1.00 = 1250 credits (min purchase $5). `marble-1.0-draft` ≈ **$0.12–0.20/world**; `marble-1.1` ≈ $1.28; text/photo/pano conditioning.
- Export: **SPZ/PLY splat (2M or 500k mobile), GLB collider mesh (100–200k tri)** — the collider feeds the walkability bitmask for free — plus HQ mesh and a PNG panorama. Note OpenCV→OpenGL axis flip (handled in one adapter).
- An evening with 3 hero worlds + 50 user extensions ≈ **$10–15**.
- Or the operator's own venue scans: PLY → SuperSplat cleanup → `build-lod` → .RAD.

**Alternatives checked:** Tencent HunyuanWorld — ⛔ license explicitly excludes the EU (unusable in Poland even self-hosted). Matrix-3D (MIT) — fine legally, ~1 h/scene → pre-generation only. SpAItial (Echo) — promising API (SPZ/SOG out), pricing not public, waitlist. Odyssey — streams video, no 3DGS artifact. Perspective changes fast — the abstraction below is mandatory.

## Phase 2 — "walk to the edge, extend the world by prompt"

- The Marble **API has no expand endpoint** (expand exists only in the Marble web app). The production pattern is **tile + portal**: at the world edge, take a panorama/screenshot of the current scene → `worlds:generate` (pano/image-conditioned + style preset + the player's prompt) → a new world tile → stitch with a portal. The game world is a **graph of scene tiles connected by portals**, not one monolithic file. (Arrival.Space ships the same pattern; World Labs themselves recommend composing worlds.)
- Research-grade 3DGS outpainting (WonderJourney etc.) is not production — excluded.

## WorldProvider abstraction (mandatory)

```
generate(input: prompt|image|pano, style, size) -> job -> WorldArtifact
WorldArtifact { spz, ply, glb_collider, pano, seed, prompt, provider, coords }
```

- Every artifact is copied into **our own storage** (R2) — providers change prices and delete assets.
- Coordinate normalization lives in one adapter; the viewer is format-agnostic (ply/spz/sog/rad).
- Swapping Marble → SpAItial → self-hosted Matrix-3D = swapping one adapter.

## Venue world pipeline (pre-generated, not live)

1. Operator's venue scan or a Marble hero world. 2. SuperSplat cleanup. 3. `build-lod` → .RAD chunked, **≤10–15 MB total budget** (the LTE cell over the crowd is the real bottleneck). 4. GLB collider → walkability bitmask. 5. Upload to R2 as immutable versioned files.
