// ============================================================
// Full browser simulation: THREE page hops for the host.
//
//   dashboard    -> host-create-lobby (socket A)
//   waiting-room -> host-reclaim-lobby (socket B), start-game
//   host-game    -> host-reclaim-lobby (socket C), must still receive
//                   next-question and player-answered live
//
// A student stays on ONE socket across the whole game.
// ============================================================
const { io } = require('socket.io-client');

const API = 'http://localhost:3000';
const TRANSPORTS = ['websocket'];

function connect() {
    const s = io(API, { transports: TRANSPORTS, reconnection: false });
    return new Promise((res, rej) => {
        const to = setTimeout(() => rej(new Error('connect timeout')), 4000);
        s.on('connect', () => { clearTimeout(to); res(s); });
        s.on('connect_error', rej);
    });
}

function emitCb(sock, event, payload) {
    return new Promise((res) => sock.emit(event, payload, res));
}

function waitFor(sock, event, ms = 6000) {
    return new Promise((resolve) => {
        const t = setTimeout(() => resolve({ timeout: true }), ms);
        sock.once(event, (data) => { clearTimeout(t); resolve({ data }); });
    });
}

async function main() {
    const quizRes = await fetch(`${API}/api/quizzes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            title: 'Multi Nav',
            description: '3-page host flow',
            questions: [
                { question_text: 'Q1?', option_a: 'A', option_b: 'B', option_c: 'C', option_d: 'D', correct_option: 'A', time_limit: 8 }
            ]
        })
    });
    const { quizId } = await quizRes.json();

    let failures = 0;
    const check = (label, cond) => {
        console.log((cond ? 'PASS' : 'FAIL') + ' ' + label);
        if (!cond) failures++;
    };

    // ---- PAGE 1: dashboard ----
    const dash = await connect();
    const created = await emitCb(dash, 'host-create-lobby', { hostName: 'Teacher', quizId });
    const pin = created.pin, hostToken = created.hostToken;
    check('page1: lobby created, token issued', !!pin && !!hostToken);
    dash.disconnect(); // navigation -> page 2
    await new Promise((r) => setTimeout(r, 300));

    // Student joins on one lasting socket
    const student = await connect();
    const joined = await emitCb(student, 'player-join-lobby', { pin, username: 'Alice' });
    check('student joined', joined.success);

    // ---- PAGE 2: waiting room ----
    const waiting = await connect();
    const reclaimB = await emitCb(waiting, 'host-reclaim-lobby', { pin, hostToken });
    check('page2: waiting-room reclaimed lobby', reclaimB.success);
    const gs = waitFor(waiting, 'game-started');
    const start = await emitCb(waiting, 'start-game', { pin });
    check('page2: start-game succeeded', start.success);
    check('page2: game-started broadcast received', (await gs).data !== undefined);
    waiting.disconnect(); // navigation -> page 3
    await new Promise((r) => setTimeout(r, 300));

    // ---- PAGE 3: host-game (teacher screen) ----
    const hostGame = await connect();
    const reclaimC = await emitCb(hostGame, 'host-reclaim-lobby', { pin, hostToken });
    check('page3: host-game reclaimed lobby', reclaimC.success);

    const nq = await waitFor(hostGame, 'next-question', 5000);
    check('page3: next-question received', !!nq.data);
    const qId = nq.data?.question?.id;

    const pa = waitFor(hostGame, 'player-answered', 5000);
    const ans = await emitCb(student, 'submit-answer', { pin, questionId: qId, answer: 'A', timeRemaining: 7 });
    check('student answered', ans.success);
    const paData = (await pa).data;
    check('page3: player-answered received live', !!paData && paData.answeredCount === 1);

    hostGame.disconnect(); student.disconnect();

    console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });