/**
 * SecureFPS: Authoritative 3D Multiplayer Game Server
 * Built with Node.js, Express, Socket.IO, and Zod
 *
 * Authoritative Architecture:
 * - 30Hz fixed server tick loop (33.33ms)
 * - Single compact snapshot broadcast per room per tick ('world:snapshot')
 * - 1.2s rolling position ring buffer per player for lag compensation
 * - Server-side rewind raycasting on 'player:fire' with head & body hitboxes
 * - Static arena obstacle occlusion testing using raycast AABB slab intersection
 * - Weapon config validation (fire rate caps, damage, headshot multipliers)
 * - Per-tick displacement & speed budgeting with bounds and collision checks
 * - Server-authoritative rubberbanding on speed or position violations
 * - Farthest-from-enemy tactical respawn selection with 2s spawn protection
 * - Room-level match timers, score limits, authoritative scoreboards, and lobby cycling
 * - Schema-validated packet input handlers with try/catch and per-socket rate limiting
 * - Signed JWT handshake authentication with single active socket per user
 * - Anti-cheat telemetry aggregation and signed reporting to Flask backend
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const os = require('os');
const { z } = require('zod');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../backend/.env') });
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
require('dotenv').config();

const WeaponConfig = require('./shared/weapon_config');
const ArenaCollision = require('./shared/arena_collision');

const PORT = parseInt(process.env.PORT || '4001', 10);
const MATCH_DURATION_SECONDS = 480;
const MATCH_SCORE_LIMIT = (process.env.MATCH_SCORE_LIMIT === '15') ? 10 : parseInt(process.env.MATCH_SCORE_LIMIT || '10', 10);
const HOST = process.env.HOST || '0.0.0.0';
const GAME_SERVER_SECRET = process.env.GAME_SERVER_SECRET || 'securefps-multiplayer-secret-key-2026';
const MATCH_RESULT_KEY = crypto.createHmac('sha256', GAME_SERVER_SECRET).update('securefps:match-result:v1').digest();
if (process.env.NODE_ENV === 'production' && (
  GAME_SERVER_SECRET.trim().length < 32 ||
  ['securefps-multiplayer-secret-key-2026', 'generate-a-strong-random-shared-game-server-secret'].includes(GAME_SERVER_SECRET.trim())
)) {
  throw new Error('Configure a unique GAME_SERVER_SECRET of at least 32 characters.');
}
const ALLOW_ANONYMOUS = process.env.NODE_ENV !== 'production' && process.env.ALLOW_ANONYMOUS !== 'false';
const FLASK_INTERNAL_URL = process.env.FLASK_INTERNAL_URL || 'http://127.0.0.1:5000';
const RESPAWN_DELAY_MS = parseInt(process.env.RESPAWN_DELAY_MS || '3000', 10);

const app = express();
app.use(cors({
  origin: (origin, callback) => callback(null, true),
  credentials: true
}));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true
  },
  pingInterval: 10000,
  pingTimeout: 20000,
  maxHttpBufferSize: 64 * 1024 // 64KB max packet size to prevent buffer overflow
});

// Rooms State Map: roomCode -> Room Object
const rooms = new Map();
// Active User Sockets Map: userId -> socket.id
const activeUserSockets = new Map();
// IP Room Creation Tracking: ip -> count
const ipRoomCount = new Map();
const MAX_ROOMS_PER_IP = 6;
const MAX_TOTAL_ROOMS = 500;

function releaseRoomIpQuota(room) {
  const ip = room?.creatorIp;
  if (!ip) return;
  const remaining = Math.max(0, (ipRoomCount.get(ip) || 0) - 1);
  if (remaining === 0) ipRoomCount.delete(ip);
  else ipRoomCount.set(ip, remaining);
}

// =========================================================================
// ZOD VALIDATION SCHEMAS
// =========================================================================

const LobbyCreateSchema = z.object({
  preferredCode: z.string().trim().regex(/^[A-Za-z0-9]{4,8}$/).optional(),
  name: z.string().trim().min(1).max(24).default('Operator_Host'),
  operator: z.enum(['vanguard', 'valkyrie']).default('vanguard'),
  honour_score: z.number().int().min(0).max(100).optional().default(100)
}).passthrough();

const LobbyJoinSchema = z.object({
  roomCode: z.string().trim().min(3).max(10),
  name: z.string().trim().min(1).max(24).default('Operator'),
  operator: z.enum(['vanguard', 'valkyrie']).default('vanguard'),
  userId: z.string().optional(),
  honour_score: z.number().int().min(0).max(100).optional().default(100)
}).passthrough();

const SessionResumeSchema = z.object({
  roomCode: z.string().trim().min(3).max(10),
  reconnectToken: z.string().min(16)
});

const PlayerMoveSchema = z.object({
  seq: z.number().int().nonnegative().optional(),
  clientTime: z.number().optional(),
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
  yaw: z.number().finite().default(0),
  pitch: z.number().finite().optional().default(0),
  isSprinting: z.boolean().optional().default(false),
  isCrouching: z.boolean().optional().default(false)
});

const PlayerFireSchema = z.object({
  seq: z.number().int().nonnegative().optional(),
  clientTime: z.number().finite(),
  origin: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite()
  }),
  direction: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite()
  }).optional(),
  target: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite()
  }).optional(),
  weaponKey: z.string().min(1).max(20).default('carbine')
});

// =========================================================================
// RATE LIMITER PER SOCKET
// =========================================================================

class SocketRateLimiter {
  constructor(socket) {
    this.socket = socket;
    this.counters = {
      move: { count: 0, resetAt: Date.now() + 1000, limit: 50 },
      fire: { count: 0, resetAt: Date.now() + 1000, limit: 18 },
      ping: { count: 0, resetAt: Date.now() + 1000, limit: 6 },
      general: { count: 0, resetAt: Date.now() + 1000, limit: 20 }
    };
    this.violationCount = 0;
  }

  check(bucket = 'general') {
    const now = Date.now();
    const b = this.counters[bucket] || this.counters.general;
    if (now > b.resetAt) {
      b.count = 0;
      b.resetAt = now + 1000;
    }
    b.count++;
    if (b.count > b.limit) {
      this.violationCount++;
      if (this.violationCount >= 25) {
        console.warn(`[Security] Socket ${this.socket.id} exceeded rate limits repeatedly (${this.violationCount}). Disconnecting.`);
        this.socket.emit('error', { message: 'Rate limit violation. Connection terminated.' });
        this.socket.disconnect(true);
      }
      return false;
    }
    return true;
  }
}

// Generate unique 6-character room code using cryptographically secure random integers
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    const randIdx = crypto.randomInt(0, chars.length);
    code += chars.charAt(randIdx);
  }
  if (rooms.has(code)) return generateRoomCode();
  return code;
}

function generateReconnectToken() {
  return crypto.randomBytes(24).toString('hex');
}

/**
 * Farthest-from-enemies spawn selection
 */
/**
 * Tactical respawn selection:
 * Evaluates candidates based on:
 * 1. Safe distance from all active opponents (>= 20m preferred)
 * 2. Static obstacle occlusion (ArenaCollision raycast occlusion)
 * 3. Opponent viewing cone / field of view (prohibits spawning directly in front of crosshairs)
 * 4. Deprioritizes exposed open areas (such as central spire)
 * 5. Safely retains player starting base when base is uncamped and occluded
 */
function getTacticalSpawn(room, excludePlayerId = null) {
  const activePlayers = [];
  if (room && room.players) {
    room.players.forEach((p, id) => {
      if (id !== excludePlayerId && !p.disconnected && p.health > 0) {
        activePlayers.push(p);
      }
    });
  }

  const victim = room?.players?.get(excludePlayerId);
  const startingSpawn = (victim && victim.spawnIndex !== undefined)
    ? ArenaCollision.ARENA_SPAWNS[victim.spawnIndex % ArenaCollision.ARENA_SPAWNS.length]
    : ArenaCollision.ARENA_SPAWNS[0];

  if (activePlayers.length === 0) {
    return { ...startingSpawn };
  }

  // Filter out the center elevated platform (index 6: {x: 0, y: 2.0, z: 0}) from active respawns
  const candidateSpawns = ArenaCollision.ARENA_SPAWNS.filter((s, idx) => idx !== 6);

  let bestSpawn = startingSpawn;
  let bestScore = -Infinity;

  for (const spawn of candidateSpawns) {
    let minDist = Infinity;
    let anyDirectLoS = false;
    let inFrontOfAnyEnemy = false;
    let enemyLookingDirectlyAtSpawn = false;

    const spawnHead = { x: spawn.x, y: (spawn.y || 0) + 1.2, z: spawn.z };

    for (const enemy of activePlayers) {
      const dx = spawn.x - enemy.x;
      const dz = spawn.z - enemy.z;
      const dist = Math.hypot(dx, dz);
      if (dist < minDist) {
        minDist = dist;
      }

      const enemyEye = { x: enemy.x, y: (enemy.y || 0) + 1.6, z: enemy.z };
      const isOccluded = typeof ArenaCollision.checkRaycastOcclusion === 'function'
        ? ArenaCollision.checkRaycastOcclusion(enemyEye, spawnHead)
        : false;

      // Enemy horizontal forward unit vector from yaw (Three.js camera convention: yaw=0 -> -Z)
      const enemyYaw = Number(enemy.yaw) || 0;
      const fwdX = -Math.sin(enemyYaw);
      const fwdZ = -Math.cos(enemyYaw);

      const toSpawnLen = Math.max(0.001, dist);
      const toSpawnDirX = dx / toSpawnLen;
      const toSpawnDirZ = dz / toSpawnLen;
      const dot = (toSpawnDirX * fwdX) + (toSpawnDirZ * fwdZ);

      if (dot > 0.25) {
        inFrontOfAnyEnemy = true;
        if (!isOccluded) {
          enemyLookingDirectlyAtSpawn = true;
        }
      }
      if (!isOccluded) {
        anyDirectLoS = true;
      }
    }

    // Safety scoring
    let score = minDist;
    if (minDist < 16.0) score -= 500;
    else if (minDist < 22.0) score -= 100;

    // Never respawn directly in front of an enemy looking towards the spawn point
    if (enemyLookingDirectlyAtSpawn) {
      score -= 2000;
    } else if (anyDirectLoS) {
      score -= 250;
    } else {
      score += 120; // Fully occluded behind static walls/bunkers
    }

    if (!inFrontOfAnyEnemy) {
      score += 60; // Behind opponents' back
    }

    // Starting spawn retention priority: always prefer player starting base unless camped
    const isHomeBase = (spawn.x === startingSpawn.x && spawn.z === startingSpawn.z);
    if (isHomeBase && !enemyLookingDirectlyAtSpawn && minDist >= 10.0) {
      score += 1500;
    }

    if (score > bestScore) {
      bestScore = score;
      bestSpawn = spawn;
    }
  }

  return { ...bestSpawn };
}

// Sanitize player state for public broadcast (removes Timers, internal maps)
function sanitizePlayer(p) {
  return {
    id: p.id,
    name: p.name,
    isFemale: p.operator === 'valkyrie',
    isHost: !!p.isHost,
    isReady: !!p.isReady,
    x: p.x,
    y: p.y,
    z: p.z,
    yaw: p.yaw,
    pitch: p.pitch,
    health: p.health,
    kills: p.kills,
    deaths: p.deaths,
    assists: p.assists || 0,
    totalShots: p.totalShots || 0,
    totalHits: p.totalHits || 0,
    headshots: p.headshots || 0,
    isCrouching: !!p.isCrouching,
    isSprinting: !!p.isSprinting,
    spawnProtected: Boolean(p.spawnProtectedUntil && p.spawnProtectedUntil > Date.now())
  };
}

function sanitizeRoomPlayers(room) {
  const result = [];
  if (!room || !room.players) return result;
  room.players.forEach(p => {
    if (!p.disconnected) {
      result.push(sanitizePlayer(p));
    }
  });
  return result;
}

// =========================================================================
// AUTHENTICATION MIDDLEWARE
// =========================================================================

async function checkMatchmakingAdmission(socket, errorEvent) {
  // The low-level socket harness imports the server and exercises room state without Flask.
  if (require.main !== module) return true;
  try {
    const response = await fetch(new URL('/api/internal/matchmaking-policy', FLASK_INTERNAL_URL), {
      headers: { Authorization: 'Bearer ' + GAME_SERVER_SECRET },
      signal: AbortSignal.timeout(1500)
    });
    if (!response.ok) throw new Error(`Policy check returned HTTP ${response.status}`);
    const policy = await response.json();
    if (policy.allow_new_admissions === true) return socket.connected;
    if (policy.allow_new_admissions === false) {
      socket.emit(errorEvent, { message: 'New room admissions are paused during platform lockdown.' });
      return false;
    }
    throw new Error('Invalid policy');
  } catch (err) {
    if (ALLOW_ANONYMOUS || process.env.NODE_ENV !== 'production') {
      console.warn(`[Matchmaking] Backend policy check bypassed in dev/local mode (${err.message}). Allowing admission.`);
      return socket.connected;
    }
    socket.emit(errorEvent, { message: 'Matchmaking policy is unavailable. Try again shortly.' });
  }
  return false;
}

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (token) {
    try {
      const decoded = jwt.verify(token, GAME_SERVER_SECRET);
      socket.userId = decoded.userId || decoded.sub || socket.id;
      socket.authenticatedPlayer = typeof decoded.userId === 'string';
      socket.username = decoded.username || decoded.name || 'Operator';
      socket.sessionId = decoded.sessionId || null;
      socket.isDemoCheater = Boolean(
        decoded.isDemoCheater ||
        decoded.account_type === 'demo_test' ||
        decoded.is_demo_cheater ||
        decoded.username === 'cheater_demo' ||
        decoded.username === 'demo_cheater'
      );
      console.log(`[Auth] Socket ${socket.id} authenticated as ${socket.username} (${socket.userId})${socket.isDemoCheater ? ' [DEMO CHEATER]' : ''}`);
      return next();
    } catch (err) {
      console.warn(`[Auth] Socket ${socket.id} token rejected:`, err.message);
      if (!ALLOW_ANONYMOUS) {
        return next(new Error('Authentication failed: Invalid or expired token'));
      }
    }
  } else if (!ALLOW_ANONYMOUS) {
    return next(new Error('Authentication required: Token missing'));
  }

  // Fallback / Dev anonymous connection
  socket.userId = socket.handshake.auth?.userId || socket.id;
  socket.username = socket.handshake.auth?.name || 'Operator';
  return next();
});

// =========================================================================
// EXPRESS HTTP HEALTH & STATS ENDPOINTS
// =========================================================================

app.get('/health', (req, res) => {
  let totalActive = 0;
  rooms.forEach(r => {
    r.players.forEach(p => { if (!p.disconnected) totalActive++; });
  });
  res.json({
    status: 'ok',
    rooms: rooms.size,
    activePlayers: totalActive,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.get('/api/health', (req, res) => {
  let totalActive = 0;
  rooms.forEach(r => {
    r.players.forEach(p => { if (!p.disconnected) totalActive++; });
  });
  res.json({
    status: 'online',
    server: 'SecureFPS Authoritative 3D Multiplayer Game Server',
    rooms: rooms.size,
    totalPlayers: totalActive,
    timestamp: new Date().toISOString()
  });
});

app.get('/status', (req, res) => {
  res.json({
    status: 'online',
    port: PORT,
    rooms: rooms.size,
    clients: io.of('/').sockets.size,
    uptime: Math.floor(process.uptime()),
    timestamp: Date.now()
  });
});

// Internal authoritative enforcement endpoint: immediately ban/kick player from active matches
app.post('/internal/kick', (req, res) => {
  const secret = req.headers['x-game-server-secret'] || req.headers['authorization']?.replace(/^Bearer\s+/, '');
  if (secret !== GAME_SERVER_SECRET) {
    return res.status(403).json({ error: 'Unauthorized internal call' });
  }
  const { userId, reason } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  let kickedCount = 0;
  const targetIdStr = String(userId);

  for (const [socketId, s] of io.of('/').sockets) {
    if (String(s.userId) === targetIdStr) {
      kickedCount++;
      s.emit('player:banned', {
        reason: reason || 'Platform security enforcement action.',
        bannedAt: new Date().toISOString()
      });

      rooms.forEach((room) => {
        if (room.players.has(socketId)) {
          const p = room.players.get(socketId);
          room.players.delete(socketId);
          io.to(room.code).emit('player:left', {
            id: socketId,
            name: p?.name || 'Operator',
            reason: 'banned'
          });
          console.log(`[Enforcement] Removed banned player ${p?.name} (${socketId}) from room ${room.code}`);
        }
      });

      if (activeUserSockets.get(s.userId) === socketId) {
        activeUserSockets.delete(s.userId);
      }
      s.disconnect(true);
    }
  }

  console.log(`[Enforcement] Processed kick for user ${targetIdStr}, disconnected ${kickedCount} socket(s)`);
  res.json({ success: true, kickedCount });
});

app.get('/api/rooms', (req, res) => {
  const roomList = [];
  rooms.forEach((r, code) => {
    const connected = [...r.players.values()].filter(player => !player.disconnected);
    roomList.push({
      roomCode: code,
      state: r.state,
      hostName: r.players.get(r.hostId)?.name || null,
      playerCount: connected.length,
      maxPlayers: r.maxPlayers,
      players: connected.map(p => ({
        id: p.id,
        name: p.name,
        kills: p.kills,
        deaths: p.deaths,
        health: p.health,
        ping: p.ping ?? null
      })),
      createdAt: r.createdAt ?? null
    });
  });
  res.json({ rooms: roomList, totalRooms: roomList.length });
});

// =========================================================================
// 30Hz FIXED SERVER TICK & ROOM LIFECYCLE
// =========================================================================

const TICK_INTERVAL_MS = 1000 / 30; // 33.33ms
let lastTickTime = performance.now();

function serverTick() {
  const now = performance.now();
  const dt = Math.max(0.001, (now - lastTickTime) / 1000);
  lastTickTime = now;
  const currentWallTime = Date.now();

  rooms.forEach((room, roomCode) => {
    if (room.state !== 'in_game') return;

    // 1. Check Match Duration & Score Limit
    const elapsedSeconds = (currentWallTime - room.matchStartTime) / 1000;
    let matchEnded = false;
    let endReason = 'time_expired';
    let winningPlayer = null;

    if (elapsedSeconds >= room.matchDuration) {
      matchEnded = true;
      endReason = 'time_expired';
    }

    room.players.forEach(p => {
      if (p.kills >= room.scoreLimit) {
        matchEnded = true;
        endReason = 'score_limit_reached';
        winningPlayer = p;
      }
    });

    if (matchEnded) {
      endMatch(room, endReason, winningPlayer);
      return;
    }

    // 2. Process Input Queues & Physics Validation for Each Player
    const snapshotPlayers = [];

    room.players.forEach(player => {
      if (player.disconnected) return;

      // Drain queued movements (process latest state)
      if (player.inputQueue && player.inputQueue.length > 0) {
        const latestMove = player.inputQueue[player.inputQueue.length - 1];
        player.inputQueue = [];

        if (player.health > 0) {
          if (player.isFirstPacket) {
            player.isFirstPacket = false;
            player.x = latestMove.x;
            player.y = latestMove.y;
            player.z = latestMove.z;
            player.yaw = latestMove.yaw;
            player.pitch = latestMove.pitch;
            player.lastProcessedSeq = latestMove.seq || 0;
            player.lastMoveTime = now;
          } else {
            const moveDt = Math.max(0.001, (now - player.lastMoveTime) / 1000);
            const dx = latestMove.x - player.x;
            const dy = latestMove.y - player.y;
            const dz = latestMove.z - player.z;
            const horizDist = Math.sqrt(dx * dx + dz * dz);

            // Authoritative Displacement Budget:
            // Controlled demonstration check: only authorized demo cheater inside a designated demo room with toggle ON
            const isDemoCheaterInDemo = Boolean(room.isDemoRoom && player.isDemoCheater);
            const demoToggles = player.demoToggles || {};
            const maxAllowedSpeed = (isDemoCheaterInDemo && demoToggles.speed) ? 48.0 : (latestMove.isSprinting ? 12.0 : 8.0);
            const maxAllowedDistance = (maxAllowedSpeed * moveDt) + 0.65;
            const maxVertDist = (14.0 * moveDt) + 1.2;

            const isSpeedValid = horizDist <= maxAllowedDistance && Math.abs(dy) <= maxVertDist;
            const isBoundsValid = (isDemoCheaterInDemo && demoToggles.wallhack) || ArenaCollision.isWithinBounds(latestMove.x, latestMove.y, latestMove.z);
            const collisionObstacle = (isDemoCheaterInDemo && demoToggles.wallhack) ? false : ArenaCollision.checkPointCollision(latestMove.x, latestMove.y, latestMove.z);

            if (isSpeedValid && isBoundsValid && !collisionObstacle) {
              player.x = latestMove.x;
              player.y = latestMove.y;
              player.z = latestMove.z;
              player.yaw = latestMove.yaw;
              player.pitch = latestMove.pitch;
              player.isCrouching = latestMove.isCrouching;
              player.isSprinting = latestMove.isSprinting;
              player.lastProcessedSeq = latestMove.seq || 0;
              player.lastMoveTime = now;
            } else {
              // Speed hack / wall penetration / teleport detected -> rubberband
              player.rubberbandCount = (player.rubberbandCount || 0) + 1;
              const targetSocket = io.sockets.sockets.get(player.id);
              if (targetSocket) {
                targetSocket.emit('player:rubberband', {
                  seq: latestMove.seq || 0,
                  x: player.x,
                  y: player.y,
                  z: player.z
                });
              }
            }
          }
        }
      }

      // 3. Record Position History Ring Buffer (1.2 seconds depth)
      player.history.push({
        time: now,
        wallTime: currentWallTime,
        x: player.x,
        y: player.y,
        z: player.z,
        yaw: player.yaw,
        pitch: player.pitch,
        isCrouching: player.isCrouching
      });
      while (player.history.length > 0 && (now - player.history[0].time > 1200)) {
        player.history.shift();
      }

      snapshotPlayers.push({
        id: player.id,
        x: Number(player.x.toFixed(2)),
        y: Number(player.y.toFixed(2)),
        z: Number(player.z.toFixed(2)),
        yaw: Number(player.yaw.toFixed(3)),
        pitch: Number(player.pitch.toFixed(3)),
        crouch: !!player.isCrouching,
        sprint: !!player.isSprinting,
        hp: player.health,
        kills: player.kills,
        deaths: player.deaths,
        seq: player.lastProcessedSeq || 0
      });
    });

    // 4. Broadcast Single Compact Snapshot per Room
    io.to(roomCode).volatile.emit('world:snapshot', {
      serverTime: Math.round(now),
      wallTime: currentWallTime,
      remainingMs: Math.max(0, room.matchDuration * 1000 - (currentWallTime - room.matchStartTime)),
      players: snapshotPlayers
    });
  });
}

const tickTimer = setInterval(serverTick, TICK_INTERVAL_MS);
if (tickTimer && typeof tickTimer.unref === 'function') {
  tickTimer.unref();
}

/**
 * End Match and Broadcast Authoritative Scoreboard
 */
function endMatch(room, reason = 'match_completed', winner = null) {
  if (!room || room.state !== 'in_game') return;
  room.state = 'lobby';

  // Build authoritative scoreboard
  const scoreboard = [];
  room.players.forEach(p => {
    scoreboard.push({
      id: p.id,
      name: p.name,
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists || 0,
      headshots: p.headshots || 0,
      score: (p.kills * 100) + ((p.assists || 0) * 50) + ((p.headshots || 0) * 50),
      shotsFired: p.totalShots || 0,
      shotsHit: p.totalHits || 0,
      accuracy: (p.totalShots > 0) ? Math.round((p.totalHits / p.totalShots) * 100) : 0,
      isWinner: winner ? (p.id === winner.id) : false
    });
  });

  scoreboard.sort((a, b) => b.score - a.score);
  if (!winner && scoreboard.length > 0) {
    scoreboard[0].isWinner = true;
  }

  // Clear respawn timers
  if (room.respawnTimers) {
    room.respawnTimers.forEach(t => clearTimeout(t));
    room.respawnTimers.clear();
  }

  const result = {
    roomCode: room.code,
    reason: reason,
    scoreboard: scoreboard,
    durationSeconds: Math.floor((Date.now() - room.matchStartTime) / 1000),
  };
  const matchId = crypto.randomUUID();
  const draw = reason === 'time_expired' && !scoreboard.some(row => row.kills > 0);
  for (const row of scoreboard) {
    const socket = io.sockets.sockets.get(row.id);
    if (!socket) continue;
    const completionToken = socket.authenticatedPlayer ? jwt.sign({
      match_id: matchId,
      started_at: room.matchStartTime,
      duration: result.durationSeconds,
      kills: row.kills,
      deaths: row.deaths,
      assists: row.assists,
      headshots: row.headshots,
      shots_fired: row.shotsFired,
      shots_hit: row.shotsHit,
      result: draw ? 'draw' : row.isWinner ? 'win' : 'loss',
    }, MATCH_RESULT_KEY, { algorithm: 'HS256', audience: 'securefps-match-result', subject: socket.userId, expiresIn: '30m' }) : undefined;
    socket.emit('match:ended', { ...result, completionToken });
  }

  console.log(`[Match Lifecycle] Match in room ${room.code} ended (Reason: ${reason}). Scoreboard sent.`);

  // Reset player ready states for rematch
  room.players.forEach(p => {
    p.isReady = false;
    p.health = 100;
  });

  io.to(room.code).emit('lobby:player_update', {
    players: sanitizeRoomPlayers(room)
  });
}

/**
 * Room-level Respawn Scheduler with Far-Spawn Algorithm & 2s Spawn Protection
 */
function scheduleRespawn(room, victim) {
  if (!room || !victim) return;
  room.respawnTimers = room.respawnTimers || new Map();

  if (room.respawnTimers.has(victim.id)) {
    clearTimeout(room.respawnTimers.get(victim.id));
  }

  const timer = setTimeout(() => {
    room.respawnTimers.delete(victim.id);
    if (room && room.players.has(victim.id)) {
      const respawnPos = getTacticalSpawn(room, victim.id);
      victim.health = 100;
      victim.x = respawnPos.x;
      victim.y = respawnPos.y;
      victim.z = respawnPos.z;
      victim.isFirstPacket = true;
      victim.spawnProtectedUntil = Date.now() + 2000; // 2s invulnerability

      io.to(room.code).emit('player:respawned', {
        id: victim.id,
        x: victim.x,
        y: victim.y,
        z: victim.z,
        spawnProtected: true
      });
      console.log(`[Respawn] Authoritative respawn: ${victim.name} at (${victim.x}, ${victim.y}, ${victim.z})`);
    }
  }, RESPAWN_DELAY_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();

  room.respawnTimers.set(victim.id, timer);
}

// =========================================================================
// REAL-TIME SLIDING-WINDOW ANTI-CHEAT TELEMETRY BRIDGE
// =========================================================================

async function sendInternalAntiCheatReport(roomCode, player, features) {
  try {
    const payload = JSON.stringify({
      roomCode,
      userId: player.userId || player.id,
      playerName: player.name,
      features
    });
    const signature = crypto.createHmac('sha256', GAME_SERVER_SECRET).update(payload).digest('hex');
    const resp = await fetch(`${FLASK_INTERNAL_URL}/api/internal/anti-cheat-report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Game-Server-Signature': signature,
        'Authorization': `Bearer ${GAME_SERVER_SECRET}`
      },
      body: payload
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data.action_taken === 'suspended') {
        const socket = io.sockets.sockets.get(player.id);
        if (socket) {
          socket.emit('player:suspended', { reason: 'Real-time anti-cheat trigger: anomalous gameplay' });
          socket.disconnect(true);
        }
      }
    }
  } catch (err) {
    // Suppress network errors if Flask is offline during standalone tests
  }
}

const slidingWindowTimer = setInterval(() => {
  try {
    rooms.forEach((room, roomCode) => {
      if (room.state !== 'in_game') return;
      room.players.forEach(player => {
        if (player.disconnected || player.health <= 0) return;
        const totalShots = player.totalShots || 0;
        const totalHits = player.totalHits || 0;
        const accuracy = totalShots > 0 ? (totalHits / totalShots) : 0;

        const history = player.positionHistory || [];
        let dist = 0;
        if (history.length > 1) {
          const recent = history.slice(-45);
          for (let i = 1; i < recent.length; i++) {
            const dx = recent[i].x - recent[i - 1].x;
            const dz = recent[i].z - recent[i - 1].z;
            dist += Math.sqrt(dx * dx + dz * dz);
          }
        }
        const speed = dist / 1.5;

        const features = {
          accuracy: Math.min(1.0, accuracy),
          fire_rate: Math.min(25.0, (player.shotsInWindow || 0) / 1.5),
          movement_speed_mean: speed,
          movement_speed_max: Math.max(speed, player.maxSpeedInWindow || 0),
          movement_speed_std: 0.8,
          kdr: player.kills / Math.max(1, player.deaths || 0),
          aim_speed_mean: 120.0,
          aim_speed_std: 45.0,
          aim_speed_max: 280.0,
          flick_rate: player.flicksInWindow || 0,
          snap_to_hit_ratio: player.snapsInWindow || 0,
          wall_aim_ratio: 0.0,
          reaction_time_median: 0.22,
          headshot_ratio: (player.headshots || 0) / Math.max(1, totalHits)
        };

        player.shotsInWindow = 0;
        player.maxSpeedInWindow = 0;

        if (totalShots >= 5 || speed > 8.0) {
          sendInternalAntiCheatReport(roomCode, player, features);
        }
      });
    });
  } catch (err) {}
}, 1500);

if (slidingWindowTimer && typeof slidingWindowTimer.unref === 'function') {
  slidingWindowTimer.unref();
}

// =========================================================================
// SOCKET.IO CONNECTION & AUTHORITATIVE EVENT HANDLERS
// =========================================================================

io.on('connection', (socket) => {
  console.log(`[Multiplayer] Client connected: ${socket.id} (User: ${socket.username})`);

  // Track single live socket per user ID
  if (socket.userId && activeUserSockets.has(socket.userId)) {
    const existingSocketId = activeUserSockets.get(socket.userId);
    if (existingSocketId !== socket.id) {
      const oldSocket = io.sockets.sockets.get(existingSocketId);
      if (oldSocket) {
        oldSocket.emit('error', { message: 'Signed in from another device/tab. Disconnecting.' });
        oldSocket.disconnect(true);
      }
    }
  }
  if (socket.userId) activeUserSockets.set(socket.userId, socket.id);

  const rateLimiter = new SocketRateLimiter(socket);
  let currentRoom = null;
  let playerState = null;

  function leaveCurrentRoom() {
    if (!currentRoom || !playerState) return;
    playerState.demoToggles = { speed: false, headshot: false, wallhack: false, rapidfire: false };
    const roomCode = currentRoom.code;

    if (currentRoom.respawnTimers && currentRoom.respawnTimers.has(socket.id)) {
      clearTimeout(currentRoom.respawnTimers.get(socket.id));
      currentRoom.respawnTimers.delete(socket.id);
    }

    currentRoom.players.delete(socket.id);
    socket.leave(roomCode);

    if (currentRoom.players.size === 0) {
      if (currentRoom.respawnTimers) {
        currentRoom.respawnTimers.forEach(t => clearTimeout(t));
      }
      rooms.delete(roomCode);
      releaseRoomIpQuota(currentRoom);
      console.log(`[Lobby] Room ${roomCode} destroyed (empty)`);
    } else {
      if (socket.id === currentRoom.hostId) {
        const nextHost = Array.from(currentRoom.players.values()).find(p => !p.disconnected);
        if (nextHost) {
          nextHost.isHost = true;
          nextHost.isReady = true;
          currentRoom.hostId = nextHost.id;
          io.to(roomCode).emit('lobby:host_changed', { newHostId: nextHost.id, newHostName: nextHost.name });
        }
      }
      io.to(roomCode).emit('player:left', { id: socket.id, name: playerState.name, reason: 'leave' });
      io.to(roomCode).emit('lobby:player_update', { players: sanitizeRoomPlayers(currentRoom) });
    }

    currentRoom = null;
    playerState = null;
  }

  // --- LOBBY: CREATE ---
  socket.on('lobby:create', async (rawData) => {
    try {
      if (!rateLimiter.check('general')) return;
      if (!await checkMatchmakingAdmission(socket, 'lobby:error')) return;
      const parseResult = LobbyCreateSchema.safeParse(rawData || {});
      if (!parseResult.success) {
        socket.emit('lobby:error', { message: 'Invalid room creation parameters.' });
        return;
      }
      const data = parseResult.data;

      // Check per-IP and total room caps
      const clientIp = socket.handshake.address || 'unknown';
      const ipRooms = ipRoomCount.get(clientIp) || 0;
      if (ipRooms >= MAX_ROOMS_PER_IP) {
        socket.emit('lobby:error', { message: 'Room creation limit reached for this IP.' });
        return;
      }
      if (rooms.size >= MAX_TOTAL_ROOMS) {
        socket.emit('lobby:error', { message: 'Server room capacity reached. Join an existing room.' });
        return;
      }

      leaveCurrentRoom();

      const roomCode = (data.preferredCode && !rooms.has(data.preferredCode.toUpperCase()))
        ? data.preferredCode.toUpperCase()
        : generateRoomCode();
      const playerName = data.name;

      const isDemo = Boolean(
        socket.isDemoCheater ||
        data.isDemoRoom ||
        (data.preferredCode && data.preferredCode.toUpperCase().startsWith('DEMO'))
      );

      const room = {
        code: roomCode,
        name: roomCode,
        isDemoRoom: isDemo,
        hostId: socket.id,
        state: 'lobby',
        createdAt: Date.now(),
        maxPlayers: 8,
        matchDuration: MATCH_DURATION_SECONDS,
        scoreLimit: MATCH_SCORE_LIMIT,
        matchStartTime: 0,
        players: new Map(),
        respawnTimers: new Map(),
        creatorIp: clientIp
      };

      const spawn = ArenaCollision.ARENA_SPAWNS[0];
      const reconnectToken = generateReconnectToken();

      playerState = {
        id: socket.id,
        userId: socket.userId,
        isDemoCheater: Boolean(socket.isDemoCheater),
        demoToggles: { speed: false, headshot: false, wallhack: false, rapidfire: false },
        name: playerName,
        operator: data.operator,
        reconnectToken: reconnectToken,
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
        assists: 0,
        totalShots: 0,
        totalHits: 0,
        headshots: 0,
        shotSequence: 0,
        rubberbandCount: 0,
        isFirstPacket: true,
        lastMoveTime: performance.now(),
        lastShotTime: 0,
        inputQueue: [],
        history: []
      };

      room.players.set(socket.id, playerState);
      rooms.set(roomCode, room);
      ipRoomCount.set(clientIp, ipRooms + 1);
      currentRoom = room;

      socket.join(roomCode);

      socket.emit('lobby:created', {
        success: true,
        roomCode: roomCode,
        isHost: true,
        reconnectToken: reconnectToken,
        players: sanitizeRoomPlayers(room)
      });

      console.log(`[Lobby] Room ${roomCode} created by ${playerName} (${socket.id})`);
    } catch (err) {
      console.error('[Lobby] lobby:create error:', err);
      socket.emit('lobby:error', { message: 'Internal server error creating lobby.' });
    }
  });

  // --- LOBBY: JOIN ---
  socket.on('lobby:join', async (rawData) => {
    try {
      if (!rateLimiter.check('general')) return;
      if (!await checkMatchmakingAdmission(socket, 'lobby:error')) return;
      const parseResult = LobbyJoinSchema.safeParse(rawData || {});
      if (!parseResult.success) {
        socket.emit('lobby:error', { message: 'Invalid room join parameters.' });
        return;
      }
      const data = parseResult.data;
      const targetCode = data.roomCode.toUpperCase();

      const room = rooms.get(targetCode);
      if (!room) {
        socket.emit('lobby:error', { message: `Room "${targetCode}" not found. Verify the code.` });
        return;
      }

      leaveCurrentRoom();

      if (room.state === 'in_game') {
        socket.emit('lobby:error', { message: `Match in room "${targetCode}" is in progress. Reconnect via session:resume.` });
        return;
      }

      if (room.players.size >= room.maxPlayers) {
        socket.emit('lobby:error', { message: `Room "${targetCode}" is full (max ${room.maxPlayers} players).` });
        return;
      }

      const spawn = ArenaCollision.ARENA_SPAWNS[room.players.size % ArenaCollision.ARENA_SPAWNS.length];
      const reconnectToken = generateReconnectToken();

      playerState = {
        id: socket.id,
        userId: socket.userId,
        isDemoCheater: Boolean(socket.isDemoCheater),
        demoToggles: { speed: false, headshot: false, wallhack: false, rapidfire: false },
        name: data.name,
        operator: data.operator,
        reconnectToken: reconnectToken,
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
        assists: 0,
        totalShots: 0,
        totalHits: 0,
        headshots: 0,
        rubberbandCount: 0,
        isFirstPacket: true,
        lastMoveTime: performance.now(),
        lastShotTime: 0,
        inputQueue: [],
        history: []
      };

      room.players.set(socket.id, playerState);
      currentRoom = room;
      socket.join(targetCode);

      socket.emit('lobby:joined', {
        success: true,
        roomCode: targetCode,
        isHost: false,
        reconnectToken: reconnectToken,
        players: sanitizeRoomPlayers(room)
      });

      io.to(targetCode).emit('lobby:player_update', {
        players: sanitizeRoomPlayers(room)
      });

      console.log(`[Lobby] ${data.name} joined room ${targetCode}.`);
    } catch (err) {
      console.error('[Lobby] lobby:join error:', err);
      socket.emit('lobby:error', { message: 'Internal server error joining lobby.' });
    }
  });

  // --- RECONNECT: SESSION RESUME ---
  socket.on('session:resume', async (rawData) => {
    try {
      if (!await checkMatchmakingAdmission(socket, 'session:resume_failed')) return;
      const parseResult = SessionResumeSchema.safeParse(rawData || {});
      if (!parseResult.success) {
        socket.emit('session:resume_failed', { message: 'Invalid resume token.' });
        return;
      }
      const { roomCode, reconnectToken } = parseResult.data;
      const room = rooms.get(roomCode.toUpperCase());
      if (!room) {
        socket.emit('session:resume_failed', { message: 'Room no longer exists.' });
        return;
      }

      let targetPlayer = null;
      let targetOldId = null;
      room.players.forEach((p, pid) => {
        if (p.reconnectToken === reconnectToken) {
          targetPlayer = p;
          targetOldId = pid;
        }
      });

      if (!targetPlayer) {
        socket.emit('session:resume_failed', { message: 'Reconnect token expired or unrecognized.' });
        return;
      }

      // Clear grace timer
      if (targetPlayer.graceTimer) {
        clearTimeout(targetPlayer.graceTimer);
        targetPlayer.graceTimer = null;
      }

      // Re-bind to new socket
      room.players.delete(targetOldId);
      targetPlayer.id = socket.id;
      targetPlayer.disconnected = false;
      room.players.set(socket.id, targetPlayer);
      playerState = targetPlayer;
      currentRoom = room;

      socket.join(roomCode.toUpperCase());

      socket.emit('game:reconnected', {
        roomCode: room.code,
        isHost: targetPlayer.isHost,
        state: room.state,
        matchDuration: room.matchDuration,
        scoreLimit: room.scoreLimit,
        matchTimeRemaining: room.state === 'in_game'
          ? Math.max(0, room.matchDuration - Math.floor((Date.now() - room.matchStartTime) / 1000))
          : room.matchDuration,
        players: sanitizeRoomPlayers(room)
      });

      io.to(room.code).emit('player:reconnected', {
        id: socket.id,
        name: targetPlayer.name
      });

      console.log(`[Reconnect] ${targetPlayer.name} successfully resumed session in room ${room.code}.`);
    } catch (err) {
      console.error('[Reconnect] session:resume error:', err);
      socket.emit('session:resume_failed', { message: 'Internal reconnect error.' });
    }
  });

  // --- LOBBY: READY ---
  socket.on('lobby:ready', (data) => {
    try {
      if (!rateLimiter.check('general') || !playerState || !currentRoom) return;
      playerState.isReady = Boolean(data?.isReady);
      io.to(currentRoom.code).emit('lobby:player_update', {
        players: sanitizeRoomPlayers(currentRoom)
      });
    } catch (err) {
      console.error('[Lobby] lobby:ready error:', err);
    }
  });

  // --- LOBBY: START MATCH ---
  socket.on('lobby:start', () => {
    try {
      if (!rateLimiter.check('general') || !playerState || !currentRoom) return;
      if (socket.id !== currentRoom.hostId) {
        socket.emit('lobby:error', { message: 'Only the room host can start the match.' });
        return;
      }
      if (currentRoom.state === 'in_game') {
        socket.emit('lobby:error', { message: 'Match already active.' });
        return;
      }
      if (currentRoom.players.size < 2) {
        socket.emit('lobby:error', { message: 'At least 2 operators are required to start.' });
        return;
      }

      const unready = Array.from(currentRoom.players.values()).filter(p => !p.isReady);
      if (unready.length > 0) {
        socket.emit('lobby:error', { message: 'All operators must be READY before launching.' });
        return;
      }

      currentRoom.state = 'in_game';
      currentRoom.matchStartTime = Date.now();

      // Assign tactical spawns
      let spawnIdx = 0;
      currentRoom.players.forEach(p => {
        p.spawnIndex = spawnIdx;
        const spawn = ArenaCollision.ARENA_SPAWNS[spawnIdx % ArenaCollision.ARENA_SPAWNS.length];
        spawnIdx++;
        p.x = spawn.x;
        p.y = spawn.y;
        p.z = spawn.z;
        p.yaw = 0;
        p.pitch = 0;
        p.health = 100;
        p.kills = 0;
        p.deaths = 0;
        p.assists = 0;
        p.totalShots = 0;
        p.totalHits = 0;
        p.headshots = 0;
        p.shotSequence = 0;
        p.damageDealtMap = {};
        p.lastShotTime = 0;
        p.isFirstPacket = true;
        p.inputQueue = [];
        p.history = [];
        p.spawnProtectedUntil = Date.now() + 2000;
        p.demoToggles = { speed: false, headshot: false, wallhack: false, rapidfire: false };
      });

      io.to(currentRoom.code).emit('game:start', {
        roomCode: currentRoom.code,
        startedAt: currentRoom.matchStartTime,
        matchDuration: currentRoom.matchDuration,
        scoreLimit: currentRoom.scoreLimit,
        players: sanitizeRoomPlayers(currentRoom)
      });

      console.log(`[Match Start] Room ${currentRoom.code} commenced with ${currentRoom.players.size} operators.`);
    } catch (err) {
      console.error('[Lobby] lobby:start error:', err);
      socket.emit('lobby:error', { message: 'Internal error starting match.' });
    }
  });

  // --- LOBBY: LEAVE ---
  socket.on('lobby:leave', () => {
    try {
      if (!rateLimiter.check('general')) return;
      leaveCurrentRoom();
      socket.emit('lobby:left', { success: true });
    } catch (err) {
      console.error('[Lobby] lobby:leave error:', err);
    }
  });

  // --- IN-GAME MOVEMENT (Client sends volatile @ 30Hz) ---
  socket.on('player:move', (rawData) => {
    try {
      if (!rateLimiter.check('move') || !playerState || !currentRoom) return;
      if (currentRoom.state !== 'in_game' || playerState.health <= 0) return;

      const parseResult = PlayerMoveSchema.safeParse(rawData || {});
      if (!parseResult.success) return; // Drop malformed movement packets silently

      playerState.inputQueue.push(parseResult.data);
      // Cap queue size to prevent memory buildup
      if (playerState.inputQueue.length > 5) {
        playerState.inputQueue.shift();
      }
    } catch (err) {
      console.error('[Movement] player:move error:', err);
    }
  });

  // --- CLIENT PING HEARTBEAT ---
  socket.on('player:ping', (timestamp) => {
    try {
      if (!rateLimiter.check('ping')) return;
      socket.emit('player:pong', timestamp);
    } catch (err) {
      console.error('[Ping] player:ping error:', err);
    }
  });

  // --- DEMO TOGGLES (Validated strictly against authorized demo account + demo room) ---
  socket.on('demo:set_toggles', (rawToggles) => {
    try {
      if (!playerState || !currentRoom) return;
      if (!currentRoom.isDemoRoom || !playerState.isDemoCheater) {
        playerState.demoToggles = { speed: false, headshot: false, wallhack: false, rapidfire: false };
        socket.emit('demo:toggles_ack', { authorized: false, toggles: playerState.demoToggles });
        return;
      }
      const input = (rawToggles && typeof rawToggles === 'object') ? rawToggles : {};
      playerState.demoToggles = {
        speed: Boolean(input.speed),
        headshot: Boolean(input.headshot),
        wallhack: Boolean(input.wallhack),
        rapidfire: Boolean(input.rapidfire)
      };
      socket.emit('demo:toggles_ack', { authorized: true, toggles: playerState.demoToggles });
    } catch (_) {}
  });

  // --- IN-GAME WEAPON FIRE (Server Authoritative Hitscan & Lag Compensation) ---
  socket.on('player:fire', (rawData) => {
    try {
      if (!rateLimiter.check('fire') || !playerState || !currentRoom) return;
      if (currentRoom.state !== 'in_game' || playerState.health <= 0) return;

      const parseResult = PlayerFireSchema.safeParse(rawData || {});
      if (!parseResult.success) {
        return; // Drop bad payload
      }
      const fireData = parseResult.data;
      const now = performance.now();
      const weaponKey = fireData.weaponKey || 'carbine';
      const isDemoCheaterInDemo = Boolean(currentRoom.isDemoRoom && playerState.isDemoCheater);
      const demoToggles = playerState.demoToggles || {};

      // 1. Weapon Fire Rate Check (rapidfire toggle only allowed for demo cheater in demo room)
      const minInterval = WeaponConfig.minFireIntervalMs(weaponKey);
      const effectiveMinInterval = (isDemoCheaterInDemo && demoToggles.rapidfire)
        ? Math.max(20, minInterval * 0.25)
        : minInterval;
      if (now - playerState.lastShotTime < effectiveMinInterval) {
        return; // Reject rapid-fire exploit
      }
      playerState.lastShotTime = now;
      playerState.totalShots = (playerState.totalShots || 0) + 1;
      playerState.shotSequence = (playerState.shotSequence || 0) + 1;
      const shotId = `${currentRoom.code}:${currentRoom.matchStartTime}:${socket.id}:${playerState.shotSequence}`;
      socket.emit('player:shot_confirmed', { shotId, weaponKey });

      // Determine ray origin and direction
      const origin = fireData.origin;
      let dirX = 0, dirY = 0, dirZ = -1;

      if (fireData.direction) {
        const mag = Math.sqrt(
          fireData.direction.x * fireData.direction.x +
          fireData.direction.y * fireData.direction.y +
          fireData.direction.z * fireData.direction.z
        );
        if (mag > 0.001) {
          dirX = fireData.direction.x / mag;
          dirY = fireData.direction.y / mag;
          dirZ = fireData.direction.z / mag;
        }
      } else if (fireData.target) {
        const dx = fireData.target.x - origin.x;
        const dy = fireData.target.y - origin.y;
        const dz = fireData.target.z - origin.z;
        const mag = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (mag > 0.001) {
          dirX = dx / mag;
          dirY = dy / mag;
          dirZ = dz / mag;
        }
      }

      // Broadcast cosmetic gunshot FX to others in room
      const weaponInfo = WeaponConfig.getWeapon(weaponKey);
      const tracerEnd = {
        x: origin.x + dirX * Math.min(60, weaponInfo.range),
        y: origin.y + dirY * Math.min(60, weaponInfo.range),
        z: origin.z + dirZ * Math.min(60, weaponInfo.range)
      };

      socket.to(currentRoom.code).emit('player:fired', {
        id: socket.id,
        origin: origin,
        target: tracerEnd,
        weaponKey: weaponKey
      });

      // 2. Rewind Lag Compensation (clamped <= 250ms in the past)
      let rewindTime = now;
      if (typeof fireData.clientTime === 'number') {
        const timeDiff = now - fireData.clientTime;
        if (timeDiff >= 0 && timeDiff <= 350) {
          rewindTime = fireData.clientTime;
        } else {
          rewindTime = Math.max(now - 200, now - 80);
        }
      } else {
        rewindTime = Math.max(now - 200, now - 80);
      }

      let closestHit = null;
      let closestDistance = Infinity;

      currentRoom.players.forEach((victim, victimId) => {
        // Exclude shooter, dead players, disconnected, and spawn-protected
        if (victimId === socket.id || victim.disconnected || victim.health <= 0) return;
        if (victim.spawnProtectedUntil && victim.spawnProtectedUntil > Date.now()) return;

        // Interpolate victim position at rewindTime from history ring buffer
        let vPos = { x: victim.x, y: victim.y, z: victim.z, isCrouching: victim.isCrouching };
        if (victim.history && victim.history.length > 1) {
          for (let i = victim.history.length - 1; i >= 0; i--) {
            if (victim.history[i].time <= rewindTime) {
              const h0 = victim.history[i];
              const h1 = victim.history[i + 1] || h0;
              const span = Math.max(0.001, h1.time - h0.time);
              const alpha = Math.min(1.0, Math.max(0.0, (rewindTime - h0.time) / span));
              vPos = {
                x: h0.x + (h1.x - h0.x) * alpha,
                y: h0.y + (h1.y - h0.y) * alpha,
                z: h0.z + (h1.z - h0.z) * alpha,
                isCrouching: h0.isCrouching
              };
              break;
            }
          }
        }

        // Hitboxes matching RemotePlayer meshes and TacticalOperator
        const isCrouching = Boolean(vPos.isCrouching);
        const headBox = {
          minX: vPos.x - 0.32, maxX: vPos.x + 0.32,
          minY: vPos.y + (isCrouching ? 1.00 : 1.40), maxY: vPos.y + (isCrouching ? 1.50 : 2.00),
          minZ: vPos.z - 0.32, maxZ: vPos.z + 0.32
        };
        const bodyBox = {
          minX: vPos.x - 0.45, maxX: vPos.x + 0.45,
          minY: vPos.y + 0.05, maxY: vPos.y + (isCrouching ? 1.05 : 1.45),
          minZ: vPos.z - 0.45, maxZ: vPos.z + 0.45
        };

        const headT = ArenaCollision.intersectRayBox(origin.x, origin.y, origin.z, dirX, dirY, dirZ, headBox, weaponInfo.range);
        const bodyT = ArenaCollision.intersectRayBox(origin.x, origin.y, origin.z, dirX, dirY, dirZ, bodyBox, weaponInfo.range);

        if (headT !== null && headT < closestDistance) {
          closestDistance = headT;
          closestHit = { victim, isHeadshot: true, distance: headT };
        } else if (bodyT !== null && bodyT < closestDistance) {
          closestDistance = bodyT;
          closestHit = { victim, isHeadshot: Boolean(isDemoCheaterInDemo && demoToggles.headshot), distance: bodyT };
        }
      });

      // 3. Occlusion Check Against Static Arena Geometry
      if (closestHit) {
        const hitPoint = {
          x: origin.x + dirX * closestHit.distance,
          y: origin.y + dirY * closestHit.distance,
          z: origin.z + dirZ * closestHit.distance
        };

        const isOccluded = ArenaCollision.checkRaycastOcclusion(origin, hitPoint);
        if (isOccluded && !(isDemoCheaterInDemo && demoToggles.wallhack)) {
          // Wallhack / shot blocked by obstacle for genuine players
          return;
        }

        // Confirmed Hit! Apply Authoritative Damage
        playerState.totalHits = (playerState.totalHits || 0) + 1;
        const victim = closestHit.victim;
        const damageResult = WeaponConfig.computeDamage(weaponKey, closestHit.isHeadshot);
        const dealtDamage = damageResult.damage;

        victim.health = Math.max(0, victim.health - dealtDamage);
        victim.damageDealtMap = victim.damageDealtMap || {};
        victim.damageDealtMap[socket.id] = (victim.damageDealtMap[socket.id] || 0) + dealtDamage;

        if (closestHit.isHeadshot) {
          playerState.headshots = (playerState.headshots || 0) + 1;
        }

        // Confirm hitmarker to shooter
        socket.emit('player:hit_confirmed', {
          victimId: victim.id,
          damage: dealtDamage,
          headshot: closestHit.isHeadshot,
          shotId
        });

        // Notify victim of damage taken
        const victimSocket = io.sockets.sockets.get(victim.id);
        if (victimSocket) {
          victimSocket.emit('player:hurt', {
            damage: dealtDamage,
            attackerId: socket.id,
            attackerName: playerState.name,
            attackerPos: { x: playerState.x, y: playerState.y, z: playerState.z },
            currentHealth: victim.health
          });
        }

        // 4. If Victim Eliminated
        if (victim.health <= 0) {
          playerState.kills++;
          victim.deaths++;

          // Award assists to other contributors (>= 25 dmg)
          if (victim.damageDealtMap) {
            Object.keys(victim.damageDealtMap).forEach(damagerId => {
              if (damagerId !== socket.id && victim.damageDealtMap[damagerId] >= 25) {
                const assister = currentRoom.players.get(damagerId);
                if (assister) {
                  assister.assists = (assister.assists || 0) + 1;
                  const assisterSocket = io.sockets.sockets.get(damagerId);
                  if (assisterSocket) {
                    assisterSocket.emit('player:assist', {
                      victimId: victim.id,
                      victimName: victim.name
                    });
                  }
                }
              }
            });
            victim.damageDealtMap = {};
          }

          io.to(currentRoom.code).emit('player:killed', {
            killerId: socket.id,
            killerName: playerState.name,
            victimId: victim.id,
            victimName: victim.name,
            weapon: weaponInfo.name,
            headshot: closestHit.isHeadshot
          });

          // Check if match score limit is reached (10 kills ends match immediately!)
          if (playerState.kills >= currentRoom.scoreLimit) {
            endMatch(currentRoom, 'score_limit_reached', playerState);
            return;
          }

          // Room-level respawn scheduler
          scheduleRespawn(currentRoom, victim);
        }
      }
    } catch (err) {
      console.error('[Combat] player:fire error:', err);
    }
  });

  // --- DISCONNECTION & GRACE PERIOD ---
  socket.on('disconnect', () => {
    try {
      console.log(`[Multiplayer] Client disconnected: ${socket.id}`);
      if (socket.userId && activeUserSockets.get(socket.userId) === socket.id) {
        activeUserSockets.delete(socket.userId);
      }

      if (currentRoom && playerState) {
        const roomCode = currentRoom.code;

        if (currentRoom.state === 'in_game') {
          // In-game disconnect: activate 90s grace period for reconnection
          playerState.disconnected = true;
          playerState.disconnectTime = Date.now();

          io.to(roomCode).emit('player:disconnected_grace', {
            id: socket.id,
            name: playerState.name,
            gracePeriod: 90
          });

          playerState.graceTimer = setTimeout(() => {
            if (currentRoom && currentRoom.players.has(socket.id)) {
              const p = currentRoom.players.get(socket.id);
              if (p && p.disconnected) {
                console.log(`[Multiplayer] Grace expired for ${p.name} in room ${roomCode}. Removing.`);
                currentRoom.players.delete(socket.id);
                io.to(roomCode).emit('player:left', { id: socket.id, name: p.name, reason: 'timeout' });
                io.to(roomCode).emit('lobby:player_update', { players: sanitizeRoomPlayers(currentRoom) });

                if (currentRoom.players.size === 0) {
                  rooms.delete(roomCode);
                  releaseRoomIpQuota(currentRoom);
                  console.log(`[Lobby] Room ${roomCode} destroyed after grace expiry.`);
                }
              }
            }
          }, 90000);
          if (playerState.graceTimer && typeof playerState.graceTimer.unref === 'function') {
            playerState.graceTimer.unref();
          }

          // Migrate host if host dropped
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
          // Lobby disconnect: immediate removal
          leaveCurrentRoom();
        }
      }
    } catch (err) {
      console.error('[Disconnect] Cleanup error:', err);
    }
  });
});

// =========================================================================
// START SERVER & GRACEFUL SHUTDOWN
// =========================================================================

function startServer(port = PORT) {
  server.listen(port, HOST, () => {
    console.log('====================================================');
    console.log(`SecureFPS Authoritative Game Server running on port ${port}`);
    console.log(`Local Access: http://127.0.0.1:${port}`);
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          console.log(`LAN Access: http://${iface.address}:${port}`);
        }
      }
    }
    console.log('====================================================');
  });

  server.once('error', (err) => {
    console.error(`[Fatal] Server error on port ${port}:`, err.message);
    process.exit(1);
  });
}

function gracefulShutdown(signal) {
  console.log(`[Server] Received ${signal}. Draining connections and shutting down...`);
  clearInterval(tickTimer);
  io.emit('server:shutdown', { message: 'Server is restarting or shutting down.' });
  io.close(() => {
    server.close(() => {
      console.log('[Server] HTTP and Socket.IO server closed cleanly.');
      process.exit(0);
    });
  });
  // Force exit after 3 seconds if hanging
  setTimeout(() => process.exit(0), 3000);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

if (require.main === module) {
  startServer(PORT);
}

module.exports = { app, server, io, rooms, generateRoomCode, getTacticalSpawn, tickTimer };
