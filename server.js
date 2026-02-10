//=============================================================================
//  VXU Smart Server (Game Relay + Web Dashboard)
//=============================================================================
const net = require('net');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

// ─── CONFIGURATION ──────────────────────────────────────────────────────────
const GAME_PORT = parseInt(process.env.GAME_PORT) || 7771; // TCP Port for Game
const WEB_PORT  = parseInt(process.env.PORT) || 3000;      // HTTP Port for Dashboard
const ADMIN_PASS = process.env.ADMIN_PASS || "admin";      // Dashboard Password

// ─── STATE ──────────────────────────────────────────────────────────────────
let nextId = 1; // ID 0 is reserved for Server/Admin
const clients = new Map(); // socket -> { id, name, ip, char_name, char_idx }
let serverConfig = {
    name: "Official VXU Server",
    motd: "Welcome to the world of VX Unchained!",
    maxPlayers: 20
};

// ─── EXPRESS & SOCKET.IO SETUP ──────────────────────────────────────────────
const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);

// Serve the Dashboard HTML
app.get('/', (req, res) => {
    res.send(dashboardHTML());
});

// Endpoint for the Game to fetch the server list (Text format for easy RGSS parsing)
// Returns: Name|IP|Port|Count|Max
app.get('/list', (req, res) => {
    // In a real master server setup, this would return multiple rows.
    // For now, it returns ITSELF so players can find this server easily.
    // We assume the request comes from the internet, so we try to detect our public IP 
    // or just send back a placeholder if behind a proxy.
    const count = getPlayerCount();
    // For local testing, use local IP. For cloud, you'd configure the public IP.
    const displayIP = req.headers['x-forwarded-for'] || req.socket.localAddress || "127.0.0.1";
    
    // Format: SERVER_NAME|IP|PORT|CURRENT|MAX
    const data = `${serverConfig.name}|${displayIP}|${GAME_PORT}|${count}|${serverConfig.maxPlayers}`;
    res.type('text/plain').send(data);
});

// ─── GAME SERVER (TCP) ──────────────────────────────────────────────────────
const DELIM = '|';

function encode(...parts) { return parts.join(DELIM) + '\n'; }
function decode(line) { return line.replace(/\r?\n$/, '').split(DELIM); }

function getPlayerCount() {
    let count = 0;
    for (const c of clients.values()) if (c.id !== null) count++;
    return count;
}

function broadcast(data, excludeSocket) {
    for (const [sock, info] of clients) {
        if (sock === excludeSocket) continue;
        if (info.id === null) continue;
        try { sock.write(data); } catch (e) {}
    }
}

const gameServer = net.createServer((socket) => {
    const clientIP = socket.remoteAddress;
    
    clients.set(socket, {
        id: null,
        name: "Connecting...",
        ip: clientIP,
        char_name: "",
        char_idx: 0,
        buffer: ""
    });

    socket.setNoDelay(true);

    socket.on('data', (data) => {
        const info = clients.get(socket);
        if (!info) return;

        info.buffer += data.toString('ascii');
        let newlineIdx;
        while ((newlineIdx = info.buffer.indexOf('\n')) !== -1) {
            const line = info.buffer.substring(0, newlineIdx + 1);
            info.buffer = info.buffer.substring(newlineIdx + 1);
            handleGameMessage(socket, info, line);
        }
    });

    socket.on('close', () => {
        const info = clients.get(socket);
        if (info && info.id !== null) {
            broadcast(encode('DELPLAYER', info.id));
            io.emit('log', `Player Left: ${info.name}`);
            io.emit('player_left', info.id);
        }
        clients.delete(socket);
        io.emit('update_counts', { current: getPlayerCount(), max: serverConfig.maxPlayers });
    });

    socket.on('error', () => {}); // Ignore connection reset errors
});

function handleGameMessage(socket, info, line) {
    const parts = decode(line);
    if (parts.length === 0) return;

    switch (parts[0]) {
        case 'JOIN':
            if (getPlayerCount() >= serverConfig.maxPlayers) {
                socket.end(); 
                return;
            }
            const id = nextId++;
            info.id = id;
            info.name = parts[1] || 'Player';
            info.char_name = parts[2];
            info.char_idx = parts[3];
            
            // 1. Send Welcome
            socket.write(encode('WELCOME', id, serverConfig.name));
            // 2. Send MOTD as chat
            socket.write(encode('CHAT', 0, 'System', serverConfig.motd));
            
            // 3. Sync players
            // Send existing to new
            for (const [sock, other] of clients) {
                if (sock === socket || other.id === null) continue;
                socket.write(encode('ADDPLAYER', other.id, other.name, other.char_name, other.char_idx));
            }
            // Send new to existing
            broadcast(encode('ADDPLAYER', id, info.name, info.char_name, info.char_idx), socket);
            
            // 4. Update Web Dashboard
            io.emit('log', `Player Joined: ${info.name} (ID: ${id})`);
            io.emit('player_join', { id, name: info.name, ip: info.ip });
            io.emit('update_counts', { current: getPlayerCount(), max: serverConfig.maxPlayers });
            break;

        case 'POS':
            if (info.id === null) return;
            info.char_name = parts[6];
            info.char_idx = parts[7];
            // Relay
            broadcast(encode('POS', info.id, parts[1], parts[2], parts[3], parts[4], parts[5], parts[6], parts[7]), socket);
            break;

        case 'CHAT':
            if (info.id === null) return;
            const msg = parts[1];
            const chatPkt = encode('CHAT', info.id, info.name, msg);
            broadcast(chatPkt); // Echo to all
            io.emit('chat', { name: info.name, msg: msg });
            break;
    }
}

// ─── DASHBOARD SOCKET.IO HANDLERS ───────────────────────────────────────────
io.on('connection', (socket) => {
    // Send initial state
    socket.emit('config', serverConfig);
    socket.emit('update_counts', { current: getPlayerCount(), max: serverConfig.maxPlayers });
    
    const playerList = [];
    for (const c of clients.values()) {
        if (c.id !== null) playerList.push({ id: c.id, name: c.name, ip: c.ip });
    }
    socket.emit('full_player_list', playerList);

    // Admin Commands
    socket.on('admin_kick', (id) => {
        for (const [sock, info] of clients) {
            if (info.id === id) {
                sock.end();
                io.emit('log', `Kicked player ID ${id}`);
                break;
            }
        }
    });

    socket.on('admin_chat', (msg) => {
        // Send as Server (ID 0)
        const pkt = encode('CHAT', 0, 'Admin', msg);
        broadcast(pkt);
        io.emit('chat', { name: 'Admin', msg: msg });
    });

    socket.on('update_config', (newConfig) => {
        serverConfig = { ...serverConfig, ...newConfig };
        io.emit('config', serverConfig);
        io.emit('log', 'Server configuration updated');
    });
});

// ─── STARTUP ────────────────────────────────────────────────────────────────
gameServer.listen(GAME_PORT, '0.0.0.0', () => {
    console.log(`Game TCP Server running on port ${GAME_PORT}`);
});

httpServer.listen(WEB_PORT, () => {
    console.log(`Web Dashboard running on http://localhost:${WEB_PORT}`);
});

// ─── HTML DASHBOARD (Embedded for simplicity) ───────────────────────────────
function dashboardHTML() {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>VXU Server Admin</title>
    <style>
        :root { --bg: #121212; --card: #1e1e1e; --text: #e0e0e0; --accent: #bb86fc; --red: #cf6679; }
        body { font-family: sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 20px; display: grid; grid-template-columns: 1fr 300px; gap: 20px; height: 100vh; box-sizing: border-box; }
        h2 { margin-top: 0; color: var(--accent); }
        .card { background: var(--card); padding: 20px; border-radius: 8px; margin-bottom: 20px; }
        
        /* Chat Area */
        #chat-box { height: 300px; overflow-y: auto; background: #000; padding: 10px; border: 1px solid #333; margin-bottom: 10px; font-family: monospace; }
        .chat-msg { margin-bottom: 4px; }
        .chat-name { font-weight: bold; color: var(--accent); }
        input[type="text"] { width: 100%; padding: 10px; background: #333; border: none; color: white; box-sizing: border-box; }

        /* Player List */
        table { width: 100%; border-collapse: collapse; }
        th, td { text-align: left; padding: 8px; border-bottom: 1px solid #333; }
        button.kick { background: var(--red); color: white; border: none; padding: 4px 8px; cursor: pointer; border-radius: 4px; }
        
        /* Config */
        .form-group { margin-bottom: 10px; }
        label { display: block; margin-bottom: 5px; font-size: 0.9em; }
        
        @media (max-width: 800px) { body { grid-template-columns: 1fr; height: auto; } }
    </style>
    <script src="/socket.io/socket.io.js"></script>
</head>
<body>

    <div>
        <div class="card">
            <h2>Live Chat & Logs</h2>
            <div id="chat-box"></div>
            <input type="text" id="admin-input" placeholder="Type to broadcast as Admin..." onkeypress="handleChat(event)">
        </div>

        <div class="card">
            <h2>Active Players (<span id="count-display">0/0</span>)</h2>
            <table>
                <thead><tr><th>ID</th><th>Name</th><th>IP</th><th>Action</th></tr></thead>
                <tbody id="player-table"></tbody>
            </table>
        </div>
    </div>

    <div>
        <div class="card">
            <h2>Server Config</h2>
            <div class="form-group">
                <label>Server Name</label>
                <input type="text" id="cfg-name">
            </div>
            <div class="form-group">
                <label>Max Players</label>
                <input type="number" id="cfg-max">
            </div>
            <div class="form-group">
                <label>MOTD (Message of the Day)</label>
                <input type="text" id="cfg-motd">
            </div>
            <button onclick="saveConfig()" style="width:100%; padding: 10px; background: var(--accent); border:none; color: #000; font-weight: bold; cursor: pointer;">Update Settings</button>
        </div>
        
        <div class="card">
            <h2>Server Info</h2>
            <p><strong>Status:</strong> <span style="color:#4caf50">Online</span></p>
            <p><strong>Game Port:</strong> ${GAME_PORT}</p>
            <p><strong>Web Port:</strong> ${WEB_PORT}</p>
        </div>
    </div>

    <script>
        const socket = io();
        const chatBox = document.getElementById('chat-box');
        
        // Log / Chat
        function addLog(html) {
            const div = document.createElement('div');
            div.className = 'chat-msg';
            div.innerHTML = html;
            chatBox.appendChild(div);
            chatBox.scrollTop = chatBox.scrollHeight;
        }

        socket.on('chat', (data) => {
            addLog('<span class="chat-name">' + data.name + ':</span> ' + data.msg);
        });

        socket.on('log', (msg) => {
            addLog('<span style="color:#888">[' + new Date().toLocaleTimeString() + '] ' + msg + '</span>');
        });

        function handleChat(e) {
            if (e.key === 'Enter') {
                const input = document.getElementById('admin-input');
                if(input.value.trim()) {
                    socket.emit('admin_chat', input.value);
                    input.value = '';
                }
            }
        }

        // Config
        socket.on('config', (cfg) => {
            document.getElementById('cfg-name').value = cfg.name;
            document.getElementById('cfg-max').value = cfg.maxPlayers;
            document.getElementById('cfg-motd').value = cfg.motd;
        });

        function saveConfig() {
            socket.emit('update_config', {
                name: document.getElementById('cfg-name').value,
                maxPlayers: parseInt(document.getElementById('cfg-max').value),
                motd: document.getElementById('cfg-motd').value
            });
        }

        // Players
        let players = [];

        function renderPlayers() {
            const tbody = document.getElementById('player-table');
            tbody.innerHTML = '';
            players.forEach(p => {
                const tr = document.createElement('tr');
                tr.innerHTML = '<td>' + p.id + '</td><td>' + p.name + '</td><td>' + p.ip.replace('::ffff:', '') + '</td><td><button class="kick" onclick="kick(' + p.id + ')">Kick</button></td>';
                tbody.appendChild(tr);
            });
        }

        socket.on('full_player_list', (list) => {
            players = list;
            renderPlayers();
        });

        socket.on('player_join', (p) => {
            players.push(p);
            renderPlayers();
        });

        socket.on('player_left', (id) => {
            players = players.filter(p => p.id !== id);
            renderPlayers();
        });

        socket.on('update_counts', (data) => {
            document.getElementById('count-display').innerText = data.current + '/' + data.max;
        });

        function kick(id) {
            if(confirm('Kick player ID ' + id + '?')) {
                socket.emit('admin_kick', id);
            }
        }
    </script>
</body>
</html>
    `;
}