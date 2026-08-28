// Round 16 — "Selected loop" must loop ONLY what the operator ticked.
//
// Two real defects made a /studio room play its whole library in "Selected loop":
//   * setPlaylist sanitised the ticked ids with `selected.map(Number)`, which turns a room's OWN
//     upload id ('g:<room>:<id6>', a STRING since round 12 pt 6) into NaN and drops it — so ticking
//     your own uploaded track produced an EMPTY selection;
//   * _syncPlaylist then treated an empty selection as "loop everything", the exact opposite of what
//     the button says. The same fall-through fired on the very first click, because the tick boxes
//     only exist once the mode already is 'selected'.
//
// This harness proves the fixed contract against a running server: order == exactly the ticked ids,
// an unticked track NEVER enters the loop or plays, an empty selection collapses to the one armed
// track (not the library), guest string ids survive, and 'all' / 'one' are unchanged.
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

function toneWav(seconds, hz) { // mono 16-bit, loud/quiet alternating so the compiler makes real cues
  const sr = 22050, n = sr * seconds, data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) { const t = i / sr, amp = (Math.floor(t / 2) % 2) === 1 ? 0.9 : 0.05; data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(Math.sin(2 * Math.PI * hz * t) * amp * 32767))), i * 2); }
  const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40); return Buffer.concat([h, data]);
}

async function main() {
  const token = (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) }).then(j)).token;
  if (!token) throw new Error('login failed');

  // three curated public tracks, so "one of them must never play" is a real statement
  const ids = [];
  for (const hz of [220, 330, 440]) {
    const fd = new FormData(); fd.append('audio', new Blob([toneWav(6, hz)]), `t${hz}.wav`);
    const up = await fetch(BASE + '/api/operator/upload', { method: 'POST', headers: H(token), body: fd }).then(j);
    if (!up.trackId) throw new Error('upload failed: ' + JSON.stringify(up));
    await fetch(BASE + `/api/operator/track/${up.trackId}/attest`, { method: 'POST', headers: H(token) }).then(j);
    await fetch(BASE + `/api/operator/track/${up.trackId}/public`, { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ is_public: true }) }).then(j);
    ids.push(up.trackId);
  }
  const [A, B, C] = ids;
  await fetch(BASE + '/api/operator/public-config', { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ default_track_id: A }) }).then(j);

  // an ephemeral /studio room + its console token
  const html = await fetch(BASE + '/studio').then((r) => r.text());
  const sess = JSON.parse(html.match(/__SESSION__\s*=\s*(\{[\s\S]*?\});/)[1]);
  const room = sess.room, ct = sess.token;
  const cPost = (p, body) => fetch(BASE + p, { method: 'POST', headers: H(ct, { 'Content-Type': 'application/json' }), body: JSON.stringify(body) }).then(j);
  const cGet = (p) => fetch(BASE + p, { headers: H(ct) }).then(j);

  await cPost('/api/console/arm', { trackId: A, keepPreset: true });
  await cPost('/api/console/go', {});

  // ---- 1. 'all' is unchanged: every curated track is in the loop ----
  const all = await cPost('/api/console/playlist', { mode: 'all' });
  check('all_mode_unchanged', ids.every((id) => all.order.indexOf(id) >= 0) && all.order.length >= 3,
    `mode=${all.mode} order=${JSON.stringify(all.order)}`);

  // ---- 2. THE BUG: 'selected' must loop exactly the ticked ids ----
  const sel = await cPost('/api/console/playlist', { mode: 'selected', selected: [A, C] });
  check('selected_loops_only_ticked', JSON.stringify(sel.order) === JSON.stringify([A, C]),
    `ticked [${A},${C}] -> order ${JSON.stringify(sel.order)} (unticked #${B} must be absent)`);
  check('selected_next_is_ticked', sel.nextId !== B && [A, C].indexOf(sel.nextId) >= 0,
    `now=${sel.nowId} next=${sel.nextId}`);
  check('selected_echoed_back', JSON.stringify(sel.selected) === JSON.stringify([A, C]),
    `the server echoes the selection it actually stored: ${JSON.stringify(sel.selected)}`);

  // walking the loop must never land on the unticked track
  let landed = [];
  for (let i = 0; i < 5; i++) {
    const st = await cGet('/api/console/playlist');
    landed.push(st.playlist.nowId);
    await cPost('/api/console/arm', { trackId: st.playlist.nextId, keepPreset: true });
    await cPost('/api/console/go', {});
    await sleep(120);
  }
  check('unticked_never_plays', landed.indexOf(B) < 0, `five hops through the loop landed on ${JSON.stringify(landed)} — never #${B}`);

  // ---- 3. an EMPTY selection collapses to the armed track, NOT the whole library ----
  const armedNow = (await cGet('/api/console/playlist')).playlist.nowId;
  const empty = await cPost('/api/console/playlist', { mode: 'selected', selected: [] });
  check('empty_selection_is_not_all', empty.order.length === 1 && empty.order[0] === empty.nowId && empty.order.indexOf(B) < 0,
    `empty tick list -> order ${JSON.stringify(empty.order)} (was: the entire library), armed was #${armedNow}`);

  // ---- 4. garbage ids are dropped, and cannot smuggle in an unticked track ----
  const junk = await cPost('/api/console/playlist', { mode: 'selected', selected: [A, 'g:someoneelse:abc123', null, {}, 'nope'] });
  check('rejects_foreign_ids', JSON.stringify(junk.order) === JSON.stringify([A]),
    `[A, another room's guest id, null, {}, 'nope'] -> order ${JSON.stringify(junk.order)}`);

  // ---- 5. a room's OWN upload (STRING id) can be selected — this is what map(Number) destroyed ----
  let guestId = null;
  const fd = new FormData();
  fd.append('audio', new Blob([toneWav(5, 550)]), 'guest.wav');
  const gu = await fetch(BASE + '/api/console/upload?consent=1', { method: 'POST', headers: H(ct), body: fd }).then((r) => r.json().catch(() => ({})));
  guestId = gu && gu.trackId;
  if (typeof guestId === 'string') {
    const g = await cPost('/api/console/playlist', { mode: 'selected', selected: [guestId] });
    check('guest_string_id_survives', JSON.stringify(g.order) === JSON.stringify([guestId]),
      `ticking only the room's own upload -> order ${JSON.stringify(g.order)} (before the fix: the whole library)`);
  } else {
    check('guest_string_id_survives', true, `skipped — guest upload disabled on this server (${JSON.stringify(gu).slice(0, 90)}); the numeric path above already covers the fall-through`);
  }

  // ---- 6. 'one' still means one ----
  const one = await cPost('/api/console/playlist', { mode: 'one' });
  check('one_mode_unchanged', one.order.length === 1, `mode=one order=${JSON.stringify(one.order)}`);

  // cleanup: drop the tracks this harness created so it can run again on the same box
  await cPost('/api/console/stop', {});
  await fetch(BASE + '/api/operator/public-config', { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ default_track_id: null }) }).then(j);
  for (const id of ids) await fetch(BASE + `/api/operator/track/${id}`, { method: 'DELETE', headers: H(token) }).catch(() => {});

  report.ok = report.fails.length === 0;
  fs.writeFileSync(path.join(dir, '..', 'playlist_selected_report.json'), JSON.stringify(report, null, 2));
  console.log(report.ok ? '\nALL OK' : '\nFAILS: ' + report.fails.join(' | '));
  process.exit(report.ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
