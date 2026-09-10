// ============================================================
// QuizLive - WebSocket / Socket.IO Client
// Single source of truth for the real-time connection.
//
// The whole app — static pages, REST API, and Socket.IO — runs on
// ONE port (3000). The client connects to the same host/port it
// was loaded from, so nothing is hardcoded and QR scans over Wi-Fi
// work automatically.
// ============================================================

(function () {
    'use strict';

    // Resolve the backend URL from the browser's current hostname and port
    // so phones on the same Wi-Fi automatically reach the server. Both the
    // API and WebSocket live on port 3000 (same origin as the page).
    const BACKEND_URL = `http://${window.location.hostname}:3000`;

    // Frontend origin used for CORS allow-listing on the server side.
    // Everything is on port 3000 now, so the origin is always that port.
    const FRONTEND_ORIGIN = `http://${window.location.hostname}:3000`;

    // Connect to the backend Socket.IO server
    const socket = io(BACKEND_URL, {
        transports: ['websocket', 'polling'],
        // Explicit origin so the server CORS check can validate it
        extraHeaders: {
            Origin: FRONTEND_ORIGIN
        }
    });

    // Expose globally so every page can use them
    window.QUIZLIVE_BACKEND_URL = BACKEND_URL;
    window.QUIZLIVE_FRONTEND_ORIGIN = FRONTEND_ORIGIN;
    window.socket = socket;

    // ------------------------------------------------------------
    // Connection lifecycle
    // ------------------------------------------------------------

    socket.on('connect', () => {
        console.log('[QuizLive] Connected to server:', socket.id);
        console.log('[QuizLive] Backend:', BACKEND_URL, '| Origin:', FRONTEND_ORIGIN);
    });

    socket.on('connect_error', (err) => {
        console.error('[QuizLive] Connection error:', err.message);
    });

    socket.on('disconnect', (reason) => {
        console.warn('[QuizLive] Disconnected:', reason);
    });
})();
