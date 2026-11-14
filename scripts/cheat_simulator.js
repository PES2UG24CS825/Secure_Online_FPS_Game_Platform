#!/usr/bin/env node
/**
 * SecureFPS: Headless Cheat Simulator
 * Simulates adversarial cheat patterns against the Authoritative Multiplayer Server
 * 
 * Cheat Modes:
 * 1. speedhack: Sends excessive kinematic displacement exceeding the 7.5m/s sprint limit.
 * 2. teleport: Sends sudden out-of-bounds coordinates through arena obstacles.
 * 3. aimbot: Sends inhuman snap angles and 100% headshot accuracy bursts.
 * 
 * Usage:
 *   node scripts/cheat_simulator.js [--mode speedhack|teleport|aimbot|all] [--port 4001]
 */

const ioClient = require('socket.io-client');
const jwt = require('jsonwebtoken');

const SERVER_URL = process.env.GAME_SERVER_URL || `http://127.0.0.1:${process.argv[3] || '4001'}`;
const SECRET = process.env.GAME_SERVER_SECRET || 'securefps-multiplayer-secret-key-2026';
const MODE = process.argv.includes('--mode') ? process.argv[process.argv.indexOf('--mode') + 1] : 'all';

console.log('====================================================');
console.log('SecureFPS Headless Cheat Simulator');
console.log(`Target Game Server: ${SERVER_URL}`);
console.log(`Active Mode: ${MODE}`);
console.log('====================================================\n');

function makeToken(userId, name) {
  return jwt.sign({ userId, username: name, sessionId: `sim-${Date.now()}` }, SECRET, { expiresIn: '1h' });
}

async function runSimulator() {
  const userId = `cheat-sim-${Math.random().toString(36).substring(2, 7)}`;
  const username = `Hacker_${MODE.toUpperCase()}`;
  const token = makeToken(userId, username);

  const socket = ioClient(SERVER_URL, {
    transports: ['websocket'],
    auth: { token, userId, name: username }
  });

  socket.on('connect', async () => {
    console.log(`[+] Connected to game server as ${username} (Socket: ${socket.id})`);

    // 1. Create or join room
    socket.emit('lobby:create', { name: username });

    socket.once('lobby:created', async (roomData) => {
      const roomCode = roomData.roomCode;
      console.log(`[+] Room created: ${roomCode}. Initializing match...`);

      // Start the match
      socket.emit('lobby:ready', { isReady: true });
      socket.emit('lobby:start_match', { roomCode });

      await new Promise(r => setTimeout(r, 600));

      if (MODE === 'speedhack' || MODE === 'all') {
        await executeSpeedHack(socket);
      }
      if (MODE === 'teleport' || MODE === 'all') {
        await executeTeleport(socket);
      }
      if (MODE === 'aimbot' || MODE === 'all') {
        await executeAimbot(socket);
      }

      setTimeout(() => {
        console.log('\n[+] Simulation run complete. Disconnecting.');
        socket.disconnect();
        process.exit(0);
      }, 1500);
    });
  });

  socket.on('player:rubberband', (data) => {
    console.log(`[ANTI-CHEAT DETECTED] Server rubberbanded position back to (${data.x.toFixed(2)}, ${data.y.toFixed(2)}, ${data.z.toFixed(2)})! Velocity clamped.`);
  });

  socket.on('player:suspended', (data) => {
    console.log(`[ANTI-CHEAT ENFORCED] Server suspended account! Reason: ${data.reason || 'Anomalous sliding window features'}`);
  });

  socket.on('disconnect', (reason) => {
    console.log(`[-] Socket disconnected: ${reason}`);
  });

  socket.on('connect_error', (err) => {
    console.error(`[-] Connection failed: ${err.message}. Is the multiplayer server running on ${SERVER_URL}?`);
    process.exit(1);
  });
}

async function executeSpeedHack(socket) {
  console.log('\n>>> EXECUTING SPEED HACK ATTACK (Attempting 45 m/s displacement)...');
  let currentX = 0;
  for (let i = 0; i < 15; i++) {
    currentX += 6.5; // Exceeds per-tick max speed budget
    socket.volatile.emit('player:move', {
      seq: i + 1,
      clientTime: Date.now(),
      x: currentX,
      y: 0,
      z: 10,
      yaw: 0,
      pitch: 0,
      isCrouching: false,
      isSprinting: true
    });
    await new Promise(r => setTimeout(r, 33)); // 30Hz tick rate
  }
}

async function executeTeleport(socket) {
  console.log('\n>>> EXECUTING TELEPORT ATTACK (Attempting instant +80m phase through walls)...');
  socket.volatile.emit('player:move', {
    seq: 999,
    clientTime: Date.now(),
    x: 85.0, // Outside arena bounds
    y: 0.0,
    z: -95.0,
    yaw: 0,
    pitch: 0,
    isCrouching: false,
    isSprinting: false
  });
  await new Promise(r => setTimeout(r, 100));
}

async function executeAimbot(socket) {
  console.log('\n>>> EXECUTING AIMBOT SNAP ATTACK (Inhuman 180° snap & 100% precision burst)...');
  for (let i = 0; i < 10; i++) {
    socket.emit('player:fire', {
      clientTime: Date.now(),
      seq: i + 1,
      origin: { x: 0, y: 1.6, z: 0 },
      direction: { x: 0, y: 0, z: -1 },
      weaponKey: 'carbine'
    });
    await new Promise(r => setTimeout(r, 90)); // Max cyclic rate
  }
}

runSimulator();
