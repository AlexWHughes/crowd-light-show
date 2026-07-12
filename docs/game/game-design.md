# Cat Conga — game design (MVP)

## Core loop (<15 seconds to first joy)

Open (pushed from the light show tab) → you are already a cat in the crowd (zero choices) → a compass arrow points at the chain's tail → walk there / get close → auto-latch → **flash + vibration + "meow" + the chain counter ticks up for everyone** → ride the conga → pinch to zoom out and see the city → identify-me / preset chat.

## MVP cut (post red-team)

**MUST (Phases A–D):**
- Join from the light show tab, no registration; avatar assigned automatically.
- ONE giant chain per event (deliberate: no competing snake factions in MVP).
- Compass arrow to the tail + auto-latch on proximity.
- **Segment leaders every 25–50 links** — micro-agency without breaking the "one chain" idea. A rotating single head with a 1000-person queue is not viable; leader hand-off happens automatically when a leader stalls for 5 s.
- Effects (flash/vibrate/meow) **only on milestones** (50/100/500/1000) — per-attach effects at 2000 joins would be vibration spam.
- One-finger joystick for leaders; walls are impassable; chains pass through each other.
- Pinch zoom-out (`touch-action: none`): whole chain visible, you are highlighted.
- ID = ordinal number; **identify-me = unique blink pattern + giant number** on the phone screen (≤3 Hz cap — same epilepsy duty-of-care as the light show). Color alone can't identify anyone when there is one chain.
- Preset chat: 8–12 phrases + paw emojis (PL/EN/RU/UA), XSS-safe, rate-limited.
- 3DGS venue scene ≤10–15 MB; automatic 2D fallback (dots + lines — doubles as debug view) via a 10-second FPS probe; audio unlock on first tap; wake lock.

**Phase 2 (feature flags, dark until legal/operator gate):**
- `INVITES_ENABLED=0` — structured meetup invites (coffee/ice-cream/drink enum, never free text), mutual consent, self-declared age gate, available only after X minutes in the chain, meetups only in the designated public zone of the event.
- `INSCRIPTIONS_ENABLED=0` — chain inscriptions: only **pre-approved text stamped along the path**. The raw trail is never rendered — a crowd will draw obscenities with the trajectory itself, and text premoderation can't catch that.
- LLM curator moderation, free chat behind trust, timed head rotation.

**Later:** multiple colored chains that poach tails, creator role (prompt-extend the world), city replay reels, spectator feed for the stage projector.

## Roles and their fun

- **Leaders (head + segment leaders):** steer their segment; thicker/brighter trail; see "N cats behind you". Auto-handover on stall (votekick was cut: 30% of 1000 voters is unreachable or brigade-able).
- **Links:** passive joy — color waves run down the chain, milestone vibrations, "purr" tap (a wave ripples from you to neighbors), preset chat, identify-me.
- **Seekers (not yet attached):** a mini-game, not a lobby: arrow, "20 m to tail", collectible fireflies; newcomers get a "magnet" (tail segment spawns nearby in the first 30 s); a teleport hint after 60 s. Nobody stays lost.
- **Creators (Phase 2):** extend the world by prompt at the map edge; paw-voting for the best builds.

## Avatars — no gender fields

No "gender" field anywhere. An avatar is assigned randomly; switch with one tap. Two visual presets of the same scruffy ink-black yellow-eyed cat: **A "tufty"** (spiky fur, short scarf) and **B "tassels"** (fluffier silhouette, ear tassels). No labels — just a picture switcher. Accessories later stack on either preset. No names (number + chain color only) → no nickname moderation problem. All production assets are generated in-house (paid-plan generation tool, full ownership) — internet reference images are style inspiration only.

## Metrics

1. Show→game conversion (target >40% of devices within 2 min of the finale).
2. Time-to-tail **measured from "world loaded"** (median <30 s, p90 <60 s) + time-to-world-loaded separately.
3. Chain length: max + area under curve (length × time).
4. % surviving 5 minutes; % identify-me; % dropped to 2D fallback; FPS of the median device; % re-entry next day.

## Design risks → countermeasures

| Risk | Countermeasure |
|---|---|
| Crowd doesn't get it in 5 s | Zero text; pulsing tail marker; newcomer magnet; A/B at a live event |
| Everyone wants to lead | Segment leaders + "purr" micro-agency |
| Tail boredom in a giant chain | Color waves, counter, chat, mini-goals, self highlight in zoom-out |
| Troll leader | Stall timer auto-handover; short-lived trail; walls block anyway |
| Dead world after the event | Honest event-game positioning (peak = 30–60 min post show); replay reel; push to next event. No fake 24/7 world |
| Dead batteries | 2D fallback, dark scene (OLED), eco mode |
| Real-crowd crush from identify-me | Works standing still; copy says "don't run — let them find you" |

Precedents studied: Twitch Plays Pokémon, r/place, One Million Checkboxes, slither.io/agar.io, Crowd City, Habbo/Club Penguin, Coldplay Xylobands.
