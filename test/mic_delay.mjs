// The beat-alignment delay, measured rather than assumed (round 16.5).
//
// Andrii: "the lights do not land on the beat of the music in the room; I want to raise a delay
// until they do". A live microphone is always late — air, input buffer, network, the phone's own
// attack/release — and that lag cannot be subtracted. It CAN be padded until the flash lands on the
// next beat. This harness proves the control does what it says: that the number the crowd receives
// really is the level from N milliseconds earlier, that the setting survives a reload, and that
// moving it never pushes the crowd past the epilepsy governor.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3000';
const dir = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { base: BASE, checks: {}, fails: [] };
const check = (id, ok, d) => { report.checks[id] = { ok: !!ok, detail: d }; if (!ok) report.fails.push(id + ': ' + d); console.log((ok ? 'OK  ' : 'FAIL') + ' [' + id + '] ' + d); };

// Chromium's built-in fake microphone is a PERIODIC beep, and a periodic stimulus makes any two
// delays a whole period apart mathematically indistinguishable — it cannot tell a 900 ms delay from
// a 400 ms one. So we hand Chromium an APERIODIC recording instead: a tone whose loudness jumps to a
// new pseudo-random level every 80-250 ms, which correlates with itself at exactly one shift. Now the
// measurement is unambiguous across the whole range of the control.
function aperiodicWav(seconds, file) {
  const sr = 48000, n = sr * seconds, data = Buffer.alloc(n * 2);
  let seed = 20260829;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let i = 0;
  while (i < n) {
    const seg = Math.round((0.08 + rnd() * 0.17) * sr);      // 80-250 ms of one loudness
    const amp = 0.05 + rnd() * 0.9;
    for (let k = 0; k < seg && i < n; k++, i++) {
      const t = i / sr;
      data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 500 * t) * amp * 32000), i * 2);
    }
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
  return file;
}

// Record, inside the page, what the microphone measured and what was actually put on the wire.
const RECORD_START = () => {
  window.__rec = [];
  window.__recOn = true;
  (function tick() {
    if (!window.__recOn) return;
    requestAnimationFrame(tick);
    const m = window.__opMic;
    window.__rec.push([performance.now(), m.level, m.delayedLevel]);
  })();
};

// Chromium's fake microphone is a PERIODIC tone: its measured level repeats almost exactly every
// second (autocorrelation r ~= 1.00 at 1000 ms). Any two delays a whole period apart are therefore
// literally indistinguishable in the data, so the estimator below searches inside ONE period and the
// settings under test are kept below it; the top of the range is checked modulo the period instead,
// and the alias is reported rather than hidden.
function resample(rec, hz = 100) {
  const T = rec.map((r) => r[0]), L = rec.map((r) => r[1]), D = rec.map((r) => r[2]);
  const interp = (arr, t) => {
    if (t <= T[0]) return arr[0];
    if (t >= T[T.length - 1]) return arr[arr.length - 1];
    let lo = 0, hi = T.length - 1;
    while (lo < hi - 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; }
    const s = T[hi] - T[lo];
    return arr[lo] + (arr[hi] - arr[lo]) * (s > 0 ? (t - T[lo]) / s : 0);
  };
  const step = 1000 / hz, out = { t: [], l: [], d: [], hz };
  for (let t = T[0]; t <= T[T.length - 1]; t += step) { out.t.push(t); out.l.push(interp(L, t)); out.d.push(interp(D, t)); }
  return out;
}

// The repeat period of whatever the microphone is hearing, in ms (0 if it does not repeat).
// A periodic signal correlates just as well at 2P and 3P as at P, so taking the strongest peak
// returns a MULTIPLE of the period at random and the alias-avoiding window comes out too wide. Take
// the FUNDAMENTAL: the smallest lag whose correlation is within a hair of the best one.
function estimatePeriod(r) {
  const n = r.l.length, mean = r.l.reduce((a, x) => a + x, 0) / n;
  const curve = [];
  for (let lag = Math.round(0.2 * r.hz); lag < Math.min(3 * r.hz, n - 20); lag++) {
    let num = 0, da = 0, db = 0;
    for (let i = 0; i + lag < n; i++) { const a = r.l[i] - mean, b = r.l[i + lag] - mean; num += a * b; da += a * a; db += b * b; }
    curve.push([lag * (1000 / r.hz), num / Math.sqrt((da * db) || 1)]);
  }
  if (!curve.length) return { period: 0, corr: 0 };
  const maxC = Math.max(...curve.map((c) => c[1]));
  if (maxC <= 0.9) return { period: 0, corr: maxC };
  const first = curve.find((c, i) => c[1] >= maxC - 0.03
    && (i === 0 || curve[i - 1][1] <= c[1]) && (i === curve.length - 1 || curve[i + 1][1] <= c[1]));
  return { period: first ? first[0] : 0, corr: first ? first[1] : maxC };
}

// The shift that best explains the wire signal, searched over [0, maxMs].
function estimateLag(r, maxMs) {
  const n = r.l.length;
  let best = 0, bestErr = Infinity;
  for (let s = 0; s <= maxMs; s += 10) {
    const off = Math.round(s * r.hz / 1000);
    let sum = 0, cnt = 0;
    for (let i = off; i < n; i++) { const e = r.d[i] - r.l[i - off]; sum += e * e; cnt++; }
    if (cnt < 40) continue;
    const err = Math.sqrt(sum / cnt);
    if (err < bestErr) { bestErr = err; best = s; }
  }
  return { best, bestErr };
}

async function capture(op, delayMs, seconds = 6) {
  await op.evaluate((d) => {
    const s = document.getElementById('micDelay');
    s.value = String(d); s.dispatchEvent(new Event('input', { bubbles: true }));
  }, delayMs);
  await sleep(2000);                                   // let the line cover the new setting
  await op.evaluate(RECORD_START);
  await sleep(seconds * 1000);
  const rec = await op.evaluate(() => { window.__recOn = false; return window.__rec; });
  return resample(rec);
}

async function main() {
  const wav = aperiodicWav(180, path.join(process.env.TEMP || '/tmp', 'cls-mic-delay-stimulus.wav'));
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--use-file-for-fake-audio-capture=' + wav + '%noloop', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 1400 }, permissions: ['microphone'] });
  const op = await ctx.newPage();
  const errs = [];
  op.on('pageerror', (e) => errs.push(String(e.message)));
  await op.goto(BASE + '/studio');
  await op.waitForFunction(() => window.__opMic && window.__SESSION__ && window.CLS_MIC, { timeout: 30000 });
  const room = await op.evaluate(() => window.__SESSION__.room);

  const ph = await browser.newContext({ viewport: { width: 390, height: 844 } }).then((c) => c.newPage());
  await ph.goto(BASE + '/join?room=' + room + '&auto=1');
  await ph.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 30000 });

  await op.click('#playSound');
  await op.waitForFunction(() => !document.getElementById('opConsole').classList.contains('pre-start'), { timeout: 30000 });
  await op.waitForSelector('#srcMic', { state: 'visible', timeout: 20000 });
  await op.click('#srcMic');
  await op.waitForFunction(() => window.__opMic.on === true, { timeout: 20000 });
  await sleep(2500);

  const ui = await op.evaluate(() => {
    const s = document.getElementById('micDelay'), v = document.getElementById('micDelayVal'), h = document.getElementById('micDelayHint');
    const panel = document.getElementById('micPanel');
    return s ? { min: s.min, max: s.max, step: s.step, value: s.value, readout: (v || {}).textContent,
      inPanel: !!(panel && panel.contains(s)), panelShown: !!(panel && !panel.classList.contains('hidden')),
      hint: ((h || {}).textContent || '') } : null;
  });
  check('the_delay_control_is_in_the_microphone_panel', !!ui && ui.inPanel && ui.panelShown,
    ui ? `range ${ui.min}..${ui.max} ms step ${ui.step}, reads "${String(ui.readout).trim()}"` : 'no delay control was found');
  check('the_range_covers_a_whole_beat', !!ui && Number(ui.max) >= 1000 && Number(ui.step) <= 25,
    ui ? `up to ${ui.max} ms in ${ui.step} ms steps — a beat is 500 ms at 120 BPM, 1000 ms at 60 BPM` : 'n/a');
  check('the_hint_explains_what_to_do_with_it', !!ui && /beat|takt/i.test(ui.hint) && /delay|opóźnien/i.test(ui.hint),
    ui ? `"${ui.hint.slice(0, 90)}…"` : 'n/a');

  // ---- the measurement: is the crowd really getting the level from N ms ago? ----
  const base = await capture(op, 0);
  const per = estimatePeriod(base);
  const window0 = per.period ? Math.max(200, per.period - 20) : 1500;   // an aperiodic stimulus needs no such guard
  const b0 = estimateLag(base, window0);
  console.log(`     (stimulus repeats every ${Math.round(per.period)} ms, r=${per.corr.toFixed(2)}; searching shifts up to ${window0} ms)`);
  check('with_no_delay_the_crowd_gets_what_the_microphone_hears_now', b0.best <= 100,
    `best-fit lag with the control at 0 is ${b0.best} ms (residual ${b0.bestErr.toFixed(3)})`);

  const measured = [{ set: 0, got: b0.best }];
  for (const set of [300, 600, 900]) {
    if (per.period && set >= per.period) continue;      // would alias — covered by the modulo check below
    const r = await capture(op, set);
    const m = estimateLag(r, window0);
    measured.push({ set, got: m.best, err: m.bestErr });
    check(`a_${set}_ms_setting_really_delays_the_crowd_by_${set}_ms`, Math.abs(m.best - (b0.best + set)) <= 120,
      `measured ${m.best} ms for a ${set} ms setting (expected about ${b0.best + set} ms, residual ${m.bestErr.toFixed(3)})`);
  }
  check('the_measured_lag_rises_with_the_control', measured.every((x, i) => i === 0 || x.got > measured[i - 1].got),
    measured.map((x) => `${x.set}->${x.got}ms`).join('  '));

  // the very top of the range, where the periodic stimulus can only pin it down modulo one period
  const top = await capture(op, 1400);
  const tf = estimateLag(top, 1400);
  const expect = b0.best + 1400;
  const aliasOk = per.period
    ? Math.min(...[0, 1, 2].map((k) => Math.abs(tf.best - (expect - k * per.period)))) <= 140
    : Math.abs(tf.best - expect) <= 160;
  check('the_top_of_the_range_delays_by_the_full_amount', aliasOk,
    per.period
      ? `measured ${tf.best} ms for 1400 ms; with a ${Math.round(per.period)} ms repeating stimulus that is ${expect} ms modulo the period`
      : `measured ${tf.best} ms for 1400 ms (expected about ${expect} ms)`);

  // ---- moving the control must never make the crowd less safe ----
  // The delayed stream is a time SHIFT of a stream that was already governed, so it cannot be
  // brighter; what has to be proven is that SWEEPING it (the operator hunting for the beat) does not
  // manufacture flashes at the discontinuities.
  await op.evaluate((d) => { const s = document.getElementById('micDelay'); s.value = String(d); s.dispatchEvent(new Event('input', { bubbles: true })); }, 0);
  await sleep(1500);
  const baseFrom = await ph.evaluate(() => window.__cls.flashCount);
  await sleep(8000);
  const baseFlashes = (await ph.evaluate(() => window.__cls.flashCount)) - baseFrom;

  const sweepFrom = await ph.evaluate(() => window.__cls.flashCount);
  const t0 = Date.now();
  for (let i = 0; Date.now() - t0 < 8000; i++) {
    const d = [0, 250, 700, 1500, 900, 120, 1400, 300][i % 8];
    await op.evaluate((x) => { const s = document.getElementById('micDelay'); s.value = String(x); s.dispatchEvent(new Event('input', { bubbles: true })); }, d);
    await sleep(220);
  }
  const sweepSecs = (Date.now() - t0) / 1000;
  const sweepFlashes = (await ph.evaluate(() => window.__cls.flashCount)) - sweepFrom;
  const sweepRate = sweepFlashes / sweepSecs, baseRate = baseFlashes / 8;
  check('sweeping_the_delay_stays_inside_the_epilepsy_governor', sweepRate <= 3,
    `${sweepFlashes} flashes in ${sweepSecs.toFixed(1)} s = ${sweepRate.toFixed(2)}/s (cap 3/s; steady baseline ${baseRate.toFixed(2)}/s)`);
  check('sweeping_the_delay_does_not_manufacture_flashes', sweepRate <= Math.max(baseRate * 2 + 0.5, 1.5),
    `sweeping ${sweepRate.toFixed(2)}/s vs steady ${baseRate.toFixed(2)}/s`);

  // ---- the setting has to survive a reload: the same room needs the same number every night ----
  await op.evaluate(() => { const s = document.getElementById('micDelay'); s.value = '640'; s.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(500);
  await op.reload();
  await op.waitForFunction(() => window.__opMic && window.CLS_MIC, { timeout: 30000 });
  await sleep(1200);
  const kept = await op.evaluate(() => ({ v: (document.getElementById('micDelay') || {}).value, read: (document.getElementById('micDelayVal') || {}).textContent, tele: window.__opMic.delayMs }));
  check('the_delay_is_remembered_on_this_device', String(kept.v) === '640' && kept.tele === 640,
    `after a reload the control reads ${kept.v} ms ("${String(kept.read).trim()}"), telemetry ${kept.tele}`);

  check('no_console_errors', errs.length === 0, errs.length ? errs.slice(0, 4).join(' | ') : 'nothing thrown');
  await browser.close();
  report.ok = report.fails.length === 0;
  fs.writeFileSync(path.join(dir, '..', 'mic_delay_report.json'), JSON.stringify(report, null, 2));
  console.log(report.ok ? '\nALL OK' : '\nFAILS: ' + report.fails.join(' | '));
  process.exit(report.ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
