// ============================================================
// STRESS TEST: host navigates away MID-QUESTION (the crash that
// originally took down the server), then reclaims on a fresh
// socket while a student is mid-question. Repeat N times.
// ============================================================
const { io } = require('socket.io-client');

const API = 'http://localhost:3000';
const TRANSPORTS = ['websocket'];

function connect() {
    const s = io(API, { transports: TRANSPORTS, reconnection: false });
    return new Promise((res, rej) => {
        const to = setTimeout(() => rej(new Error('connect timeout')), 5000);
        s.on('connect', () => { clearTimeout(to); res(s); });
        s.on('connect_error', rej);
    });
}
function emitCb(sock, event, payload) {
    return new Promise((res) => sock.emit(event, payload, res));
}
function waitFor(sock, event, ms = 7000) {
    return new Promise((resolve) => {
        const t = setTimeout(() => resolve({ timeout: true }), ms);
        sock.once(event, (data) => { clearTimeout(t); resolve({ data }); });
    });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runIteration(i, quizId) {
    let failures = 0;
    const check = (l, c) => { if (!c) { failures++; console.log('  FAIL ' + l); } };

    // Page 1: dashboard -> create
    const dash = await connect();
    const created = await emitCb(dash, 'host-create-lobby', { hostName: 'Teacher', quizId });
    const pin = created.pin, hostToken = created.hostToken;
    check('lobby created', !!pin && !!hostToken);
    dash.disconnect();
    await sleep(200);

    // Student joins (one lasting socket)
    const student = await connect();
    const joined = await emitCb(student, 'player-join-lobby', { pin, username: 'Alice' });
    check('student joined', joined.success);

    // Page 2: waiting room -> reclaim + start
    const waiting = await connect();
    const reclaimB = await emitCb(waiting, 'host-reclaim-lobby', { pin, hostToken });
    check('waiting reclaimed', reclaimB.success);
    const gs = waitFor(waiting, 'game-started');
    await emitCb(waiting, 'start-game', { pin });
    await gs;
    waiting.disconnect(); // -> page 3
    await sleep(200);

    // Page 3: host-game -> reclaim, question is now LIVE
    const hostGame = await connect();
    const reclaimC = await emitCb(hostGame, 'host-reclaim-lobby', { pin, hostToken });
    check('host-game reclaimed', reclaimC.success);
    const nq = await waitFor(hostGame, 'next-question', 6000);
    check('next-question received', !!nq.data);
    const qId = nq.data?.question?.id;

    // ==== HOST NAVIGATES AWAY MID-QUESTION ====
    hostGame.disconnect();
    await sleep(400);

    // ==== HOST RETURNS ON A FRESH SOCKET, STILL MID-QUESTION ====
    const hostReturn = await connect();
    const reclaimD = await emitCb(hostReturn, 'host-reclaim-lobby', { pin, hostToken });
    check('host reclaimed mid-question', reclaimD.success);

    // Student answers while host is on fresh socket
    const pa = waitFor(hostReturn, 'player-answered', 6000);
    const ans = await emitCb(student, 'submit-answer', { pin, questionId: qId, answer: 'A', timeRemaining: 7 });
    check('student answered', ans.success);
    const paData = (await pa).data;
    check('host saw player-answered', !!paData && paData.answeredCount === 1);

    hostReturn.disconnect(); student.disconnect();
    return failures;
}

async function main() {
    const quizRes = await fetch(`${API}/api/quizzes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            title: 'MidQuestion Stress', description: 'x',
            questions: [{ question_text: 'Q?', option_a: 'A', option_b: 'B', option_c: 'C', option_d: 'D', correct_option: 'A', time_limit: 10 }]
        })
    });
    const { quizId } = await quizRes.json();

    const ROUNDS = 5;
    let totalFailures = 0;
    for (let i = 1; i <= ROUNDS; i++) {
        const f = await runIteration(i, quizId);
        totalFailures += f;
        console.log(`round ${i}: ${f === 0 ? 'PASS' : f + ' FAILURE(S)'}`);
    }
    console.log(totalFailures === 0 ? '\nALL STRESS ROUNDS PASSED' : `\n${totalFailures} FAILURE(S) TOTAL`);
    process.exit(totalFailures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
