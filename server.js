//=============================================================================
//  VXU Smart Server v3.0 — Game Relay + Web Dashboard
//=============================================================================
//  Supports TWO game connection modes simultaneously:
//    • TCP (port 7771)  — Low latency, for LAN play
//    • HTTP API (same port as dashboard) — Works through any firewall,
//      deployable to Render.com / Railway / any cloud host
//
//  Both modes share the same game state. A TCP player and an HTTP player
//  can see each other on the same server.
//
//  SETUP:
//    npm install
//    node server.js
//    Open http://localhost:3000 for the admin dashboard
//
//  DEPLOYMENT (Render.com):
//    1. Push to GitHub
//    2. Create a new Web Service on Render
//    3. Set Build Command: npm install
//    4. Set Start Command: node server.js
//    5. Set Environment Variable: PUBLIC_URL = https://your-app.onrender.com
//    6. Done! Players select "Public Servers" in-game to connect.
//=============================================================================

const net = require('net');
const http = require('http');
const crypto = require('crypto');
const os = require('os');

// ─── CONFIGURATION ──────────────────────────────────────────────────────
const GAME_PORT = parseInt(process.env.GAME_PORT) || 7771;
const WEB_PORT = parseInt(process.env.PORT) || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || null;  // e.g. "https://my-server.onrender.com"
const ADMIN_PASS = process.env.ADMIN_PASS || "admin";
const DELIM = '|';
const HTTP_TIMEOUT = 30000; // 30 seconds — drop HTTP clients that stop polling

// ─── STATE ──────────────────────────────────────────────────────────────
let nextId = 1;  // 0 = server/admin
const tcpClients = new Map();  // socket → { id, name, ip, char_name, char_idx, buffer }
const httpClients = new Map();  // token  → { id, name, ip, char_name, char_idx, lastPoll, queue[] }

let serverConfig = {
    name: "VXU Server",
    motd: "Welcome to VX Unchained Multiplayer!",
    maxPlayers: 20
};

// Simple logging
function log(msg) {
    const ts = new Date().toISOString().substr(11, 8);
    console.log(`[${ts}] ${msg}`);
}

// ─── PROTOCOL HELPERS ───────────────────────────────────────────────────
function encode(...parts) { return parts.join(DELIM) + '\n'; }
function decode(line) { return line.replace(/\r?\n$/, '').split(DELIM); }

function getPlayerCount() {
    let count = 0;
    for (const c of tcpClients.values()) if (c.id !== null) count++;
    for (const c of httpClients.values()) count++;
    return count;
}

function getAllPlayers() {
    const list = [];
    for (const c of tcpClients.values()) {
        if (c.id !== null) list.push(c);
    }
    for (const c of httpClients.values()) {
        list.push(c);
    }
    return list;
}

// Broadcast to all TCP clients + queue for all HTTP clients
function broadcast(data, excludeId) {
    for (const [sock, info] of tcpClients) {
        if (info.id === excludeId) continue;
        if (info.id === null) continue;
        try { sock.write(data); } catch (e) { }
    }
    for (const [token, info] of httpClients) {
        if (info.id === excludeId) continue;
        info.queue.push(data);
    }
}

// Broadcast to dashboard
let ioInstance = null;
function dashLog(msg) { if (ioInstance) ioInstance.emit('log', msg); }
function dashEvent(event, data) { if (ioInstance) ioInstance.emit(event, data); }

// Generate secure token for HTTP clients
function generateToken() {
    return crypto.randomBytes(16).toString('hex');
}

// ─── GET LOCAL IP ───────────────────────────────────────────────────────
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name in interfaces) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

// =========================================================================
//  TCP GAME SERVER (for LAN play)
// =========================================================================
const gameServer = net.createServer((socket) => {
    const clientIP = (socket.remoteAddress || '').replace('::ffff:', '');
    log(`TCP Connect: ${clientIP}`);

    tcpClients.set(socket, {
        id: null, name: "Connecting...", ip: clientIP,
        char_name: "", char_idx: 0, buffer: ""
    });

    socket.setNoDelay(true);

    socket.on('data', (data) => {
        const info = tcpClients.get(socket);
        if (!info) return;
        info.buffer += data.toString('ascii');
        let idx;
        while ((idx = info.buffer.indexOf('\n')) !== -1) {
            const line = info.buffer.substring(0, idx + 1);
            info.buffer = info.buffer.substring(idx + 1);
            handleTcpMessage(socket, info, line);
        }
        if (info.buffer.length > 4096) socket.destroy();
    });

    socket.on('close', () => {
        const info = tcpClients.get(socket);
        if (info && info.id !== null) {
            broadcast(encode('DELPLAYER', info.id), info.id);
            log(`TCP Left: ${info.name} (ID ${info.id})`);
            dashLog(`Player Left: ${info.name}`);
            dashEvent('player_left', info.id);
        }
        tcpClients.delete(socket);
        dashEvent('update_counts', { current: getPlayerCount(), max: serverConfig.maxPlayers });
    });

    socket.on('error', () => { });
});

function handleTcpMessage(socket, info, line) {
    const parts = decode(line);
    if (parts.length === 0) return;

    switch (parts[0]) {
        case 'JOIN': {
            if (getPlayerCount() >= serverConfig.maxPlayers) { socket.end(); return; }
            const id = nextId++;
            info.id = id;
            info.name = parts[1] || 'Player';
            info.char_name = parts[2] || '';
            info.char_idx = parseInt(parts[3]) || 0;

            socket.write(encode('WELCOME', id, serverConfig.name));
            socket.write(encode('CHAT', 0, 'Server', serverConfig.motd));

            // Send all existing players (TCP + HTTP) to new client
            for (const p of getAllPlayers()) {
                if (p.id === id) continue;
                socket.write(encode('ADDPLAYER', p.id, p.name, p.char_name, p.char_idx));
            }

            // Announce new player to everyone else
            broadcast(encode('ADDPLAYER', id, info.name, info.char_name, info.char_idx), id);

            log(`TCP Join: ${info.name} (ID ${id})`);
            dashLog(`Player Joined: ${info.name} (TCP, ID: ${id})`);
            dashEvent('player_join', { id, name: info.name, ip: info.ip, mode: 'TCP' });
            dashEvent('update_counts', { current: getPlayerCount(), max: serverConfig.maxPlayers });
            break;
        }
        case 'POS': {
            if (info.id === null || parts.length < 8) return;
            info.char_name = parts[6];
            info.char_idx = parseInt(parts[7]) || 0;
            broadcast(encode('POS', info.id, parts[1], parts[2], parts[3], parts[4], parts[5], parts[6], parts[7]), info.id);
            break;
        }
        case 'CHAT': {
            if (info.id === null || parts.length < 2) return;
            const chatPkt = encode('CHAT', info.id, info.name, parts[1]);
            broadcast(chatPkt);
            dashEvent('chat', { name: info.name, msg: parts[1] });
            break;
        }
    }
}

// =========================================================================
//  HTTP GAME API (for internet play — works on Render.com etc.)
// =========================================================================
//  POST /api/join   body: NAME|CHAR_NAME|CHAR_IDX    → WELCOME|id|name|token
//  POST /api/sync   body: TOKEN|MAP|X|Y|DIR|SPD|CN|CI → queued messages
//  POST /api/leave  body: TOKEN                       → OK
//  POST /api/chat   body: TOKEN|MESSAGE               → OK
//  GET  /api/list   → server info (pipe delimited)
// =========================================================================

function parseBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
            if (body.length > 4096) { resolve(null); req.destroy(); }
        });
        req.on('end', () => resolve(body));
    });
}

// Get body from either POST body or GET ?d= query parameter
function getBody(req) {
    const urlObj = require('url').parse(req.url, true);
    if (req.method === 'GET' && urlObj.query.d) {
        return Promise.resolve(decodeURIComponent(urlObj.query.d));
    }
    return parseBody(req);
}

// Extract the path without query string
function getPath(url) {
    const idx = url.indexOf('?');
    return idx >= 0 ? url.substring(0, idx) : url;
}

function handleApiJoin(req, res) {
    getBody(req).then(body => {
        if (!body) { res.writeHead(400); res.end('Bad request'); return; }

        if (getPlayerCount() >= serverConfig.maxPlayers) {
            res.writeHead(503); res.end('Server full'); return;
        }

        const parts = body.split(DELIM);
        const id = nextId++;
        const token = generateToken();
        const clientIP = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').replace('::ffff:', '');

        const clientInfo = {
            id, token,
            name: parts[0] || 'Player',
            ip: clientIP,
            char_name: parts[1] || '',
            char_idx: parseInt(parts[2]) || 0,
            lastPoll: Date.now(),
            queue: []
        };

        httpClients.set(token, clientInfo);

        // Queue messages: welcome, motd, existing players
        let response = encode('WELCOME', id, serverConfig.name, token);
        response += encode('CHAT', 0, 'Server', serverConfig.motd);

        for (const p of getAllPlayers()) {
            if (p.id === id) continue;
            response += encode('ADDPLAYER', p.id, p.name, p.char_name, p.char_idx);
        }

        // Announce to everyone else
        broadcast(encode('ADDPLAYER', id, clientInfo.name, clientInfo.char_name, clientInfo.char_idx), id);

        log(`HTTP Join: ${clientInfo.name} (ID ${id})`);
        dashLog(`Player Joined: ${clientInfo.name} (HTTP, ID: ${id})`);
        dashEvent('player_join', { id, name: clientInfo.name, ip: clientIP, mode: 'HTTP' });
        dashEvent('update_counts', { current: getPlayerCount(), max: serverConfig.maxPlayers });

        res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end(response);
    });
}

function handleApiSync(req, res) {
    getBody(req).then(body => {
        if (!body) { res.writeHead(400); res.end('Bad'); return; }

        const parts = body.split(DELIM);
        if (parts.length < 1) { res.writeHead(400); res.end('Bad'); return; }

        const token = parts[0];
        const info = httpClients.get(token);
        if (!info) { res.writeHead(401); res.end('Invalid token'); return; }

        info.lastPoll = Date.now();

        // Process position if included (token|map|x|y|dir|spd|cn|ci)
        if (parts.length >= 8) {
            info.char_name = parts[6];
            info.char_idx = parseInt(parts[7]) || 0;
            broadcast(
                encode('POS', info.id, parts[1], parts[2], parts[3], parts[4], parts[5], parts[6], parts[7]),
                info.id
            );
        }

        // Flush queued messages to this client
        const messages = info.queue.join('');
        info.queue = [];

        res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end(messages);
    });
}

function handleApiChat(req, res) {
    getBody(req).then(body => {
        if (!body) { res.writeHead(400); res.end('Bad'); return; }
        const parts = body.split(DELIM);
        if (parts.length < 2) { res.writeHead(400); res.end('Bad'); return; }

        const token = parts[0];
        const info = httpClients.get(token);
        if (!info) { res.writeHead(401); res.end('Invalid token'); return; }

        info.lastPoll = Date.now();
        const chatPkt = encode('CHAT', info.id, info.name, parts[1]);
        broadcast(chatPkt);
        dashEvent('chat', { name: info.name, msg: parts[1] });

        res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end('OK');
    });
}

function handleApiLeave(req, res) {
    getBody(req).then(body => {
        if (!body) { res.writeHead(400); res.end('Bad'); return; }
        const token = body.trim();
        const info = httpClients.get(token);
        if (info) {
            broadcast(encode('DELPLAYER', info.id), info.id);
            log(`HTTP Left: ${info.name} (ID ${info.id})`);
            dashLog(`Player Left: ${info.name}`);
            dashEvent('player_left', info.id);
            httpClients.delete(token);
            dashEvent('update_counts', { current: getPlayerCount(), max: serverConfig.maxPlayers });
        }
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end('OK');
    });
}

function handleApiList(req, res) {
    const count = getPlayerCount();
    // Determine what IP to show
    let displayIP;
    if (PUBLIC_URL) {
        // Cloud deployment — show the public URL (strip protocol for game client)
        displayIP = PUBLIC_URL.replace(/^https?:\/\//, '');
    } else {
        displayIP = getLocalIP();
    }
    const port = PUBLIC_URL ? 443 : GAME_PORT;
    const mode = PUBLIC_URL ? 'HTTP' : 'TCP';

    // Format: NAME|IP_OR_HOST|PORT|CURRENT|MAX|MODE
    const data = `${serverConfig.name}|${displayIP}|${port}|${count}|${serverConfig.maxPlayers}|${mode}`;
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end(data);
}

// ─── HTTP TIMEOUT CLEANUP ───────────────────────────────────────────────
setInterval(() => {
    const now = Date.now();
    for (const [token, info] of httpClients) {
        if (now - info.lastPoll > HTTP_TIMEOUT) {
            broadcast(encode('DELPLAYER', info.id), info.id);
            log(`HTTP Timeout: ${info.name} (ID ${info.id})`);
            dashLog(`Player Timed Out: ${info.name}`);
            dashEvent('player_left', info.id);
            httpClients.delete(token);
            dashEvent('update_counts', { current: getPlayerCount(), max: serverConfig.maxPlayers });
        }
    }
}, 10000);

// =========================================================================
//  WEB SERVER (Dashboard + HTTP API)
// =========================================================================
const httpServer = http.createServer((req, res) => {
    // ─── API Routes (accept both GET and POST for HTTPS compatibility) ──
    const path = getPath(req.url);
    if (path === '/api/join') { handleApiJoin(req, res); return; }
    if (path === '/api/sync') { handleApiSync(req, res); return; }
    if (path === '/api/chat') { handleApiChat(req, res); return; }
    if (path === '/api/leave') { handleApiLeave(req, res); return; }
    if (path === '/api/list') { handleApiList(req, res); return; }
    // Also support /list for backwards compat
    if (path === '/list') { handleApiList(req, res); return; }

    // ─── CORS preflight ─────────────────────────────────────────────
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        res.end();
        return;
    }

    // ─── Socket.IO client library ───────────────────────────────────
    // Let Socket.IO handle its own routes
    if (req.url.startsWith('/socket.io')) return;

    // ─── Dashboard ──────────────────────────────────────────────────
    if (req.method === 'GET' && (req.url === '/' || req.url === '/dashboard')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(dashboardHTML());
        return;
    }

    // ─── Health check (for Render.com) ──────────────────────────────
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
        return;
    }

    res.writeHead(404);
    res.end('Not found');
});

// ─── SOCKET.IO FOR DASHBOARD ────────────────────────────────────────────
let socketIoLoaded = false;
try {
    const { Server } = require('socket.io');
    ioInstance = new Server(httpServer);

    ioInstance.on('connection', (socket) => {
        socket.emit('config', serverConfig);
        socket.emit('update_counts', { current: getPlayerCount(), max: serverConfig.maxPlayers });

        const playerList = getAllPlayers().map(p => ({
            id: p.id, name: p.name, ip: p.ip || '?',
            mode: httpClients.has(p.token) ? 'HTTP' : 'TCP'
        }));
        socket.emit('full_player_list', playerList);

        socket.on('admin_kick', (id) => {
            // Kick from TCP
            for (const [sock, info] of tcpClients) {
                if (info.id === id) { sock.end(); break; }
            }
            // Kick from HTTP
            for (const [token, info] of httpClients) {
                if (info.id === id) {
                    broadcast(encode('DELPLAYER', info.id), info.id);
                    httpClients.delete(token);
                    dashEvent('player_left', info.id);
                    dashEvent('update_counts', { current: getPlayerCount(), max: serverConfig.maxPlayers });
                    break;
                }
            }
            dashLog(`Kicked player ID ${id}`);
        });

        socket.on('admin_chat', (msg) => {
            const pkt = encode('CHAT', 0, 'Admin', msg);
            broadcast(pkt);
            dashEvent('chat', { name: 'Admin', msg });
        });

        socket.on('update_config', (newConfig) => {
            serverConfig = { ...serverConfig, ...newConfig };
            ioInstance.emit('config', serverConfig);
            dashLog('Server configuration updated');
        });
    });

    socketIoLoaded = true;
} catch (e) {
    console.log('Socket.IO not available — dashboard will be static. Run: npm install');
}

// =========================================================================
//  STARTUP
// =========================================================================

// Start TCP server (for LAN play)
gameServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.log(`Note: TCP port ${GAME_PORT} already in use — TCP/LAN mode disabled.`);
        console.log('HTTP mode is still available for internet play.');
    }
});
gameServer.listen(GAME_PORT, '0.0.0.0', () => {
    console.log(`  TCP Game Server: port ${GAME_PORT} (LAN play)`);
});

// Start HTTP server (dashboard + HTTP API)
httpServer.listen(WEB_PORT, '0.0.0.0', () => {
    const localIP = getLocalIP();
    console.log('');
    console.log('====================================================');
    console.log('  VXU Smart Server v3.0');
    console.log('====================================================');
    console.log(`  Dashboard:    http://localhost:${WEB_PORT}`);
    console.log(`  HTTP Game API: http://localhost:${WEB_PORT}/api/`);
    console.log(`  TCP Game Port: ${GAME_PORT}`);
    console.log(`  Your LAN IP:   ${localIP}`);
    if (PUBLIC_URL) {
        console.log(`  Public URL:    ${PUBLIC_URL}`);
    }
    console.log('');
    console.log('  Server List URL (set this in VXU_Net.ini):');
    if (PUBLIC_URL) {
        console.log(`    ${PUBLIC_URL}/api/list`);
    } else {
        console.log(`    http://${localIP}:${WEB_PORT}/api/list`);
    }
    console.log('');
    console.log('  Waiting for players...');
    console.log('====================================================');
    console.log('');
});

// Graceful shutdown
process.on('SIGINT', () => {
    log('Shutting down...');
    for (const [sock] of tcpClients) sock.destroy();
    gameServer.close();
    httpServer.close(() => process.exit(0));
});

// =========================================================================
//  HTML DASHBOARD
// =========================================================================
function dashboardHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>VXU Server Admin</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        :root {
            --bg: #0f0f1a; --card: #1a1a2e; --card2: #16213e;
            --text: #e0e0e0; --muted: #8888aa;
            --accent: #00d4ff; --accent2: #7c3aed;
            --green: #22c55e; --red: #ef4444; --orange: #f59e0b;
            --border: #2a2a4a;
        }
        body {
            font-family: 'Segoe UI', system-ui, sans-serif;
            background: var(--bg);
            color: var(--text);
            padding: 20px;
            min-height: 100vh;
        }

        /* Header */
        .header {
            display: flex; justify-content: space-between; align-items: center;
            margin-bottom: 24px; padding-bottom: 16px;
            border-bottom: 1px solid var(--border);
        }
        .header h1 { font-size: 1.5em; color: var(--accent); }
        .status-badge {
            display: inline-flex; align-items: center; gap: 6px;
            padding: 4px 12px; border-radius: 20px;
            font-size: 0.85em; font-weight: 600;
        }
        .status-online { background: #22c55e22; color: var(--green); border: 1px solid #22c55e44; }

        /* Grid */
        .grid { display: grid; grid-template-columns: 1fr 320px; gap: 20px; }
        @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }

        /* Cards */
        .card {
            background: var(--card); border: 1px solid var(--border);
            border-radius: 12px; padding: 20px; margin-bottom: 20px;
        }
        .card h2 {
            font-size: 1em; color: var(--muted); text-transform: uppercase;
            letter-spacing: 1px; margin-bottom: 16px;
        }

        /* Player count */
        .player-count { font-size: 2em; font-weight: bold; color: var(--accent); }
        .player-max { color: var(--muted); font-size: 0.5em; }

        /* Chat */
        #chat-box {
            height: 280px; overflow-y: auto; background: #0a0a16;
            padding: 12px; border-radius: 8px; border: 1px solid var(--border);
            margin-bottom: 12px; font-family: 'Consolas', monospace; font-size: 0.9em;
        }
        .chat-msg { margin-bottom: 6px; line-height: 1.4; }
        .chat-name { color: var(--accent); font-weight: bold; }
        .chat-system { color: var(--muted); font-style: italic; }

        input[type="text"], input[type="number"], input[type="password"] {
            width: 100%; padding: 10px 12px;
            background: #0f0f1a; border: 1px solid var(--border);
            color: var(--text); border-radius: 8px; font-size: 0.95em;
        }
        input:focus { outline: none; border-color: var(--accent); }

        /* Table */
        table { width: 100%; border-collapse: collapse; }
        th { text-align: left; padding: 8px 12px; color: var(--muted); font-size: 0.8em; text-transform: uppercase; letter-spacing: 1px; }
        td { padding: 10px 12px; border-top: 1px solid var(--border); }
        tr:hover td { background: #ffffff08; }
        .mode-badge {
            display: inline-block; padding: 2px 8px; border-radius: 4px;
            font-size: 0.75em; font-weight: 600;
        }
        .mode-tcp { background: #7c3aed22; color: #a78bfa; }
        .mode-http { background: #f59e0b22; color: #fbbf24; }

        /* Buttons */
        .btn {
            padding: 8px 16px; border: none; border-radius: 8px;
            cursor: pointer; font-weight: 600; font-size: 0.9em; transition: opacity 0.2s;
        }
        .btn:hover { opacity: 0.85; }
        .btn-primary { background: var(--accent); color: #000; }
        .btn-danger { background: var(--red); color: #fff; }
        .btn-small { padding: 4px 10px; font-size: 0.8em; border-radius: 6px; }

        /* Form */
        .form-group { margin-bottom: 14px; }
        .form-group label { display: block; margin-bottom: 6px; font-size: 0.85em; color: var(--muted); }

        /* Info items */
        .info-item { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--border); }
        .info-label { color: var(--muted); font-size: 0.9em; }
        .info-value { font-weight: 600; font-size: 0.9em; color: var(--text); word-break: break-all; }
    </style>
</head>
<body>

<div class="header">
    <h1>VXU Server Dashboard</h1>
    <span class="status-badge status-online">&#x25CF; Online</span>
</div>

<div class="grid">
    <div>
        <div class="card">
            <h2>Live Chat & Activity</h2>
            <div id="chat-box"></div>
            <input type="text" id="admin-input" placeholder="Broadcast a message as Admin..." onkeypress="if(event.key==='Enter'){sendChat()}">
        </div>

        <div class="card">
            <h2>Players Online &mdash; <span class="player-count" id="count-display">0<span class="player-max"> / 0</span></span></h2>
            <table>
                <thead><tr><th>ID</th><th>Name</th><th>IP</th><th>Mode</th><th></th></tr></thead>
                <tbody id="player-table"></tbody>
            </table>
            <div id="no-players" style="text-align:center; color:var(--muted); padding:20px;">No players connected</div>
        </div>
    </div>

    <div>
        <div class="card">
            <h2>Server Settings</h2>
            <div class="form-group">
                <label>Server Name</label>
                <input type="text" id="cfg-name">
            </div>
            <div class="form-group">
                <label>Max Players</label>
                <input type="number" id="cfg-max" min="2" max="100">
            </div>
            <div class="form-group">
                <label>Message of the Day</label>
                <input type="text" id="cfg-motd">
            </div>
            <button class="btn btn-primary" style="width:100%" onclick="saveConfig()">Save Settings</button>
        </div>

        <div class="card">
            <h2>Server Info</h2>
            <div class="info-item">
                <span class="info-label">TCP Port (LAN)</span>
                <span class="info-value">${GAME_PORT}</span>
            </div>
            <div class="info-item">
                <span class="info-label">HTTP Port</span>
                <span class="info-value">${WEB_PORT}</span>
            </div>
            <div class="info-item">
                <span class="info-label">LAN IP</span>
                <span class="info-value">${getLocalIP()}</span>
            </div>
            <div class="info-item">
                <span class="info-label">Public URL</span>
                <span class="info-value">${PUBLIC_URL || 'Not set (local only)'}</span>
            </div>
            <div class="info-item">
                <span class="info-label">Server List API</span>
                <span class="info-value" style="font-size:0.8em">${PUBLIC_URL ? PUBLIC_URL + '/api/list' : 'http://' + getLocalIP() + ':' + WEB_PORT + '/api/list'}</span>
            </div>
        </div>
    </div>
</div>

<script>
// ─── Socket.IO (if available) ───────────────────────────────────────
let socket = null;
let players = [];

function tryConnect() {
    if (typeof io === 'undefined') {
        // Socket.IO not loaded — fallback to static page
        document.getElementById('chat-box').innerHTML = '<div class="chat-system">Dashboard requires Socket.IO. Run: npm install</div>';
        return;
    }
    socket = io();

    socket.on('chat', (data) => {
        addLog('<span class="chat-name">' + esc(data.name) + ':</span> ' + esc(data.msg));
    });

    socket.on('log', (msg) => {
        addLog('<span class="chat-system">[' + new Date().toLocaleTimeString() + '] ' + esc(msg) + '</span>');
    });

    socket.on('config', (cfg) => {
        document.getElementById('cfg-name').value = cfg.name;
        document.getElementById('cfg-max').value = cfg.maxPlayers;
        document.getElementById('cfg-motd').value = cfg.motd;
    });

    socket.on('full_player_list', (list) => { players = list; renderPlayers(); });
    socket.on('player_join', (p) => { players.push(p); renderPlayers(); });
    socket.on('player_left', (id) => { players = players.filter(p => p.id !== id); renderPlayers(); });
    socket.on('update_counts', (d) => {
        document.getElementById('count-display').innerHTML = d.current + '<span class="player-max"> / ' + d.max + '</span>';
    });
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function addLog(html) {
    const box = document.getElementById('chat-box');
    const div = document.createElement('div');
    div.className = 'chat-msg';
    div.innerHTML = html;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
}

function renderPlayers() {
    const tbody = document.getElementById('player-table');
    const noP = document.getElementById('no-players');
    tbody.innerHTML = '';
    noP.style.display = players.length === 0 ? 'block' : 'none';
    players.forEach(p => {
        const tr = document.createElement('tr');
        const ip = (p.ip || '?').replace('::ffff:', '');
        const modeClass = (p.mode === 'HTTP') ? 'mode-http' : 'mode-tcp';
        const modeLabel = p.mode || 'TCP';
        tr.innerHTML = '<td>' + p.id + '</td><td>' + esc(p.name) + '</td><td>' + esc(ip) + '</td>'
            + '<td><span class="mode-badge ' + modeClass + '">' + modeLabel + '</span></td>'
            + '<td><button class="btn btn-danger btn-small" onclick="kick(' + p.id + ')">Kick</button></td>';
        tbody.appendChild(tr);
    });
}

function sendChat() {
    const input = document.getElementById('admin-input');
    if (socket && input.value.trim()) {
        socket.emit('admin_chat', input.value);
        input.value = '';
    }
}

function saveConfig() {
    if (socket) {
        socket.emit('update_config', {
            name: document.getElementById('cfg-name').value,
            maxPlayers: parseInt(document.getElementById('cfg-max').value),
            motd: document.getElementById('cfg-motd').value
        });
    }
}

function kick(id) {
    if (socket && confirm('Kick player ID ' + id + '?')) {
        socket.emit('admin_kick', id);
    }
}

// Load Socket.IO dynamically
const script = document.createElement('script');
script.src = '/socket.io/socket.io.js';
script.onload = tryConnect;
script.onerror = tryConnect;
document.head.appendChild(script);
</script>

</body>
</html>`;
}
