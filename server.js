// Multiplayer relay server for "Удивительное измерение".
//
// CURRENT (foundation): rooms + lobby + player position broadcast + level sync.
// The server is a dumb relay; nothing here is authoritative.
//
// =====================================================================
// TODO — Phase 2: Host-authoritative shared world
// =====================================================================
// To implement #4-#11 from the Spec (shared NPC/trains/lamps/darkness, late-join
// snapshots, target-switch on Squidward, etc.) the architecture should change as
// follows. This is a multi-day refactor — leaving the plan here so the next pass
// starts from solid ground instead of re-deriving it.
//
//   1. Server stays a relay (no game logic here). Authority lives on the host
//      browser — it runs the existing single-player update() loop.
//
//   2. New message: { type: 'snapshot', t, players, npcs, trains, lamps, dark, kgb,
//                     unidentified, codeRound, level } sent by host at 15-20 Hz.
//      Server forwards to all clients verbatim.
//
//   3. Client side (game.html):
//      a) When connected as a CLIENT, the local update() must not simulate NPCs,
//         trains, lamps, KGB gaze, or unidentified — those come from snapshots.
//         The client still runs its own player input/movement and sends pos to host.
//      b) Replace direct enms[]/specs[]/trains[] mutation in update() with a
//         "world state" object that is either filled by simulation (host) or by
//         applying the latest snapshot (client). Two arrays per entity type:
//             world.npcs       (authoritative)
//             world.npcs_disp  (interpolated render copy)
//         On snapshot arrival, push into a small buffer (last 3-4 snapshots) and
//         interpolate world.npcs_disp at (now - 100ms) using two adjacent snapshots.
//
//   4. Late-join: when a client joins, server asks the host for a fresh snapshot
//      (new message { type: 'snapshot_request', for: <clientId> }), host replies
//      with a one-time { type: 'snapshot_full', to: <clientId>, ... }, server
//      relays only to that client. From then on the regular 15-20 Hz feed covers it.
//
//   5. Player input from clients: { type: 'input', keys: { up:bool, down:bool, ... } }
//      sent at 30 Hz to host. Host applies these to remote-player avatars in its
//      own simulation, runs collision/contacts there, broadcasts via snapshot. The
//      "pos" message used today becomes deprecated once full sync lands — keep it
//      around during transition for backward-compat.
//
//   6. Trains scaling: host's spawn loop counts active players and spawns one
//      train per player, each biased to a different player's row/col so they
//      don't all stack on the same lane. (Already partly implemented client-side
//      — needs to move to host once #3 is done.)
//
//   7. Squidward L20: already does target-switch with 1.5s cooldown locally.
//      In host-authoritative mode the same logic runs ONLY on the host; the
//      target id ends up in the snapshot for clients to render the chase line.
//
//   8. L20/L21 are special: bossfight (intro49 / 49s freeze) and dialog scene
//      should probably stay single-player for the host only, with clients seeing
//      a "host is in cutscene" message. Mixing co-op into those scenes is its
//      own design problem and should not block the rest of the sync work.
//
// Until Phase 2 lands, each client simulates its own world locally — that's why
// nick/color/level can be synced (all foundation), but two clients see different
// NPC positions. This is by design for the foundation milestone.
// =====================================================================
//
// HOW TO RUN (Windows / macOS / Linux, requires Node.js installed):
//   1) cd to this folder (where server.js sits)
//   2) npm init -y                 (if you've never run Node here)
//   3) npm install ws              (installs the WebSocket library)
//   4) node server.js              (starts the server on ws://localhost:8080)
//
// Then in the game's "Мультиплеер" menu, host clicks "Создать", clients enter the same
// 4-letter code under "Подключиться к коду".
//
// The server only relays messages between the host and clients of the same room — it
// does NOT validate game state. Authority lives on the host's browser (their game runs
// the simulation; clients display + send their own input/position).

'use strict';

let WebSocketServer;
try { WebSocketServer = require('ws').Server; }
catch (e) {
  // When required from Electron main, we DON'T want to kill the whole app — just log
  // and bail. The game UI will surface "Сервер не ответил" if the user tries to host.
  console.error('[server] The "ws" package is missing. Multiplayer disabled.');
  if (require.main === module) process.exit(1);
  return; // (in CJS top-level, require() callers see a module with no exports)
}

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
// In the cloud (free hosts inject PORT) bind all interfaces. Locally leave the
// default dual-stack bind so ws://localhost:8080 keeps working on Windows (::1).
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : undefined);
// Public-server hygiene — keep one abusive client from exhausting the relay.
const MAX_ROOMS = 1000;            // total concurrent rooms
const MAX_PLAYERS_PER_ROOM = 8;    // clients per room (host not counted)
const MAX_MSGS_PER_SEC = 80;       // per-connection flood guard

// rooms[code] = { host: WebSocket, clients: Map<id, WebSocket>, level, seed }
const rooms = Object.create(null);

// Minimal HTTP server so free hosts (Render/Railway/Fly) that health-check over
// HTTP get a 200, and so a browser opening the URL sees a friendly status line.
// The WebSocket server shares this same HTTP server / port (no separate port).
const http = require('http');
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Udivitelnoe izmerenie — MP relay is up. Active rooms: ' + Object.keys(rooms).length);
});
// EADDRINUSE here when another local instance already owns the port — idle quietly.
httpServer.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.warn('[server] Port ' + PORT + ' already in use — another instance is hosting. This process will idle.');
  } else {
    console.error('[server] HTTP server error:', err && err.message);
  }
});

let wss;
try {
  wss = new WebSocketServer({ server: httpServer, maxPayload: 64 * 1024 }); // 64KB/msg cap
} catch (err) {
  console.error('[server] Failed to create WebSocketServer:', err.message);
  if (require.main === module) process.exit(1);
  return;
}
wss.on('error', (err) => { console.error('[server] WebSocketServer error:', err && err.message); });

httpServer.listen(PORT, HOST, () => {
  console.log('[server] Listening on port ' + PORT + (HOST ? ' (' + HOST + ')' : '') + ' — ws + http');
});

function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // unambiguous chars
  let s = '';
  for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

function send(sock, msg) {
  if (sock && sock.readyState === 1) {
    try { sock.send(JSON.stringify(msg)); } catch (e) {}
  }
}

function broadcastRoom(room, msg, exclude) {
  if (room.host && room.host !== exclude) send(room.host, msg);
  for (const c of room.clients.values()) if (c !== exclude) send(c, msg);
}

function leaveRoom(sock) {
  const code = sock._roomCode;
  if (!code) return;
  const room = rooms[code];
  if (!room) return;
  if (sock === room.host) {
    // Host drop → close room and notify clients
    for (const c of room.clients.values()) send(c, { type: 'host_left' });
    delete rooms[code];
    console.log('[server] Room ' + code + ' closed (host left)');
  } else {
    room.clients.delete(sock._playerId);
    broadcastRoom(room, { type: 'player_left', id: sock._playerId });
    console.log('[server] Player ' + sock._playerId + ' left ' + code);
  }
  sock._roomCode = null;
  sock._playerId = null;
}

wss.on('connection', (sock) => {
  sock.on('message', (raw) => {
    // Flood guard — drop anything beyond MAX_MSGS_PER_SEC on this connection.
    const _now = Date.now();
    if (!sock._rlT || _now - sock._rlT >= 1000) { sock._rlT = _now; sock._rlN = 0; }
    if (++sock._rlN > MAX_MSGS_PER_SEC) return;
    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!m || typeof m.type !== 'string') return;

    if (m.type === 'create') {
      if (Object.keys(rooms).length >= MAX_ROOMS) { send(sock, { type: 'error', msg: 'сервер переполнен, попробуйте позже' }); return; }
      let code = makeCode();
      while (rooms[code]) code = makeCode();
      rooms[code] = { host: sock, clients: new Map(), level: 1, seed: 0 };// seed: общий seed карты текущего уровня (для late-join)
      sock._roomCode = code;
      sock._playerId = 'host';
      sock._name = (m.name || 'Хост').slice(0, 24);
      send(sock, { type: 'created', code, id: 'host' });
      console.log('[server] Room ' + code + ' created by ' + sock._name);
      return;
    }

    if (m.type === 'join') {
      const code = (m.code || '').toUpperCase();
      const room = rooms[code];
      if (!room) { send(sock, { type: 'error', msg: 'комната не найдена' }); return; }
      if (room.clients.size >= MAX_PLAYERS_PER_ROOM) { send(sock, { type: 'error', msg: 'комната заполнена' }); return; }
      const id = 'p' + Math.random().toString(36).slice(2, 7);
      room.clients.set(id, sock);
      sock._roomCode = code;
      sock._playerId = id;
      sock._name = (m.name || 'Игрок').slice(0, 24);
      send(sock, { type: 'joined', code, id, level: room.level, seed: room.seed });// ★ seed → late-join строит ту же карту
      broadcastRoom(room, { type: 'player_joined', id, name: sock._name }, sock);
      console.log('[server] ' + sock._name + ' joined ' + code + ' as ' + id);
      return;
    }

    // Relay from a connected player
    const room = sock._roomCode ? rooms[sock._roomCode] : null;
    if (!room) return;

    if (m.type === 'pos') {
      // Relay position + light player state to others in the room. hearts/alive/downed/heldItem ride
      // along so co-op HUD, spectator/downed flags and held-item render stay live without extra events.
      broadcastRoom(room, { type: 'pos', id: sock._playerId, x: m.x, y: m.y, name: sock._name,
                            hearts: m.hearts, alive: m.alive, downed: m.downed, heldItem: m.heldItem }, sock);
      return;
    }

    if (m.type === 'level') {
      // Only the host may change the room's level
      if (sock !== room.host) return;
      room.level = m.level | 0;
      room.seed = (m.seed >>> 0) || room.seed;// ★ запоминаем seed уровня (для late-join + ресинка)
      broadcastRoom(room, { type: 'level', level: room.level, seed: room.seed }, sock);
      return;
    }

    if (m.type === 'event') {
      // Forward arbitrary game events (item use, door, etc.) — used by future iterations
      broadcastRoom(room, { type: 'event', id: sock._playerId, payload: m.payload }, sock);
      return;
    }

    // Host-only train state — relay snapshot list and one-shot audio events to all clients.
    // This is the first vertical slice of host-authoritative sync: only trains, nothing else.
    if (m.type === 'trains' || m.type === 'train_event') {
      if (sock !== room.host) return;
      broadcastRoom(room, m, sock);
      return;
    }
  });

  sock.on('close', () => leaveRoom(sock));
  sock.on('error', () => leaveRoom(sock));
});
