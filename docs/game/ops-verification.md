# Cat Conga — ops & verification plan

## Deployment topology

- **New isolated container `lightshow-game`** behind the existing nginx-proxy + acme-companion (additive vhost `game.<domain>`, no host ports, internal `expose`). The light show container and all neighbors stay untouched.
- Container hardening mirrors the show: `mem_limit 512m`, `pids_limit 256`, `cpus 1.0`, non-root user, `read_only` rootfs + tmpfs **+ one writable volume for SQLite snapshots**, `cap_drop: ALL`, `no-new-privileges`, log rotation, image pinned by digest.
- WebSocket vhost needs `proxy_read_timeout 3600s` + app-level ping/pong.

## Asset delivery

- **MVP serves splats from the existing box** — no CDN, no new domains, no DNS changes. This is viable only under two hard conditions (also the kill criteria): **world budget ≤15 MB** and **prefetch window ≥20–30 min** (the whole show, per-client randomized). Math: 1000 phones × 15 MB over 30–40 min ≈ 50–70 Mbit/s average (≤7% of the ~1 Gbit/s uplink); peaks tamed by per-connection `limit_rate` + start jitter. Neighbors and the show's WS traffic are unaffected — verified live during the checks.
- CDN-grade headers anyway: versioned immutable files (`world-v3.rad`), `Cache-Control: public, max-age=31536000, immutable`, Range/206, client-side Cache API.
- **Kill criteria → switch to the CDN option** (Cloudflare R2, $0 egress): world >20 MB, or prefetch window <10 min, or >2000 phones, or measured neighbor degradation. Only then does an asset domain question arise (`*.r2.dev` is throttled by design — never production). A deferred scaling decision, not an MVP blocker.
- **The radio cell over the crowd remains the real bottleneck** in any scheme → world budget ≤10–15 MB, prefetch spread over the whole show, progressive entry.

## Safety rules for the build agent

1. Backup before any change + **proven restore** (vhost files; SQLite `.backup` + integrity check).
2. Read-only recon first (`docker ps`, `ss -ltnp` snapshots); additive changes only; neighbors' containers/volumes/env are untouchable; after deploy — every neighbor Up + endpoints respond.
3. Secrets never in git; env files chmod 600; secret-scan of tree **and** history before any public push.
4. The show's epilepsy governor is untouchable; the game applies the same duty of care (all blink effects clamped ≤3 Hz).
5. **Kill-switch, 3 levels:** `GAME_ENABLED=0` env; authorized `/api/admin/kill` (broadcast shutdown + 503 for new joins + client cap); `docker stop lightshow-game` — proven not to affect the show.

## Phase gates & verification (fact-based, 30 checks)

Every phase ends with machine-verifiable facts; "code exists" never counts as "works".

- **Phase A:** healthz 200 + TLS; asset 206 + immutable + ≤15 MB + `limit_rate` confirmed; show & neighbors respond <1 s during a parallel download storm; headless smoke (mobile UA: splatCount>0, non-black screenshot, 0 JS errors — *explicitly labeled smoke, not perf*: headless SwiftShader ≠ a phone GPU); reload works offline from Cache API; graceful error screen when the asset server is down; FPS-probe → 2D fallback; neighbors before==after + backup + secret scan. **Closed by an agent-run self-gate: an Android emulator (agent installs the SDK itself) must hold ≥25 fps for 10 min in mobile Chrome without a tab crash, plus a CPU-throttled (×6) Playwright FPS probe as a second data point. The agent renders the verdict itself (failure → PlayCanvas branch or 2D-first) and honestly logs the residual risk: emulators render on the host GPU — real iPhones/thermals are only proven at a live event.**
- **Phase B:** JWT accept/reject (missing + expired, TTL ≤10 min); **synthetic load test 1500–2000 WS clients from an already-available second machine** (tick p95 <60 ms, RSS assert); NEAR-cap asserted in a 500-cat cluster; backpressure test (slow client → MAP-only → disconnect, server RSS flat); permessage-deflate off; teleport intents clamped.
- **Phase C:** 200–500-bot harness (all attach; server chain dump has no cycles/orphans; segment leaders assigned); leader handover ≤2 s; reconnect inside 15 s grace → same seat, after grace → detach + splice; ring-buffer decimation without tail teleport; walls impassable; position p95 ≤250 ms.
- **Phase D:** headless e2e show→push→enter→attach; prefetch timing randomization logged; identify-me pattern+number+≤3 Hz asserts; chat delivery + XSS escaped + rate limit; milestone-only effects; kill-switch (401 / shutdown+503 / show survives `docker stop`); soak 200×10 min, RSS assert; feature flags off (endpoints 403/404); neighbors/backup/secret-scan; tagged release; reports archived.

## Autonomy policy (revised)

The build agent decides and verifies everything itself with current means: the Phase-A emulator self-gate; a **synthetic dress rehearsal** (≥20 parallel clients with a 4G network profile + Android emulators, full show→prefetch→handoff→attach cycle); legal drafts (DPIA/LIA, ToS, privacy delta) finalized as DRAFTs in the knowledge vault; default decisions already made (non-alcoholic invite enum, 13+ rules, invites/inscriptions feature-flagged off); cat assets self-made (procedural low-poly, or Meshy free tier under CC BY with attribution). **Only two things stay human:** final validation at a live event (real phones, thermals, crowd behavior) and the decision to flip the Phase-1 feature flags.

## What headless can NOT prove (honest list)

Real phone FPS/memory/thermals; throttling after an hour of screen-torching; the "wow" factor; touch UX; hostile venue 4G/NAT; iOS Safari quirks (WebGL memory, lock/unlock, autoplay); actual crowd comprehension. Only real devices and a real crowd answer these.
