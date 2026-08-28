# Cat Conga — safety, moderation, legal guardrails

> Not legal advice. Condensed from the planning research (PL/EU focus); final texts require operator + lawyer sign-off.

## Moderation philosophy: design-out first

Lessons from Club Penguin (Ultimate Safe Chat), Among Us (guests get Quick Chat only), Habbo (the 2012 "Great Mute"), Roblox (sync ML filter + async review), VRChat (trust rank, personal bubble), Discord AutoMod: **for a solo operator, the winning move is to remove the attack surface, not to moderate it.**

**MVP ships with almost nothing to moderate:**
- The only text channel is a **preset chat** (8–12 curated phrases + emojis) — inherently safe.
- Meetup invites and chain inscriptions are **feature-flagged off** (`INVITES_ENABLED=0`, `INSCRIPTIONS_ENABLED=0`) until the operator/legal gate.
- Identify-me is voluntary, TTL 60 s, cooldown, panic reset.
- Rate limits everywhere (1 msg/2 s burst 5; sessions per IP); report button with an auto-snapshot of the last 20 events; local block/mute; trust-score skeleton; admin page with one-click undo; kill-switch.

**Phase 1 (when flags turn on):**
- Inscriptions: only **pre-approved text stamped along the path** (LLM premoderation before anyone sees it; the raw trail is never rendered — trajectories can draw obscenities that text filters can't see).
- Invites: structured enum only (no free text), mutual consent, self-declared age gate, unlocked after X minutes in the chain, meetups only in the designated public zone of the event, warning before every acceptance.
- Sync profanity filter: npm `obscenity` (leetspeak/unicode-resistant) + PL/RU/UA/EN wordlists; free OpenAI omni-moderation as a pre-check. (Google Perspective API sunsets 2026-12-31 — excluded.)
- **Async LLM curator** (batches every 10–20 s): Gemini 2.5 Flash-Lite ≈ **$0–0.5 per 1000-player evening** (Claude Haiku 4.5 as quality reserve). Verdicts feed a trust score with escalation: warn (in-character "caretaker cat") → mute 5 min → kick (rejoin in 1 h) → session ban. Kick+ actions surface to the operator with undo.

**Ban evasion, honestly:** with no accounts, permanent bans are unattainable. Device fingerprinting is **legally toxic in the EU** (consent required under PKE art. 399 / ePrivacy — and abusers won't consent) → not built. The real defense is **trust-gating**: a fresh session has trust 0 and therefore no free text, no inscriptions, no identify-me — nothing to abuse with. Session+cookie bans stop lazy offenders; IP is only a soft suspicion signal (the whole crowd shares one NAT).

## Legal guardrails (PL/EU)

1. **DPIA is mandatory before launch** (GDPR art. 35 + the Polish UODO list: systematic monitoring of a public place + children + location + innovative tech). Agent drafts; operator signs.
2. **The "beer" invite**: Polish alcohol law (art. 13¹ ustawy o wychowaniu w trzeźwości) makes any beer promotion toward minors radioactive → replace with a neutral drink/coffee/ice-cream enum, or 18+ gate that single option. Cheaper to drop it.
3. **DSA applies even to a micro-operator** (art. 19 lifts Section 3, but not arts. 11–18): public point of contact, moderation rules in the ToS in plain language (including "moderation is algorithmic"), a notice-and-action report mechanism, a **statement of reasons for every ban** (what rule, was it automated, how to appeal — a human answers appeals).
4. **Anonymous ≠ outside GDPR**: session tokens, IPs, chat content are personal data. Legal bases: 6(1)(b) for the game, 6(1)(f) for moderation (documented LIA). Retention: chat auto-deleted ≤24 h after the event; moderation logs ≤30 days; incident evidence until handover to authorities.
5. **Minors**: rules state 13+/16+ (PL digital consent age is 16); no targeting of children; IRL-meetup safety-by-design is the central risk block (grooming, KK art. 200a) — hence the invite feature flag.
6. **Avatar IP**: internet reference images are style inspiration only; production assets are self-made (procedural low-poly) or generated on a free tier under CC BY 4.0 with attribution (e.g. "Model created with Meshy" in NOTICE), prompts/dates archived; no imitation of any single artist's recognizable character.

## What the build agent may do vs. the operator

- **Agent:** draft ToS/privacy-delta/warnings/statement-of-reasons templates/retention table/DPIA+LIA; implement code measures (auto-deletion, report, rate limits, opt-in identify, no fingerprinting, appeal channel); generate assets after the tool purchase is approved.
- **Operator/lawyer only:** sign DPIA/LIA; legal review of ToS/privacy; the age-bar and "beer" decisions; child-incident procedure; DSA art. 18 notifications; insurance check.
