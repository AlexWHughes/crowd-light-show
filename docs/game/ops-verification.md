# Cat Conga — ops & verification plan

## Deployment topology

- **New isolated container `lightshow-game`** behind the existing nginx-proxy + acme-companion (additive vhost `game.<domain>`, no host ports, internal `expose`). The light show container and all neighbors stay untouched.
- Container hardening mirrors the show: `mem_limit 512m`, `pids_limit 256`, `cpus 1.0`, non-root user, `read_only` rootfs + tmpfs **+ one writable volume for SQLite snapshots**, `cap_drop: ALL`, `no-new-privileges`, log rotation, image pinned by digest.
- WebSocket vhost needs `proxy_read_timeout 3600s` + app-level ping/pong.

## Asset delivery — hard rules

- **Serving splats from the box to a crowd is forbidden.** 150 MB × 1000 phones saturates the shared 1 Gbit/s uplink for 25+ minutes and degrades the live show and every neighbor. Dev tests ≤200 clients with per-connection `limit_rate` only.
- **Cloudflare R2** ($0 egress; free tier covers the MVP): versioned immutable files (`world-v3.rad`), `Cache-Control: public, max-age=31536000, immutable`, Range/206.
- ⚠️ **Production must never point at `*.r2.dev`** (throttled by design — grep-checked in the DONE criteria). A custom R2 domain requires moving the zone's NS to Cloudflare — an **operator decision required before Phase A**; the fallback is a cheap dedicated asset domain.
- Even with a CDN, **the radio cell over the crowd is the real bottleneck** → world budget ≤10–15 MB, prefetch spread over the whole show, progressive entry.
- Big events (>1000 CCU or overlapping a show): an hourly cloud box (CX22-class, <€0.5/day) with the same compose, switched by DNS.

## Safety rules for the build agent

1. Backup before any change + **proven restore** (vhost files; SQLite `.backup` + integrity check).
2. Read-only recon first (`docker ps`, `ss -ltnp` snapshots); additive changes only; neighbors' containers/volumes/env are untouchable; after deploy — every neighbor Up + endpoints respond.
3. Secrets never in git; env files chmod 600; secret-scan of tree **and** history before any public push.
4. The show's epilepsy governor is untouchable; the game applies the same duty of care (all blink effects clamped ≤3 Hz).
5. **Kill-switch, 3 levels:** `GAME_ENABLED=0` env; authorized `/api/admin/kill` (broadcast shutdown + 503 for new joins + client cap); `docker stop lightshow-game` — proven not to affect the show.

## Phase gates & verification (fact-based, 30 checks)

Every phase ends with machine-verifiable facts; "code exists" never counts as "works".

- **Phase A:** healthz 200 + TLS; asset 206 + immutable + ≤15 MB; grep: no r2.dev in prod; headless smoke (mobile UA: splatCount>0, non-black screenshot, 0 JS errors — *explicitly labeled smoke, not perf*: headless SwiftShader ≠ a phone GPU); reload works offline from Cache API; graceful error screen when the CDN is down; FPS-probe → 2D fallback; neighbors before==after + backup + secret scan. **Closed by a mandatory real-phone gate: mid-range Android + iPhone, ≥25 fps for 10 min, no tab crash. Phases B+ do not start until it passes.**
- **Phase B:** JWT accept/reject (missing + expired, TTL ≤10 min); **synthetic load test 1500–2000 WS clients from a separate machine** (tick p95 <60 ms, RSS assert); NEAR-cap asserted in a 500-cat cluster; backpressure test (slow client → MAP-only → disconnect, server RSS flat); permessage-deflate off; teleport intents clamped.
- **Phase C:** 200–500-bot harness (all attach; server chain dump has no cycles/orphans; segment leaders assigned); leader handover ≤2 s; reconnect inside 15 s grace → same seat, after grace → detach + splice; ring-buffer decimation without tail teleport; walls impassable; position p95 ≤250 ms.
- **Phase D:** headless e2e show→push→enter→attach; prefetch timing randomization logged; identify-me pattern+number+≤3 Hz asserts; chat delivery + XSS escaped + rate limit; milestone-only effects; kill-switch (401 / shutdown+503 / show survives `docker stop`); soak 200×10 min, RSS assert; feature flags off (endpoints 403/404); neighbors/backup/secret-scan; tagged release; reports archived.

## Operator track (parallel, human-only)

NS/asset-domain decision (before Phase A); R2/Marble/asset-tool payments; the Phase-A phone gate; **a dress rehearsal with ≥20 real phones on 4G before the first event — the production gate**; DPIA/ToS signatures; the "beer"-invite and age-bar decisions; Marble ToS commercial-rights check; the live event itself.

## What headless can NOT prove (honest list)

Real phone FPS/memory/thermals; throttling after an hour of screen-torching; the "wow" factor; touch UX; hostile venue 4G/NAT; iOS Safari quirks (WebGL memory, lock/unlock, autoplay); actual crowd comprehension. Only real devices and a real crowd answer these.
