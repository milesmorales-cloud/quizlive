// ============================================================
// QuizLive - Frontend static server (replaces `npx serve`)
// Serves the frontend/ directory with Cache-Control: no-store
// so phones and the host always load the latest HTML/JS. This
// prevents stale cached pages (e.g. a cached join-quiz.html that
// predates PIN auto-fill) from breaking the QR join flow.
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = path.normalize(__dirname);

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

http.createServer((req, res) => {
    // Only serve static files via GET (and HEAD for curl checks).
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', Allow: 'GET, HEAD' });
        res.end('Method Not Allowed');
        return;
    }

    // Resolve the requested path (ignore query strings).
    let pathname = decodeURIComponent((req.url || '/').split('?')[0]);
    if (pathname === '/' || pathname === '') {
        pathname = '/teacher-dashboard.html';
    }

    const filePath = path.normalize(path.join(ROOT, pathname));

    // Path traversal guard: reject anything that escapes the frontend dir.
    if (!filePath.startsWith(ROOT)) {
        res.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        res.end('Forbidden');
        return;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            console.log(`[${new Date().toISOString()}] 404 ${req.method} ${pathname}`);
            res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
            res.end('Not Found');
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        console.log(`[${new Date().toISOString()}] 200 ${req.method} ${pathname}`);
        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Cache-Control': 'no-store, max-age=0'
        });
        res.end(data);
    });
}).listen(PORT, () => {
    console.log(`QuizLive frontend running at http://localhost:${PORT} (no-store)`);
});