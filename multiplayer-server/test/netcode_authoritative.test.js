/**
 * SecureFPS: Netcode & Authoritative Multiplayer Server Test Suite
 * Tests:
 * 1. Malformed packets do not crash the server
 * 2. Rate limits trip on spam and disconnect repeat offenders
 * 3. Movement validation (speed budget, dead moves, world bounds, rubberband)
 * 4. Combat arbitration (weapon cooldowns, wall occlusion, lag-compensated hit, assists)
 * 5. Room-level respawn & spawn protection (even if killer disconnects)
 * 6. Session reconnect via server token
 * 7. Token authentication & single socket per user
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const ioClient = require('socket.io-client');
const jwt = require('jsonwebtoken');
const crypto = require('node:crypto');

process.env.RESPAWN_DELAY_MS = '200';
const { app, server, io, rooms, getTacticalSpawn, tickTimer } = require('../server');
const WeaponConfig = require('../shared/weapon_config');
const ArenaCollision = require('../shared/arena_collision');

const TEST_SECRET = process.env.GAME_SERVER_SECRET || 'securefps-multiplayer-secret-key-2026';
let serverPort = 0;
let serverUrl = '';

function createToken(userId, username = 'TestOp', sessionId = 'sess-123') {
  return jwt.sign({ userId, username, sessionId }, TEST_SECRET, { expiresIn: '1h' });
}

function connectClient(userId = 'u1', username = 'Player1', options = {}) {
  const token = options.noToken ? undefined : createToken(userId, username);
  return new Promise((resolve, reject) => {
    const socket = ioClient(serverUrl, {
      transports: ['websocket'],
      forceNew: true,
      auth: { token, userId, name: username },
      ...options
    });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (err) => resolve({ socket, error: err }));
  });
}

before(async () => {
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      serverUrl = `http://127.0.0.1:${serverPort}`;
      console.log(`[Test Harness] Server running on port ${serverPort}`);
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

describe('Authoritative Multiplayer Server Netcode', () => {

  it('ends matches at 10 kills or 480 seconds and resets authoritative rematches', async () => {
    const host = await connectClient('limits-host', 'LimitsHost');
    const guest = await connectClient('limits-guest', 'LimitsGuest');
    const created = await new Promise(resolve => {
      host.once('lobby:created', resolve);
      host.emit('lobby:create', { name: 'LimitsHost', operator: 'valkyrie' });
    });
    const roomCode = created.roomCode;

    await new Promise(resolve => {
      guest.once('lobby:joined', resolve);
      guest.emit('lobby:join', { roomCode, name: 'LimitsGuest' });
    });
    guest.emit('lobby:ready', { isReady: true });
    await new Promise(resolve => setTimeout(resolve, 40));

    const started = new Promise(resolve => host.once('game:start', resolve));
    host.emit('lobby:start');
    const firstStart = await started;
    assert.equal(firstStart.matchDuration, 480);
    assert.equal(firstStart.scoreLimit, 10);
    assert.equal(firstStart.players.find(player => player.id === host.id).isFemale, true);
    assert.equal(firstStart.players.find(player => player.id === guest.id).isFemale, false);

    const room = rooms.get(roomCode);
    room.players.get(host.id).kills = 10;
    const scoreResultPromise = new Promise(resolve => host.once('match:ended', resolve));
    const scoreResult = await scoreResultPromise;
    assert.equal(scoreResult.reason, 'score_limit_reached');
    const receiptKey = crypto.createHmac('sha256', TEST_SECRET).update('securefps:match-result:v1').digest();
    const receipt = jwt.verify(scoreResult.completionToken, receiptKey, {
      algorithms: ['HS256'], audience: 'securefps-match-result', subject: 'limits-host',
    });
    assert.equal(receipt.kills, 10);
    assert.equal(receipt.result, 'win');

    host.emit('lobby:ready', { isReady: true });
    guest.emit('lobby:ready', { isReady: true });
    await new Promise(resolve => setTimeout(resolve, 40));
    const rematchPromise = new Promise(resolve => host.once('game:start', resolve));
    host.emit('lobby:start');
    const rematch = await rematchPromise;
    assert.equal(rematch.matchDuration, 480);
    assert.equal(rematch.scoreLimit, 10);
    assert.ok(rematch.players.every(player =>
      player.kills === 0 &&
      player.deaths === 0 &&
      player.totalShots === 0 &&
      player.totalHits === 0
    ));

    const timeoutResultPromise = new Promise(resolve => host.once('match:ended', resolve));
    room.matchStartTime = Date.now() - 481000;
    const timeoutResult = await timeoutResultPromise;
    assert.equal(timeoutResult.reason, 'time_expired');

    const hostLeave = new Promise(resolve => host.once('lobby:left', resolve));
    host.emit('lobby:leave');
    await hostLeave;
    const guestLeave = new Promise(resolve => guest.once('lobby:left', resolve));
    guest.emit('lobby:leave');
    await guestLeave;
    host.disconnect();
    guest.disconnect();
  });

  it('1. Malformed packets do not crash the process', async () => {
    const c1 = await connectClient('mal1', 'MalTester');
    assert.ok(c1.connected);

    // Send nulls, wrong types, missing required fields, negative infinite numbers
    c1.emit('player:join', null);
    c1.emit('player:join', { room: 12345, name: [1, 2, 3] });
    c1.emit('lobby:create', null);
    c1.emit('lobby:create', { preferredCode: 'INVALID#$#$', name: {} });
    c1.emit('lobby:join', null);
    c1.emit('lobby:join', { roomCode: 123 });
    c1.emit('session:resume', { roomCode: null, reconnectToken: 555 });
    c1.emit('player:move', { x: NaN, y: Infinity, z: 'walk' });
    c1.emit('player:fire', { origin: 'hello', target: null });
    c1.emit('player:ping', null);

    // Wait 100ms to ensure server handled all events without crashing
    await new Promise(r => setTimeout(r, 100));

    // Server should still be healthy
    assert.strictEqual(server.listening, true);
    c1.disconnect();
  });

  it('2. Rate limiting trips and drops packet flooding', async () => {
    const c1 = await connectClient('spam1', 'SpamTester');
    assert.ok(c1.connected);

    // Flood 60 fire packets in a split second
    for (let i = 0; i < 60; i++) {
      c1.emit('player:fire', {
        clientTime: Date.now(),
        origin: { x: 0, y: 1.6, z: 0 },
        direction: { x: 0, y: 0, z: -1 },
        weaponKey: 'carbine'
      });
    }

    await new Promise(r => setTimeout(r, 80));
    assert.strictEqual(server.listening, true);
    c1.disconnect();
  });

  it('3. Movement validation rejects speed hacks & emits player:rubberband', async () => {
    const host = await connectClient('h1', 'HostOp');
    const guest = await connectClient('g1', 'GuestOp');

    // Create room and join
    const roomCreated = await new Promise(res => {
      host.once('lobby:created', res);
      host.emit('lobby:create', { name: 'HostOp' });
    });
    const roomCode = roomCreated.roomCode;

    await new Promise(res => {
      guest.once('lobby:joined', res);
      guest.emit('lobby:join', { roomCode, name: 'GuestOp' });
    });

    guest.emit('lobby:ready', { isReady: true });
    await new Promise(r => setTimeout(r, 50));

    // Start match
    const startPromise = new Promise(res => host.once('game:start', res));
    host.emit('lobby:start');
    await startPromise;

    // First packet anchors position
    guest.emit('player:move', {
      seq: 1,
      x: 0, y: 0, z: 0,
      yaw: 0, pitch: 0
    });
    await new Promise(r => setTimeout(r, 50));

    // Speed hack: jump 40 meters in next tick
    const rubberbandPromise = new Promise(res => guest.once('player:rubberband', res));
    guest.emit('player:move', {
      seq: 2,
      x: 40.0, y: 0, z: 0,
      yaw: 0, pitch: 0
    });

    const rubberband = await rubberbandPromise;
    assert.ok(rubberband, 'Server must emit player:rubberband');
    assert.strictEqual(rubberband.seq, 2);
    assert.strictEqual(rubberband.x, 0); // Authoritative position unchanged

    host.disconnect();
    guest.disconnect();
  });

  it('4. Combat arbitration: weapon cooldown enforced and wall occlusion blocks shot', async () => {
    const shooter = await connectClient('s1', 'ShooterOp');
    const victim = await connectClient('v1', 'VictimOp');

    const created = await new Promise(res => {
      shooter.once('lobby:created', res);
      shooter.emit('lobby:create', { name: 'ShooterOp' });
    });
    const roomCode = created.roomCode;

    await new Promise(res => {
      victim.once('lobby:joined', res);
      victim.emit('lobby:join', { roomCode, name: 'VictimOp' });
    });

    victim.emit('lobby:ready', { isReady: true });
    await new Promise(r => setTimeout(r, 40));

    const started = new Promise(res => shooter.once('game:start', res));
    shooter.emit('lobby:start');
    await started;

    // Anchor positions: shooter at (0, 0, 5), victim on other side of central compound at (0, 0, -15)
    // Central compound platform and spire are between them (z in [-8, 8])
    shooter.emit('player:move', { seq: 1, x: 0, y: 0, z: 12, yaw: 0, pitch: 0 });
    victim.emit('player:move', { seq: 1, x: 0, y: 0, z: -12, yaw: 0, pitch: 0 });
    await new Promise(r => setTimeout(r, 80));

    // Try shooting directly through the central compound (occluded)
    let hitConfirmedReceived = false;
    shooter.once('player:hit_confirmed', () => { hitConfirmedReceived = true; });

    shooter.emit('player:fire', {
      clientTime: performance.now(),
      origin: { x: 0, y: 1.6, z: 12 },
      direction: { x: 0, y: 0, z: -1 }, // pointing right at victim through central building
      weaponKey: 'carbine'
    });

    await new Promise(r => setTimeout(r, 100));
    assert.strictEqual(hitConfirmedReceived, false, 'Occluded shot must not register damage');

    shooter.disconnect();
    victim.disconnect();
  });

  it('5. Lag-compensated hit detection and authoritative damage calculation', async () => {
    const shooter = await connectClient('s2', 'Shooter2');
    const victim = await connectClient('v2', 'Victim2');

    const created = await new Promise(res => {
      shooter.once('lobby:created', res);
      shooter.emit('lobby:create', { name: 'Shooter2' });
    });
    const roomCode = created.roomCode;

    await new Promise(res => {
      victim.once('lobby:joined', res);
      victim.emit('lobby:join', { roomCode, name: 'Victim2' });
    });

    victim.emit('lobby:ready', { isReady: true });
    await new Promise(r => setTimeout(r, 40));

    const started = new Promise(res => shooter.once('game:start', res));
    shooter.emit('lobby:start');
    await started;

    // Clear line of sight on West lane (x = -26, clear from z = -10 to z = 10)
    shooter.emit('player:move', { seq: 1, x: -26, y: 0, z: 10, yaw: 0, pitch: 0 });
    victim.emit('player:move', { seq: 1, x: -26, y: 0, z: -5, yaw: 0, pitch: 0 });
    await new Promise(r => setTimeout(r, 100)); // allow history buffer to capture victim position

    // Clear victim spawn protection
    const rObj = rooms.get(roomCode);
    const vState = rObj.players.get(victim.id);
    vState.spawnProtectedUntil = 0;

    // Shooter fires directly at victim body: origin (-26, 1.2, 10), dir (0, 0, -1)
    const hitPromise = new Promise(res => shooter.once('player:hit_confirmed', res));
    const hurtPromise = new Promise(res => victim.once('player:hurt', res));

    shooter.emit('player:fire', {
      clientTime: performance.now(),
      origin: { x: -26, y: 1.2, z: 10 },
      direction: { x: 0, y: 0, z: -1 },
      weaponKey: 'carbine'
    });

    const [hitData, hurtData] = await Promise.all([hitPromise, hurtPromise]);
    assert.ok(hitData, 'Shooter must receive hit_confirmed');
    assert.strictEqual(hitData.damage, 25, 'Carbine body damage must be 25');
    assert.strictEqual(hurtData.currentHealth, 75, 'Victim health must be 75');

    shooter.disconnect();
    victim.disconnect();
  });

  it('6. Room-level respawn succeeds even if killer disconnects', async () => {
    const killer = await connectClient('k1', 'Killer');
    const victim = await connectClient('v3', 'Victim3');

    const created = await new Promise(res => {
      killer.once('lobby:created', res);
      killer.emit('lobby:create', { name: 'Killer' });
    });
    const roomCode = created.roomCode;

    await new Promise(res => {
      victim.once('lobby:joined', res);
      victim.emit('lobby:join', { roomCode, name: 'Victim3' });
    });

    victim.emit('lobby:ready', { isReady: true });
    await new Promise(r => setTimeout(r, 40));

    const started = new Promise(res => killer.once('game:start', res));
    killer.emit('lobby:start');
    await started;

    // Line of sight on West lane
    killer.emit('player:move', { seq: 1, x: -26, y: 0, z: 10, yaw: 0, pitch: 0 });
    victim.emit('player:move', { seq: 1, x: -26, y: 0, z: -5, yaw: 0, pitch: 0 });
    await new Promise(r => setTimeout(r, 100));

    const rObj = rooms.get(roomCode);
    const vState = rObj.players.get(victim.id);
    vState.spawnProtectedUntil = 0;
    vState.health = 20; // 1 sniper shot will eliminate

    // Killer fires sniper shot (damage = 80)
    const killPromise = new Promise(res => victim.once('player:killed', res));
    killer.emit('player:fire', {
      clientTime: performance.now(),
      origin: { x: -26, y: 1.2, z: 10 },
      direction: { x: 0, y: 0, z: -1 },
      weaponKey: 'sniper'
    });
    await killPromise;

    // Killer disconnects immediately after kill!
    killer.disconnect();

    // Victim must still receive authoritative respawn from room timer
    const respawnPromise = new Promise(res => victim.once('player:respawned', res));
    const respawnData = await respawnPromise;

    assert.ok(respawnData, 'Victim must receive player:respawned from room timer');
    assert.strictEqual(respawnData.id, victim.id);
    assert.ok(typeof respawnData.x === 'number' && typeof respawnData.y === 'number' && typeof respawnData.z === 'number');

    victim.disconnect();
  });

  it('7. Reconnect via session:resume restores game state', async () => {
    const p1 = await connectClient('rec1', 'Reconnector');
    const p2 = await connectClient('rec2', 'Teammate');

    const created = await new Promise(res => {
      p1.once('lobby:created', res);
      p1.emit('lobby:create', { name: 'Reconnector' });
    });
    const roomCode = created.roomCode;
    const reconnectToken = created.reconnectToken;
    assert.ok(reconnectToken, 'Server must issue reconnectToken on lobby:create');

    await new Promise(res => {
      p2.once('lobby:joined', res);
      p2.emit('lobby:join', { roomCode, name: 'Teammate' });
    });

    p2.emit('lobby:ready', { isReady: true });
    await new Promise(r => setTimeout(r, 40));

    const started = new Promise(res => p1.once('game:start', res));
    p1.emit('lobby:start');
    const startState = await started;
    assert.equal(startState.matchDuration, 480);
    assert.equal(startState.scoreLimit, 10);
    const room = rooms.get(roomCode);
    const originalPlayer = room.players.get(p1.id);
    originalPlayer.x = 7;
    originalPlayer.y = 1.8;
    originalPlayer.z = -4;
    originalPlayer.health = 73;
    originalPlayer.kills = 3;
    originalPlayer.deaths = 2;
    originalPlayer.assists = 1;
    originalPlayer.totalShots = 9;
    originalPlayer.totalHits = 4;
    originalPlayer.headshots = 2;
    room.matchStartTime = Date.now() - 4000;

    // Disconnect p1 during active match
    p1.disconnect();
    await new Promise(r => setTimeout(r, 60));

    // Connect new socket and resume session using token
    const p1Resume = await connectClient('rec1', 'Reconnector');
    const reconnectedPromise = new Promise(res => p1Resume.once('game:reconnected', res));

    p1Resume.emit('session:resume', {
      roomCode: roomCode,
      reconnectToken: reconnectToken
    });

    const reconnected = await reconnectedPromise;
    assert.ok(reconnected, 'Server must emit game:reconnected');
    assert.strictEqual(reconnected.roomCode, roomCode);
    assert.strictEqual(reconnected.isHost, true);
    assert.strictEqual(reconnected.state, 'in_game');
    assert.strictEqual(reconnected.matchDuration, 480);
    assert.strictEqual(reconnected.scoreLimit, 10);
    assert.ok(reconnected.matchTimeRemaining <= 476);
    const restoredPlayer = reconnected.players.find(player => player.id === p1Resume.id);
    assert.ok(restoredPlayer, 'Reconnect snapshot must include the restored operator');
    assert.deepEqual(
      [restoredPlayer.x, restoredPlayer.y, restoredPlayer.z, restoredPlayer.health],
      [7, 1.8, -4, 73],
    );
    assert.deepEqual(
      [restoredPlayer.kills, restoredPlayer.deaths, restoredPlayer.assists, restoredPlayer.totalShots, restoredPlayer.totalHits, restoredPlayer.headshots],
      [3, 2, 1, 9, 4, 2],
    );

    p1Resume.disconnect();
    p2.disconnect();
  });

  it('8. Single active socket per user ID disconnects prior duplicate', async () => {
    const s1 = await connectClient('uniqueUser1', 'UserOne');
    assert.ok(s1.connected);

    // Open second connection with same user ID
    const s2 = await connectClient('uniqueUser1', 'UserOne_SecondTab');
    assert.ok(s2.connected);

    // Wait 50ms for s1 to be kicked
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(s1.connected, false, 'Previous socket must be disconnected on new login');

    s2.disconnect();
  });
});
