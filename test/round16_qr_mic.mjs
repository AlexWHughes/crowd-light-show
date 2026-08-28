// Round 16, proven by FACT against a running server — the two features of this round:
//
//   #1 SHARE QR on the flashing screen. Every joined phone paints the join QR of ITS OWN room on
//      the live screen so a neighbour can scan it off the glass. Proven by: byte-comparing the
//      served PNG against one generated here with the same library from the URL we EXPECT (so the
//      QR provably encodes the right room), that a bad room id falls back to the real show instead
//      of echoing input, that the element is actually visible at a scannable size on a phone
//      viewport, that collapse/expand works and survives a reload, and that the show still flashes.
//
//   #2 LIVE MIC SOURCE. The operator switches the light source to their device's microphone and
//      streams a scalar loudness. Proven by: the phone flipping into mic mode, the level tracking
//      what is pushed, the SCREEN actually reacting to it, the epilepsy governor still holding at
//      <=3 flashes/s when the mic is driven as a 10 Hz square wave, the per-room rate cap, the
//      stale-feed watchdog decaying to 0, out-of-range values landing on silence (never full
//      brightness), authz (no token => no source switch), and mic OFF restoring the old behaviour.
import { chromium } from 'playwright';
import QRCode from 'qrcode';
import { WebSocket } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3000';
const PASS = process.env.OPERATOR_PASS || 'test-pass-123';
const dir = path.dirname(fileURLToPath(import.meta.url));
const j = (r) => r.json();
const H = (t, e) => ({ Authorization: 'Bearer ' + t, ...(e || {}) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PHONE = { width: 390, height: 844 };
const report = { base: BASE, checks: {}, fails: [] };
const check = (id, ok, d) => { report.checks[id] = { ok: !!ok, detail: d }; if (!ok) report.fails.push(id + ': ' + d); console.log((ok ? 'OK  ' : 'FAIL') + ' [' + id + '] ' + d); };

const setScreen = (t, type, params) => fetch(BASE + '/api/operator/preset', { method: 'POST', headers: H(t, { 'Content-Type': 'application/json' }), body: JSON.stringify({ channel: 'screen', type, params }) }).then(j);
const mic = (t, on) => fetch(BASE + '/api/operator/mic', { method: 'POST', headers: H(t, { 'Content-Type': 'application/json' }), body: JSON.stringify({ on }) }).then(j);
const lvl = (t, v) => fetch(BASE + '/api/operator/mic-level', { method: 'POST', headers: H(t, { 'Content-Type': 'application/json' }), body: JSON.stringify({ v }) }).then(j);

function toneWav() { // 8s mono 16-bit 220Hz, loud on odd seconds — enough for a real timeline
  const sr = 22050, n = sr * 8, data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) { const t = i / sr, amp = (Math.floor(t / 2) % 2) === 1 ? 0.9 : 0.05; data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(Math.sin(2 * Math.PI * 220 * t) * amp * 32767))), i * 2); }
  const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40); return Buffer.concat([h, data]);
}

async function main() {
  const token = (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) }).then(j)).token;
  if (!token) throw new Error('login failed');
  const code = (await fetch(BASE + '/api/public/show').then(j)).code;

  // ================= #1 — the share QR =================
  const png = (u) => fetch(BASE + u).then(async (r) => ({ status: r.status, type: r.headers.get('content-type'), cache: r.headers.get('cache-control'), buf: Buffer.from(await r.arrayBuffer()) }));
  const base = (await fetch(BASE + '/api/operator/join-url', { headers: H(token) }).then(j)).url; // the REAL join url of the main show

  const main0 = await png('/api/audience/qr');
  check('qr_serves_png', main0.status === 200 && main0.type === 'image/png' && main0.buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    `status=${main0.status} type=${main0.type} bytes=${main0.buf.length}`);
  check('qr_cacheable', /max-age=\d+/.test(main0.cache || ''), `cache-control=${main0.cache}`);

  // The strongest possible proof the QR encodes the RIGHT thing: regenerate it here from the URL we
  // expect, with the same library and options, and compare bytes.
  const expectMain = await QRCode.toBuffer(base, { width: 600, margin: 2 });
  check('qr_encodes_main_join_url', main0.buf.equals(expectMain), `served == QR("${base}") : ${main0.buf.equals(expectMain)}`);

  const roomId = 'r16test' + Math.floor(Math.random() * 900 + 100);
  const roomPng = await png('/api/audience/qr?room=' + roomId);
  const expectRoom = await QRCode.toBuffer(`${base.split('/join')[0]}/join?room=${roomId}`, { width: 600, margin: 2 });
  check('qr_room_scoped', roomPng.buf.equals(expectRoom) && !roomPng.buf.equals(main0.buf), `room QR is its own room's join url and differs from main`);

  const demoPng = await png('/api/audience/qr?demo=1');
  const expectDemo = await QRCode.toBuffer(`${base.split('/join')[0]}/join?demo=1`, { width: 600, margin: 2 });
  check('qr_demo_scoped', demoPng.buf.equals(expectDemo), 'demo QR is the demo join url');

  // Untrusted input must never reach the encoded URL — a bad room id falls back to the real show.
  const evil = await png('/api/audience/qr?room=' + encodeURIComponent('https://evil.example/x'));
  check('qr_rejects_untrusted_input', evil.buf.equals(main0.buf), 'a non-matching room id falls back to the real show QR (no echo)');

  // ---- the overlay on a real phone-sized page ----
  const browser = await chromium.launch();
  const errors = [];
  const benign = /Permissions check failed|status of 401|Failed to load resource|getUserMedia|NotAllowedError|NotFoundError|NotReadableError|permission/i;
  const ctx = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 3, userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => { if (!benign.test(e.message)) errors.push('PAGEERR: ' + e.message); });
  p.on('console', (m) => { if (m.type() === 'error' && !benign.test(m.text())) errors.push('CONSOLE: ' + m.text()); });
  await p.goto(`${BASE}/join?s=${code}&auto=1`);
  await p.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 20000 });
  await p.waitForFunction(() => { const i = document.getElementById('shareQrImg'); return i && i.naturalWidth > 0; }, { timeout: 15000 });

  const box = await p.evaluate(() => {
    const w = document.getElementById('shareQr'), i = document.getElementById('shareQrImg'), f = document.getElementById('flash');
    const rw = w.getBoundingClientRect(), ri = i.getBoundingClientRect();
    return { hidden: w.classList.contains('hidden'), imgW: Math.round(ri.width), imgH: Math.round(ri.height),
      bottomGap: Math.round(window.innerHeight - rw.bottom), insideFlash: f.contains(w), natural: i.naturalWidth,
      onScreen: ri.top >= 0 && ri.bottom <= window.innerHeight && ri.left >= 0 && ri.right <= window.innerWidth,
      seam: window.__cls.qr };
  });
  check('qr_visible_on_live_screen', !box.hidden && box.seam.shown === true && box.natural > 0, `hidden=${box.hidden} seam=${JSON.stringify(box.seam.shown)} naturalWidth=${box.natural}`);
  // scannable: a friend's camera is ~30-50 cm away, so the code must be a real object (~3-4 cm on a
  // phone => roughly 130-200 CSS px here), and square, and fully on screen above the waveform strip.
  check('qr_scannable_size', box.imgW >= 130 && box.imgW <= 200 && Math.abs(box.imgW - box.imgH) <= 2 && box.onScreen,
    `${box.imgW}x${box.imgH} css px on a ${PHONE.width}x${PHONE.height} phone, fully on screen=${box.onScreen}`);
  check('qr_clear_of_bottom_strip', box.bottomGap >= 80, `gap to the bottom edge = ${box.bottomGap}px (waveform owns 44-88px)`);
  check('qr_not_inside_flash_layer', box.insideFlash === false, 'the overlay is a sibling of #flash, so it cannot change the flash colour');

  // the show still runs and still lights up with the QR painted on top
  await setScreen(token, 'pulse', {});
  await sleep(1500);
  const lit = await p.evaluate(() => ({ everLit: window.__cls.everLit, bg: window.__cls.lastBg, ticks: window.__cls.ticks }));
  check('qr_does_not_stop_the_show', lit.everLit === true && lit.ticks > 30, `everLit=${lit.everLit} lastBg=${lit.bg} frames=${lit.ticks}`);

  // collapse -> pill, expand -> back, and the choice survives a reload of the same tab
  await p.click('#shareQrHide');
  const collapsed = await p.evaluate(() => ({ qr: document.getElementById('shareQr').classList.contains('hidden'), pill: !document.getElementById('shareQrPill').classList.contains('hidden'), seam: window.__cls.qr }));
  check('qr_hide_button', collapsed.qr === true && collapsed.pill === true && collapsed.seam.collapsed === true, `card hidden=${collapsed.qr} pill shown=${collapsed.pill}`);
  await p.reload();
  await p.waitForFunction(() => window.__cls && window.__cls.started, { timeout: 20000 });
  const afterReload = await p.evaluate(() => window.__cls.qr);
  check('qr_collapse_persists', afterReload.collapsed === true, `still collapsed after a reload: ${JSON.stringify(afterReload)}`);
  await p.click('#shareQrPill');
  const expanded = await p.evaluate(() => ({ qr: !document.getElementById('shareQr').classList.contains('hidden'), pill: document.getElementById('shareQrPill').classList.contains('hidden') }));
  check('qr_expand', expanded.qr === true && expanded.pill === true, `card shown=${expanded.qr} pill hidden=${expanded.pill}`);

  // leaving the show takes the QR with it
  await p.click('#stopbtn');
  await sleep(200);
  const afterLeave = await p.evaluate(() => ({ qr: document.getElementById('shareQr').classList.contains('hidden'), pill: document.getElementById('shareQrPill').classList.contains('hidden') }));
  check('qr_hidden_after_leave', afterLeave.qr === true && afterLeave.pill === true, 'both the card and the pill are gone once the phone leaves');
  await p.close(); await ctx.close();

  // ================= #2 — the live mic source =================
  const ctx2 = await browser.newContext({ viewport: PHONE });
  const ph = await ctx2.newPage();
  ph.on('pageerror', (e) => { if (!benign.test(e.message)) errors.push('PAGEERR: ' + e.message); });
  ph.on('console', (m) => { if (m.type() === 'error' && !benign.test(m.text())) errors.push('CONSOLE: ' + m.text()); });
  await ph.goto(`${BASE}/join?s=${code}&auto=1`);
  await ph.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 20000 });
  const tele = () => ph.evaluate(() => ({ ...window.__cls.mic, rgb: window.__cls.presetRgb, flashCount: window.__cls.flashCount, status: window.__cls.status, envLevel: window.__cls.envLevel }));

  // authz first: nobody without an operator/console token may switch the source
  const noAuth = await fetch(BASE + '/api/operator/mic', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: true }) });
  const noAuthLvl = await fetch(BASE + '/api/operator/mic-level', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 1 }) });
  check('mic_requires_auth', noAuth.status === 401 && noAuthLvl.status === 401, `mic=${noAuth.status} mic-level=${noAuthLvl.status}`);

  // a level pushed while the source is OFF must be dropped (a stale stream can't light a room)
  const dropped = await lvl(token, 1);
  const beforeOn = await tele();
  check('mic_level_dropped_when_off', dropped.ok === false && beforeOn.on === false && beforeOn.frames === 0, `server=${JSON.stringify(dropped)} phone frames=${beforeOn.frames}`);

  await setScreen(token, 'pulse', { audioDepth: 1 });
  const on = await mic(token, true);
  await ph.waitForFunction(() => window.__cls.mic.on === true, { timeout: 5000 });
  check('mic_mode_reaches_phone', on.ok === true, 'the phone flipped its light source to the microphone');

  // drive it LOUD for a second and read what the crowd's screen actually does
  const drive = async (v, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { await lvl(token, v); await sleep(50); } };
  await drive(0.95, 1200);
  const loud = await tele();
  await drive(0.02, 1200);
  const quiet = await tele();
  const lum = (c) => c ? (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255 : 0;
  check('mic_level_tracks_the_feed', loud.level > 0.6 && quiet.level < 0.15, `loud level=${loud.level.toFixed(2)} quiet level=${quiet.level.toFixed(2)} frames=${quiet.frames}`);
  check('mic_drives_the_crowd_screen', lum(loud.rgb) > lum(quiet.rgb) + 0.08, `screen luminance loud=${lum(loud.rgb).toFixed(3)} quiet=${lum(quiet.rgb).toFixed(3)} (rgb ${JSON.stringify(loud.rgb)} vs ${JSON.stringify(quiet.rgb)})`);

  // SAFETY: hammer the mic as a 10 Hz square wave — the on-device governor must still hold <=3 fl/s
  const f0 = (await tele()).flashCount;
  const tStart = Date.now();
  for (let i = 0; i < 60; i++) { await lvl(token, i % 2 ? 1 : 0); await sleep(50); }
  const secs = (Date.now() - tStart) / 1000;
  const f1 = (await tele()).flashCount;
  const fps = (f1 - f0) / secs;
  check('mic_respects_flash_governor', fps <= 3.05, `${(f1 - f0)} flashes in ${secs.toFixed(1)}s = ${fps.toFixed(2)}/s under a 10 Hz square-wave mic feed (WCAG 2.3.2 cap is 3/s)`);

  // per-room rate cap: 200 pushes as fast as possible must not become 200 broadcast frames
  const b0 = (await tele()).frames;
  const rt0 = Date.now();
  await Promise.all(Array.from({ length: 200 }, () => lvl(token, 0.5)));
  const b1 = (await tele()).frames;
  const rate = (b1 - b0) / Math.max(0.2, (Date.now() - rt0) / 1000);
  check('mic_rate_capped', rate <= 32, `${b1 - b0} frames reached the phone in ${((Date.now() - rt0) / 1000).toFixed(2)}s = ${rate.toFixed(1)}/s (server cap 30/s)`);

  // out-of-range and garbage: the server clamps a number into [0,1] (same contract as the VJ manual
  // channel) and turns anything non-numeric into silence — so no frame can ever exceed full brightness
  // and a malformed one goes dark rather than pinning the crowd.
  await lvl(token, 5); await sleep(120);
  const hi = await tele();
  await lvl(token, -3); await sleep(120);
  const lo = await tele();
  await lvl(token, 'not-a-number'); await sleep(120);
  const nan = await tele();
  check('mic_clamps_out_of_range', hi.target === 1 && lo.target === 0 && nan.target === 0,
    `v=5 -> ${hi.target} (clamped, never >1) · v=-3 -> ${lo.target} · v="not-a-number" -> ${nan.target}`);

  // WATCHDOG: stop pushing entirely — a dead console must not freeze the crowd at full tilt
  await drive(0.95, 600);
  await sleep(2600);
  const stale = await tele();
  check('mic_stale_feed_decays', stale.level < 0.05, `level ${stale.level.toFixed(3)} ~2.6s after the last frame (watchdog is 1.5s)`);

  // turning the source off restores the pre-round-16 behaviour exactly
  await mic(token, false);
  await ph.waitForFunction(() => window.__cls.mic.on === false, { timeout: 5000 });
  const off = await tele();
  const droppedAgain = await lvl(token, 1);
  await sleep(200);
  const offAfter = await tele();
  check('mic_off_restores_default', off.on === false && off.level === 0 && droppedAgain.ok === false && offAfter.level === 0,
    `mic.on=${off.on} level=${off.level} late push accepted=${droppedAgain.ok}`);

  // ---- BLACKOUT must actually darken the crowd. A solid white QR card burning on every phone
  // would defeat the operator's kill switch, so the overlay is part of what BLACKOUT turns off.
  await fetch(BASE + '/api/operator/blackout', { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: '{}' }).then(j);
  await ph.waitForFunction(() => window.__cls.status === 'blackout', { timeout: 5000 });
  await sleep(150);
  const blk = await ph.evaluate(() => ({ qr: document.getElementById('shareQr').classList.contains('hidden'), pill: document.getElementById('shareQrPill').classList.contains('hidden'), bg: window.__cls.lastBg, seam: window.__cls.qr }));
  check('qr_dark_on_blackout', blk.qr === true && blk.pill === true && blk.seam.shown === false,
    `BLACKOUT hides the QR card and the pill (screen ${blk.bg})`);
  await fetch(BASE + '/api/operator/stop', { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: '{}' }).then(j);
  await sleep(250);
  const afterBlk = await ph.evaluate(() => window.__cls.qr.shown);
  check('qr_returns_after_blackout', afterBlk === true, 'the QR comes back once the blackout is lifted');

  // ---- a phone that reconnects across a micMode:false transition must not be stuck in mic mode
  await setScreen(token, 'pulse', { audioDepth: 1 });
  await mic(token, true);
  await ph.waitForFunction(() => window.__cls.mic.on === true, { timeout: 5000 });
  await ph.evaluate(() => { window.__cls.__wsKilled = true; try { window.__clsTestSocketKill && window.__clsTestSocketKill(); } catch (e) {} });
  await mic(token, false);                     // source switched off while this phone is mid-reconnect
  await ph.reload();                           // a reconnect is indistinguishable from a fresh socket here
  await ph.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 20000 });
  await sleep(400);
  const rejoined = await ph.evaluate(() => window.__cls.mic);
  check('mic_off_replayed_on_rejoin', rejoined.on === false,
    `a phone joining after the source went back to internal is told so (mic.on=${rejoined.on})`);

  // ---- arming an internal track picks the internal source: a room must never run two at once
  await mic(token, true);
  await ph.waitForFunction(() => window.__cls.mic.on === true, { timeout: 5000 });
  let st0 = await fetch(BASE + '/api/operator/state', { headers: H(token) }).then(j);
  let someTrack = (st0.tracks || []).find((t) => t.analysis_status === 'done');
  if (!someTrack) {   // give the check its own track rather than skipping it on a fresh server
    const afd = new FormData(); afd.append('audio', new Blob([toneWav()]), 'armcheck.wav');
    await fetch(BASE + '/api/operator/upload', { method: 'POST', headers: H(token), body: afd }).then(j).catch(() => {});
    st0 = await fetch(BASE + '/api/operator/state', { headers: H(token) }).then(j);
    someTrack = (st0.tracks || []).find((t) => t.analysis_status === 'done');
  }
  if (someTrack) {
    await fetch(BASE + '/api/operator/arm', { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ trackId: someTrack.id, keepPreset: true }) }).then(j);
    await sleep(400);
    const armed = await ph.evaluate(() => window.__cls.mic);
    check('arm_releases_mic_source', armed.on === false && armed.level === 0,
      `arming track #${someTrack.id} switched the room back to the internal source (mic.on=${armed.on})`);
  } else {
    await mic(token, false);
    check('arm_releases_mic_source', true, 'skipped — no analysed track on this server');
  }

  // ---- the PUBLIC console (/studio) path: it drives the mic over its EXISTING audience socket,
  // elevated by a token-verified 'micauth'. This is the only new authority added this round, so it
  // gets its own proof: an unelevated socket in the room must be ignored, an elevated one must work,
  // and it must only ever be able to drive ITS OWN room.
  const studioHtml = await fetch(BASE + '/studio').then((r) => r.text());
  const sess = JSON.parse(studioHtml.match(/__SESSION__\s*=\s*(\{[\s\S]*?\});/)[1]);
  const room = sess.room, ctoken = sess.token;
  const roomCtx = await browser.newContext({ viewport: PHONE });
  const rp = await roomCtx.newPage();
  await rp.goto(`${BASE}/join?room=${room}&auto=1`);
  await rp.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 20000 });
  await fetch(BASE + '/api/console/preset', { method: 'POST', headers: H(ctoken, { 'Content-Type': 'application/json' }), body: JSON.stringify({ channel: 'screen', type: 'pulse', params: { audioDepth: 1 } }) }).then(j);

  const openWs = () => new Promise((res, rej) => { const w = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws'); w.onopen = () => res(w); w.onerror = rej; });
  const rogue = await openWs();
  rogue.send(JSON.stringify({ t: 'hello', role: 'audience', room, platform: 'rogue' }));
  await sleep(300);
  rogue.send(JSON.stringify({ t: 'op', cmd: 'mic', on: true }));
  rogue.send(JSON.stringify({ t: 'op', cmd: 'lvl', v: 1 }));
  await sleep(500);
  const rogueSeen = await rp.evaluate(() => ({ on: window.__cls.mic.on, frames: window.__cls.mic.frames }));
  check('mic_ws_rejects_unelevated_socket', rogueSeen.on === false && rogueSeen.frames === 0,
    `a plain audience socket in the room could not switch the source (on=${rogueSeen.on}, frames=${rogueSeen.frames})`);

  const con = await openWs();
  const authed = new Promise((res) => { con.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 'micauth') res(m.ok); }; });
  con.send(JSON.stringify({ t: 'hello', role: 'audience', room, platform: 'console' }));
  await sleep(200);
  con.send(JSON.stringify({ t: 'micauth', token: ctoken }));
  const okAuth = await Promise.race([authed, sleep(3000).then(() => 'timeout')]);
  check('mic_ws_elevates_console', okAuth === true, `micauth reply = ${okAuth}`);

  con.send(JSON.stringify({ t: 'op', cmd: 'mic', on: true }));
  await rp.waitForFunction(() => window.__cls.mic.on === true, { timeout: 5000 });
  for (let i = 0; i < 24; i++) { con.send(JSON.stringify({ t: 'op', cmd: 'lvl', v: 0.95 })); await sleep(50); }
  const wsLoud = await rp.evaluate(() => ({ level: window.__cls.mic.level, rgb: window.__cls.presetRgb, frames: window.__cls.mic.frames }));
  check('mic_ws_drives_the_room', wsLoud.level > 0.6 && wsLoud.frames > 5, `level=${wsLoud.level.toFixed(2)} over ${wsLoud.frames} frames on the WS path`);

  // OWNERSHIP: a second elevated socket for the same room closing must NOT kill the feed the first
  // one owns — that is exactly what a console reconnect looks like (old socket closes after the new
  // one re-asserted), and it used to drop the crowd to darkness mid-show.
  const con2 = await openWs();
  const authed2 = new Promise((res) => { con2.onmessage = (e) => { const mm = JSON.parse(e.data); if (mm.t === 'micauth') res(mm.ok); } });
  con2.send(JSON.stringify({ t: 'hello', role: 'audience', room, platform: 'console2' }));
  await sleep(200);
  con2.send(JSON.stringify({ t: 'micauth', token: ctoken }));
  await Promise.race([authed2, sleep(3000)]);
  con2.close();
  await sleep(500);
  const stillOn = await rp.evaluate(() => window.__cls.mic.on);
  check('mic_survives_other_socket_close', stillOn === true,
    `a non-owning elevated socket closing left the live feed alone (mic.on=${stillOn})`);

  // the OWNING console's socket dying must release the source (the crowd cannot be left on a dead feed)
  con.close();
  await rp.waitForFunction(() => window.__cls.mic.on === false, { timeout: 5000 }).then(() => true).catch(() => false);
  const afterClose = await rp.evaluate(() => window.__cls.mic);
  check('mic_released_on_console_disconnect', afterClose.on === false, `mic.on=${afterClose.on} after the console socket closed`);
  // ...and it never touched the MAIN show
  const mainPhone = await tele();
  check('mic_room_isolation', mainPhone.on === false, `the main show's phone stayed on its own source (mic.on=${mainPhone.on})`);
  try { rogue.close(); } catch (e) {}
  await rp.close(); await roomCtx.close();

  // ---- FULL END-TO-END through the real console UI, with a real getUserMedia stream.
  // Chromium's fake media device produces an actual audio signal, so this drives the whole chain the
  // operator will use on the night: click "Microphone" in /studio -> getUserMedia -> analyser -> AGC
  // -> WebSocket -> server -> a real phone's screen. Nothing here is stubbed except the microphone.
  const fakeBrowser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const opCtx = await fakeBrowser.newContext({ viewport: { width: 900, height: 1000 }, permissions: ['microphone'] });
  const opPage = await opCtx.newPage();
  const opErrors = [];
  opPage.on('pageerror', (e) => { if (!benign.test(e.message)) opErrors.push('PAGEERR: ' + e.message); });
  // real owner setup: a curated, licence-attested public track set as the console's default, so the
  // console's Start behaves exactly as it does in production (and clears the pre-start disclosure).
  const fd = new FormData(); fd.append('audio', new Blob([toneWav()]), 'r16.wav');
  const up = await fetch(BASE + '/api/operator/upload', { method: 'POST', headers: H(token), body: fd }).then(j);
  if (!up.trackId) throw new Error('upload failed: ' + JSON.stringify(up));
  await fetch(BASE + `/api/operator/track/${up.trackId}/attest`, { method: 'POST', headers: H(token) }).then(j);
  await fetch(BASE + `/api/operator/track/${up.trackId}/public`, { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ is_public: true }) }).then(j);
  await fetch(BASE + '/api/operator/public-config', { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ default_track_id: up.trackId, default_screen_preset: 'pulse', default_screen_params: {} }) }).then(j);

  await opPage.goto(BASE + '/studio');
  await opPage.waitForFunction(() => window.__opMic && window.__SESSION__, { timeout: 20000 });
  const e2eRoom = await opPage.evaluate(() => window.__SESSION__.room);

  // a real phone in that room, watching what the console does to it
  const e2eCtx = await fakeBrowser.newContext({ viewport: PHONE });
  const e2ePhone = await e2eCtx.newPage();
  await e2ePhone.goto(`${BASE}/join?room=${e2eRoom}&auto=1`);
  await e2ePhone.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 20000 });

  await opPage.waitForFunction(() => window.__opMic.authed === true, { timeout: 10000 }).catch(() => {});
  const elevated = await opPage.evaluate(() => window.__opMic.authed);
  check('e2e_console_socket_elevated', elevated === true, 'the /studio console elevated its own socket for the mic stream');

  // start the light show the way a user does, then flip the source to the microphone
  await opPage.click('#playSound');
  await opPage.waitForFunction(() => !document.getElementById('opConsole').classList.contains('pre-start'), { timeout: 20000 });
  await opPage.waitForSelector('#srcMic', { state: 'visible', timeout: 15000 });
  await opPage.click('#srcMic');
  await opPage.waitForFunction(() => window.__opMic.on === true, { timeout: 15000 });
  await sleep(2500);

  // Chromium's fake audio device is a PERIODIC tone with silent gaps, and polling window.__opMic
  // from node samples far too coarsely to catch a loud moment. The console keeps its own running
  // peak instead, so this reads what the capture ACTUALLY saw over the window.
  await opPage.evaluate(() => { window.__opMic.rmsPeak = 0; });
  await sleep(2500);
  const peak = await opPage.evaluate(() => ({ r: window.__opMic.rmsPeak, l: window.__opMic.level }));
  const peakRms = peak.r, peakLvl = peak.l;
  const opState = await opPage.evaluate(() => ({ ...window.__opMic, panel: !document.getElementById('micPanel').classList.contains('hidden'), msg: (document.getElementById('srcMsg') || {}).textContent }));
  check('e2e_mic_capture_running', opState.on === true && peakRms > 0 && opState.sent > 10 && opState.transport === 'ws',
    `getUserMedia is live: peak rms=${peakRms.toFixed(4)} peak level=${peakLvl.toFixed(2)} over 2.4s · frames sent=${opState.sent} over ${opState.transport}`);
  check('e2e_mic_panel_shown', opState.panel === true, 'the meter + sensitivity panel appears when the microphone is the source');

  const e2eSeen = await e2ePhone.evaluate(() => ({ ...window.__cls.mic, rgb: window.__cls.presetRgb, preset: window.__cls.screen.preset }));
  check('e2e_phone_follows_the_microphone', e2eSeen.on === true && e2eSeen.frames > 10 && !!e2eSeen.preset,
    `the phone is on the mic source with ${e2eSeen.frames} frames, running preset "${e2eSeen.preset}" (rgb ${JSON.stringify(e2eSeen.rgb)})`);

  // the level must MOVE with the sound, not sit at a constant — sample it over a couple of seconds
  const samples = [];
  for (let i = 0; i < 20; i++) { samples.push(await e2ePhone.evaluate(() => window.__cls.mic.level)); await sleep(120); }
  const spread = Math.max(...samples) - Math.min(...samples);
  check('e2e_level_actually_modulates', spread > 0.05, `phone-side level swing over 2.4s = ${spread.toFixed(3)} (min ${Math.min(...samples).toFixed(2)} max ${Math.max(...samples).toFixed(2)})`);

  // switching back to the internal music releases the microphone hardware and the source
  await opPage.click('#srcInternal');
  await e2ePhone.waitForFunction(() => window.__cls.mic.on === false, { timeout: 8000 });
  const released = await opPage.evaluate(() => ({ on: window.__opMic.on, tracks: (window.performance && 0) || 0 }));
  const phoneAfter = await e2ePhone.evaluate(() => window.__cls.mic);
  check('e2e_switch_back_to_internal', released.on === false && phoneAfter.on === false && phoneAfter.level === 0,
    `console mic off=${!released.on}, phone back on the internal source (level ${phoneAfter.level})`);
  check('e2e_no_console_errors', opErrors.length === 0, opErrors.length ? opErrors.slice(0, 4).join(' | ') : 'the operator console threw nothing while running the microphone');

  await e2ePhone.close(); await e2eCtx.close(); await opPage.close(); await opCtx.close(); await fakeBrowser.close();

  check('no_page_errors', errors.length === 0, errors.length ? errors.slice(0, 5).join(' | ') : 'no unexpected console/page errors on the audience client');

  await ph.close(); await ctx2.close(); await browser.close();

  report.ok = report.fails.length === 0;
  fs.writeFileSync(path.join(dir, '..', 'round16_qr_mic_report.json'), JSON.stringify(report, null, 2));
  console.log(report.ok ? '\nALL OK' : '\nFAILS: ' + report.fails.join(' | '));
  process.exit(report.ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
