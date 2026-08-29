// Round 16.2, in a real browser: the microphone level chain end-to-end, and the XY pad's size.
//
// The unit tests in test/mic_level.test.mjs pin the maths. This pins the WIRING — that the console
// actually feeds a band-limited spectrum through it, that the meter exposes the noise floor and the
// gate, that a silent input really produces a zero on the wire, and that the colour pad is big
// enough to drag a hue accurately.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3000';
const dir = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { base: BASE, checks: {}, fails: [] };
const check = (id, ok, d) => { report.checks[id] = { ok: !!ok, detail: d }; if (!ok) report.fails.push(id + ': ' + d); console.log((ok ? 'OK  ' : 'FAIL') + ' [' + id + '] ' + d); };

async function main() {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 1400 }, permissions: ['microphone'] });
  const op = await ctx.newPage();
  const errs = [];
  op.on('pageerror', (e) => errs.push(String(e.message)));
  await op.goto(BASE + '/studio');
  await op.waitForFunction(() => window.__opMic && window.__SESSION__ && window.CLS_MIC, { timeout: 30000 });
  check('mic_module_loaded', await op.evaluate(() => !!(window.CLS_MIC && window.CLS_MIC.makeMicLevel && window.CLS_MIC.bandDb)),
    'the console loads the microphone level module');

  await op.click('#playSound');
  await op.waitForFunction(() => !document.getElementById('opConsole').classList.contains('pre-start'), { timeout: 30000 });
  await op.waitForSelector('#srcMic', { state: 'visible', timeout: 20000 });
  await op.click('#srcMic');
  await op.waitForFunction(() => window.__opMic.on === true, { timeout: 20000 });
  await sleep(3500);

  // The chain must be measuring in dB against a tracked floor, not normalising a raw RMS. Chromium's
  // fake device is a PERIODIC tone with silent gaps, so sample a window and judge on the loudest
  // frame rather than on whichever instant this happens to land in.
  let m = null;
  for (let i = 0; i < 25; i++) {
    const s = await op.evaluate(() => ({ db: window.__opMic.db, floorDb: window.__opMic.floorDb, overDb: window.__opMic.overDb, open: window.__opMic.open, level: window.__opMic.level, sent: window.__opMic.sent }));
    if (!m || s.db > m.db) m = s;
    await sleep(80);
  }
  check('mic_reports_db_against_a_floor', m.db > -140 && m.db < 0 && m.floorDb > -140 && m.floorDb <= m.db + 1,
    `loudest frame in 2 s: input ${m.db.toFixed(1)} dB, tracked room floor ${m.floorDb.toFixed(1)} dB, ${m.overDb.toFixed(1)} dB over (gate ${m.open ? 'open' : 'closed'})`);
  check('mic_is_sending', m.sent > 20, `${m.sent} frames on the wire`);

  // Chromium's fake device is a periodic tone — it must clear the gate at least sometimes.
  let openFrames = 0, peak = 0;
  for (let i = 0; i < 30; i++) {
    const s = await op.evaluate(() => ({ open: window.__opMic.open, level: window.__opMic.level }));
    if (s.open) openFrames++; peak = Math.max(peak, s.level);
    await sleep(100);
  }
  check('a_real_signal_opens_the_gate', openFrames > 5 && peak > 0.15,
    `the gate opened in ${openFrames}/30 samples with a peak level of ${peak.toFixed(2)}`);

  // THE COMPLAINT: turning sensitivity up must not turn the room's own noise into a light show. The
  // fake device is a real signal, so the honest test of "noise never lights up" is the maths (unit
  // tests); here we check the structural guarantee — the GATE does not move with the slider.
  const gateMoves = await op.evaluate(() => {
    const mk = window.CLS_MIC.makeMicLevel;
    const run = (sens) => { const st = mk(); let r; for (let i = 0; i < 600; i++) r = st(-58 + (i % 7) * 0.4, 16, sens); return r; };
    return { at1: run(1).open, at3: run(3).open, lvl1: run(1).level, lvl3: run(3).level };
  });
  check('sensitivity_cannot_light_up_a_silent_room', gateMoves.at1 === false && gateMoves.at3 === false && gateMoves.lvl3 === 0,
    `steady room noise stays gated at sensitivity 1 and at 3 (levels ${gateMoves.lvl1} / ${gateMoves.lvl3})`);

  // sensitivity 0 is off, on the wire as well as on screen
  await op.evaluate(() => { const s = document.getElementById('micGain'); s.value = '0'; s.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(1200);
  const off = await op.evaluate(() => ({ level: window.__opMic.level, label: document.getElementById('micGainVal').textContent }));
  check('sensitivity_zero_is_off', off.level === 0, `level ${off.level}, slider reads "${off.label}"`);
  await op.evaluate(() => { const s = document.getElementById('micGain'); s.value = '1'; s.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(600);
  const back = await op.evaluate(() => document.getElementById('micGainVal').textContent);
  check('sensitivity_readout_is_in_db', /dB/.test(back), `the slider says what it does: "${back}"`);

  // ---------------------------- the XY pad ----------------------------
  await op.evaluate(() => { const d = document.getElementById('vjAdv'); if (d) d.open = true; });
  await op.evaluate(() => { const b = document.getElementById('vjEnable'); if (b) b.click(); });
  await sleep(400);
  await op.evaluate(() => { const t = document.querySelector('#vjTabs [data-vjtab="xy"]'); if (t) t.click(); });
  await sleep(600);
  const pad = await op.evaluate(() => {
    const box = document.querySelector('#vjStage div[style*="linear-gradient(to top"]');
    if (!box) return null;
    const r = box.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  check('xy_pad_is_big_enough_to_drag', !!pad && pad.w >= 300 && pad.h >= 300,
    pad ? `${pad.w}x${pad.h} css px (was 210x180 — under 2 px per degree of hue)` : 'the XY pad was not found');

  // dragging across the pad must sweep the whole hue circle, and the cursor must follow the real size
  if (pad) {
    // getBoundingClientRect is viewport-relative: on this long console page the pad sits below the
    // fold, so without scrolling it into view the mouse coordinates land somewhere else entirely.
    await op.evaluate(() => document.querySelector('#vjStage div[style*="linear-gradient(to top"]').scrollIntoView({ block: 'center' }));
    await sleep(400);
    const box = await op.evaluate(() => { const b = document.querySelector('#vjStage div[style*="linear-gradient(to top"]'); const r = b.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    await op.mouse.move(box.x + 4, box.y + box.h / 2);
    await op.mouse.down();
    // window.__opVJ is refreshed from a rAF-scheduled, 50 ms-throttled emit, so read it AFTER that
    // has had a chance to run — otherwise this measures the previous frame, not the drag.
    await sleep(250);
    const hueLeft = await op.evaluate(() => window.__opVJ.hue);
    await op.mouse.move(box.x + box.w - 4, box.y + box.h * 0.15, { steps: 12 });
    await sleep(250);
    const far = await op.evaluate(() => ({ hue: window.__opVJ.hue, bri: window.__opVJ.bri }));
    await op.mouse.up();
    await sleep(150);
    const dot = await op.evaluate(() => {
      const b = document.querySelector('#vjStage div[style*="linear-gradient(to top"]');
      const d = b.querySelector('div'); const br = b.getBoundingClientRect(), dr = d.getBoundingClientRect();
      return { relX: (dr.left + dr.width / 2 - br.left) / br.width, relY: (dr.top + dr.height / 2 - br.top) / br.height };
    });
    check('xy_pad_sweeps_the_whole_range', far.hue > 330 && hueLeft < 30 && far.bri > 0.75,
      `dragging corner to corner moved hue ${Math.round(hueLeft)}° -> ${Math.round(far.hue)}° and brightness to ${far.bri.toFixed(2)}`);
    check('xy_cursor_tracks_the_real_size', dot.relX > 0.9 && dot.relY < 0.3,
      `the cursor sits at ${(dot.relX * 100).toFixed(0)}% across and ${(dot.relY * 100).toFixed(0)}% down — it follows the pad's actual size, not a hard-coded 210x180`);
  }

  check('no_console_errors', errs.length === 0, errs.length ? errs.slice(0, 4).join(' | ') : 'nothing thrown');

  await browser.close();
  report.ok = report.fails.length === 0;
  fs.writeFileSync(path.join(dir, '..', 'mic_and_pad_report.json'), JSON.stringify(report, null, 2));
  console.log(report.ok ? '\nALL OK' : '\nFAILS: ' + report.fails.join(' | '));
  process.exit(report.ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
