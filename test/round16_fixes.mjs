// The four things Andrii hit on the round-16 build, each pinned by a check that FAILS on the code
// that shipped and passes on the fix:
//
//   #1 the VJ pult went dead in microphone mode — both manual gates ask for a running show, and the
//      microphone source deliberately stops the internal show (there is no track), so the room sat at
//      'idle' while the crowd was very much live.
//   #2 the Live preview showed a different colour from every phone — it ran on a LOCAL animation
//      clock, with N=1 and no VJ layer, instead of the crowd's own anchor.
//   #3 the operator heard one track while the phones played another — the console's visible <audio>
//      scrubber is a real player that every transport action silences, but the source switch did not.
//   #4 the sensitivity slider bottomed out at 0.4x, so the microphone could never be turned down to
//      nothing.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3000';
const PASS = process.env.OPERATOR_PASS || 'test-pass-123';
const dir = path.dirname(fileURLToPath(import.meta.url));
const j = (r) => r.json();
const H = (t, e) => ({ Authorization: 'Bearer ' + t, ...(e || {}) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { base: BASE, checks: {}, fails: [] };
const check = (id, ok, d) => { report.checks[id] = { ok: !!ok, detail: d }; if (!ok) report.fails.push(id + ': ' + d); console.log((ok ? 'OK  ' : 'FAIL') + ' [' + id + '] ' + d); };
const lum = (c) => c ? (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255 : 0;
const parseBg = (s) => { const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(s || ''); return m ? [+m[1], +m[2], +m[3]] : null; };

function toneWav(sec, hz) {
  const sr = 22050, n = Math.round(sr * sec), data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) { const t = i / sr, amp = (Math.floor(t * 2) % 2) === 1 ? 0.9 : 0.05; data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * hz * t) * amp * 32767), i * 2); }
  const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40); return Buffer.concat([h, data]);
}

async function main() {
  const token = (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) }).then(j)).token;
  if (!token) throw new Error('login failed');
  const fd = new FormData(); fd.append('audio', new Blob([toneWav(30, 220)]), 'r16fix.wav');
  const up = await fetch(BASE + '/api/operator/upload', { method: 'POST', headers: H(token), body: fd }).then(j);
  if (!up.trackId) throw new Error('upload failed: ' + JSON.stringify(up));
  await fetch(BASE + `/api/operator/track/${up.trackId}/attest`, { method: 'POST', headers: H(token) }).then(j);
  await fetch(BASE + `/api/operator/track/${up.trackId}/public`, { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ is_public: true }) }).then(j);
  await fetch(BASE + '/api/operator/public-config', { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ default_track_id: up.trackId, default_screen_preset: 'pulse', default_screen_params: {} }) }).then(j);
  const code = (await fetch(BASE + '/api/public/show').then(j)).code;

  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });

  // ============================== #4 (markup, no browser needed) ==============================
  const html = await fetch(BASE + '/studio').then((r) => r.text());
  const slider = /<input[^>]*id="micGain"[^>]*>/.exec(html);
  const min = slider ? /min="([^"]*)"/.exec(slider[0]) : null;
  check('mic_gain_reaches_zero', !!min && Number(min[1]) === 0, `sensitivity slider min="${min ? min[1] : '?'}" — it must be able to turn the microphone down to nothing`);

  // ============================== the /studio console + one phone ==============================
  const opCtx = await browser.newContext({ viewport: { width: 1100, height: 1300 }, permissions: ['microphone'] });
  const op = await opCtx.newPage();
  const opErrors = [];
  op.on('pageerror', (e) => opErrors.push(String(e.message)));
  await op.goto(BASE + '/studio');
  // NOTE: deliberately does not wait for window.__opState — that seam only exists on the fixed
  // build, and this test must still be runnable against the build that shipped the bugs.
  await op.waitForFunction(() => window.__opMic && window.__SESSION__, { timeout: 30000 });
  const room = await op.evaluate(() => window.__SESSION__.room);
  const ctoken = await op.evaluate(() => window.__SESSION__.token);
  const cPost = (p, body) => fetch(BASE + p, { method: 'POST', headers: H(ctoken, { 'Content-Type': 'application/json' }), body: JSON.stringify(body) }).then(j);

  const phCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const ph = await phCtx.newPage();
  await ph.goto(`${BASE}/join?room=${room}&auto=1`);
  await ph.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 30000 });

  await op.click('#playSound');
  await op.waitForFunction(() => !document.getElementById('opConsole').classList.contains('pre-start'), { timeout: 30000 });
  await op.waitForSelector('#srcMic', { state: 'visible', timeout: 20000 });
  await op.click('#srcMic');
  await op.waitForFunction(() => window.__opMic.on === true, { timeout: 20000 });
  await ph.waitForFunction(() => window.__cls.mic.on === true, { timeout: 10000 });
  await sleep(1500);

  // ---------------------------- #1: manual control in microphone mode ----------------------------
  // Pure manual, full white, flash latched: the crowd must go bright and the torch must be asked for.
  await cPost('/api/console/manual', { on: true, mode: 'full', hue: 0, sat: 0, bri: 1, flash: 1 });
  await sleep(1200);
  let lit = 0, torchOn = 0, n = 0, neutral = 0;
  for (let i = 0; i < 14; i++) {
    const s = await ph.evaluate(() => ({ bg: window.__cls.lastBg, want: window.__cls.torch.want }));
    const c = parseBg(s.bg);
    if (c) { lit = Math.max(lit, lum(c)); if (Math.max(...c) - Math.min(...c) <= 14) neutral++; }
    torchOn += s.want ? 1 : 0; n++;
    await sleep(120);
  }
  // Pure manual at sat 0 / bri 1 must paint a NEUTRAL bright screen and hold the flash latched. A
  // preset that merely happens to be bright is coloured and its torch flickers — that is exactly what
  // the broken build produced, so both halves of this assertion matter.
  check('manual_works_in_mic_mode', lit > 0.5 && neutral >= n - 2 && torchOn >= n - 2,
    `with the microphone as the source, pure-manual white reached luminance ${lit.toFixed(2)}, was neutral-grey in ${neutral}/${n} samples and held the flash in ${torchOn}/${n}`);

  // STOP must still darken the crowd even though the microphone source is still selected
  await cPost('/api/console/stop', {});
  await sleep(900);
  const afterStop = await ph.evaluate(() => ({ bg: window.__cls.lastBg, want: window.__cls.torch.want, manual: window.__cls.manual.on }));
  check('stop_still_darkens_in_mic_mode', lum(parseBg(afterStop.bg)) < 0.05 && !afterStop.want && afterStop.manual === false,
    `after STOP: screen ${afterStop.bg}, flash want ${afterStop.want}, manual released ${!afterStop.manual}`);

  // ---------------------------- #2: the Live preview matches the crowd ----------------------------
  await cPost('/api/console/manual', { on: false });
  // rainbow_chase with audioDepth 0 is driven by PHASE alone: if the preview runs on its own clock it
  // cannot agree with the crowd, no matter what the loudness is doing.
  await cPost('/api/console/preset', { channel: 'screen', type: 'rainbow_chase', params: { audioDepth: 0 } });
  await sleep(1500);
  const anchored = await op.evaluate(() => ({ startedAt: window.__opMainPv.startedAt, synced: window.__opMainPv.synced }));
  check('preview_is_anchored_to_the_room', anchored.startedAt != null && anchored.synced === true,
    `the console renders the preview off the room's own preset anchor (startedAt=${anchored.startedAt}, clock synced=${anchored.synced})`);

  // Polling the two pages in turn reads them milliseconds apart, which on a fast preset is itself a
  // big luminance gap — so record a TRACE on each page against the shared wall clock and compare the
  // traces aligned in time. That measures what actually matters: is the preview in PHASE with the crowd.
  const trace = (pg, expr) => pg.evaluate((e) => {
    window.__tr = [];
    const read = new Function('return ' + e);
    const tick = () => { const v = read(); if (v) window.__tr.push({ t: performance.timeOrigin + performance.now(), v: v }); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }, expr);
  // A spatial preset paints every phone differently, so compare THIS phone against ITS OWN bar in
  // the console's crowd strip — that is the claim under test: the console shows what the phones show.
  const myIdx = await ph.evaluate(() => window.__cls.idx);
  await Promise.all([trace(op, 'window.__opMainPv.bars && window.__opMainPv.bars[' + myIdx + ']'), trace(ph, 'window.__cls.lastBg')]);
  await sleep(4000);
  const [tOp, tPh] = await Promise.all([op.evaluate(() => window.__tr.slice()), ph.evaluate(() => window.__tr.slice())]);
  const toL = (a) => a.map((x) => ({ t: x.t, L: lum(parseBg(x.v)) })).filter((x) => x.L === x.L);
  const A = toL(tOp), Bt = toL(tPh);
  const gaps = [];
  for (const a of A) {                                   // nearest phone sample in time
    let best = null, bd = 1e9;
    for (const b of Bt) { const d = Math.abs(b.t - a.t); if (d < bd) { bd = d; best = b; } }
    if (best && bd <= 25) gaps.push(Math.abs(a.L - best.L));
  }
  gaps.sort((x, y) => x - y);
  const med = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 1;
  const p90 = gaps.length ? gaps[Math.floor(gaps.length * 0.9)] : 1;
  check('preview_matches_the_crowd', gaps.length > 40 && med < 0.12 && p90 < 0.3,
    `the console's bar for phone #${myIdx} vs that phone itself, time-aligned within 25 ms over ${gaps.length} pairs: median |dL| ${med.toFixed(3)}, p90 ${p90.toFixed(3)} (a free-running preview drifts across the whole range)`);

  // A spatial look means different phones show different things, so the preview has to be a strip,
  // one bar per phone — and every phone must match ITS OWN bar. Bring in a second phone and check both.
  const phB = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await phB.goto(`${BASE}/join?room=${room}&auto=1`);
  await phB.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 30000 });
  await sleep(1500);
  const strip = await op.evaluate(() => ({ bars: window.__opMainPv.bars, n: window.__opMainPv.crowdN }));
  const idxs = await Promise.all([ph.evaluate(() => window.__cls.idx), phB.evaluate(() => window.__cls.idx)]);
  check('preview_has_a_bar_per_phone', (strip.bars || []).length === Math.max(1, strip.n) && strip.n >= 3 && idxs.every((i) => i < strip.n),
    `${(strip.bars || []).length} bars for an index space of ${strip.n}; the two phones sit at ${JSON.stringify(idxs)}`);

  let bothMatch = true, detail = [];
  for (let k = 0; k < 8; k++) {
    const [bars, c1, c2] = await Promise.all([
      op.evaluate(() => window.__opMainPv.bars),
      ph.evaluate(() => window.__cls.lastBg),
      phB.evaluate(() => window.__cls.lastBg),
    ]);
    for (const [i, c] of [[idxs[0], c1], [idxs[1], c2]]) {
      const a = parseBg(bars && bars[i]), b = parseBg(c);
      if (a && b && Math.abs(lum(a) - lum(b)) > 0.35) { bothMatch = false; detail.push('phone#' + i + ' ' + c + ' vs bar ' + bars[i]); }
    }
    await sleep(150);
  }
  check('every_phone_matches_its_own_bar', bothMatch,
    bothMatch ? 'both phones tracked their own bar in the console strip across 8 samples' : detail.slice(0, 3).join(' | '));
  await phB.close();

  // ---------------------------- #3: the console's own player is silenced ----------------------------
  const opCtx2 = await browser.newContext({ viewport: { width: 1100, height: 1400 }, permissions: ['microphone'], httpCredentials: { username: 'operator', password: PASS } });
  const op2 = await opCtx2.newPage();
  await op2.goto(BASE + '/operator');
  await op2.waitForSelector('[data-arm]', { timeout: 30000 });
  const ph2 = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await ph2.goto(`${BASE}/join?s=${code}&auto=1`);
  await ph2.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 30000 });
  await op2.click(`[data-arm="${up.trackId}"]`);
  await sleep(3000);
  // the operator presses play on the visible <audio> scrubber to audition the track
  await op2.evaluate(() => { const p = document.getElementById('player'); p.muted = false; return p.play().catch(() => {}); });
  await sleep(1200);
  const pBefore = await op2.evaluate(() => { const p = document.getElementById('player'); return { paused: p.paused, t: p.currentTime }; });
  await op2.click('#srcMic');
  await op2.waitForFunction(() => window.__opMic.on === true, { timeout: 20000 });
  await sleep(2000);
  const pAfter = await op2.evaluate(() => { const p = document.getElementById('player'); return { paused: p.paused, t: p.currentTime, muted: p.muted }; });
  check('source_switch_silences_the_operators_own_player',
    pBefore.paused === false && pAfter.paused === true && pAfter.t <= pBefore.t + 0.2,
    `the console's <audio> was playing (t=${pBefore.t.toFixed(1)}s) and the source switch stopped it (paused=${pAfter.paused}, t=${pAfter.t.toFixed(1)}s, muted=${pAfter.muted})`);
  await op2.click('#srcInternal');
  await sleep(800);
  const pBack = await op2.evaluate(() => { const p = document.getElementById('player'); return { paused: p.paused }; });
  check('switch_back_leaves_the_player_silent', pBack.paused === true,
    'coming back from the microphone does not resurrect the old file behind the operator\'s back');

  check('no_console_page_errors', opErrors.length === 0, opErrors.length ? opErrors.slice(0, 4).join(' | ') : 'the console threw nothing through the whole flow');

  await browser.close();
  report.ok = report.fails.length === 0;
  fs.writeFileSync(path.join(dir, '..', 'round16_fixes_report.json'), JSON.stringify(report, null, 2));
  console.log(report.ok ? '\nALL OK' : '\nFAILS: ' + report.fails.join(' | '));
  process.exit(report.ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
