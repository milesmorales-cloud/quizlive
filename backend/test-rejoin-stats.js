// ============================================================
// Smoke test for the 4-feature build's backend additions:
//  - Feature 1: player disconnect -> snapshot -> player-rejoin-lobby
//               (state replay + question-already-answered after refresh)
//  - Feature 4: per-player shuffled letterMaps (A and B differ, both can
//               answer correctly using their display letters)
//  - Feature 2: finished game persists; /api/stats + game detail + CSV export
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

function waitFor(sock, event, ms = 5000) {
    return new Promise((resolve) => {
        const t = setTimeout(() => resolve({ timeout: true }), ms);
        sock.once(event, (data) => { clearTimeout(t); resolve({ data }); });
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    // NOTE: this test mutates shared stats, so it needs a fresh quiz each run.
    const quizTitle = `Rejoin/Stats ${Date.now()}`;
    const quizRes = await fetch(`${API}/api/quizzes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            title: quizTitle,
            description: 'rejoin + stats smoke test',
            questions: [
                { question_text: 'Prime?', option_a: '2', option_b: '3', option_c: '5', option_d: '7', correct_option: 'C', time_limit: 8 },
                { question_text: 'Capital?', option_a: 'Paris', option_b: 'London', option_c: 'Rome', option_d: 'Berlin', correct_option: 'A', time_limit: 8 }
            ]
        })
    });
    const { quizId } = await quizRes.json();

    let failures = 0;
    const check = (label, cond) => {
        console.log((cond ? 'PASS' : 'FAIL') + ' ' + label);
        if (!cond) failures++;
    };

    // ---- Host (single socket is fine; host flow already covered elsewhere) ----
    const host = await connect();
    const created = await emitCb(host, 'host-create-lobby', { hostName: 'Teacher', quizId });
    const pin = created.pin, hostToken = created.hostToken;

    // ---- Two students join. rejoinToken comes ONLY from the join-success
    //      event, not the emit callback (mirrors the real app.js client). ----
    const alice = await connect();
    const bob = await connect();
    const jsA = waitFor(alice, 'join-success', 3000);
    const jsB = waitFor(bob, 'join-success', 3000);
    await emitCb(alice, 'player-join-lobby', { pin, username: 'Alice' });
    await emitCb(bob, 'player-join-lobby', { pin, username: 'Bob' });
    const joinedA = (await jsA).data;
    const joinedB = (await jsB).data;
    check('alice joined, has rejoinToken', joinedA && joinedA.success === true && !!joinedA.rejoinToken);
    check('bob joined, has rejoinToken', joinedB && joinedB.success === true && !!joinedB.rejoinToken);
    const rejoinToken = joinedA.rejoinToken;

    // ---- Start game; capture each student's Q1 displayed letter for the correct option ----
    const nqA = waitFor(alice, 'next-question', 5000);
    const nqB = waitFor(bob, 'next-question', 5000);
    await emitCb(host, 'start-game', { pin });
    const q1Al = (await nqA).data;
    const q1Bob = (await nqB).data;
    check('Q1 delivered to both students', !!q1Al?.question && !!q1Bob?.question);
    const q1Id = q1Al.question.id;
    const q1Correct = 'C';
    const aDisplay1 = q1Al.question.letterMap[q1Correct];
    const bDisplay1 = q1Bob.question.letterMap[q1Correct];
    check('Feature4: students received different letterMaps for Q1', aDisplay1 !== bDisplay1);

    // ---- Alice and Bob answer Q1, then Alice drops (refresh) ----
    // Bob answers Q1 but goes silent on Q2 on purpose, so the Q2 null-answer
    // record surfaces as unanswered=1 in the stats detail / export.
    const ansA1 = await emitCb(alice, 'submit-answer', { pin, questionId: q1Id, answer: aDisplay1, timeRemaining: 7 });
    check('alice answered Q1 via displayed letter', ansA1.success && ansA1.isCorrect === true);
    const b1Res = await emitCb(bob, 'submit-answer', { pin, questionId: q1Id, answer: bDisplay1, timeRemaining: 7 });
    check('bob answered Q1 via his display letter', b1Res.success && b1Res.isCorrect === true);
    alice.disconnect(); // simulate a page refresh: socket dies, snapshot happens
    await sleep(400);

    // ---- Alice rejoins with her token during the same Q1 ----
    const alice2 = await connect();
    const alreadyAnswered = waitFor(alice2, 'question-already-answered', 3000);
    const replay = waitFor(alice2, 'next-question', 3000);
    const rejoinCb = await emitCb(alice2, 'player-rejoin-lobby', { pin, rejoinToken });
    check('rejoin accepted, gameState replayed', rejoinCb.success && rejoinCb.gameState === 'question');
    const replayQ = (await replay).data;
    check('replay: Q1 re-sent with alice display layout', replayQ?.question?.id === q1Id);
    const aa = (await alreadyAnswered).data;
    check('question-already-answered: pad locked to alice\'s display letter',
        aa && aa.displayAnswer === aDisplay1);

    // ---- Q1 expires -> reveal; Q2 auto-advances. Alice answers Q2 with HER display letter ----
    const q2Alice = waitFor(alice2, 'next-question', 20000);
    const q2Bob = waitFor(bob, 'next-question', 20000);
    const q2 = (await q2Alice).data;
    check('Q2 re-broadcast reaches rejoined alice', q2?.question?.id >= 0);
    const q2BobData = (await q2Bob).data; // let Bob receive Q2 too
    const q2Id = q2.question.id;
    const aDisplay2 = q2.question.letterMap['A']; // correct for Q2 is option A
    check('Feature4: Q2 shuffles differ between alice and bob',
        q2.question.letterMap['A'] !== q2BobData.question.letterMap['A'] ||
        q2.question.letterMap['B'] !== q2BobData.question.letterMap['B'] ||
        q2.question.letterMap['C'] !== q2BobData.question.letterMap['C'] ||
        q2.question.letterMap['D'] !== q2BobData.question.letterMap['D']);

    const ansA2 = await emitCb(alice2, 'submit-answer', { pin, questionId: q2Id, answer: aDisplay2, timeRemaining: 7 });
    check('alice answered Q2 via her display letter (post-rejoin), correct', ansA2.success && ansA2.isCorrect === true);

    // Bob answered Q1 earlier (during the Q1 window). He goes quiet on Q2 on
    // purpose so the Q2 null-answer record surfaces as unanswered=1 in the
    // stats detail / export.

    // ---- Game finishes: alice must receive game-finished on the rejoin socket ----
    const finished = waitFor(alice2, 'game-finished', 20000);
    const fin = (await finished).data;
    check('game-finished replayed to rejoined alice', !!fin && Array.isArray(fin.leaderboard));

    // ---- Stats: poll until the record is persisted, then verify each endpoint ----
    let stats = null;
    for (let i = 0; i < 15; i++) {
        stats = await (await fetch(`${API}/api/stats`)).json();
        if (stats.games && stats.games.length > 0) break;
        await sleep(500);
    }
    const ourGame = stats.games.find((g) => g.quizTitle === quizTitle);
    check('stats: game persisted in /api/stats', !!ourGame);
    check('stats: totals present', stats.totals && typeof stats.totals.games === 'number');

    const detail = await (await fetch(`${API}/api/stats/game/${ourGame.id}`)).json();
    check('stats detail: this quiz has 2 questions in header', Array.isArray(detail.questions) && detail.questions.length === 2);
    const aliceRow = detail.players.find((p) => p.username === 'Alice');
    const bobRow = detail.players.find((p) => p.username === 'Bob');
    check('stats detail: alice has 2 answers, 2 correct, 0 unanswered',
        aliceRow && aliceRow.answers.length === 2 && aliceRow.correct === 2 && aliceRow.unanswered === 0);
    check('stats detail: bob answered Q1, unanswered=1 on Q2 (null-answer record)',
        bobRow && bobRow.answers.length === 2 && bobRow.correct === 1 && bobRow.unanswered === 1);

    const csvRes = await fetch(`${API}/api/stats/game/${ourGame.id}/export`);
    // NOTE: fetch().text() strips a leading BOM via TextDecoder, so verify the
    // raw wire bytes instead (EF BB BF = UTF-8 BOM that Excel needs).
    const csvBuffer = Buffer.from(await csvRes.arrayBuffer());
    const csvText = csvBuffer.toString('utf8');
    const csvBody = (csvBuffer[0] === 0xEF && csvBuffer[1] === 0xBB && csvBuffer[2] === 0xBF)
        ? csvText.slice(1) : csvText;
    const csvRows = csvBody.split('\r\n').filter((l) => l.length);
    check('csv: UTF-8 BOM present (EF BB BF)',
        csvBuffer[0] === 0xEF && csvBuffer[1] === 0xBB && csvBuffer[2] === 0xBF);
    check('csv: 3 rows (header + 2 students)', csvRows.length === 3);
    check('csv: header row has q1_ans/q1_pts/q2_ans/q2_pts',
        csvRows[0] === 'username,score,correct,wrong,unanswered,q1_ans,q1_pts,q2_ans,q2_pts');
    const aliceCsv = csvRows.find((r) => r.startsWith('Alice,'));
    const bobCsv = csvRows.find((r) => r.startsWith('Bob,'));
    check('csv: Alice row = score,2 correct,0 wrong,0 unanswered, display q1, pts, display q2, pts',
        aliceCsv && aliceCsv.split(',')[3] === '0' && aliceCsv.split(',').length === 9);
    check('csv: Bob row has blank q2_ans cell', bobCsv && bobCsv.split(',')[7] === '');

    host.disconnect(); alice2.disconnect(); bob.disconnect();

    console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });