// ============================================================
// Quick host-flow verification: ensures host gets game-started,
// next-question with quizTitle, player-answered progress, and
// question-time-up events.
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

function waitFor(sock, event, ms = 6000) {
    return new Promise((resolve) => {
        const t = setTimeout(() => resolve({ timeout: true }), ms);
        sock.once(event, (data) => { clearTimeout(t); resolve({ data }); });
    });
}

function emitCb(sock, event, payload) {
    return new Promise((res) => sock.emit(event, payload, res));
}

async function main() {
    const host = await connect();
    const alice = await connect();
    const bob = await connect();

    // Create a 1-question quiz
    const quizRes = await fetch(`${API}/api/quizzes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            title: 'Host Flow Test',
            description: 'e2e',
            questions: [
                { question_text: 'Test Q?', option_a: 'A', option_b: 'B', option_c: 'C', option_d: 'D', correct_option: 'B', time_limit: 2 }
            ]
        })
    });
    const { quizId } = await quizRes.json();

    const created = await emitCb(host, 'host-create-lobby', { hostName: 'Teacher', quizId });
    const pin = created.pin;
    await emitCb(alice, 'player-join-lobby', { pin, username: 'Alice' });
    await emitCb(bob, 'player-join-lobby', { pin, username: 'Bob' });
    console.log('Lobby ready, PIN:', pin);

    // Set up listeners BEFORE start
    const hostGS = waitFor(host, 'game-started', 6000);
    const hostNQ = waitFor(host, 'next-question', 6000);
    const hostPA = waitFor(host, 'player-answered', 4000);
    const hostTU = waitFor(host, 'question-time-up', 8000);

    await emitCb(host, 'start-game', { pin });
    console.log('Game started');

    const gs = await hostGS;
    console.log('game-started received:', !!gs.data, 'quizTitle:', gs.data?.quizTitle);
    if (!gs.data || !gs.data.quizTitle) console.error('FAIL: quizTitle missing from game-started');

    const nq = await hostNQ;
    console.log('next-question received:', !!nq.data, 'quizTitle:', nq.data?.quizTitle);
    if (!nq.data || !nq.data.quizTitle) console.error('FAIL: quizTitle missing from next-question');

    const qId = nq.data?.question?.id;

    // Alice answers
    await emitCb(alice, 'submit-answer', { pin, questionId: qId, answer: 'B', timeRemaining: 2 });
    console.log('Alice answered');

    const pa = await hostPA;
    console.log('player-answered received:', !!pa.data, pa.data);
    if (!pa.data || pa.data.answeredCount !== 1) console.error('FAIL: answeredCount should be 1');
    if (!pa.data || pa.data.totalPlayers !== 2) console.error('FAIL: totalPlayers should be 2');

    const tu = await hostTU;
    console.log('question-time-up received:', !!tu.data, 'correctAnswer:', tu.data?.correctAnswer);

    host.disconnect(); alice.disconnect(); bob.disconnect();
    console.log('\nHOST FLOW VERIFICATION COMPLETE');
    process.exit(0);
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });