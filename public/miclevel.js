// Turning what a microphone hears into ONE loudness number for the crowd's lights.
//
// WHY THIS EXISTS (round 16.2). The first version ran the microphone through a rolling
// floor/ceiling normaliser — the same shape as the torch AGC, which works well on a compiled music
// envelope. On a live microphone it is exactly wrong: that normaliser stretches WHATEVER it is given
// across the full 0..1 range. In a quiet room the floor and the ceiling converge on the room's own
// hiss, the span hits its minimum, and a couple of dB of noise get expanded into a full light show.
// Worse, the sensitivity slider multiplied the ALREADY-normalised value, so turning it up amplified
// the noise and did nothing for a voice that the ceiling follower had already flattened.
//
// The fix is to stop normalising and start MEASURING, in dB, against a noise floor:
//
//   1. Band-limit. Sum power over roughly 50 Hz - 9 kHz and roll off the ends: below ~120 Hz sits
//      handling noise, HVAC rumble and desk thumps; above ~7 kHz sits microphone hiss. Both are
//      exactly the "quiet noise" that used to drive the lights, and neither carries the beat.
//   2. Track the noise floor with MINIMUM STATISTICS: fall to a new quiet fast, creep back up at a
//      fraction of a dB per second. Music and speech cannot drag it up quickly; a room that
//      genuinely gets quieter is followed within a moment, and over a long set the floor does drift
//      up to the music's own quiet level, which re-centres the response on that room.
//   3. Gate, then map a fixed dB range above the floor onto 0..1. Silence is really 0 — not
//      "whatever this room's hiss looks like stretched out" — and a voice 20 dB over the floor lands
//      in the middle of the range instead of being flattened.
//   4. SENSITIVITY COMPRESSES THE RANGE; it never moves the gate. Turning it up means "fewer dB
//      above this room's own quiet count as full brightness", which lifts a distant voice into view.
//      Because the gate stays fixed relative to the tracked floor, no setting of the slider can ever
//      make the room's own noise light up — which was the whole complaint.
//
// The maths lives here, free of any browser object, so test/mic_level.test.mjs can drive it with
// synthetic room noise, speech and music and assert the behaviour on the console.
(function (global) {
  'use strict';

  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : (x === x ? x : 0); }
  var SILENT_DB = -140;   // stands in for -Infinity (a muted, dead or not-yet-started input)

  // ---- 1. band-limited, weighted power -> dB ----------------------------------------------------
  // freqDb: Float32Array of per-bin dB from AnalyserNode.getFloatFrequencyData.
  // Returns the mean weighted band power in dB. The absolute scale does not matter — everything
  // downstream is relative to the tracked noise floor — but it must be MONOTONIC in real loudness,
  // which a plain wideband RMS is not once a room's rumble and hiss are in the mix.
  function bandDb(freqDb, sampleRate, fftSize) {
    if (!freqDb || !freqDb.length) return SILENT_DB;
    var binHz = (sampleRate || 48000) / (fftSize || (freqDb.length * 2));
    var sum = 0, used = 0;
    for (var i = 1; i < freqDb.length; i++) {
      var f = i * binHz;
      if (f < 50 || f > 9500) continue;
      var w = 1;
      if (f < 120) w = (f - 50) / 70;                      // fade in: below this is rumble/handling noise
      else if (f > 7000) w = 1 - (f - 7000) / 2500;        // fade out: above this is microphone hiss
      if (w <= 0) continue;
      var d = freqDb[i];
      if (!(d > SILENT_DB)) continue;                       // -Infinity / NaN bins
      sum += w * Math.pow(10, d / 10);
      used += w;
    }
    if (!(used > 0) || !(sum > 0)) return SILENT_DB;
    return 10 * Math.log10(sum / used);
  }

  // ---- 2..4. noise floor, gate, range mapping ---------------------------------------------------
  // step(db, dtMs, rangeScale) -> { level, floorDb, overDb, open, db }
  //   db         : band power in dB for this frame (from bandDb)
  //   rangeScale : the sensitivity slider, 1 = normal. Higher compresses the range (see below).
  //                null/0 means the microphone is turned off and the level is a hard 0.
  function makeMicLevel(opts) {
    opts = opts || {};
    var GATE_DB = opts.gateDb == null ? 7 : opts.gateDb;         // must beat the floor by this much to count
    var HYST_DB = opts.hystDb == null ? 3 : opts.hystDb;         // the gate closes lower than it opens (no chatter)
    var RANGE_DB = opts.rangeDb == null ? 45 : opts.rangeDb;     // dB above the open point that maps to full
    var FALL_TAU = opts.fallTauMs == null ? 150 : opts.fallTauMs;      // the floor drops to a new quiet quickly
    var RISE_DB_S = opts.riseDbPerSec == null ? 0.5 : opts.riseDbPerSec; // ...and creeps back up slowly
    var MAX_SPAN = opts.maxSpanDb == null ? 55 : opts.maxSpanDb;       // the floor may never be staler than this
    var floor = null, open = false;

    return function step(db, dtMs, rangeScale) {
      dtMs = Math.max(1, Math.min(250, dtMs || 16));
      if (!(db > SILENT_DB)) db = SILENT_DB;
      var alive = db > SILENT_DB + 1;
      // Seed from the first LIVE frame, never from the silence before the microphone has started.
      // Seeding from that silence used to pin the floor at -140 dB, and since it only creeps up half
      // a dB per second, everything afterwards read as "50 dB over the room" — the lights would sit
      // at full brightness, unresponsive, for a couple of minutes.
      if (floor === null) { if (!alive) return { level: 0, floorDb: SILENT_DB, overDb: 0, open: false, db: db }; floor = db; }

      // MINIMUM STATISTICS: fast down, very slow up. This is what stops music and speech teaching the
      // floor that they ARE the floor — which is how the old normaliser flattened them into nothing.
      if (db < floor) floor += (db - floor) * (1 - Math.exp(-dtMs / FALL_TAU));
      else floor += RISE_DB_S * (dtMs / 1000);
      // ...but a floor can never be more than one full range below what we are hearing. Without this
      // bound a stale estimate (a mic that started in silence, a room that got much louder) leaves the
      // level pinned at the top until the slow creep catches up.
      if (alive && floor < db - MAX_SPAN) floor = db - MAX_SPAN;
      if (floor < SILENT_DB) floor = SILENT_DB;

      var over = db - floor;                                 // dB above this room's own quiet
      var openAt = GATE_DB, closeAt = GATE_DB - HYST_DB;
      open = over > (open ? closeAt : openAt);

      // A dead input is silence at any setting: without this, a floor sitting at SILENT_DB plus any
      // scaling could still open the gate on nothing at all.
      var scale = (rangeScale == null) ? 1 : Number(rangeScale);
      if (!alive || !(scale > 0)) return { level: 0, floorDb: floor, overDb: over, open: false, db: db };

      // Sensitivity compresses the RANGE, it does not shift the gate: at 2x, half as many dB above
      // the room's quiet already count as full brightness.
      var range = Math.max(6, RANGE_DB / scale);
      var level = open ? clamp01((over - closeAt) / range) : 0;
      return { level: level, floorDb: floor, overDb: over, open: open, db: db };
    };
  }

  // The sensitivity slider: 0 is a real off switch, 1 is normal, 3 compresses the range to a third
  // so a distant or quiet source reaches full brightness. It NEVER moves the gate, so no setting can
  // make a silent room light up.
  function rangeScaleFor(slider) {
    var g = Number(slider);
    if (!(g > 0)) return null;          // null => microphone off
    return g;
  }
  // What the operator should read on screen: how many dB above this room's quiet now count as full.
  function rangeDbFor(slider, rangeDb) {
    var s = rangeScaleFor(slider);
    return s == null ? null : Math.max(6, (rangeDb == null ? 45 : rangeDb) / s);
  }

  // ---- BEAT ALIGNMENT (round 16.5) --------------------------------------------------------------
  //
  // A live microphone cannot be in time with the room. The sound has to cross the air to this device
  // (~3 ms per metre), sit in the operating system's input buffer, get measured, cross the network to
  // every phone, and then survive the phone's own attack/release smoothing. By the time the crowd
  // lights up, the beat that caused it has passed. You cannot remove that lag — the future of a live
  // signal is not knowable — but you can ADD to it until the flash lands on the NEXT beat, which
  // looks perfectly in time. At 120 BPM a beat is 500 ms, so the whole correction a room ever needs
  // is under one beat; MAX_DELAY_MS covers a beat even at a slow 40 BPM.
  //
  // The delay line always retains the full MAX_DELAY_MS of history regardless of the delay currently
  // asked for, so moving the control jumps straight to a value it already holds — no silence, no
  // refill, no waiting. That matters because the operator dials this in by ear against the room,
  // moving the control while the crowd is watching.
  var MAX_DELAY_MS = 1500;
  function makeDelayLine(maxMs) {
    var cap = Math.max(0, Number(maxMs) || MAX_DELAY_MS);
    var t = [], v = [];
    return {
      // Record the level measured at time `now` (any monotonic clock, milliseconds).
      push: function (now, level) {
        if (!(now >= 0) || !(level >= 0)) return;
        t.push(now); v.push(level);
        // keep the FULL window, not just the delay in force — see the note above
        var cutoff = now - cap - 250;
        var drop = 0; while (drop < t.length - 1 && t[drop] < cutoff) drop++;
        if (drop > 0) { t.splice(0, drop); v.splice(0, drop); }
      },
      // The level as it was `delayMs` before `now`, linearly interpolated between the two frames
      // that straddle it. Before the line has that much history (only the first moments after the
      // microphone starts) it returns the oldest value it holds, so the output is always continuous.
      sample: function (now, delayMs) {
        if (!t.length) return 0;
        var d = Number(delayMs); if (!(d > 0)) d = 0;
        if (d > cap) d = cap;
        var want = now - d;
        if (want <= t[0]) return v[0];
        if (want >= t[t.length - 1]) return v[v.length - 1];
        var lo = 0, hi = t.length - 1;
        while (lo < hi - 1) { var mid = (lo + hi) >> 1; if (t[mid] <= want) lo = mid; else hi = mid; }
        var span = t[hi] - t[lo];
        var f = span > 0 ? (want - t[lo]) / span : 0;
        return v[lo] + (v[hi] - v[lo]) * f;
      },
      // how much history is actually available right now (ms) — the meter uses it while warming up
      span: function () { return t.length ? t[t.length - 1] - t[0] : 0; },
      size: function () { return t.length; },
      reset: function () { t = []; v = []; },
    };
  }
  // The control is in whole milliseconds, clamped — never trust a number straight off a slider or
  // out of a browser store.
  function delayMsFor(value) {
    var d = Math.round(Number(value));
    if (!(d > 0)) return 0;
    return d > MAX_DELAY_MS ? MAX_DELAY_MS : d;
  }

  global.CLS_MIC = { bandDb: bandDb, makeMicLevel: makeMicLevel, rangeScaleFor: rangeScaleFor, rangeDbFor: rangeDbFor,
    makeDelayLine: makeDelayLine, delayMsFor: delayMsFor, MAX_DELAY_MS: MAX_DELAY_MS, SILENT_DB: SILENT_DB };
})(typeof globalThis !== 'undefined' ? globalThis : this);
