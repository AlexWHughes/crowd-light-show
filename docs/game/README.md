# Cat Conga — crowd game module (design docs)

> **Status: DESIGN PHASE (2026-07-12). Not built yet.** Planned by an 8-agent research team + adversarial red-team review.

When the light show ends, the crowd doesn't close the tab — it falls into a shared 3D world. Every phone becomes a scruffy ink-black cat with big yellow eyes, walking around a Gaussian-Splatting scan of the venue. The goal is dead simple: **find the tail of the giant conga chain and latch on.** Leaders steer, everyone else just rides the wave. Zoom out and you see the whole city with chains crawling through it. Press **"identify me"** and your phone screen blinks a unique pattern with a giant number — so the people you danced with in the virtual crowd can find you in the *real* one.

No app install. No accounts. Mobile browser only — the same tab that just ran the light show.

## Documents

| Doc | Contents |
|---|---|
| [game-design.md](game-design.md) | Core loop, MVP cut, roles, segment leaders, metrics, avatar policy |
| [architecture.md](architecture.md) | Realtime multiplayer: handoff from the show, tick/AOI, chain model, scaling |
| [rendering-and-worlds.md](rendering-and-worlds.md) | 3DGS rendering stack (Spark 2.x), world generation (Marble API), formats |
| [safety-moderation-legal.md](safety-moderation-legal.md) | Design-out moderation, AI curator, EU/PL legal guardrails |
| [ops-verification.md](ops-verification.md) | Deployment topology, CDN, phase gates, verification criteria |

## Build phases

- **Phase A — Delivery & rendering:** new isolated container + splat delivery from the existing box (≤15 MB world, rate-limited, immutable/206; CDN only as a scaling option) + Spark renderer + Cache API + FPS-probe with 2D fallback. Closed by an **agent-run emulator self-gate** (Android emulator ≥25 fps for 10 min + CPU-throttled probe; residual iPhone/thermal risk honestly logged for the live event).
- **Phase B — Multiplayer core:** authoritative WS server (8 Hz tick), AOI with hard neighbor cap, backpressure, load-proven at 1500–2000 concurrent clients.
- **Phase C — The chain:** polyline-based conga model, segment leaders every 25–50 links, leader handover, reconnect grace, collision mask.
- **Phase D — Handoff & game shell:** push from the light show, textless onboarding (<15 s to first joy), identify-me, preset chat, milestone effects, kill-switch, metrics.
- **Phase 2 (feature-flagged, off by default):** real-life meetup invites (`INVITES_ENABLED=0`), chain inscriptions (`INSCRIPTIONS_ENABLED=0`), LLM moderation curator, prompt-based world extension for creators.

## Key design bets

1. **"One Million Checkboxes on legs":** one action (latch onto the tail), one shared counter, zero onboarding text. Snake mechanics **without death and without PvP** — only growth.
2. **The network bottleneck is the LTE cell over the crowd, not the server:** world budget ≤10–15 MB, prefetch spread across the whole show, progressive entry on ~20% of splats.
3. **Phones are hot and drained after an hour of flashing:** wake lock, Cache API (survive iOS WebGL context loss), automatic 2D fallback via FPS probe.
4. **Social math of one 1000-person chain:** segment leaders instead of a single rotating head, milestone-only effects (50/100/500/1000), identify-me by blink *pattern* (color is shared by the whole chain).
5. **Design-out moderation:** preset chat + structured actions means there is almost nothing to moderate in the MVP; trust-gating replaces (legally toxic) device fingerprinting.

*The Russian-language planning specs (source of truth for the /goal build prompts) live in the operator's knowledge vault; these docs are the public condensed mirror.*
