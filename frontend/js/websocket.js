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

    // Use the same origin that served this page.
    // This works for local development, LAN access, and cloud deployment.
    const BACKEND_URL = window.location.origin;

    // Frontend origin used for CORS allow-listing on the server side.
    const FRONTEND_ORIGIN = window.location.origin;

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
