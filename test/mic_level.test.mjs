// The microphone level maths, driven with synthetic room noise, speech and music.
//
// These are exactly the complaints from a real console: "it reacts far too much to quiet noise and
// barely at all to a voice — and turning the sensitivity up makes the noise worse while the voice
// still does nothing". Each is an assertion here.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/miclevel.js';

const { makeMicLevel, bandDb, rangeScaleFor } = globalThis.CLS_MIC;

// A room, in dB of band power. Numbers are realistic for a phone microphone with AGC/NS/AEC off:
// a quiet room floor sits around -58 dBFS, a voice at a metre is 15-30 dB above it, a party is more.
const NOISE = -58, VOICE = -34, MUSIC = -22, LOUD = -12;
const jit = (() => { let s = 12345; return (amp) => { s = (s * 1103515245 + 12345) & 0x7fffffff; return ((s / 0x7fffffff) - 0.5) * 2 * amp; }; })();

// Run a level tracker over a script of [dB, seconds] segments at 60 fps, returning every level.
function run(script, { sens = 1, opts, warmupSec = 6 } = {}) {
  const step = makeMicLevel(opts);
  const dt = 1000 / 60, out = [];
  for (let t = 0; t < warmupSec * 60; t++) step(NOISE + jit(1.5), dt, sens);   // let the floor settle
  for (const [db, sec] of script) {
    for (let i = 0; i < sec * 60; i++) out.push(step(db + jit(1.5), dt, sens).level);
  }
  return out;
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * p)] ?? 0; };

test('a quiet room stays dark — the noise floor is not a light show', () => {
  const lv = run([[NOISE, 20]]);
  assert.ok(pct(lv, 0.99) < 0.05, `99th percentile over 20 s of room noise was ${pct(lv, 0.99).toFixed(3)}, must be < 0.05`);
  assert.ok(mean(lv) < 0.01, `mean level on silence was ${mean(lv).toFixed(4)}`);
});

test('a voice reads clearly, in the middle of the range', () => {
  // speech: bursts with gaps, the shape that the old ceiling-follower flattened into nothing
  const script = [];
  for (let i = 0; i < 8; i++) { script.push([VOICE, 0.45], [NOISE, 0.35]); }
  const lv = run(script);
  const loudFrames = lv.filter((x) => x > 0.3).length;
  assert.ok(pct(lv, 0.9) > 0.4, `a voice only reached ${pct(lv, 0.9).toFixed(2)} at the 90th percentile — it must be clearly visible`);
  assert.ok(loudFrames > lv.length * 0.3, `only ${loudFrames}/${lv.length} frames registered the voice`);
  assert.ok(pct(lv, 0.1) < 0.12, `the gaps between words did not go dark (10th percentile ${pct(lv, 0.1).toFixed(2)})`);
});

test('music uses the top of the range, and its dynamics survive', () => {
  const script = [];
  for (let i = 0; i < 10; i++) { script.push([LOUD, 0.12], [MUSIC, 0.38]); }   // beat + body
  const lv = run(script);
  assert.ok(pct(lv, 0.95) > 0.75, `music peaked at only ${pct(lv, 0.95).toFixed(2)}`);
  assert.ok(pct(lv, 0.95) - pct(lv, 0.2) > 0.15, 'the beat and the body of the music collapsed to the same brightness');
});

test('the whole range is used, not just the top or the bottom', () => {
  const lv = [NOISE, -50, -44, VOICE, -28, MUSIC, -17, LOUD].map((db) => mean(run([[db, 2]])));
  for (let i = 1; i < lv.length; i++) assert.ok(lv[i] >= lv[i - 1] - 0.02, `level must not fall as the room gets louder: ${JSON.stringify(lv.map((x) => +x.toFixed(2)))}`);
  assert.ok(lv[0] < 0.05, `silence -> ${lv[0].toFixed(2)}`);
  assert.ok(lv[lv.length - 1] > 0.85, `a loud room -> ${lv[lv.length - 1].toFixed(2)}`);
  const spread = lv.filter((x) => x > 0.1 && x < 0.9).length;
  assert.ok(spread >= 3, `only ${spread} of the ${lv.length} loudness steps landed in the middle of the range — the response is not spread across it`);
});

test('turning sensitivity UP lifts a quiet source but NOT the noise floor', () => {
  // This is the exact complaint: more sensitivity used to mean more reaction to noise and still
  // nothing for a voice, because the gain multiplied an already-normalised signal.
  const quietVoice = -42;   // someone speaking further away
  const before = mean(run([[quietVoice, 3]], { sens: 1 }));
  const after = mean(run([[quietVoice, 3]], { sens: rangeScaleFor(2) }));   // slider 2.0 -> half the dB needed
  assert.ok(after > before + 0.15, `sensitivity did not help a quiet voice: ${before.toFixed(2)} -> ${after.toFixed(2)}`);

  const noiseBefore = pct(run([[NOISE, 8]], { sens: 1 }), 0.99);
  const noiseAfter = pct(run([[NOISE, 8]], { sens: rangeScaleFor(3) }), 0.99);   // slider at maximum
  assert.ok(noiseAfter < 0.06, `at maximum sensitivity a silent room lit up to ${noiseAfter.toFixed(3)} — it must stay dark`);
  assert.ok(noiseAfter <= noiseBefore + 0.03, 'raising sensitivity amplified the room noise');
});

test('sensitivity 0 is a real off switch', () => {
  assert.equal(rangeScaleFor(0), null);
  assert.equal(rangeScaleFor('0'), null);
  assert.equal(rangeScaleFor(1), 1);
  assert.equal(rangeScaleFor(3), 3);
  // and it really silences a loud room, not just a quiet one
  const step = makeMicLevel();
  let r; for (let i = 0; i < 400; i++) r = step(-12, 16, null);
  assert.equal(r.level, 0, 'sensitivity 0 must mute the microphone even in a loud room');
});

test('the floor follows a room that genuinely gets quieter, without chasing the music', () => {
  const step = makeMicLevel();
  const dt = 1000 / 60;
  for (let i = 0; i < 600; i++) step(NOISE, dt, 1);            // settle at -58
  let r = step(NOISE, dt, 1);
  assert.ok(Math.abs(r.floorDb - NOISE) < 2, `floor settled at ${r.floorDb.toFixed(1)}, expected about ${NOISE}`);
  for (let i = 0; i < 60 * 20; i++) r = step(MUSIC, dt, 1);    // 20 s of loud music
  assert.ok(r.floorDb < NOISE + 12, `20 s of music dragged the noise floor up to ${r.floorDb.toFixed(1)} — it must not learn that music is silence`);
  assert.ok(r.level > 0.4, `music stopped registering after a while (level ${r.level.toFixed(2)})`);
  for (let i = 0; i < 60 * 2; i++) r = step(-72, dt, 1);       // the room goes properly quiet
  assert.ok(r.floorDb < -68, `the floor did not follow the room down (${r.floorDb.toFixed(1)})`);
  assert.equal(r.level, 0);
});

test('band weighting ignores rumble and hiss, which is what the noise actually was', () => {
  const N = 1024, sr = 48000;
  const mk = (fn) => { const a = new Float32Array(N / 2); for (let i = 0; i < a.length; i++) a[i] = fn(i * sr / N); return a; };
  const quiet = mk(() => -100);
  const rumble = mk((f) => (f < 90 ? -20 : -100));            // desk thump / HVAC
  const hiss = mk((f) => (f > 9500 ? -20 : -100));            // microphone hiss
  const voice = mk((f) => (f > 200 && f < 3500 ? -20 : -100));
  const q = bandDb(quiet, sr, N), r = bandDb(rumble, sr, N), h = bandDb(hiss, sr, N), v = bandDb(voice, sr, N);
  assert.ok(v > r + 12, `a voice must read far above rumble of the same level (voice ${v.toFixed(1)} dB vs rumble ${r.toFixed(1)} dB)`);
  assert.ok(v > h + 12, `a voice must read far above hiss of the same level (voice ${v.toFixed(1)} dB vs hiss ${h.toFixed(1)} dB)`);
  assert.ok(q < v - 30, 'a silent spectrum must read far below a voice');
});

test('a microphone that starts in silence still settles on the room, not on -140 dB', () => {
  // The console opens the stream before any audio arrives, so the first frames are dead. Seeding the
  // noise floor from those used to pin it at -140 dB; since it only creeps up half a dB per second,
  // every real sound afterwards read as "50 dB over the room" and the lights sat at full for minutes.
  const step = makeMicLevel();
  const dt = 1000 / 60;
  let r;
  for (let i = 0; i < 40; i++) r = step(-Infinity, dt, 1);        // the stream is open but silent
  assert.equal(r.level, 0, 'silence before the microphone starts must not light anything up');
  for (let i = 0; i < 60 * 2; i++) r = step(NOISE + jit(1.5), dt, 1);   // 2 s of a real, quiet room
  assert.ok(Math.abs(r.floorDb - NOISE) < 4, 'after 2 s the floor should sit on the room, got ' + r.floorDb.toFixed(1) + ' dB vs ' + NOISE);
  assert.ok(r.level < 0.05, 'a quiet room right after startup read ' + r.level.toFixed(2));
});

test('a stale floor cannot pin the lights at full', () => {
  // A room that gets much louder (the PA comes on) must not sit at 1.0 while the floor creeps up.
  const step = makeMicLevel();
  const dt = 1000 / 60;
  let r;
  for (let i = 0; i < 600; i++) r = step(-95, dt, 1);             // an extremely quiet start
  for (let i = 0; i < 60; i++) r = step(-20, dt, 1);              // the PA comes on
  assert.ok(r.overDb <= 56, 'the floor was allowed to go ' + r.overDb.toFixed(0) + ' dB stale');
  for (let i = 0; i < 60 * 3; i++) r = step(-26, dt, 1);          // a quieter passage
  assert.ok(r.level < 0.99, 'a quieter passage still read ' + r.level.toFixed(2) + ' — the response is pinned');
});

test('a dead or muted input is silence, not noise', () => {
  const step = makeMicLevel();
  let r;
  for (let i = 0; i < 300; i++) r = step(-Infinity, 16, 1);
  assert.equal(r.level, 0);
  for (let i = 0; i < 300; i++) r = step(NaN, 16, 3);
  assert.equal(r.level, 0);
});
