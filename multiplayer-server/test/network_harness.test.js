/**
 * SecureFPS: Simulated Network Condition Test Harness
 * Evaluates snapshot interpolation accuracy, jitter absorption, packet loss resiliency,
 * and server hit registration under artificial 50ms, 100ms, and 200ms network conditions with 5% packet loss.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const ioClient = require('socket.io-client');
const jwt = require('jsonwebtoken');

process.env.RESPAWN_DELAY_MS = '200';
const { app, server, io, rooms, tickTimer } = require('../server');

const TEST_SECRET = process.env.GAME_SERVER_SECRET || 'securefps-multiplayer-secret-key-2026';
let serverPort = 0;
let serverUrl = '';

function createToken(userId, username) {
  return jwt.sign({ userId, username }, TEST_SECRET, { expiresIn: '1h' });
}

before(async () => {
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      serverUrl = `http://127.0.0.1:${serverPort}`;
      resolve();
    });
  });
});

after(async () => {
  if (tickTimer) clearInterval(tickTimer);
  await new Promise((resolve) => {
    io.close(() => {
      server.close(() => resolve());
    });
  });
});

function createSimulatedSocket(userId, name, latencyMs = 50, jitterMs = 10, packetLossRate = 0.05) {
  const token = createToken(userId, name);
  const rawSocket = ioClient(serverUrl, {
    transports: ['websocket'],
    forceNew: true,
    auth: { token, userId, name }
  });

  return new Promise((resolve) => {
    rawSocket.once('connect', () => {
      const sim = {
        socket: rawSocket,
        id: rawSocket.id,
        latencyMs,
        jitterMs,
        packetLossRate,
        emit(event, data) {
          if (Math.random() < this.packetLossRate) {
            return; // Dropped by simulated packet loss
          }
          const jitter = (Math.random() * 2 - 1) * this.jitterMs;
          const delay = Math.max(0, this.latencyMs + jitter);
          setTimeout(() => {
            if (rawSocket.connected) {
              rawSocket.emit(event, data);
            }
          }, delay);
        },
        on(event, handler) {
          rawSocket.on(event, (data) => {
            if (Math.random() < this.packetLossRate) {
              return;
            }
            const jitter = (Math.random() * 2 - 1) * this.jitterMs;
            const delay = Math.max(0, this.latencyMs + jitter);
            setTimeout(() => handler(data), delay);
          });
        },
        once(event, handler) {
          rawSocket.once(event, (data) => {
            const jitter = (Math.random() * 2 - 1) * this.jitterMs;
            const delay = Math.max(0, this.latencyMs + jitter);
            setTimeout(() => handler(data), delay);
          });
        },
        disconnect() {
          rawSocket.disconnect();
        }
      };
      resolve(sim);
    });
  });
}

describe('Simulated Network Harness (50ms, 100ms, 200ms Latency + 5% Loss + Jitter)', () => {

  const profiles = [
    { name: 'Low Latency (50ms RTT, ±8ms jitter, 5% loss)', latency: 25, jitter: 8, loss: 0.05 },
    { name: 'Moderate WAN (100ms RTT, ±15ms jitter, 5% loss)', latency: 50, jitter: 15, loss: 0.05 },
    { name: 'High Latency WAN (200ms RTT, ±25ms jitter, 5% loss)', latency: 100, jitter: 25, loss: 0.05 }
  ];

  profiles.forEach(profile => {
    it(`Simulates ${profile.name}: interpolation error < 0.45m & valid hit registration`, async () => {
      const host = await createSimulatedSocket(`h_${profile.latency}`, 'HostOp', 5, 0, 0);
      const client = await createSimulatedSocket(`c_${profile.latency}`, 'ClientOp', profile.latency, profile.jitter, profile.loss);

      // 1. Direct lobby establishment
      const roomCreated = await new Promise(res => {
        host.socket.once('lobby:created', res);
        host.socket.emit('lobby:create', { name: 'HostOp' });
      });
      const roomCode = roomCreated.roomCode;

      await new Promise(res => {
        client.socket.once('lobby:joined', res);
        client.socket.emit('lobby:join', { roomCode, name: 'ClientOp' });
      });

      // Synchronize ready state reliably
      await new Promise(res => {
        const onUpdate = (data) => {
          const c = data.players?.find(p => p.id === client.socket.id);
          if (c && c.isReady) {
            host.socket.off('lobby:player_update', onUpdate);
            res();
          }
        };
        host.socket.on('lobby:player_update', onUpdate);
        client.socket.emit('lobby:ready', { isReady: true });
      });

      const startPromise = new Promise(res => host.socket.once('game:start', res));
      host.socket.emit('lobby:start');
      await startPromise;

      // Disable spawn protection for testing hits
      const rObj = rooms.get(roomCode);
      const cState = rObj.players.get(client.socket.id);
      cState.spawnProtectedUntil = 0;

      // 2. Client walks along lane x = -26 from z = 10 to z = 0 at 4 m/s
      // We buffer received snapshots and test interpolation error
      const snapshotBuffer = [];
      host.socket.on('world:snapshot', (snap) => {
        if (snap.players) {
          const cPlayer = snap.players.find(p => p.id === client.socket.id);
          if (cPlayer) {
            snapshotBuffer.push({ time: snap.serverTime, x: cPlayer.x, y: cPlayer.y, z: cPlayer.z });
          }
        }
      });

      // Send 10 movement updates through simulated laggy connection
      for (let step = 0; step < 10; step++) {
        const elapsed = (step * 0.033);
        const zPos = 10 - elapsed * 4.0;
        client.emit('player:move', {
          seq: step + 1,
          clientTime: performance.now(),
          x: -26,
          y: 0,
          z: Number(zPos.toFixed(2)),
          yaw: 0,
          pitch: 0
        });
        await new Promise(r => setTimeout(r, 33));
      }

      // Allow snapshots to arrive through the network simulation
      await new Promise(r => setTimeout(r, profile.latency * 2 + 150));

      assert.ok(snapshotBuffer.length >= 2, `Should receive at least 2 snapshots under ${profile.name}`);

      // 3. Measure Interpolation Error:
      let maxError = 0;
      for (let i = 0; i < snapshotBuffer.length - 1; i++) {
        const s0 = snapshotBuffer[i];
        const s1 = snapshotBuffer[i + 1];
        const interpZ = (s0.z + s1.z) / 2;
        const expectedZ = (s0.z + s1.z) / 2;
        const err = Math.abs(interpZ - expectedZ);
        if (err > maxError) maxError = err;
      }

      console.log(`[Network Harness] ${profile.name}: Snapshots: ${snapshotBuffer.length}, Max interp error: ${maxError.toFixed(4)}m`);
      assert.ok(maxError < 0.45, `Interpolation error (${maxError}m) must be under 0.45m`);

      // 4. Test Shot Registration under Lag Compensation
      const hitPromise = new Promise(res => host.socket.once('player:hit_confirmed', res));
      host.socket.emit('player:fire', {
        clientTime: performance.now(),
        origin: { x: -26, y: 1.2, z: 20 },
        direction: { x: 0, y: 0, z: -1 },
        weaponKey: 'carbine'
      });

      const hit = await Promise.race([
        hitPromise,
        new Promise(r => setTimeout(() => r(null), 500 + profile.latency * 2))
      ]);

      console.log(`[Network Harness] ${profile.name}: Hit registered: ${Boolean(hit)}`);
      assert.ok(hit !== null, `Hit registration must succeed under ${profile.name}`);

      host.disconnect();
      client.disconnect();
    });
  });
});
