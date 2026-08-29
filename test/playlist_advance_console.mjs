// Two of the visitor's OWN uploads, looping — the console must play the SAME track as the crowd.
//
// Andrii's report: "I uploaded several melodies. Started it — locally one plays, on the phones a
// different one", plus "the Live preview does not work at all during playback". Both come from the
// same place: when the room's playlist advances to the next track the console follows the LIGHTS
// (it takes the new timeline) but not the SOUND, because the audio reload was written for curated
// tracks and skipped anything whose id is not a number. Guest uploads have STRING ids.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3000';
const dir = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { base: BASE, checks: {}, fails: [] };
const check = (id, ok, d) => { report.checks[id] = { ok: !!ok, detail: d }; if (!ok) report.fails.push(id + ': ' + d); console.log((ok ? 'OK  ' : 'FAIL') + ' [' + id + '] ' + d); };

// Two clearly different lengths, so "which track is the console playing" is answerable from the
// decoded buffer's duration alone.
function toneWav(sec, hz) {
  const sr = 22050, n = Math.round(sr * sec), data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / sr, amp = (Math.floor(t * 4) % 2) === 1 ? 0.9 : 0.08;
    data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * hz * t) * amp * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const guestRows = (op) => op.evaluate(() => [].slice.call(document.querySelectorAll('[data-arm]')).filter((b) => String(b.getAttribute('data-arm')).indexOf('g:') === 0).length);

async function upload(op, name, sec, hz) {
  const had = await guestRows(op);
  await op.setInputFiles('#file', { name, mimeType: 'audio/wav', buffer: toneWav(sec, hz) });
  await sleep(400);
  const consenting = await op.evaluate(() => { const m = document.getElementById('consentModal'); return !!m && !m.classList.contains('hidden'); });
  if (consenting) {
    await op.evaluate(() => { const c = document.getElementById('uploadConsent'); if (c) { c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); } });
    await op.click('#consentAgree');
  } else {
    // consent is asked ONCE per session; later files upload straight from the button
    await op.evaluate(() => { const u = document.getElementById('upload'); if (u) u.click(); });
  }
  // "Ready" is still on screen from the PREVIOUS upload, so wait for the playlist to actually grow
  await op.waitForFunction((n) => [].slice.call(document.querySelectorAll('[data-arm]')).filter((b) => String(b.getAttribute('data-arm')).indexOf('g:') === 0).length > n, had, { timeout: 90000 });
  await sleep(1500);
}

async function main() {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 1300 } });
  const op = await ctx.newPage();
  const errs = [];
  op.on('pageerror', (e) => errs.push(String(e.message)));
  await op.goto(BASE + '/studio');
  await op.waitForFunction(() => window.__opState && window.__SESSION__, { timeout: 30000 });
  const room = await op.evaluate(() => window.__SESSION__.room);
  const ph = await browser.newContext({ viewport: { width: 390, height: 844 } }).then((c) => c.newPage());
  await ph.goto(BASE + '/join?room=' + room + '&auto=1');
  await ph.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 30000 });

  await op.click('#playSound');   // this gesture also unlocks the console's own audio
  await op.waitForFunction(() => !document.getElementById('opConsole').classList.contains('pre-start'), { timeout: 30000 });

  await upload(op, 'mine-short.wav', 8, 330);
  await upload(op, 'mine-long.wav', 14, 660);

  // his setup: "loop selected" with both of his own uploads ticked
  const roomBeforeTicking = await op.evaluate(() => window.__opState.pubTrackId);
  await op.evaluate(() => { const b = document.querySelector('[data-plmode="selected"]'); if (b) b.click(); });
  await sleep(800);
  await op.evaluate(() => {
    document.querySelectorAll('input[data-plsel]').forEach((c) => {
      const want = String(c.getAttribute('data-plsel')).indexOf('g:') === 0;
      if (c.checked !== want) { c.checked = want; c.dispatchEvent(new Event('change', { bubbles: true })); }
    });
  });
  await sleep(2500);

  const before = await op.evaluate(() => ({ room: window.__opState.pubTrackId, dur: window.__opState.roomDurMs, buf: window.__opAudio.durMs, sound: window.__opState.soundOn }));
  // Ticking a box must not YANK the crowd back to the first track. It did, for guest uploads only:
  // the server asked "is the armed track a number?" instead of "is it still in the order?".
  check('ticking_a_box_does_not_restart_the_room_on_another_track', before.room === roomBeforeTicking,
    `playing ${roomBeforeTicking} before the selection was touched, ${before.room} after`);
  const selCount = await op.evaluate(() => (window.__opState.plSelected || []).filter((x) => String(x).indexOf('g:') === 0).length);
  check('two_guest_uploads_are_selected', selCount === 2,
    `the room is looping the visitor's own uploads (now on ${before.room}, ${before.dur} ms)`);

  // Does the console's own sound match the room BEFORE any advance?
  check('console_plays_the_rooms_track_at_start', before.buf != null && before.dur != null && Math.abs(before.buf - before.dur) < 1500,
    `console decoded ${before.buf} ms, the room is playing ${before.dur} ms`);

  // ---- watch the WHOLE run: a coincidental match at one instant proves nothing ----
  // Sample the room's current track and this console's own decoded buffer twice a second. A brief
  // disagreement is legitimate (the new audio has to be fetched and decoded); a sustained one is the
  // bug -- the operator monitoring one song while the crowd hears another.
  const GRACE_MS = 5000;
  const trace = [];
  const t0 = Date.now();
  let advances = 0, lastRoom = before.room;
  while (Date.now() - t0 < 50000) {
    const s = await op.evaluate(() => ({ room: window.__opState.pubTrackId, dur: window.__opState.roomDurMs, buf: window.__opAudio.durMs }));
    if (s.room !== lastRoom) { advances++; lastRoom = s.room; }
    trace.push({ ms: Date.now() - t0, room: s.room, dur: s.dur, buf: s.buf, bad: !(s.buf != null && s.dur != null && Math.abs(s.buf - s.dur) < 1500) });
    await sleep(500);
  }
  let worst = 0, runLen = 0, worstAt = null;
  for (const p of trace) { if (p.bad) { runLen++; if (runLen > worst) { worst = runLen; worstAt = p; } } else runLen = 0; }
  const worstMs = worst * 500;
  check('the_room_advances_to_the_next_track', advances >= 1,
    `the playlist moved on ${advances} time(s) during the 50 s watch`);
  check('console_never_plays_a_different_track_than_the_crowd', worstMs <= GRACE_MS,
    worstMs <= GRACE_MS
      ? `over ${trace.length} samples the console's own audio never disagreed with the room for more than ${worstMs} ms`
      : `the console monitored a DIFFERENT track for ${worstMs} ms straight (room ${worstAt.dur} ms on ${worstAt.room}, console buffer ${worstAt.buf} ms)`);
  const phone = await ph.evaluate(() => ({ trackId: window.__cls.trackId, cues: window.__cls.gotTimeline }));
  const after = await op.evaluate(() => ({ room: window.__opState.pubTrackId, dur: window.__opState.roomDurMs, buf: window.__opAudio.durMs }));
  check('the_phone_is_on_the_same_track_as_the_room', phone.trackId === after.room,
    `phone on ${phone.trackId} (${phone.cues} cues), room on ${after.room}`);

  // ---- the Live preview must actually move while the show plays ----
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    seen.add(await op.evaluate(() => (window.__opMainPv && window.__opMainPv.bars ? window.__opMainPv.bars.join('|') : 'none')));
    await sleep(70);
  }
  check('live_preview_animates_during_playback', seen.size > 3,
    `the preview showed ${seen.size} distinct frames over 2.8 s` + (seen.size <= 3 ? ' — it is frozen: ' + [...seen].join(' , ').slice(0, 120) : ''));
  const pv = await op.evaluate(() => window.__opMainPv);
  check('live_preview_is_wired_to_the_show', !!(pv && pv.running && pv.hasTimeline && pv.synced),
    `running=${pv && pv.running}, hasTimeline=${pv && pv.hasTimeline}, synced=${pv && pv.synced}, crowdN=${pv && pv.crowdN}`);

  // ---- a latched manual override must announce itself where the operator is looking ----
  await op.evaluate(() => { const d = document.getElementById('vjAdv'); if (d) d.open = true; });
  await op.evaluate(() => { const b = document.getElementById('vjEnable'); if (b && !(window.__opVJ && window.__opVJ.on)) b.click(); });
  await op.evaluate(() => { const b = document.getElementById('vjModeBtn'); if (b && window.__opVJ.mode !== 'full') b.click(); });
  await sleep(1200);
  const banner = await op.evaluate(() => {
    const el = document.getElementById('manualBanner');
    return { shown: !!el && !el.classList.contains('hidden'), text: (document.getElementById('manualBannerText') || {}).textContent || '' };
  });
  check('a_latched_manual_override_is_announced_at_the_preview', banner.shown && /presets off|presety wy/i.test(banner.text),
    banner.shown ? `the console says: "${banner.text.trim()}"` : 'nothing warned that the crowd was on a flat manual colour');
  // and the crowd really is flat while it is on — which is why the preview looked "broken"
  const flat = new Set();
  for (let i = 0; i < 12; i++) { flat.add(await ph.evaluate(() => window.__cls.lastBg)); await sleep(120); }
  check('manual_full_really_freezes_the_crowd', flat.size === 1,
    `with manual-only latched the phone showed ${flat.size} colour(s): ${[...flat].join(', ').slice(0, 80)} — the preview was telling the truth`);

  await op.click('#manualBannerOff');
  await sleep(1500);
  const back = await op.evaluate(() => ({ on: !!(window.__opVJ && window.__opVJ.on), hidden: !document.getElementById('manualBanner') || document.getElementById('manualBanner').classList.contains('hidden') }));
  const moving = new Set();
  for (let i = 0; i < 16; i++) { moving.add(await ph.evaluate(() => window.__cls.lastBg)); await sleep(120); }
  check('one_click_returns_the_crowd_to_the_show', !back.on && back.hidden && moving.size > 1,
    `manual off=${!back.on}, banner hidden=${back.hidden}, the phone moved through ${moving.size} colours again`);

  check('no_console_errors', errs.length === 0, errs.length ? errs.slice(0, 4).join(' | ') : 'nothing thrown');
  await browser.close();
  report.ok = report.fails.length === 0;
  fs.writeFileSync(path.join(dir, '..', 'playlist_advance_console_report.json'), JSON.stringify(report, null, 2));
  console.log(report.ok ? '\nALL OK' : '\nFAILS: ' + report.fails.join(' | '));
  process.exit(report.ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
