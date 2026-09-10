// Bisect stage runner — placed in backend/ so node_modules resolves.
// Stage 1: express only. Stage 2: + cors. Stage 3: + socket.io. Stage 4: + database.
const express = require('express');
const http = require('http');

let stage = +process.argv[2] || 1;
const PORT = 3450 + stage;
const app = express();

if (stage >= 2) {
  const cors = require('cors');
  const allowedOriginPattern = new RegExp(`^http://[^:/]+:${3000}$`);
  const isOriginAllowed = (origin) => (!origin ? true : allowedOriginPattern.test(origin));
  app.use(cors({ origin: isOriginAllowed, credentials: true }));
  console.log('   cors middleware loaded');
}
if (stage >= 3) {
  const { Server } = require('socket.io');
  const io = new Server(http.createServer(app), { cors: { origin: true } });
  io.on('connection', () => {});
  console.log('   socket.io loaded');
}
if (stage >= 4) {
  const database = require('./database');
  app.get('/api/health', (q, r) => r.json({ ok: true, db: !!database }));
  console.log('   database loaded');
} else {
  app.get('/api/health', (q, r) => r.json({ ok: true }));
}

const srv = http.createServer(app);
srv.listen(PORT, async () => {
  console.log(`stage ${stage}: up on ${PORT}`);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 3000);
  const start = Date.now();
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: ac.signal });
    console.log(`   probe: ${r.status} in ${Date.now() - start}ms`);
  } catch (e) {
    console.log(`   probe: ${e.name} ${e.code || ''} in ${Date.now() - start}ms`);
  } finally {
    clearTimeout(t);
    srv.close();
    process.exit(0);
  }
});