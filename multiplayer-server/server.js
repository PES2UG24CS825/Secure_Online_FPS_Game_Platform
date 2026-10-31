/**
 * SecureFPS: Authoritative 3D Multiplayer Game Server
 * Built with Node.js, Express, and Socket.IO
 * Provides server-authoritative physics validation, 6-character room lobby matchmaking,
 * 30Hz state synchronization, combat arbitration, and cross-network WAN support.
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const os = require('os');
require('dotenv').config();

const PORT = parseInt(process.env.PORT || '4001', 10);
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.use(cors());
app.use(express.json());

let activeServerPort = PORT;
app.get('/status', (req, res) => {
  res.json({
    status: 'online',
    port: activeServerPort,
    rooms: rooms ? rooms.size : 0,
    timestamp: Date.now()
  });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  pingInterval: 10000,
  pingTimeout: 20000
});

// Rooms State Map: roomCode -> Room Object
const rooms = new Map();

// Generate unique 6-character alphanumeric room code (e.g. CYBER7, TACT92)
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  // Ensure uniqueness
  if (rooms.has(code)) {
    return generateRoomCode();
  }
  return code;
}

// Spawn Points within the 80m x 80m tactical arena (Ground elevation y=0, compound y=2.0)
const ARENA_SPAWNS = [
  { x: 0, y: 0, z: 28 },
  { x: 0, y: 0, z: -28 },
  { x: -26, y: 0, z: 0 },
  { x: 26, y: 0, z: 14 },
  { x: -20, y: 0, z: 18 },
  { x: 20, y: 0, z: -18 },
  { x: 0, y: 2.0, z: 0 },
  { x: 15, y: 0, z: 15 }
];

function getRandomSpawn(index = -1) {
  if (index >= 0 && index < ARENA_SPAWNS.length) {
    return { ...ARENA_SPAWNS[index] };
  }
  const idx = Math.floor(Math.random() * ARENA_SPAWNS.length);
  return { ...ARENA_SPAWNS[idx] };
}

// Helper to get or create legacy room
function getOrCreateRoom(roomName = 'arena_alpha') {
  if (!rooms.has(roomName)) {
    rooms.set(roomName, {
      code: roomName,
      name: roomName,
      hostId: null,
      state: 'in_game',
      players: new Map(),
      maxPlayers: 8,
      matchTime: 600,
      scores: new Map()
    });
  }
  return rooms.get(roomName);
}

// Health status check endpoint
app.get('/api/health', (req, res) => {
  let totalPlayers = 0;
  rooms.forEach(r => totalPlayers += r.players.size);
  res.json({
    status: 'online',
    server: 'SecureFPS Authoritative Game Server',
    rooms: rooms.size,
    totalPlayers: totalPlayers,
    timestamp: new Date().toISOString()
  });
});

io.on('connection', (socket) => {
  console.log(`[Multiplayer] Player connected: ${socket.id}`);

  let currentRoom = null;
  let playerState = null;

  // =========================================================================
  // MULTIPLAYER LOBBY PROTOCOL
  // =========================================================================

  // 1. Create Private Match Lobby
  socket.on('lobby:create', (data) => {
    const roomCode = (data?.preferredCode && !rooms.has(data.preferredCode))
      ? data.preferredCode
      : generateRoomCode();
    const playerName = (data?.name || 'Host_Operator').trim().substring(0, 20);

    const room = {
      code: roomCode,
      name: roomCode,
      hostId: socket.id,
      state: 'lobby', // 'lobby' | 'in_game'
      maxPlayers: 8,
      matchTime: 600,
      players: new Map()
    };

    const spawn = getRandomSpawn(0);
    playerState = {
      id: socket.id,
      name: playerName,
      isHost: true,
      isReady: true,
      x: spawn.x,
      y: spawn.y,
      z: spawn.z,
      yaw: 0,
      pitch: 0,
      health: 100,
      kills: 0,
      deaths: 0,
      isFirstPacket: true,
      lastMoveTime: Date.now(),
      lastShotTime: 0
    };

    room.players.set(socket.id, playerState);
    rooms.set(roomCode, room);
    currentRoom = room;

    socket.join(roomCode);

    socket.emit('lobby:created', {
      success: true,
      roomCode: roomCode,
      isHost: true,
      players: Array.from(room.players.values())
    });

    console.log(`[Multiplayer Lobby] Room ${roomCode} created by host ${playerName} (${socket.id})`);
  });

  // 2. Join Match Lobby with 6-char Code
  socket.on('lobby:join', (data) => {
    const rawCode = (data?.roomCode || '').trim().toUpperCase();
    const playerName = (data?.name || 'Operator').trim().substring(0, 20);

    if (!rawCode) {
      socket.emit('lobby:error', { message: 'Please enter a valid 6-character room code.' });
      return;
    }

    const room = rooms.get(rawCode);
    if (!room) {
      socket.emit('lobby:error', { message: `Room "${rawCode}" not found. Verify the code with host.` });
      return;
    }

    if (room.state === 'in_game') {
      // Check if this player was disconnected and is reconnecting within grace period
      let reconnectedPlayerKey = null;
      for (const [pid, p] of room.players.entries()) {
        if (p.disconnected && (p.name === playerName || p.userId === data?.userId)) {
          reconnectedPlayerKey = pid;
          break;
        }
      }

      if (reconnectedPlayerKey) {
        const existingState = room.players.get(reconnectedPlayerKey);
        if (existingState.graceTimer) {
          clearTimeout(existingState.graceTimer);
          existingState.graceTimer = null;
        }
        room.players.delete(reconnectedPlayerKey);

        existingState.id = socket.id;
        existingState.disconnected = false;
        existingState.disconnectTime = null;
        room.players.set(socket.id, existingState);
        playerState = existingState;
        currentRoom = room;
        socket.join(rawCode);

        socket.emit('game:reconnected', {
          roomCode: rawCode,
          isHost: existingState.isHost,
          state: room.state,
          players: Array.from(room.players.values())
        });

        io.to(rawCode).emit('player:reconnected', {
          id: socket.id,
          name: existingState.name
        });
        console.log(`[Multiplayer] Player ${existingState.name} successfully reconnected within grace period!`);
        return;
      }

      socket.emit('lobby:error', { message: `Match in room "${rawCode}" is already in progress.` });
      return;
    }

    if (room.players.size >= room.maxPlayers) {
      socket.emit('lobby:error', { message: `Room "${rawCode}" is full (maximum ${room.maxPlayers} players).` });
      return;
    }

    const spawnIndex = room.players.size % ARENA_SPAWNS.length;
    const spawn = getRandomSpawn(spawnIndex);

    playerState = {
      id: socket.id,
      name: playerName,
      isHost: false,
      isReady: false,
      x: spawn.x,
      y: spawn.y,
      z: spawn.z,
      yaw: 0,
      pitch: 0,
      health: 100,
      kills: 0,
      deaths: 0,
      isFirstPacket: true,
      lastMoveTime: Date.now(),
      lastShotTime: 0
    };

    room.players.set(socket.id, playerState);
    currentRoom = room;
    socket.join(rawCode);

    socket.emit('lobby:joined', {
      success: true,
      roomCode: rawCode,
      isHost: false,
      players: Array.from(room.players.values())
    });

    // Broadcast updated player list to everyone in room
    io.to(rawCode).emit('lobby:player_update', {
      players: Array.from(room.players.values())
    });

    console.log(`[Multiplayer Lobby] ${playerName} (${socket.id}) joined room ${rawCode}. Players: ${room.players.size}`);
  });

  // 3. Toggle Ready Status
  socket.on('lobby:ready', (data) => {
    if (!playerState || !currentRoom) return;

    playerState.isReady = !!data.isReady;

    io.to(currentRoom.code).emit('lobby:player_update', {
      players: Array.from(currentRoom.players.values())
    });

    console.log(`[Multiplayer Lobby] ${playerState.name} set ready: ${playerState.isReady} in room ${currentRoom.code}`);
  });

  // 4. Host Starts the Match (Requires minimum 2 players and all ready)
  socket.on('lobby:start', () => {
    if (!playerState || !currentRoom) return;

    if (socket.id !== currentRoom.hostId) {
      socket.emit('lobby:error', { message: 'Only the room host can start the match.' });
      return;
    }

    if (currentRoom.state === 'in_game') {
      socket.emit('lobby:error', { message: 'Match is already in progress.' });
      return;
    }

    if (currentRoom.players.size < 2) {
      socket.emit('lobby:error', { message: 'Cannot start match alone. At least 2 operators are required.' });
      return;
    }

    const unreadyPlayers = Array.from(currentRoom.players.values()).filter(p => !p.isReady);
    if (unreadyPlayers.length > 0) {
      socket.emit('lobby:error', { message: 'All operators must be READY before launching mission.' });
      return;
    }

    currentRoom.state = 'in_game';

    // Assign distinct, separated tactical spawn points to each connected player
    let idx = 0;
    currentRoom.players.forEach(p => {
      const spawn = getRandomSpawn(idx % ARENA_SPAWNS.length);
      idx++;
      p.x = spawn.x;
      p.y = spawn.y;
      p.z = spawn.z;
      p.health = 100;
      p.kills = 0;
      p.deaths = 0;
      p.isFirstPacket = true;
      p.lastMoveTime = Date.now();
    });

    const playerList = Array.from(currentRoom.players.values());

    // Broadcast synchronized game start to all clients in the room
    io.to(currentRoom.code).emit('game:start', {
      roomCode: currentRoom.code,
      matchDuration: 600,
      players: playerList
    });

    console.log(`[Multiplayer Match] Room ${currentRoom.code} match started by host with ${playerList.length} players!`);
  });

  // 5. Leave Room / Return to Menu
  socket.on('lobby:leave', () => {
    if (!currentRoom || !playerState) return;

    const roomCode = currentRoom.code;
    currentRoom.players.delete(socket.id);
    socket.leave(roomCode);

    if (currentRoom.players.size === 0) {
      rooms.delete(roomCode);
      console.log(`[Multiplayer Lobby] Room ${roomCode} destroyed (empty)`);
    } else {
      if (socket.id === currentRoom.hostId) {
        // Elect new host
        const nextHost = currentRoom.players.values().next().value;
        if (nextHost) {
          nextHost.isHost = true;
          nextHost.isReady = true;
          currentRoom.hostId = nextHost.id;
          io.to(roomCode).emit('lobby:host_changed', { newHostId: nextHost.id, newHostName: nextHost.name });
        }
      }

      io.to(roomCode).emit('lobby:player_update', {
        players: Array.from(currentRoom.players.values())
      });
    }

    currentRoom = null;
    playerState = null;
    socket.emit('lobby:left', { success: true });
  });

  // =========================================================================
  // LEGACY QUICK JOIN (Backward Compatibility)
  // =========================================================================
  socket.on('player:join', (data) => {
    const roomName = data.room || 'arena_alpha';
    currentRoom = getOrCreateRoom(roomName);

    if (currentRoom.players.size >= currentRoom.maxPlayers) {
      socket.emit('room:full', { message: 'Room has reached maximum player capacity.' });
      return;
    }

    const spawn = getRandomSpawn();
    playerState = {
      id: socket.id,
      name: (data.name || 'Operator').substring(0, 24),
      isHost: false,
      isReady: true,
      x: spawn.x,
      y: spawn.y,
      z: spawn.z,
      yaw: 0,
      pitch: 0,
      health: 100,
      kills: 0,
      deaths: 0,
      isFirstPacket: true,
      lastMoveTime: Date.now(),
      lastShotTime: 0
    };

    currentRoom.players.set(socket.id, playerState);
    socket.join(roomName);

    const existingPlayers = Array.from(currentRoom.players.values()).filter(p => p.id !== socket.id);
    socket.emit('room:players', existingPlayers);
    socket.to(roomName).emit('player:joined', playerState);

    console.log(`[Multiplayer] ${playerState.name} (${socket.id}) quick-joined room ${roomName}`);
  });

  // =========================================================================
  // AUTHORITATIVE GAMEPLAY SYNCHRONIZATION (30Hz)
  // =========================================================================
  socket.on('player:move', (data) => {
    if (!playerState || !currentRoom) return;

    const now = Date.now();

    if (playerState.isFirstPacket) {
      playerState.isFirstPacket = false;
      playerState.x = data.x;
      playerState.y = data.y;
      playerState.z = data.z;
      playerState.yaw = data.yaw || 0;
      playerState.lastMoveTime = now;
      socket.to(currentRoom.code || currentRoom.name).emit('player:moved', {
        id: socket.id,
        x: playerState.x,
        y: playerState.y,
        z: playerState.z,
        yaw: playerState.yaw
      });
      return;
    }

    const dt = Math.max(0.001, (now - playerState.lastMoveTime) / 1000);
    const dx = data.x - playerState.x;
    const dy = data.y - playerState.y;
    const dz = data.z - playerState.z;
    const distanceMoved = Math.sqrt(dx * dx + dz * dz);
    const speed = distanceMoved / dt;

    // Maximum plausible horizontal speed limit: 22 m/s
    if (speed <= 22.0) {
      playerState.x = data.x;
      playerState.y = data.y;
      playerState.z = data.z;
      playerState.yaw = data.yaw || 0;
      playerState.lastMoveTime = now;

      socket.to(currentRoom.code || currentRoom.name).emit('player:moved', {
        id: socket.id,
        x: playerState.x,
        y: playerState.y,
        z: playerState.z,
        yaw: playerState.yaw
      });
    } else {
      socket.emit('player:rubberband', {
        x: playerState.x,
        y: playerState.y,
        z: playerState.z
      });
    }
  });

  // Client Latency Heartbeat
  socket.on('player:ping', (timestamp) => {
    socket.emit('player:pong', timestamp);
  });

  // Firing & Hitscan Arbitration
  socket.on('player:fire', (data) => {
    if (!playerState || !currentRoom) return;

    const now = Date.now();
    if (now - playerState.lastShotTime < 75) {
      return; // Discard rapid-fire packet exploit
    }
    playerState.lastShotTime = now;

    // Broadcast visual & audio gunshot FX to other players in room
    const targetRoom = currentRoom.code || currentRoom.name;
    socket.to(targetRoom).emit('player:fired', {
      id: socket.id,
      origin: data.origin,
      target: data.target
    });

    // Server arbitrates hit & damage
    if (data.hitPlayerId && currentRoom.players.has(data.hitPlayerId)) {
      const victim = currentRoom.players.get(data.hitPlayerId);
      if (victim.health > 0) {
        const isHeadshot = !!data.headshot;
        const weaponKey = data.weaponKey || 'carbine';
        const weaponDamages = {
          carbine: { body: 25, head: 50 },
          smg: { body: 18, head: 36 },
          pistol: { body: 22, head: 44 },
          sniper: { body: 80, head: 110 }
        };
        const w = weaponDamages[weaponKey] || weaponDamages.carbine;
        const damage = isHeadshot ? w.head : w.body;

        victim.health = Math.max(0, victim.health - damage);

        // Track damage contributions for assists
        victim.damageDealtMap = victim.damageDealtMap || {};
        victim.damageDealtMap[socket.id] = (victim.damageDealtMap[socket.id] || 0) + damage;

        // Notify victim of damage with attacker coordinates for directional arc
        io.to(victim.id).emit('player:hurt', {
          damage: damage,
          attackerId: socket.id,
          attackerName: playerState.name,
          attackerPos: { x: playerState.x, y: playerState.y, z: playerState.z },
          currentHealth: victim.health
        });

        // Notify attacker of confirmed hitmarker
        socket.emit('player:hit_confirmed', {
          victimId: victim.id,
          damage: damage,
          headshot: isHeadshot
        });

        // If victim died
        if (victim.health <= 0) {
          playerState.kills++;
          victim.deaths++;

          // Check assists (players other than killer who dealt >= 25 dmg)
          if (victim.damageDealtMap) {
            Object.keys(victim.damageDealtMap).forEach(damagerId => {
              if (damagerId !== socket.id && victim.damageDealtMap[damagerId] >= 25) {
                const assister = currentRoom.players.get(damagerId);
                if (assister) {
                  assister.assists = (assister.assists || 0) + 1;
                  io.to(damagerId).emit('player:assist', {
                    victimId: victim.id,
                    victimName: victim.name
                  });
                }
              }
            });
            victim.damageDealtMap = {};
          }

          io.to(targetRoom).emit('player:killed', {
            killerId: socket.id,
            killerName: playerState.name,
            victimId: victim.id,
            victimName: victim.name,
            weapon: weaponKey,
            headshot: isHeadshot
          });

          // Schedule respawn after 3 seconds
          setTimeout(() => {
            if (currentRoom && currentRoom.players.has(victim.id)) {
              const respawnPos = getRandomSpawn();
              victim.health = 100;
              victim.x = respawnPos.x;
              victim.y = respawnPos.y;
              victim.z = respawnPos.z;

              io.to(targetRoom).emit('player:respawned', {
                id: victim.id,
                x: victim.x,
                y: victim.y,
                z: victim.z
              });
            }
          }, 3000);
        }
      }
    }
  });

  // Disconnect cleanup with 90-second reconnect grace period during active matches
  socket.on('disconnect', () => {
    if (currentRoom && playerState) {
      const roomCode = currentRoom.code || currentRoom.name;

      if (currentRoom.state === 'in_game') {
        // Disconnect during active match: grant 90-second grace period!
        playerState.disconnected = true;
        playerState.disconnectTime = Date.now();
        console.log(`[Multiplayer] Player ${playerState.name} (${socket.id}) disconnected during match. Starting 90s grace period...`);

        io.to(roomCode).emit('player:disconnected_grace', {
          id: socket.id,
          name: playerState.name,
          gracePeriod: 90
        });

        // Set 90s grace expiration timer
        playerState.graceTimer = setTimeout(() => {
          if (currentRoom && currentRoom.players.has(socket.id)) {
            const p = currentRoom.players.get(socket.id);
            if (p && p.disconnected) {
              console.log(`[Multiplayer] Player ${p.name} grace period expired (90s). Removing from room ${roomCode}.`);
              currentRoom.players.delete(socket.id);

              if (socket.id === currentRoom.hostId) {
                const nextHost = Array.from(currentRoom.players.values()).find(pl => !pl.disconnected);
                if (nextHost) {
                  nextHost.isHost = true;
                  nextHost.isReady = true;
                  currentRoom.hostId = nextHost.id;
                  io.to(roomCode).emit('lobby:host_changed', { newHostId: nextHost.id, newHostName: nextHost.name });
                }
              }

              io.to(roomCode).emit('player:left', { id: socket.id, name: p.name, reason: 'timeout' });
              io.to(roomCode).emit('lobby:player_update', {
                players: Array.from(currentRoom.players.values())
              });

              if (currentRoom.players.size === 0) {
                rooms.delete(roomCode);
                console.log(`[Multiplayer] Room ${roomCode} destroyed (all players left).`);
              }
            }
          }
        }, 90000);

        // Host migration if host disconnects
        if (socket.id === currentRoom.hostId) {
          const nextHost = Array.from(currentRoom.players.values()).find(p => !p.disconnected && p.id !== socket.id);
          if (nextHost) {
            nextHost.isHost = true;
            nextHost.isReady = true;
            currentRoom.hostId = nextHost.id;
            io.to(roomCode).emit('lobby:host_changed', { newHostId: nextHost.id, newHostName: nextHost.name });
          }
        }
      } else {
        // Disconnect in lobby before match started: immediate cleanup, 0 penalty
        currentRoom.players.delete(socket.id);
        if (currentRoom.players.size === 0) {
          rooms.delete(roomCode);
          console.log(`[Multiplayer] Room ${roomCode} destroyed (empty after lobby disconnect)`);
        } else {
          if (socket.id === currentRoom.hostId) {
            const nextHost = currentRoom.players.values().next().value;
            if (nextHost) {
              nextHost.isHost = true;
              nextHost.isReady = true;
              currentRoom.hostId = nextHost.id;
              io.to(roomCode).emit('lobby:host_changed', { newHostId: nextHost.id, newHostName: nextHost.name });
            }
          }
          io.to(roomCode).emit('player:left', { id: socket.id, name: playerState.name });
          io.to(roomCode).emit('lobby:player_update', {
            players: Array.from(currentRoom.players.values())
          });
        }
      }

      console.log(`[Multiplayer] Player ${playerState.name} (${socket.id}) disconnected. Remaining: ${currentRoom ? currentRoom.players.size : 0}`);
    }
  });
});

// Authoritative Server on Port 4001 (Strict - No silent fallbacks)
function startServer(port = PORT) {
  activeServerPort = port;
  server.listen(port, HOST, () => {
    console.log('====================================================');
    console.log(`SecureFPS Authoritative Game Server running on port ${port}`);
    console.log(`Local Access: http://127.0.0.1:${port}`);

    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          console.log(`LAN Network Access: http://${iface.address}:${port}`);
        }
      }
    }
    console.log('WAN Cross-Network: Reachable via public IP, Cloudflare Tunnel, or ngrok');
    console.log('====================================================');
  });

  server.once('error', (err) => {
    console.error(`[Multiplayer] Fatal server error on port ${port}:`, err.message);
    process.exit(1);
  });
}

startServer(PORT);
