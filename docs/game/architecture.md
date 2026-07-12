# Cat Conga — realtime architecture

## Topology

**A separate container `lightshow-game`** (vhost `game.<domain>`) next to the light show. Never the same process: the game tick/GC would wreck the show's p95 4–8 ms clock-sync; fresh gameplay code must not crash the production show; the game deploys/scales independently.

## Handoff from the show (one push)

1. **Prefetch is spread across the WHOLE show** — the bottleneck is the LTE cell over the crowd (1000 × 30 MB through a 50–150 Mbit/s shared cell = tens of minutes, not "2–3 minutes before the encore"). The show sends `{t:'prefetch', sceneUrl}` at the *start*; each client begins downloading at a `hash(playerId)`-randomized offset. Splats go into **Cache API / Service Worker** — page reloads (iOS drops WebGL contexts on screen lock) must not re-download.
2. **Progressive entry:** play on the first ~20% of splats (coarse LOD chunks), stream the rest in the background.
3. On the operator's cue the show broadcasts `{t:'game', url, token: JWT, T0}` — JWT signed with a shared secret (env of both containers), claims `{room, playerId}`, **TTL ≤10 min**; the transition fires simultaneously on the already-synced clocks, but game handshakes jitter by `hash(playerId) % 5000 ms` (no thundering herd).

## Server

Own **Node + ws** (reusing the show's proven hub/rooms/token/heartbeat/governor patterns). Colyseus rejected (its schema sync fits per-entity state, not polylines + two-level AOI); Nakama rejected (Go + Postgres, accounts we don't need).

- **Authoritative fixed tick 8 Hz** (cats walk ~2 m/s → 25 cm/tick; this is not a shooter). Clients send only a clamped **intent vector** (10 Hz); the server integrates positions — client coordinates are ignored (anti-cheat by construction), speed clamped per tick.
- Snapshots 5–8 Hz; client interpolates with a **250–400 ms buffer** (≥2 snapshot intervals); prediction + soft correction for your own cat.
- **AOI grid (3×3 cells) + hard NEAR cap of 40–60 closest cats.** A conga herds everyone into a line/cluster — a grid without a cap explodes egress. LOD by count, not just distance. NEAR deltas ≈ 8–9 bytes/cat. MAP level (zoom-out) sends **simplified chain polylines** (RDP ≈ 20 points), 1–2 Hz. Snapshots are serialized once per cell/map and the buffer reused — never per-client stringify.
- **permessage-deflate OFF** (ws CPU/RAM killer). **Backpressure:** `bufferedAmount` cap → degrade the client to MAP-only → disconnect. One slow phone must not eat server RAM.

## Chain model

A chain is **the leader-path polyline + an ordered member list**, not per-member physics: the head appends breadcrumbs to a ring buffer; member *i* sits at arc-length `i × spacing`. O(chain length) per tick, a perfect conga, and zoom-out gets its polyline for free.

- **Ring buffer has an explicit point limit**; overflow triggers RDP decimation of the old segment — never a tail teleport.
- **Segment leaders every 25–50 links** own their sub-polyline (same data model per segment).
- `join_tail`: server validates proximity; simultaneous joiners serialize naturally (Node single thread) — the second one latches *behind* the first (a feature).
- Leader stalled 5 s (no input, no motion) → auto-detach, next member gets `you_are_head` (vibration + banner).
- **Reconnect grace 15 s**: the seat is held; resume with the same JWT returns the same seatIndex. After grace → detach + tail splice. (iOS lock/unlock cycles need real-device testing.)
- Persistence: in-memory + debounced SQLite snapshots (crash recovery only; the container is read-only except a dedicated writable volume). No Redis before sharding.

## Collision

A **walkability bitmask** (rasterized from the world's GLB collider mesh, 1 bit per 0.5 m cell): O(1) checks, a client copy for prediction. No player-player collisions (by design and by budget). Upgrade path: recast-navigation-js.

## Scale

- The bottleneck is serialization + egress, not sockets. 500 players ≈ 2–3 KB/s down per client (NEAR), ~10 Mbit/s server egress — trivial. Naive full-state JSON would be 150+ KB/s per client; AOI is mandatory.
- Claimed capacity 1500–2500 CCU/process is **a claim, not a fact** until the synthetic **load test with 1500–2000 WS clients from a separate box** passes (tick p95 <60 ms, RSS asserts). Alert on tick p95 >60 ms.
- Sharding: one room-city = one worker process; triggers at >1500 CCU or tick p95 >50% of the interval.

## Client

Three.js objects inside the Spark splat scene (vanilla JS + ES modules, repo style, no bundler). Joystick → intent vector. Chain members are computed locally from the polyline + seatIndex (the server never sends 200 individual positions for a 200-link chain). Cat budget for 100+ on screen: one InstancedMesh + **VAT** (vertex-animation-texture walk cycle), LOD instance → billboard → dot, ≤150 draw calls. Identify-me reuses the show's fullscreen flash mechanics (pattern + number, ≤3 Hz).
