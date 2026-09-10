// ============================================================
// QuizLive - Frontend Application Logic
// Ties together the game screens (dashboard, lobby, waiting room).
//
// The Socket.IO client is initialised by js/websocket.js (loaded
// BEFORE this script).  That module owns the `socket` and
// `BACKEND_URL` globals — never duplicate them here.
// ============================================================

// Grab the shared socket + backend URL created by websocket.js
const socket = window.socket;
const BACKEND_URL = window.QUIZLIVE_BACKEND_URL;

// ------------------------------------------------------------
// 1. HOST: hostGame(quizId)
// Dispatches 'host-create-lobby', captures the generated PIN,
// saves it to localStorage, and redirects to the waiting room.
// ------------------------------------------------------------

function hostGame(quizId) {
    if (!quizId) {
        console.error('[QuizLive] hostGame requires a quizId.');
        return;
    }

    console.log('[QuizLive] Hosting quiz:', quizId);

    // Listen for the standardized 'lobby-created' response from the server
    socket.once('lobby-created', async (response) => {
        if (!response || !response.success) {
            alert('Failed to create a lobby: ' + (response?.error || 'Unknown error.'));
            return;
        }

        const pin = response.pin;

        // Save the PIN for the waiting room / lobby screens to read
        localStorage.setItem('quizlive_pin', pin);
        localStorage.setItem('quizlive_quizId', quizId);
        localStorage.setItem('quizlive_isHost', 'true');

        // Secret that lets the waiting-room page reclaim this lobby with its
        // own fresh socket after navigation (page changes always drop the
        // socket that created the lobby).
        if (response.hostToken) {
            localStorage.setItem('quizlive_hostToken', response.hostToken);
        }

        console.log('[QuizLive] Lobby created with PIN:', pin);

        // Fetch the current local network IP from the backend so the QR code
        // works on any Wi-Fi without hardcoding an address.
        let joinUrl;
        try {
            const ipRes = await fetch(`${BACKEND_URL}/api/network-ip`);
            const ipData = await ipRes.json();
            const dynamicIp = ipData.ip || '127.0.0.1';
            joinUrl = `http://${dynamicIp}:3000/join-quiz.html?pin=${pin}`;
        } catch (_) {
            // Fallback if the endpoint is unreachable
            joinUrl = `http://${window.location.hostname}:3000/join-quiz.html?pin=${pin}`;
        }

        // Store it so the waiting room can render the QR code after redirect
        localStorage.setItem('quizlive_joinUrl', joinUrl);

        // Redirect the host to the waiting room
        window.location.href = 'waiting-room.html';
    });

    // Dispatch the 'host-create-lobby' event with the quizId payload
    socket.emit('host-create-lobby', { quizId });
}

// ------------------------------------------------------------
// 2. PLAYER: joinLobby(pin, nickname)
// Dispatches 'player-join-lobby', redirects on success,
// or alerts when the PIN is invalid / nickname taken.
// ------------------------------------------------------------

function joinLobby(pin, nickname) {
    // Normalize the PIN to a trimmed string so a numeric input value matches
    // the string PIN the server stores for each lobby.
    pin = pin !== undefined && pin !== null ? String(pin).trim() : pin;

    if (!pin || !nickname) {
        alert('Please enter both a PIN and a nickname.');
        return;
    }

    console.log('[QuizLive] Joining lobby', pin, 'as', nickname);

    // Listen for the standardized 'join-success' response from the server
    socket.once('join-success', (response) => {
        if (!response || !response.success) {
            // Invalid PIN or nickname already taken
            alert((response && response.error) || 'Unable to join the lobby.');
            return;
        }

        // Save player session details
        localStorage.setItem('quizlive_pin', pin);
        localStorage.setItem('quizlive_username', nickname);
        localStorage.setItem('quizlive_isHost', 'false');

        // Rejoin token lets this player reclaim their spot (score, answer
        // state, shuffled layout) after a page refresh or dropped connection.
        if (response.rejoinToken) {
            localStorage.setItem('quizlive_rejoinToken', response.rejoinToken);
        }

        console.log('[QuizLive] Successfully joined lobby:', pin);

        // Hand the joined player back to the page that dispatched this call
        // instead of hard-redirecting. join-quiz.html listens for
        // 'quizlive:joined' and paints the "You're in — wait for the host"
        // confirmation screen; the page is itself responsible for moving on
        // once the server broadcasts 'game-started'. (Not notifying the page
        // would leave the join button spinning forever.)
        document.dispatchEvent(new CustomEvent('quizlive:joined', {
            detail: { pin, username: nickname, rejoinToken: response.rejoinToken || null }
        }));
    });

    // Dispatch the 'player-join-lobby' event with the room code and username.
    // The PIN is passed as an immediate connection callback payload so the
    // packet is sent the moment the socket is ready and never fires blank.
    const dispatchJoin = () => {
        socket.emit('player-join-lobby', { pin, username: nickname });
    };

    if (socket.connected) {
        // Already connected — send the join packet right away.
        dispatchJoin();
    } else {
        // Not connected yet: (re)initialize the connection and send the room
        // PIN the instant the socket comes online so no empty payload is sent.
        console.log('[QuizLive] Socket not connected, initializing connection...');
        socket.connect();

        socket.once('connect', dispatchJoin);
        socket.once('connect_error', () => {
            alert('Cannot reach the server. Is the backend running on port 3000?');
        });
    }
}

// ------------------------------------------------------------
// 3. LIVE PLAYER SYNCED LOBBY LISTENER
// Renders the room's player list in real time on the
// waiting-room.html page (DOM element ID: "playerList").
// ------------------------------------------------------------

socket.on('player-list-update', (data) => {
    const players = data?.players || [];

    console.log('[QuizLive] Player list updated:', players);

    // Only render if we are on the waiting room page
    if (!isWaitingRoomPage()) {
        return;
    }

    // Keep the "N player(s) joined" counter in sync with the roster
    const counterEl = document.getElementById('playerCounter');
    if (counterEl) {
        counterEl.textContent = players.length;
    }

    const playerListEl = document.getElementById('playerList');

    if (!playerListEl) {
        console.warn('[QuizLive] #playerList element not found on page.');
        return;
    }

    renderPlayerList(playerListEl, players);
});

// Helper: detect the waiting room page
function isWaitingRoomPage() {
    const path = window.location.pathname.toLowerCase();
    return path.includes('waiting-room.html');
}

// Helper: render the array of players into the list element
function renderPlayerList(container, players) {
    container.innerHTML = '';

    if (!players || players.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'text-slate-500 text-center py-4';
        empty.textContent = 'No players joined yet.';
        container.appendChild(empty);
        return;
    }

    players.forEach((player) => {
        const li = document.createElement('li');
        li.className = 'flex items-center justify-between px-4 py-3 bg-slate-800 rounded-lg border border-slate-700';

        // Player identity
        const info = document.createElement('div');
        info.className = 'flex items-center gap-3';

        // Avatar (initial letter)
        const avatar = document.createElement('span');
        avatar.className = 'w-9 h-9 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center text-white font-bold text-sm';
        avatar.textContent = (player.username || '?').charAt(0).toUpperCase();
        info.appendChild(avatar);

        // Username
        const name = document.createElement('span');
        name.className = 'font-semibold text-white';
        name.textContent = player.username || 'Unknown';
        info.appendChild(name);

        li.appendChild(info);

        // Host / player badge
        const badge = document.createElement('span');
        if (player.isHost) {
            badge.className = 'text-xs font-bold px-2 py-1 rounded-full bg-cyan-500/20 text-cyan-400 border border-cyan-500/30';
            badge.textContent = 'HOST';
        } else {
            badge.className = 'text-xs font-medium px-2 py-1 rounded-full bg-slate-700 text-slate-300';
            badge.textContent = 'PLAYER';
        }
        li.appendChild(badge);

        container.appendChild(li);
    });
}

// ------------------------------------------------------------
// 4. HOST: reclaimLobby()
// Re-binds the host's fresh page socket to the lobby that the
// previous page created. Called on waiting-room.html (and any
// later host screen) load. Without this, the lobby would be
// orphaned by the page navigation that dropped its creator.
// ------------------------------------------------------------

function reclaimLobby() {
    const pin = localStorage.getItem('quizlive_pin');
    const hostToken = localStorage.getItem('quizlive_hostToken');
    const isHost = localStorage.getItem('quizlive_isHost') === 'true';

    if (!isHost || !pin || !hostToken) return;

    console.log('[QuizLive] Reclaiming lobby', pin);

    const attempt = () => {
        socket.emit('host-reclaim-lobby', { pin, hostToken }, (response) => {
            if (response && response.success) {
                console.log('[QuizLive] Lobby reclaimed by', socket.id);
            } else {
                console.warn('[QuizLive] Lobby reclaim failed:', response?.error || 'no response');
            }
        });
    };

    if (socket.connected) {
        attempt();
    } else {
        socket.once('connect', attempt);
    }
}

// ------------------------------------------------------------
// 5. PLAYER: tryRejoinLobby()
// Attempts to reclaim a mid-game player's spot using the stored
// PIN + rejoinToken (from a prior join). The server replays the
// current game state back to this socket. Routes the player to
// the correct screen based on the replayed state.
// ------------------------------------------------------------

function tryRejoinLobby() {
    const pin = localStorage.getItem('quizlive_pin');
    const rejoinToken = localStorage.getItem('quizlive_rejoinToken');
    const isHost = localStorage.getItem('quizlive_isHost') === 'true';

    // Only players who have joined before and kept their token can rejoin.
    if (isHost || !pin || !rejoinToken) return;

    console.log('[QuizLive] Attempting to rejoin lobby', pin);

    const attempt = () => {
        socket.emit('player-rejoin-lobby', { pin, rejoinToken }, (response) => {
            if (!response || !response.success) {
                // Token expired/invalid — fall back to a fresh join screen.
                console.warn('[QuizLive] Rejoin failed:', response?.error || 'no response');
                return;
            }
            console.log('[QuizLive] Rejoined lobby, gameState =', response.gameState);

            const here = window.location.pathname.toLowerCase();
            const onArena = here.includes('live-quiz.html');
            const onResults = here.includes('results.html');

            switch (response.gameState) {
                case 'question':
                case 'review':
                    // A question is live — make sure we're on the arena page.
                    if (!onArena) window.location.href = 'live-quiz.html';
                    break;
                case 'finished':
                    // The server replays either 'game-finished' (wait for the
                    // host to reveal results) or 'show-results' (already
                    // revealed). Both are handled by live-quiz.html, which
                    // stores the leaderboard and navigates to results.html
                    // when appropriate — so make sure we're on the arena page.
                    if (!onArena) window.location.href = 'live-quiz.html';
                    break;
                case 'lobby':
                default:
                    // Still in the lobby; the waiting room already renders us.
                    break;
            }
        });
    };

    if (socket.connected) {
        attempt();
    } else {
        socket.once('connect', attempt);
    }
}

// ------------------------------------------------------------
// Auto-rejoin: if this page loaded while a player had a stored
// rejoin token (e.g. a refresh or reconnect mid-game), try to get
// them back into their spot. Skips the results screen to avoid a
// redirect loop after the game has ended.
// ------------------------------------------------------------
(function autoRejoinOnLoad() {
    const path = window.location.pathname.toLowerCase();
    if (path.includes('results.html') || path.includes('join-quiz.html')) return;
    if (localStorage.getItem('quizlive_isHost') === 'true') return;
    if (localStorage.getItem('quizlive_rejoinToken')) {
        // Wait for the socket to be up; tryRejoinLobby handles the rest.
        tryRejoinLobby();
    }
})();

// ------------------------------------------------------------
// Expose the API globally so inline onclick handlers can call it
// ------------------------------------------------------------

window.hostGame = hostGame;
window.joinLobby = joinLobby;
window.reclaimLobby = reclaimLobby;
window.tryRejoinLobby = tryRejoinLobby;
