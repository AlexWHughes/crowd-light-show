// A running console must survive the server being restarted.
//
// Rooms live in memory. When the server restarts (a deploy, a crash, an OOM kill) the console's
// token still works, so the page reconnects and looks fine — but the room is gone, and every "go"
// is refused with "arm a track first". The console ignored that answer, so the Start button sat on
// "starting..." forever and the music never came back. That is what Andrii hit live.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dir, '..');
const PORT = Number(process.env.PORT_RR || 5711);
const BASE = 'http://localhost:' + PORT;
const PASS = 'test-pass-123';
const DATA = path.join(process.env.TEMP || '/tmp', 'cls-restart-' + PORT);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = (r) => r.json();
const report = { checks: {}, fails: [] };
const check = (id, ok, d) => { report.checks[id] = { ok: !!ok, detail: d }; if (!ok) report.fails.push(id + ': ' + d); console.log((ok ? 'OK  ' : 'FAIL') + ' [' + id + '] ' + d); };

function toneWav(sec, hz) {
  const sr = 22050, n = Math.round(sr * sec), data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) { const t = i / sr, amp = (Math.floor(t * 2) % 2) === 1 ? 0.9 : 0.05; data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * hz * t) * amp * 32767), i * 2); }
  const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40); return Buffer.concat([h, data]);
}

let srv = null;
function boot() {
  return new Promise((resolve, reject) => {
    srv = spawn(process.execPath, [path.join(root, 'src', 'server.js')], {
      cwd: root,
      env: { ...process.env, PORT: String(PORT), OPERATOR_PASS: PASS, DATA_DIR: DATA, SESSION_SECRET: 'restart-test-secret-fixed', PUBLIC_CONSOLE_ENABLED: '1', RATE_LIMIT_MAX: '100000' },
      stdio: 'ignore',
    });
    srv.on('error', reject);
    const t0 = Date.now();
    (async function poll() {
      while (Date.now() - t0 < 25000) {
        try { const r = await fetch(BASE + '/healthz'); if (r.ok) return resolve(); } catch (e) {}
        await sleep(250);
      }
      reject(new Error('server did not come up'));
    })();
  });
}
async function kill() { if (srv) { srv.kill('SIGKILL'); await sleep(600); srv = null; } }

async function main() {
  fs.rmSync(DATA, { recursive: true, force: true });
  await boot();
  const token = (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }) }).then(j)).token;
  const H = { Authorization: 'Bearer ' + token };
  const fd = new FormData(); fd.append('audio', new Blob([toneWav(30, 220)]), 'track.wav');
  const up = await fetch(BASE + '/api/operator/upload', { method: 'POST', headers: H, body: fd }).then(j);
  await fetch(BASE + '/api/operator/track/' + up.trackId + '/attest', { method: 'POST', headers: H }).then(j);
  await fetch(BASE + '/api/operator/track/' + up.trackId + '/public', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ is_public: true }) }).then(j);
  await fetch(BASE + '/api/operator/public-config', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ default_track_id: up.trackId }) }).then(j);

  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const op = await browser.newContext({ viewport: { width: 1200, height: 1200 } }).then((c) => c.newPage());
  const errs = []; op.on('pageerror', (e) => errs.push(String(e.message)));
  await op.goto(BASE + '/studio');
  await op.waitForFunction(() => window.__opState && window.__SESSION__, { timeout: 25000 });
  const room = await op.evaluate(() => window.__SESSION__.room);

  const ph = await browser.newContext({ viewport: { width: 390, height: 844 } }).then((c) => c.newPage());
  await ph.goto(BASE + '/join?room=' + room + '&auto=1');
  await ph.waitForFunction(() => window.__cls && window.__cls.synced, { timeout: 25000 });

  await op.click('#playSound');
  await op.waitForFunction(() => window.__opState.curState === 'running', { timeout: 25000 });
  check('show_runs_before_restart', true, 'the show is running with a phone joined');

  // the deploy
  await kill();
  await boot();
  await op.waitForFunction(() => window.__opState && window.__opState.wsOpen !== false, { timeout: 25000 }).catch(() => {});
  await sleep(4000);

  // press Start, exactly as he did
  await op.click('#playSound');
  const recovered = await op.waitForFunction(() => window.__opState.curState === 'running', { timeout: 20000 }).then(() => true).catch(() => false);
  const after = await op.evaluate(() => ({
    state: window.__opState.curState,
    armed: window.__opState.armedId,
    btn: (document.getElementById('playSound') || {}).textContent,
    go: (document.getElementById('go') || {}).textContent,
  }));
  const phone = await ph.evaluate(() => ({ status: window.__cls.status, trackId: window.__cls.trackId })).catch(() => ({}));
  check('start_recovers_the_show_after_a_restart', recovered,
    `after the server restarted, Start left the room "${after.state}" (button "${String(after.btn).trim()}", go "${String(after.go).trim()}", armed ${after.armed})`);
  check('phones_play_again_after_a_restart', phone.status === 'running',
    `the phone is "${phone.status}" on track ${phone.trackId}`);
  check('no_console_errors', errs.length === 0, errs.length ? errs.slice(0, 3).join(' | ') : 'nothing thrown');

  await browser.close();
  await kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  report.ok = report.fails.length === 0;
  console.log(report.ok ? '\nALL OK' : '\nFAILS: ' + report.fails.join(' | '));
  process.exit(report.ok ? 0 : 1);
}
main().catch(async (e) => { console.error(e); await kill(); process.exit(2); });
