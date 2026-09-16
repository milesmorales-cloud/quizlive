const express = require('express');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcrypt');
const database = require('./database');

const SALT_ROUNDS = 12;

// ── Detect the current active local IPv4 address ──────────────────────────
// Iterates network interfaces, skips loopback and non-IPv4 entries, and
// returns the first address on a private range (10.x, 172.x, 192.168.x).
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (
                iface.family === 'IPv4' &&
                !iface.internal &&
                /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(iface.address)
            ) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1'; // fallback
}

const LOCAL_IP = getLocalIP();
console.log(`[QuizLive] Detected local network IP: ${LOCAL_IP}`);

const app = express();
const server = http.createServer(app);
// Allowed frontend origins.  The whole app is served on port 3000
// (the backend now serves the static frontend AND the API/WebSocket
// on the same single port), and the origin is always
// `http://<hostname>:3000` — hostname varies (localhost, LAN IP,
// custom hostname) depending on how each device opened the page, so
// we match ANY hostname as long as it sits on the frontend port.
// This keeps CORS explicit (port-scoped) without a brittle fixed
// allowlist that would reject phones on a different LAN IP.
const FRONTEND_PORT = process.env.FRONTEND_PORT || 3000;
const allowedOriginPattern = new RegExp(`^http://[^:/]+:${FRONTEND_PORT}$`);

// Shared CORS origin policy: the whole app runs on ONE port (3000), so only
// origins on that port are allowed. Requests with no Origin header (native
// clients, server-to-server, same-origin where the browser omits the header)
// are allowed through. Applied to BOTH the REST API and Socket.IO so the two
// surfaces enforce the same rule.
// NOTE: cors@2.x expects a callback (origin, cb) — returning a boolean
// directly stalls the middleware forever because cb is never invoked.
function corsOriginCallback(origin, callback) {
    if (!origin) return callback(null, true);
    callback(null, allowedOriginPattern.test(origin));
}

const io = new Server(server, {
    cors: {
        origin: corsOriginCallback,
        methods: ['GET', 'POST'],
        credentials: true
    }
});

// Middleware — REST CORS uses the same port-scoped policy as Socket.IO
app.use(cors({ origin: corsOriginCallback, credentials: true }));
app.use(express.json());

// In-memory game sessions: { PIN -> GameSession }
const activeGames = new Map();

// ============================================================
// Helper Functions
// ============================================================

function generatePIN() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function createGameSession(hostId, hostName, quizId) {
    let pin = generatePIN();
    while (activeGames.has(pin)) {
        pin = generatePIN();
    }

    const session = {
        pin,
        hostId,
        hostName,
        quizId,
        // hostToken is a per-session secret handed to the host's browser. It lets
        // the next page (waiting-room.html / host-game.html) reclaim the lobby
        // with a fresh socket after navigation, because real browsers always
        // disconnect the previous page's socket.
        hostToken: crypto.randomBytes(24).toString('hex'),
        // Abandonment cleanup: when the host socket disconnects we DON'T delete
        // the lobby (navigation does this constantly). We schedule a one-shot
        // grace period and only remove the lobby if the host never reclaims it.
        hostReclaimTimeout: null,
        // Snapshot of every player who disconnected, keyed by their rejoinToken.
        // When a student reconnects (Wi-Fi blip / page refresh) mid-game, their
        // score, per-question answer lock, and shuffled-option map are restored
        // from here instead of being lost. Cleared when the lobby is destroyed.
        rejoinCache: {},
        players: [{ id: hostId, username: hostName, score: 0, isHost: true, answeredQuestionId: null, answers: [], shuffleMaps: {} }],
        questions: [],
        currentQuestionIndex: 0,
        currentState: 'lobby', // lobby | question | review | finished
        questionTimer: null,
        questionStartTime: null,
        leaderboard: []
    };

    activeGames.set(pin, session);
    return session;
}

// Grace period (ms) to reclaim a lobby whose host socket disconnected.
// Long enough for the teacher's browser to finish navigating to the
// waiting room, short enough to avoid leaking abandoned lobbies.
const HOST_RECLAIM_GRACE_MS = 20000;

// Clean up a lobby the host abandoned for good: cancel its timer (if any),
// tell remaining players, and drop it from activeGames.
function destroyGameSession(session, reason) {
    if (session.questionTimer) {
        clearInterval(session.questionTimer);
    }
    io.to(session.pin).emit('host-disconnected', { message: 'Host has left the game.' });
    activeGames.delete(session.pin);
    console.log(`Lobby ${session.pin} closed (${reason}).`);
}

// Begin counting down the grace period for a host-less lobby. Reclaiming via
// 'host-reclaim-lobby' cancels the timer before it fires.
function armHostReclaimTimeout(session) {
    if (session.hostReclaimTimeout) {
        clearTimeout(session.hostReclaimTimeout);
    }
    session.hostReclaimTimeout = setTimeout(() => {
        // Only destroy if the host still hasn't reclaimed.
        if (!session.hostId) {
            destroyGameSession(session, 'host did not reclaim within grace period');
        }
    }, HOST_RECLAIM_GRACE_MS);
}

// The host (teacher) runs the game and never plays, so the scoreboard only
// ranks students. Filtering hosts here keeps every leaderboard rendering
// (player-answered, question-time-up, game-finished) consistent.
function buildLeaderboard(session) {
    return session.players
        .filter((p) => !p.isHost)
        .map((p) => ({
            id: p.id,
            username: p.username,
            score: p.score
        }))
        .sort((a, b) => b.score - a.score);
}

function calculatePoints(timeLimit, remainingSeconds) {
    const maxPoints = 1000;
    const minPoints = 100;
    const ratio = remainingSeconds / timeLimit;
    return Math.max(minPoints, Math.round(maxPoints * ratio));
}

// A per-player shuffle of the canonical option letters [A,B,C,D] -> displayed
// letter. The map says "canonical X is shown in position Y", e.g.
//   { A:'B', B:'C', C:'D', D:'A' }  means canonical A is displayed on pad B,
// canonical B on pad C, etc. Each student gets a different rotation/permutation
// so players can't copy a neighbour's pad tap; the host gets the identity map
// (the host never answers, and its options preview reads canonical order).
function buildShuffleMap() {
    const canonical = ['A', 'B', 'C', 'D'];
    // Fisher-Yates over a copy so the canonical order stays fixed.
    const shuffled = [...canonical];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const map = {};
    canonical.forEach((letter, i) => {
        map[letter] = shuffled[i];
    });
    return map;
}

// The identity map used by the host: canonical X is displayed on pad X.
function identityMap() {
    return { A: 'A', B: 'B', C: 'C', D: 'D' };
}

// Given a shuffle map (canonical -> displayed), produce the letterMap field
// sent to a client. The client fills pad X with the option whose canonical
// letter maps TO X, i.e. inverse(canonical->displayed).
function invertShuffleMap(map) {
    const inverse = {};
    Object.keys(map).forEach((canonical) => {
        inverse[map[canonical]] = canonical;
    });
    return inverse;
}

// Build the 'next-question' payload for ONE player. Students get their own
// reordered 'options' object (plus a letterMap describing the reorder); the
// host gets canonical order. If the player already answered this question, the
// payload notes it so reconnect/rejoin clients can immediately lock their pads.
function buildQuestionPayload(session, question, quizTitle, player) {
    const canonicalOptions = {
        A: question.option_a,
        B: question.option_b,
        C: question.option_c || '',
        D: question.option_d || ''
    };

    const isHost = player && player.isHost;
    // Guard against a player entry that is missing (e.g. a reclaimed session
    // where the host was stale-removed) or has no shuffles assigned yet. Fall
    // back to the identity map so the question still renders for the client.
    const shuffleMap = (player && player.shuffleMaps && player.shuffleMaps[question.id]) || identityMap();
    const map = isHost ? identityMap() : shuffleMap;
    const inverse = invertShuffleMap(map);

    // Students get options keyed by their DISPLAYED letter. Pad X shows the
    // text for canonical inverse[X] (which the client reads as options[X]).
    const displayedOptions = {};
    ['A', 'B', 'C', 'D'].forEach((padLetter) => {
        displayedOptions[padLetter] = canonicalOptions[inverse[padLetter]];
    });

    return {
        questionIndex: session.currentQuestionIndex,
        totalQuestions: session.questions.length,
        quizTitle,
        question: {
            id: question.id,
            text: question.question_text,
            options: isHost ? canonicalOptions : displayedOptions,
            letterMap: map,
            timeLimit: question.time_limit || 30
        }
    };
}

// Replay the current in-flight question to a single socket (e.g. the host
// reclaiming after a page navigation, or a student rejoining mid-game).
// Mirrors the exact payload shape the clients expect from 'next-question' +
// 'timer-tick', but reorders options for the target player.
async function emitCurrentQuestionState(socket, session, player) {
    if (session.currentState !== 'question' || !session.questions.length) return;

    const question = session.questions[session.currentQuestionIndex];
    const quiz = await database.getQuizById(session.quizId);
    const quizTitle = quiz ? quiz.title : 'Quiz';
    const timeLimit = question.time_limit || 30;

    socket.emit('next-question', buildQuestionPayload(session, question, quizTitle, player));

    // Recalculate the seconds left on the clock so the target screen isn't stale.
    if (session.questionStartTime) {
        const elapsed = Math.floor((Date.now() - session.questionStartTime) / 1000);
        const remaining = Math.max(0, timeLimit - elapsed);
        socket.emit('timer-tick', { remaining, total: timeLimit });
    } else {
        socket.emit('timer-tick', { remaining: timeLimit, total: timeLimit });
    }
}

// Feature 4: assign each student a fresh shuffle for THIS question. Must run
// BEFORE the per-socket next-question emits so the served layout matches the
// map used to grade their answers. Replays (emitCurrentQuestionState) do NOT
// call this — they rebuild from the stored maps so a reconnecting student sees
// the exact layout they already had.
function assignQuestionShuffles(session, question) {
    session.players.forEach((p) => {
        if (!p.isHost && p.shuffleMaps) {
            p.shuffleMaps[question.id] = buildShuffleMap();
        }
    });
}

function startQuestionTimer(pin, socket) {
    const session = activeGames.get(pin);
    if (!session || session.questions.length === 0) return;

    const question = session.questions[session.currentQuestionIndex];
    const timeLimit = question.time_limit || 30;

    session.questionStartTime = Date.now();
    let remaining = timeLimit;

    const tickInterval = setInterval(() => {
        remaining--;
        io.to(pin).emit('timer-tick', { remaining, total: timeLimit });

        if (remaining <= 0) {
            clearInterval(tickInterval);
            session.questionTimer = null;
            handleTimeUp(pin);
        }
    }, 1000);

    session.questionTimer = tickInterval;
}

async function handleTimeUp(pin) {
    const session = activeGames.get(pin);
    if (!session) return;

    const question = session.questions[session.currentQuestionIndex];
    const timeLimit = question.time_limit || 30;
    session.leaderboard = buildLeaderboard(session);

    // Reveal the correct answer per socket: the host sees the canonical letter,
    // each student sees the letter on their OWN pads. Feature 2 also records a
    // null-answer row for any student who didn't answer this question so
    // "unanswered" is visible in the post-game statistics.
    session.players.forEach((p) => {
        const socket = io.sockets.sockets.get(p.id);
        const map = (p.shuffleMaps && p.shuffleMaps[question.id]) || identityMap();
        const correctLetter = p.isHost ? question.correct_option : map[question.correct_option];

        // Stats: if this student never locked in an answer for this question,
        // append an explicit null record (unanswered) for the export view.
        if (!p.isHost && p.answers) {
            const alreadyRecorded = p.answers.some(
                (a) => a.questionId === question.id
            );
            if (!alreadyRecorded) {
                p.answers.push({
                    questionId: question.id,
                    questionIndex: session.currentQuestionIndex,
                    option: null,
                    optionCanonical: null,
                    isCorrect: false,
                    points: 0,
                    timeRemaining: 0
                });
            }
        }

        if (socket) {
            socket.emit('question-time-up', {
                correctAnswer: correctLetter,
                leaderboard: session.leaderboard
            });
        }
    });

    session.currentQuestionIndex++;

    setTimeout(async () => {
        if (session.currentQuestionIndex < session.questions.length) {
            session.currentState = 'question';
            // Re-arm answer locks so every player can answer the next question
            session.players.forEach((p) => {
                p.answeredQuestionId = null;
            });
            // Also fetch quiz title for the host screen
            const quiz = await database.getQuizById(session.quizId);
            const quizTitle = quiz ? quiz.title : 'Quiz';
            const nextQuestion = session.questions[session.currentQuestionIndex];

            // Feature 4: per-socket next-question so students see their own
            // shuffled options. Fresh maps for the next question are assigned
            // first so the served layout matches the grading map.
            assignQuestionShuffles(session, nextQuestion);
            session.players.forEach((p) => {
                const socket = io.sockets.sockets.get(p.id);
                if (socket) {
                    socket.emit('next-question', buildQuestionPayload(session, nextQuestion, quizTitle, p));
                }
            });
            startQuestionTimer(pin);
        } else {
            session.currentState = 'finished';
            io.to(pin).emit('game-finished', {
                leaderboard: session.leaderboard
            });

            // Feature 2: persist the finished game now. Payload mirrors what
            // database.insertGameRecord expects (quizId, pin, totalPlayers,
            // totalQuestions, players[], startedAt).
            try {
                await database.insertGameRecord({
                    quizId: session.quizId,
                    pin: session.pin,
                    totalPlayers: session.players.filter((p) => !p.isHost).length,
                    totalQuestions: session.questions.length,
                    players: session.players,
                    startedAt: session.startedAt || new Date().toISOString()
                });
                console.log(`Game ${pin} results persisted.`);
            } catch (err) {
                console.error('Failed to persist game record:', err);
            }
        }
    }, 5000);
}

// ============================================================
// WebSocket Event Handlers
// ============================================================

io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    // --------------------------------------------------------
    // HOST: Create Lobby
    // --------------------------------------------------------
    socket.on('host-create-lobby', ({ hostName, quizId }, callback) => {
        if (!quizId) {
            const error = 'Quiz ID is required.';
            socket.emit('lobby-created', { success: false, error });
            if (callback) callback({ success: false, error });
            return;
        }

        const host = hostName || 'Host';
        const session = createGameSession(socket.id, host, quizId);
        socket.join(session.pin);

        console.log(`Lobby created by ${host} with PIN: ${session.pin}`);

        // Send the room its initial roster so the host sees themselves right away
        // (and any later player-list-update events stay consistent).
        io.to(session.pin).emit('player-list-update', {
            players: session.players.map((p) => ({
                id: p.id,
                username: p.username,
                score: p.score,
                isHost: p.isHost
            }))
        });

        // Emit the standardized 'lobby-created' event to the host.
        // hostToken lets the host's NEXT page (after navigation) reclaim the
        // lobby with a fresh socket — see 'host-reclaim-lobby' below.
        socket.emit('lobby-created', {
            success: true,
            pin: session.pin,
            sessionId: session.pin,
            hostToken: session.hostToken
        });

        if (callback) {
            callback({
                success: true,
                pin: session.pin,
                sessionId: session.pin,
                hostToken: session.hostToken
            });
        }
    });

    // --------------------------------------------------------
    // HOST: Reclaim Lobby (after page navigation)
    // --------------------------------------------------------
    // Every page change in the browser drops the old Socket.IO connection and
    // opens a new one with a fresh id. So the waiting room / host screen must
    // "reclaim" the lobby (re-bind hostId to the new socket) using the secret
    // hostToken the dashboard stored in localStorage. A valid token keeps the
    // lobby alive and the teacher in control; a bad/missing token is refused.
    socket.on('host-reclaim-lobby', ({ pin, hostToken }, callback) => {
        pin = pin !== undefined && pin !== null ? String(pin).trim() : pin;

        const fail = (error) => {
            if (callback) callback({ success: false, error });
        };

        if (!pin || !hostToken) {
            return fail('PIN and host token are required.');
        }

        const session = activeGames.get(pin);

        if (!session) {
            return fail('Game session not found.');
        }

        if (session.hostToken !== hostToken) {
            return fail('Invalid host token.');
        }

        // Re-bind the session to this live socket and rejoin the room.
        session.hostId = socket.id;
        socket.join(pin);

        // Update the host player entry to the new socket id so future
        // events (disconnect, answer, etc.) match correctly.
        const hostPlayerIdx = session.players.findIndex((p) => p.isHost);
        if (hostPlayerIdx !== -1) {
            session.players[hostPlayerIdx].id = socket.id;
        }

        // Cancel any abandonment cleanup scheduled while the host navigated.
        if (session.hostReclaimTimeout) {
            clearTimeout(session.hostReclaimTimeout);
            session.hostReclaimTimeout = null;
        }

        console.log(`Host reclaimed lobby ${pin} with socket ${socket.id}`);

        // If a game is already running, replay the current question + live
        // clock to this freshly-connected socket so the host screen isn't
        // blank/blocked on events that fired before it connected. The host
        // always receives the canonical (identity) shuffle.
        if (session.currentState === 'question') {
            const hostPlayer = session.players.find((p) => p.isHost);
            emitCurrentQuestionState(socket, session, hostPlayer);
        }

        // Broadcast the full roster so the host's waiting room (and any
        // already-joined students) see the current player list immediately
        // after the host reclaims. This mirrors what 'player-join-lobby'
        // does and keeps the UI in sync without relying on the callback alone.
        io.to(pin).emit('player-list-update', {
            players: session.players.map((p) => ({
                id: p.id,
                username: p.username,
                score: p.score,
                isHost: p.isHost
            }))
        });

        if (callback) {
            callback({ success: true, pin, players: session.players.map((p) => ({
                id: p.id,
                username: p.username,
                isHost: p.isHost
            })) });
        }
    });

    // --------------------------------------------------------
    // PLAYER: Join Lobby
    // --------------------------------------------------------
    socket.on('player-join-lobby', ({ pin, username }, callback) => {
        // Normalize the PIN to a string so text/numeric inputs match the
        // string keys stored in activeGames.
        pin = pin !== undefined && pin !== null ? String(pin).trim() : pin;

        // Debug: print exactly what PINs are active in memory.
        console.log('activeGames:', activeGames);

        const fail = (error) => {
            socket.emit('join-success', { success: false, error });
            if (callback) callback({ success: false, error });
        };

        if (!pin || !username) {
            return fail('PIN and username are required.');
        }

        const session = activeGames.get(pin);

        if (!session) {
            return fail('Invalid lobby PIN.');
        }

        if (session.currentState !== 'lobby') {
            return fail('Game already in progress.');
        }

        const duplicateName = session.players.some(
            (p) => p.username.toLowerCase() === username.toLowerCase()
        );

        if (duplicateName) {
            return fail('Username already taken.');
        }

        const player = {
            id: socket.id,
            username,
            score: 0,
            isHost: false,
            answeredQuestionId: null,
            answers: [],
            shuffleMaps: {},
            // Secret for re-joining a live game after a disconnect/refresh.
            // Returned ONLY in the per-player join-success payload, never in
            // room broadcasts, so a student can prove who they were.
            rejoinToken: crypto.randomBytes(24).toString('hex')
        };
        session.players.push(player);
        socket.join(pin);

        console.log(`${username} joined lobby ${pin}`);

        // Emit the standardized 'join-success' event to the joining player.
        // rejoinToken goes ONLY here (socket.emit, not io.to) so other players
        // never see it.
        socket.emit('join-success', {
            success: true,
            pin,
            rejoinToken: player.rejoinToken,
            players: session.players.map((p) => ({
                id: p.id,
                username: p.username,
                isHost: p.isHost
            }))
        });

        // Tell the room someone just joined so the host's waiting room can
        // surface a "X joined the lobby" toast. Kept separate from the roster
        // sync below so the host can toast only NEW arrivals, not the whole list.
        io.to(pin).emit('player-joined-lobby', {
            username,
            id: player.id,
            players: session.players.length
        });

        // Notify the WHOLE room of the updated player list so the host AND
        // every already-joined student's waiting room stays in sync.
        io.to(pin).emit('player-list-update', {
            players: session.players.map((p) => ({
                id: p.id,
                username: p.username,
                score: p.score,
                isHost: p.isHost
            }))
        });

        if (callback) {
            callback({
                success: true,
                pin,
                players: session.players.map((p) => ({
                    id: p.id,
                    username: p.username,
                    isHost: p.isHost
                }))
            });
        }
    });

    // --------------------------------------------------------
    // PLAYER: Rejoin Lobby (after a disconnect / page refresh)
    // --------------------------------------------------------
    // A student whose socket dropped mid-game (Wi-Fi blip, refresh) is removed
    // from session.players and snapshotted into session.rejoinCache keyed by
    // their rejoinToken. This handler authenticates against that cache,
    // restores the player with a fresh socket.id, rejoins the room, then
    // replays whatever state the game is in to that one socket. Unlike
    // 'player-join-lobby' (which refuses once the game leaves 'lobby'), this
    // works at any point in the game.
    socket.on('player-rejoin-lobby', async ({ pin, rejoinToken }, callback) => {
        pin = pin !== undefined && pin !== null ? String(pin).trim() : pin;

        const fail = (error) => {
            socket.emit('rejoin-failed', { success: false, error });
            if (callback) callback({ success: false, error });
        };

        if (!pin || !rejoinToken) {
            return fail('PIN and rejoin token are required.');
        }

        const session = activeGames.get(pin);

        if (!session) {
            return fail('Game session not found.');
        }

        // Navigation race: a player's fresh page socket can connect BEFORE the
        // server reaps the old socket, so the disconnect handler has not yet
        // snapshotted them into rejoinCache — they are still in session.players
        // under their old socket id. Re-bind that live entry to this socket
        // (mirrors 'host-reclaim-lobby') instead of failing the rejoin.
        let player = session.players.find(
            (p) => !p.isHost && p.rejoinToken === rejoinToken
        );

        if (player) {
            // Re-bind in place; the old socket's eventual disconnect finds no
            // matching player id and leaves the roster untouched (the same
            // tolerance the host path gets from the [HostNav] case).
            player.id = socket.id;
        } else {
            const cached = session.rejoinCache[rejoinToken];

            if (!cached) {
                return fail('Rejoin token invalid or expired.');
            }

            // A rejoin token is single-use: consuming it here stops a second stale
            // page load from resurrecting an older copy of the same player.
            delete session.rejoinCache[rejoinToken];

            // Restore the player with a clean socket.id and their saved state. The
            // rejoinToken is kept on the object so a later disconnect re-snapshots
            // them under the same token.
            player = {
                id: socket.id,
                username: cached.username,
                score: cached.score,
                isHost: false,
                answeredQuestionId: cached.answeredQuestionId,
                answers: cached.answers || [],
                shuffleMaps: cached.shuffleMaps || {},
                rejoinToken
            };
            session.players.push(player);
        }
        socket.join(pin);

        console.log(`${player.username} rejoined lobby ${pin}`);

        // The whole room (host + every other student) sees the restored roster.
        io.to(pin).emit('player-list-update', {
            players: session.players.map((p) => ({
                id: p.id,
                username: p.username,
                score: p.score,
                isHost: p.isHost
            }))
        });

        // Replay the current game state to THIS socket so the student's screen
        // isn't stuck on a waiting screen.
        if (session.currentState === 'question') {
            const question = session.questions[session.currentQuestionIndex];
            await emitCurrentQuestionState(socket, session, player);

            // If this student already locked in an answer for the live
            // question, tell their client which displayed pad they chose so it
            // can lock/highlight it (the answer lock survived the disconnect).
            if (question && player.answeredQuestionId === question.id) {
                const record = (player.answers || []).find(
                    (a) => a.questionId === question.id
                );
                socket.emit('question-already-answered', {
                    displayAnswer: record ? record.option : null
                });
            }
        } else if (session.currentState === 'finished') {
            // If the host already revealed results, replay the reveal so a
            // reconnected student lands on the podium, not a dead wait screen.
            if (session.resultsRevealed) {
                socket.emit('show-results', { leaderboard: session.leaderboard });
            } else {
                socket.emit('game-finished', { leaderboard: session.leaderboard });
            }
        }

        if (callback) {
            callback({ success: true, pin, gameState: session.currentState });
        }
    });

    // --------------------------------------------------------
    // HOST: Start Game
    // --------------------------------------------------------
    socket.on('start-game', async ({ pin }, callback) => {
        // Normalize the PIN to a string to match activeGames' string keys.
        pin = pin !== undefined && pin !== null ? String(pin).trim() : pin;

        const fail = (error) => {
            if (callback) callback({ success: false, error });
        };

        if (!pin) {
            return fail('PIN is required.');
        }

        const session = activeGames.get(pin);

        if (!session) {
            return fail('Game session not found.');
        }

        if (socket.id !== session.hostId) {
            return fail('Only the host can start the game.');
        }

        if (session.players.length < 2) {
            return fail('Need at least 2 players to start.');
        }

        try {
            const questions = await database.getQuestionsByQuizId(session.quizId);

            if (!questions || questions.length === 0) {
                return fail('No questions found for this quiz.');
            }

            session.questions = questions;
            session.currentQuestionIndex = 0;
            session.currentState = 'question';
            session.startedAt = new Date().toISOString();

            // Reset all player scores and per-question answer state
            session.players.forEach((p) => {
                p.score = 0;
                p.answeredQuestionId = null;
                p.answers = p.isHost ? [] : (p.answers || []);
            });

            // Also fetch quiz title for the host screen
            const quiz = await database.getQuizById(session.quizId);
            const quizTitle = quiz ? quiz.title : 'Quiz';

            io.to(pin).emit('game-started', {
                totalQuestions: questions.length,
                quizTitle,
                players: session.players.map((p) => ({
                    id: p.id,
                    username: p.username,
                    score: p.score
                }))
            });

            // Feature 4: the first question is delivered per socket so each
            // student gets their own shuffled options. Maps are assigned first
            // so the served layout matches the grading map.
            assignQuestionShuffles(session, questions[0]);
            session.players.forEach((p) => {
                const socket = io.sockets.sockets.get(p.id);
                if (socket) {
                    socket.emit('next-question', buildQuestionPayload(session, questions[0], quizTitle, p));
                }
            });

            startQuestionTimer(pin);

            console.log(`Game started in lobby ${pin}`);

            if (callback) callback({ success: true, message: 'Game started.' });
        } catch (err) {
            console.error('Error starting game:', err);
            if (callback) callback({ success: false, error: 'Failed to load questions.' });
        }
    });

    // --------------------------------------------------------
    // HOST: Show Results
    // --------------------------------------------------------
    // The finished game does NOT auto-advance students to the podium. Instead
    // each student sits on a "waiting for the host to reveal results" screen.
    // This handler is the host's trigger: only the host (socket.id === hostId)
    // and only once the game has actually finished may broadcast 'show-results',
    // which sends every student to results.html with the final leaderboard.
    // resultsRevealed is recorded so a student who reconnects AFTER the reveal
    // goes straight to results instead of waiting on a dead screen.
    socket.on('host-show-results', ({ pin }, callback) => {
        pin = pin !== undefined && pin !== null ? String(pin).trim() : pin;

        const fail = (error) => {
            if (callback) callback({ success: false, error });
        };

        if (!pin) {
            return fail('PIN is required.');
        }

        const session = activeGames.get(pin);

        if (!session) {
            return fail('Game session not found.');
        }

        if (session.currentState !== 'finished') {
            return fail('Results can only be shown after the game has finished.');
        }

        if (socket.id !== session.hostId) {
            return fail('Only the host can show results.');
        }

        session.resultsRevealed = true;

        io.to(pin).emit('show-results', {
            leaderboard: session.leaderboard
        });

        console.log(`Host revealed results for lobby ${pin}`);

        if (callback) callback({ success: true, message: 'Results shown.' });
    });

    // --------------------------------------------------------
    // PLAYER: Submit Answer
    // --------------------------------------------------------
    socket.on('submit-answer', ({ pin, questionId, answer, timeRemaining }, callback) => {
        // Normalize the PIN to a string to match activeGames' string keys.
        pin = pin !== undefined && pin !== null ? String(pin).trim() : pin;

        const fail = (error) => {
            if (callback) callback({ success: false, error });
        };

        if (!pin || !questionId || !answer) {
            return fail('Missing required fields.');
        }

        const session = activeGames.get(pin);

        if (!session || session.currentState !== 'question') {
            return fail('No active question.');
        }

        const player = session.players.find((p) => p.id === socket.id);

        if (!player) {
            return fail('Player not in this game.');
        }

        const question = session.questions[session.currentQuestionIndex];

        if (!question || question.id !== questionId) {
            return fail('Question mismatch.');
        }

        // Score-farming guard: one answer per player per question
        if (player.answeredQuestionId === questionId) {
            return fail('You already answered this question.');
        }
        player.answeredQuestionId = questionId;

        // Feature 4: the client sends the letter on ITS pads (a shuffled
        // position). Map displayed -> canonical before grading. If the student
        // has no map (shouldn't happen), fall back to identity so the answer
        // is graded literally.
        const displayed = answer.toUpperCase();
        const shuffle = (player.shuffleMaps && player.shuffleMaps[questionId]) || identityMap();
        const inverse = invertShuffleMap(shuffle);
        const canonical = inverse[displayed] || displayed;

        const timeLimit = question.time_limit || 30;
        const remaining = Math.max(0, timeRemaining || 0);
        const isCorrect = canonical === question.correct_option;
        const points = isCorrect ? calculatePoints(timeLimit, remaining) : 0;

        if (isCorrect) {
            player.score += points;
        }

        // Feature 2: record the answer for the post-game statistics. Both the
        // displayed letter (what the student saw/tapped) and the canonical
        // option (what it actually was) are stored so the stats table can show
        // the real option without reconstructing the shuffle.
        if (player.answers) {
            player.answers.push({
                questionId,
                questionIndex: session.currentQuestionIndex,
                option: displayed,
                optionCanonical: canonical,
                isCorrect,
                points,
                timeRemaining: remaining
            });
        }

        // Build updated leaderboard
        session.leaderboard = buildLeaderboard(session);

        // Broadcast live progress so the host screen can show "X of N answered"
        const answeredCount = session.players.filter((p) => p.answeredQuestionId === questionId).length;
        const totalPlayers = session.players.filter((p) => !p.isHost).length; // students only
        io.to(pin).emit('player-answered', {
            questionId,
            answeredCount,
            totalPlayers,
            leaderboard: session.leaderboard
        });

        console.log(`${player.username} answered ${isCorrect ? 'CORRECT' : 'WRONG'} for Q${questionId}`);

        if (callback) {
            callback({
                success: true,
                isCorrect,
                correctAnswer: question.correct_option,
                pointsEarned: points,
                playerScore: player.score,
                leaderboard: session.leaderboard
            });
        }
    });

    // --------------------------------------------------------
    // Disconnect
    // --------------------------------------------------------
    socket.on('disconnect', () => {
        console.log(`Socket disconnected: ${socket.id}`);

        for (const [pin, session] of activeGames.entries()) {
            if (socket.id === session.hostId) {
                // The host's socket died. This is NORMAL mid-navigation (the
                // browser tears down the socket when the page changes), so we
                // do NOT delete the lobby immediately. Mark it host-less and
                // arm a grace period — 'host-reclaim-lobby' from the host's
                // next page cancels it and re-binds a live socket.
                session.hostId = null;
                armHostReclaimTimeout(session);
                console.log(`Lobby ${pin} host socket disconnected, waiting for reclaim...`);
            } else {
                const playerIndex = session.players.findIndex((p) => p.id === socket.id);

                // Handle the special case where the OLD host socket disconnects
                // AFTER a fresh reclaim already updated session.hostId. We must
                // keep the host player in the roster but attach the NEW socket id.
                const player = playerIndex !== -1 ? session.players[playerIndex] : null;
                if (player && player.isHost && socket.id !== session.hostId) {
                    console.log(`[HostNav] Old host socket ${socket.id} disconnected; updating host player id -> ${session.hostId}`);
                    session.players[playerIndex].id = session.hostId;
                    io.to(pin).emit('player-list-update', {
                        players: session.players.map((p) => ({
                            id: p.id,
                            username: p.username,
                            score: p.score,
                            isHost: p.isHost
                        }))
                    });
                    return; // Do NOT remove the host player
                }

                if (playerIndex !== -1) {
                    const removed = session.players.splice(playerIndex, 1)[0];

                    // Feature 1: snapshot the departing student into the rejoin
                    // cache so they can prove their identity and resume their
                    // exact state after a page refresh or a Wi-Fi drop. Saved
                    // as: score, the per-question answer lock, the full answer
                    // history (Feature 2 stats), and their shuffled-option maps
                    // (Feature 4) so a reconnect sees the same layout they had.
                    // The host is NOT snapshotted — they reclaim the lobby via
                    // their hostToken instead.
                    if (removed.rejoinToken && !removed.isHost) {
                        session.rejoinCache[removed.rejoinToken] = {
                            username: removed.username,
                            score: removed.score,
                            answeredQuestionId: removed.answeredQuestionId,
                            answers: removed.answers || [],
                            shuffleMaps: removed.shuffleMaps || {}
                        };
                    }
                    console.log(`${removed.username} left lobby ${pin}`);

                    io.to(pin).emit('player-list-update', {
                        players: session.players.map((p) => ({
                            id: p.id,
                            username: p.username,
                            score: p.score,
                            isHost: p.isHost
                        }))
                    });
                }
            }
        }
    });
});

// ============================================================
// Express HTTP Routes
// ============================================================

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', activeGames: activeGames.size });
});

app.get('/api/network-ip', (req, res) => {
    res.json({ ip: LOCAL_IP });
});

// ============================================================
// Auth Routes
// ============================================================

app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password, security_question, security_answer } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required.' });
        }
        if (!security_question || !security_answer) {
            return res.status(400).json({ error: 'Security question and answer are required.' });
        }
        if (username.trim().length < 3) {
            return res.status(400).json({ error: 'Username must be at least 3 characters.' });
        }
        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters.' });
        }
        if (security_answer.trim().length < 2) {
            return res.status(400).json({ error: 'Security answer must be at least 2 characters.' });
        }

        const existing = await database.getUserByUsername(username.trim());
        if (existing) {
            return res.status(409).json({ error: 'Username already taken.' });
        }

        const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
        const user = await database.createUser(
            username.trim(),
            hashedPassword,
            security_question.trim(),
            security_answer.trim().toLowerCase()
        );

        res.status(201).json({ message: 'Account created successfully.', userId: user.id });
    } catch (err) {
        console.error('Error registering user:', err);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

app.get('/api/auth/forgot-question/:username', async (req, res) => {
    try {
        const user = await database.getUserByUsername(req.params.username.trim());
        if (!user || !user.security_question) {
            // Return generic message to avoid username enumeration
            return res.status(404).json({ error: 'No recovery question found for that username.' });
        }
        res.json({ security_question: user.security_question });
    } catch (err) {
        console.error('Error fetching security question:', err);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

app.post('/api/auth/reset-password', async (req, res) => {
    try {
        const { username, security_question, security_answer, new_password } = req.body;

        if (!username || !security_question || !security_answer || !new_password) {
            return res.status(400).json({ error: 'All fields are required.' });
        }
        if (new_password.length < 6) {
            return res.status(400).json({ error: 'New password must be at least 6 characters.' });
        }

        const user = await database.getUserByUsername(username.trim());
        if (!user) {
            return res.status(401).json({ error: 'Incorrect username or security answer.' });
        }

        const questionMatch = user.security_question === security_question.trim();
        const answerMatch = user.security_answer === security_answer.trim().toLowerCase();

        if (!questionMatch || !answerMatch) {
            return res.status(401).json({ error: 'Incorrect username or security answer.' });
        }

        const hashedPassword = await bcrypt.hash(new_password, SALT_ROUNDS);
        await database.updateUserPassword(username.trim(), hashedPassword);

        res.json({ status: 'success', message: 'Password updated successfully.' });
    } catch (err) {
        console.error('Error resetting password:', err);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required.' });
        }

        const user = await database.getUserByUsername(username.trim());
        if (!user) {
            return res.status(401).json({ error: 'Invalid username or password.' });
        }

        const match = await bcrypt.compare(password, user.password);
        if (!match) {
            return res.status(401).json({ error: 'Invalid username or password.' });
        }

        // Generate a simple token: base64(userId:username:timestamp)
        const tokenPayload = `${user.id}:${user.username}:${Date.now()}`;
        const teacherToken = Buffer.from(tokenPayload).toString('base64');

        res.json({ status: 'success', teacherToken, username: user.username });
    } catch (err) {
        console.error('Error logging in:', err);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

app.post('/api/quizzes', async (req, res) => {
    try {
        const { title, description, questions } = req.body;

        if (!title) {
            return res.status(400).json({ error: 'Quiz title is required.' });
        }

        if (!questions || !Array.isArray(questions) || questions.length === 0) {
            return res.status(400).json({ error: 'At least one question is required.' });
        }

        for (let i = 0; i < questions.length; i++) {
            const q = questions[i];
            if (!q.question_text || !q.option_a || !q.option_b || !q.correct_option) {
                return res.status(400).json({
                    error: `Question ${i + 1} is missing required fields (question_text, option_a, option_b, correct_option).`
                });
            }
        }

        const quiz = {
            title,
            description: description || '',
            questions
        };

        const result = await database.insertQuiz(quiz);

        res.status(201).json({
            message: 'Quiz created successfully.',
            quizId: result.id,
            title: result.title,
            questionsCount: questions.length
        });
    } catch (err) {
        console.error('Error creating quiz:', err);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

app.get('/api/quizzes', async (req, res) => {
    try {
        const quizzes = await database.getAllQuizzes();
        res.json(quizzes);
    } catch (err) {
        console.error('Error fetching quizzes:', err);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

app.get('/api/quizzes/:id', async (req, res) => {
    try {
        const quiz = await database.getQuizById(req.params.id);

        if (!quiz) {
            return res.status(404).json({ error: 'Quiz not found.' });
        }

        const questions = await database.getQuestionsByQuizId(req.params.id);

        res.json({ ...quiz, questions });
    } catch (err) {
        console.error('Error fetching quiz:', err);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

app.get('/api/quizzes/:id/details', async (req, res) => {
    try {
        const quiz = await database.getQuizById(req.params.id);
        if (!quiz) {
            return res.status(404).json({ error: 'Quiz not found.' });
        }
        const questions = await database.getQuestionsByQuizId(req.params.id);
        res.json({ ...quiz, questions });
    } catch (err) {
        console.error('Error fetching quiz details:', err);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

app.put('/api/quizzes/:id/update', async (req, res) => {
    try {
        const quizId = req.params.id;
        const { title, questions } = req.body;

        if (!title) {
            return res.status(400).json({ error: 'Quiz title is required.' });
        }
        if (!questions || !Array.isArray(questions) || questions.length === 0) {
            return res.status(400).json({ error: 'At least one question is required.' });
        }
        for (let i = 0; i < questions.length; i++) {
            const q = questions[i];
            if (!q.question_text || !q.option_a || !q.option_b || !q.correct_option) {
                return res.status(400).json({
                    error: `Question ${i + 1} is missing required fields.`
                });
            }
        }

        const quiz = await database.getQuizById(quizId);
        if (!quiz) {
            return res.status(404).json({ error: 'Quiz not found.' });
        }

        await database.updateQuizQuestions(quizId, title, questions);

        res.json({
            message: 'Quiz updated successfully.',
            quizId,
            title,
            questionsCount: questions.length
        });
    } catch (err) {
        console.error('Error updating quiz:', err);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

app.delete('/api/quizzes/:id', async (req, res) => {
    try {
        const quizId = req.params.id;
        const quiz = await database.getQuizById(quizId);

        if (!quiz) {
            return res.status(404).json({ error: 'Quiz not found.' });
        }

        await database.deleteQuiz(quizId);

        res.json({ message: 'Quiz deleted successfully.', quizId });
    } catch (err) {
        console.error('Error deleting quiz:', err);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

app.delete('/api/questions/:id', async (req, res) => {
    try {
        const questionId = req.params.id;
        const deleted = await database.deleteQuestion(questionId);

        if (!deleted) {
            return res.status(404).json({ error: 'Question not found.' });
        }

        res.json({ message: 'Question deleted successfully.', questionId });
    } catch (err) {
        console.error('Error deleting question:', err);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// ============================================================
// Statistics / CSV Export Routes (Feature 2)
// ============================================================

// Summary statistics: totals across all recorded games plus a list of every
// completed game (with its per-game average score) so the teacher dashboard
// can render summary cards and a clickable history.
app.get('/api/stats', async (req, res) => {
    try {
        const games = await database.getGameRecords();

        let totalPlayers = 0;
        let scoreSum = 0;
        let scoreCount = 0;

        const summaries = [];
        for (const g of games) {
            const players = await database.getGamePlayers(g.id);
            const avg = players.length
                ? Math.round(players.reduce((s, p) => s + p.score, 0) / players.length)
                : 0;

            players.forEach((p) => { scoreSum += p.score; });
            scoreCount += players.length;
            totalPlayers += g.total_players || players.length;

            summaries.push({
                id: g.id,
                quiz_id: g.quiz_id,
                quizTitle: g.quiz_title,
                pin: g.pin,
                started_at: g.started_at,
                total_players: g.total_players,
                avg_score: avg
            });
        }

        res.json({
            totals: {
                games: games.length,
                players: totalPlayers,
                avgScore: scoreCount ? Math.round(scoreSum / scoreCount) : 0
            },
            games: summaries
        });
    } catch (err) {
        console.error('Error fetching stats:', err);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// Full per-game detail: the questions that were asked plus a per-player
// breakdown (correct / wrong / unanswered counts and their full answer array),
// used by statistics.html?game=<id> to render the tall breakdown table.
app.get('/api/stats/game/:id', async (req, res) => {
    try {
        const game = await database.getGameRecordById(req.params.id);

        if (!game) {
            return res.status(404).json({ error: 'Game not found.' });
        }

        const questions = await database.getQuestionsByQuizId(game.quiz_id);
        const players = await database.getGamePlayers(game.id);

        const playersDetail = players.map((p) => {
            const answers = JSON.parse(p.answers_json || '[]');
            const correct = answers.filter((a) => a.isCorrect).length;
            const answered = answers.filter((a) => a.option !== null).length;
            return {
                username: p.username,
                score: p.score,
                correct,
                wrong: answered - correct,
                unanswered: questions.length - answered,
                answers
            };
        });

        res.json({
            game: {
                id: game.id,
                quizTitle: game.quiz_title,
                pin: game.pin,
                started_at: game.started_at,
                finished_at: game.finished_at,
                total_players: game.total_players,
                total_questions: game.total_questions
            },
            questions: questions.map((q) => ({
                id: q.id,
                text: q.question_text,
                correct_option: q.correct_option
            })),
            players: playersDetail
        });
    } catch (err) {
        console.error('Error fetching game stats:', err);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// CSV export of one game: one row per student with score + per-question
// columns (q<i>_ans = the displayed option letter, q<i>_pts = points earned).
// A UTF-8 BOM (EF BB BF) prefixes the payload so Excel opens it cleanly.
app.get('/api/stats/game/:id/export', async (req, res) => {
    try {
        const game = await database.getGameRecordById(req.params.id);

        if (!game) {
            return res.status(404).json({ error: 'Game not found.' });
        }

        const questions = await database.getQuestionsByQuizId(game.quiz_id);
        const players = await database.getGamePlayers(game.id);

        const header = ['username', 'score', 'correct', 'wrong', 'unanswered'];
        questions.forEach((_, i) => header.push(`q${i + 1}_ans`, `q${i + 1}_pts`));

        const rows = players.map((p) => {
            const answers = JSON.parse(p.answers_json || '[]');
            const byQuestion = {};
            answers.forEach((a) => { byQuestion[a.questionIndex] = a; });

            let correct = 0;
            let wrong = 0;
            let unanswered = 0;
            questions.forEach((_, i) => {
                const a = byQuestion[i];
                if (!a || a.option === null) unanswered++;
                else if (a.isCorrect) correct++;
                else wrong++;
            });

            const row = [p.username, p.score, correct, wrong, unanswered];
            questions.forEach((_, i) => {
                const a = byQuestion[i];
                row.push(a && a.option !== null ? a.option : '', a ? a.points : 0);
            });
            return row;
        });

        const escape = (v) => {
            const s = String(v === null || v === undefined ? '' : v);
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };

        const csv = '﻿' + [header, ...rows]
            .map((r) => r.map(escape).join(','))
            .join('\r\n');

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="game_${game.id}_stats.csv"`);
        res.send(csv);
    } catch (err) {
        console.error('Error exporting game stats:', err);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// ============================================================
// Static frontend — the backend serves the whole app on ONE port
// (3000): REST API (/api/*), Socket.IO, AND the static pages.
// There is no separate port for the frontend anymore.
// ============================================================
const path = require('path');
const fs = require('fs');
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

// SPA default: map / to the teacher dashboard (matches the old
// static server) so a bare localhost:3000 load shows the app.
function sendFrontendFile(res, relPath, fallback) {
    const file = path.normalize(path.join(FRONTEND_DIR, relPath));
    if (!file.startsWith(FRONTEND_DIR)) {
        res.status(403).type('text/plain').send('Forbidden');
        return;
    }
    fs.readFile(file, (err, data) => {
        if (err) return sendFrontendFile(res, fallback, '404.html');
        const ext = path.extname(file).toLowerCase();
        const MIME = {
            '.html': 'text/html; charset=utf-8',
            '.js': 'text/javascript; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.json': 'application/json; charset=utf-8',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.svg': 'image/svg+xml',
            '.ico': 'image/x-icon',
            '.gif': 'image/gif'
        };
        res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store, max-age=0');
        res.send(data);
    });
}

app.get('/', (req, res) => sendFrontendFile(res, 'index.html', 'index.html'));

// Explicit fallback routes so clean URLs (e.g. /login, /host-game) resolve to their .html files
const PAGE_ROUTES = {
    '/login': 'login.html',
    '/teacher-dashboard': 'teacher-dashboard.html',
    '/create-quiz': 'create-quiz.html',
    '/host-game': 'host-game.html',
    '/join-quiz': 'join-quiz.html',
    '/live-quiz': 'live-quiz.html',
    '/waiting-room': 'waiting-room.html',
    '/statistics': 'statistics.html',
    '/results': 'results.html'
};
for (const [route, file] of Object.entries(PAGE_ROUTES)) {
    app.get(route, (req, res) => sendFrontendFile(res, file, file));
}

// Serve static frontend files. The `extensions` option lets /login resolve to login.html.
app.use(express.static(FRONTEND_DIR, { index: 'index.html', extensions: ['html'], maxAge: 0 }));

// ============================================================
// Start Server
// ============================================================

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`QuizLive server running on port ${PORT}`);
});

module.exports = { app, server, io };
