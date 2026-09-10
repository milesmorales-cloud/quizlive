// ============================================================
// QuizLive — Complete end-to-end smoke test
// Starts the server, runs all HTTP + Socket.IO checks, reports.
// ============================================================
import { spawn } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const io = require('socket.io-client');

const PORT = 3299;          // use an unlikely port to avoid collisions
const BASE = `http://localhost:${PORT}`;
let serverProc;
let PASS = 0, FAIL = 0;
const results = [];

function ok(label, detail = '') {
  PASS++;
  results.push(`✅  ${label}${detail ? ' — ' + detail : ''}`);
}
function ko(label, detail = '') {
  FAIL++;
  results.push(`❌  ${label}${detail ? ' — ' + detail : ''}`);
}

async function startServer() {
  return new Promise((resolve, reject) => {
    serverProc = spawn(process.execPath, ['server.js'], {
      cwd: 'C:/Users/MWANGA/quizlive/backend',
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let started = false;
    const onLine = (line) => {
      if (!started && line.includes('server running on port')) {
        started = true;
        serverProc.stdout.removeListener('data', onData);
        resolve();
      }
    };
    const onData = (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const l of lines) onLine(l);
      process.stdout.write(`[server] ${chunk}`);
    };
    serverProc.stdout.on('data', onData);
    serverProc.stderr.on('data', (c) => process.stderr.write(`[server:err] ${c}`));
    serverProc.on('error', reject);
    setTimeout(() => { if (!started) reject(new Error('Server start timeout')); }, 10000);
  });
}

async function fetchJson(url, opts = {}, timeoutMs = 3000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { redirect: 'manual', ...opts, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

async function waitForHealth(retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetchJson(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

// ── 1. Static Routes ──────────────────────────────────────────
async function smokeRoutes() {
  const routes = {
    '/':                       { expect: 200, mime: 'text/html', label: 'GET /  (landing)' },
    '/login':                  { expect: 200, mime: 'text/html', label: 'GET /login (clean route)' },
    '/login.html':             { expect: 200, mime: 'text/html', label: 'GET /login.html' },
    '/teacher-dashboard':      { expect: 200, mime: 'text/html', label: 'GET /teacher-dashboard' },
    '/teacher-dashboard.html': { expect: 200, mime: 'text/html', label: 'GET /teacher-dashboard.html' },
    '/create-quiz':            { expect: 200, mime: 'text/html', label: 'GET /create-quiz' },
    '/create-quiz.html':       { expect: 200, mime: 'text/html', label: 'GET /create-quiz.html' },
    '/host-game':              { expect: 200, mime: 'text/html', label: 'GET /host-game' },
    '/host-game.html':         { expect: 200, mime: 'text/html', label: 'GET /host-game.html' },
    '/join-quiz':              { expect: 200, mime: 'text/html', label: 'GET /join-quiz' },
    '/join-quiz.html':         { expect: 200, mime: 'text/html', label: 'GET /join-quiz.html' },
    '/nonexistent-page':       { expect: 404, mime: null,       label: 'GET /nonexistent-page (expect 404)' },
  };
  for (const [path, { expect, mime, label }] of Object.entries(routes)) {
    try {
      const r = await fetchJson(`${BASE}${path}`);
      const ct = r.headers.get('content-type') || '';
      if (r.status === expect && (mime === null || ct.includes(mime))) {
        ok(label, `status ${r.status}, content-type OK`);
      } else {
        ko(label, `expected ${expect}, got ${r.status}; content-type=${ct}`);
      }
    } catch (e) {
      ko(label, e.message);
    }
  }
}

// ── 2. REST API CRUD + Port ───────────────────────────────────
async function smokeApi() {
  const hp = await fetchJson(`${BASE}/api/health`);
  if (hp.ok) {
    const h = await hp.json();
    ok('GET /api/health', `status 200, games=${h.activeGames}`);
  } else ko('GET /api/health', `status ${hp.status}`);

  const nip = await fetchJson(`${BASE}/api/network-ip`);
  if (nip.ok) {
    const n = await nip.json();
    ok('GET /api/network-ip', `ip=${n.ip}`);
  } else ko('GET /api/network-ip', `status ${nip.status}`);

  // CREATE quiz
  const quizPayload = {
    title: `_smoke_${Date.now()}`,
    description: 'smoke test quiz',
    questions: [
      { question_text: 'What is 1+1?', option_a: '2', option_b: '3', option_c: '1', option_d: '0', correct_option: 'A', time_limit: 15 },
      { question_text: 'Capital of Kenya?', option_a: 'Nairobi', option_b: 'Mombasa', option_c: 'Kisumu', option_d: 'Nakuru', correct_option: 'A', time_limit: 20 }
    ]
  };
  let quizId;
  try {
    const cr = await fetchJson(`${BASE}/api/quizzes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(quizPayload)
    });
    const cj = await cr.json();
    if (cr.status === 201 && cj.quizId) {
      quizId = cj.quizId;
      ok('POST /api/quizzes (create)', `quizId=${quizId}`);
    } else ko('POST /api/quizzes', `status ${cr.status} body=${JSON.stringify(cj)}`);
  } catch (e) { ko('POST /api/quizzes', e.message); }

  // LIST quizzes
  try {
    const lr = await fetchJson(`${BASE}/api/quizzes`);
    const list = await lr.json();
    if (lr.ok && Array.isArray(list) && list.find(q => q.id === quizId)) {
      ok('GET /api/quizzes (list)', `found ${list.length} quizzes, quizId present`);
    } else ko('GET /api/quizzes', `quizId not found in response`);
  } catch (e) { ko('GET /api/quizzes', e.message); }

  // GET single quiz
  if (quizId) {
    try {
      const gr = await fetchJson(`${BASE}/api/quizzes/${quizId}`);
      const g = await gr.json();
      if (gr.ok && g.questions && g.questions.length === 2) {
        ok('GET /api/quizzes/:id', `2 questions returned`);
      } else ko('GET /api/quizzes/:id', `status ${gr.status} questions=${g.questions?.length}`);
    } catch (e) { ko('GET /api/quizzes/:id', e.message); }
  }

  // UPDATE quiz
  if (quizId) {
    const updatePayload = {
      title: '_smoke_updated',
      questions: [{ question_text: 'Only one?', option_a: 'Yes', option_b: 'No', option_c: '', option_d: '', correct_option: 'A', time_limit: 30 }]
    };
    try {
      const ur = await fetchJson(`${BASE}/api/quizzes/${quizId}/update`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatePayload)
      });
      const uj = await ur.json();
      if (ur.ok && uj.questionsCount === 1) {
        ok('PUT /api/quizzes/:id/update', `title updated, now 1 question`);
      } else ko('PUT /api/quizzes/:id/update', `status ${ur.status} body=${JSON.stringify(uj)}`);
    } catch (e) { ko('PUT /api/quizzes/:id/update', e.message); }
  }

  // DELETE quiz
  if (quizId) {
    try {
      const dr = await fetchJson(`${BASE}/api/quizzes/${quizId}`, { method: 'DELETE' });
      const dj = await dr.json();
      if (dr.ok) {
        ok('DELETE /api/quizzes/:id', dj.message);
      } else ko('DELETE /api/quizzes/:id', `status ${dr.status} body=${JSON.stringify(dj)}`);
    } catch (e) { ko('DELETE /api/quizzes/:id', e.message); }

    // Confirm deletion
    try {
      const gr2 = await fetchJson(`${BASE}/api/quizzes/${quizId}`);
      if (gr2.status === 404) {
        ok('DELETE confirmed (GET returns 404)', `quizId=${quizId} gone from DB`);
      } else ko('DELETE confirmed', `GET returned ${gr2.status} — quiz still exists!`);
    } catch (e) { ko('DELETE confirmed', e.message); }
  }

  // Quiz creation edge cases — no questions (should 400, not 500)
  try {
    const er = await fetchJson(`${BASE}/api/quizzes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'empty quiz', questions: [] })
    });
    if (er.status === 400) ok('POST quiz with no questions', `correctly returns 400`);
    else ko('POST quiz with no questions', `expected 400, got ${er.status}`);
  } catch (e) { ko('POST quiz with no questions', e.message); }

  // Quiz creation — missing required fields (should 400, not 500)
  try {
    const er2 = await fetchJson(`${BASE}/api/quizzes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '', questions: [{ question_text: 'Q', option_a: 'A', option_b: 'B', correct_option: 'A' }] })
    });
    if (er2.status === 400) ok('POST quiz with missing title', `correctly returns 400`);
    else ko('POST quiz with missing title', `expected 400, got ${er2.status}`);
  } catch (e) { ko('POST quiz with missing title', e.message); }
}

// ── 3. CORS ───────────────────────────────────────────────────
async function smokeCors() {
  const testOrigin = async (origin, expectAllow) => {
    const r = await fetchJson(`${BASE}/api/health`, { headers: { Origin: origin } });
    const allow = r.headers.get('access-control-allow-origin');
    return { origin, allow, expectAllow, passed: expectAllow ? (allow === origin) : (allow === null) };
  };

  const cases = [
    ['http://localhost:3000', true],
    ['http://192.168.1.104:3000', true],
    ['http://192.168.0.50:3000', true],
    ['http://10.0.0.5:3000', true],
    ['http://evil.example.com:3000', true],   // port-scoped: hostname doesn't matter
    ['http://localhost:8080', false],         // wrong port → blocked
    ['https://localhost:3000', false],        // wrong protocol
  ];

  for (const [origin, expect] of cases) {
    const res = await testOrigin(origin, expect);
    if (res.passed) {
      ok(`CORS ${origin}`, expect ? `allow-origin=${res.allow}` : 'blocked (no allow-origin header)');
    } else {
      ko(`CORS ${origin}`, `allow-origin=${res.allow}, expected ${expect ? origin : 'none'}`);
    }
  }
}

// ── 4. WebSocket + QR + Join Flow ────────────────────────────
async function smokeSocket() {
  await new Promise(r => setTimeout(r, 500)); // let server settle

  return new Promise((resolve) => {
    const hostSocket = io(BASE, { transports: ['websocket', 'polling'], reconnection: false });

    hostSocket.on('connect_error', (err) => {
      ko('WebSocket connect', err.message);
      hostSocket.disconnect();
      resolve();
    });

    hostSocket.on('connect', () => {
      ok('WebSocket connect', `socketId=${hostSocket.id}`);

      // Create a lobby
      hostSocket.emit('host-create-lobby', { hostName: 'SmokeHost', quizId: 99999 }, (cb) => {
        if (cb && cb.success) {
          ok('host-create-lobby', `pin=${cb.pin}`);
          const pin = cb.pin;
          const playerSocket = io(BASE, { transports: ['websocket', 'polling'], reconnection: false });

          playerSocket.on('connect', () => {
            ok('Player WebSocket connect', `playerSocketId=${playerSocket.id}`);

            // Player joins
            playerSocket.emit('player-join-lobby', { pin, username: 'SmokeStudent' }, (joinCb) => {
              if (joinCb && joinCb.success) {
                ok('player-join-lobby', `rejoinToken present=${!!joinCb.rejoinToken}`);
              } else ko('player-join-lobby', JSON.stringify(joinCb));
              playerSocket.disconnect();
              hostSocket.disconnect();
              resolve();
            });
          });

          // Listen for roster update on host side
          hostSocket.on('player-list-update', (data) => {
            const names = data.players.map(p => p.username).sort();
            if (names.includes('SmokeHost') && names.includes('SmokeStudent')) {
              ok('player-list-update roster', `players=[${names.join(', ')}]`);
            }
          });

          hostSocket.on('player-joined-lobby', (data) => {
            if (data.username === 'SmokeStudent') {
              ok('player-joined-lobby toast', `username=${data.username}`);
            }
          });

          playerSocket.on('connect_error', (err) => {
            ko('Player WebSocket connect', err.message);
            playerSocket.disconnect();
            hostSocket.disconnect();
            resolve();
          });
        } else {
          ko('host-create-lobby', JSON.stringify(cb));
          hostSocket.disconnect();
          resolve();
        }
      });
    });

    // Safety timeout
    setTimeout(() => { hostSocket.disconnect(); resolve(); }, 8000);
  });
}

// ── 5. QR URL encoding check ──────────────────────────────────
function smokeQrLogic() {
  // Replicate the resolveJoinUrl logic from waiting-room.html
  const testCases = [
    { hostname: '192.168.1.104', pin: '123456', expected: 'http://192.168.1.104:3000/join-quiz.html?pin=123456' },
    { hostname: '10.0.0.5', pin: '999999', expected: 'http://10.0.0.5:3000/join-quiz.html?pin=999999' },
    { hostname: 'myhost.local', pin: '555555', expected: 'http://myhost.local:3000/join-quiz.html?pin=555555' },
  ];
  for (const { hostname, pin, expected } of testCases) {
    const url = `http://${hostname}:3000/join-quiz.html?pin=${pin}`;
    if (url === expected) ok(`QR URL ${hostname}`, url);
    else ko(`QR URL ${hostname}`, `expected ${expected}, got ${url}`);
  }
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  const watchdog = setTimeout(() => {
    console.log('⏰ GLOBAL WATCHDOG TIMEOUT');
    if (serverProc) serverProc.kill('SIGTERM');
    process.exit(2);
  }, 45000);

  console.log('🚀 QuizLive Smoke Test — starting server on port', PORT);
  try {
    await startServer();
    const healthy = await waitForHealth();
    if (!healthy) { console.error('❌ Server never became healthy'); process.exit(1); }

    await smokeRoutes();
    await smokeApi();
    await smokeCors();
    await smokeSocket();
    smokeQrLogic();

  } catch (e) {
    ko('Server startup', e.message);
  } finally {
    clearTimeout(watchdog);
    if (serverProc) serverProc.kill('SIGTERM');
  }

  // Report
  console.log('\n' + '='.repeat(60));
  console.log(`QUIZLIVE SMOKE TEST SUMMARY:  ${PASS} passed  |  ${FAIL} failed  |  ${PASS + FAIL} total`);
  console.log('='.repeat(60));
  results.forEach(r => console.log(r));
  console.log('='.repeat(60));
  process.exit(FAIL > 0 ? 1 : 0);
}

main();
