const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const ioClient = require('socket.io-client');
const { app, server, io, rooms, generateRoomCode } = require('../server');
const proxyModule = require('../../reverse-proxy/proxy');

describe('Remote Host Reverse Proxy & Cross-Network Multiplayer Flow', () => {
  let mockFlask;
  let flaskPort;
  let multiplayerPort;
  let proxyServer = proxyModule.server;
  let proxyPort;

  let hostSocket;
  let guestSocket;

  before(async () => {
    // 1. Mock Flask on dynamic port
    mockFlask = http.createServer((req, res) => {
      if (req.url === '/api/game/socket-ticket') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ socket_token: 'mock-jwt-token-remote' }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', route: req.url }));
      }
    });
    await new Promise(r => mockFlask.listen(0, '127.0.0.1', r));
    flaskPort = mockFlask.address().port;

    // 2. Start Authoritative Multiplayer Server
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    multiplayerPort = server.address().port;

    // 3. Configure and Start Reverse Proxy
    process.env.FLASK_PORT = String(flaskPort);
    process.env.SOCKET_PORT = String(multiplayerPort);
    process.env.FLASK_HOST = '127.0.0.1';
    process.env.SOCKET_HOST = '127.0.0.1';

    await new Promise(r => proxyServer.listen(0, '127.0.0.1', r));
    proxyPort = proxyServer.address().port;
  });

  after(async () => {
    if (hostSocket) hostSocket.disconnect();
    if (guestSocket) guestSocket.disconnect();
    await new Promise(r => proxyServer.close(r));
    await new Promise(r => server.close(r));
    await new Promise(r => mockFlask.close(r));
  });

  it('connects both Host and Remote Joiner through the unified reverse proxy port', async () => {
    // Both connect to the proxyPort (simulating single public HTTPS origin)
    hostSocket = ioClient(`http://127.0.0.1:${proxyPort}`, {
      transports: ['websocket'],
      auth: { userId: 'host_player_1', name: 'AlphaHost' }
    });

    guestSocket = ioClient(`http://127.0.0.1:${proxyPort}`, {
      transports: ['websocket'],
      auth: { userId: 'remote_player_2', name: 'BravoGuest' }
    });

    await Promise.all([
      new Promise((resolve, reject) => {
        hostSocket.on('connect', resolve);
        hostSocket.on('connect_error', reject);
      }),
      new Promise((resolve, reject) => {
        guestSocket.on('connect', resolve);
        guestSocket.on('connect_error', reject);
      })
    ]);

    assert.ok(hostSocket.id);
    assert.ok(guestSocket.id);
    assert.notEqual(hostSocket.id, guestSocket.id);
  });

  it('completes room creation, remote joining, ready handshake, and match start', async () => {
    let createdRoomCode = null;

    // 1. Host creates room
    const createPromise = new Promise(resolve => {
      hostSocket.once('lobby:created', data => {
        createdRoomCode = data.roomCode;
        resolve(data);
      });
      hostSocket.emit('lobby:create', { name: 'AlphaHost', honour_score: 100 });
    });

    const createData = await createPromise;
    assert.ok(createdRoomCode);
    assert.equal(createdRoomCode.length, 6);
    assert.equal(createData.isHost, true);

    // 2. Remote Guest joins room using the 6-character code
    const joinPromise = new Promise(resolve => {
      guestSocket.once('lobby:joined', resolve);
      guestSocket.emit('lobby:join', { roomCode: createdRoomCode, name: 'BravoGuest', honour_score: 95 });
    });

    const joinData = await joinPromise;
    assert.equal(joinData.roomCode, createdRoomCode);
    assert.equal(joinData.isHost, false);
    assert.equal(joinData.players.length, 2);

    // 3. Remote Guest marks READY (wait for the update reflecting isReady)
    const readyUpdatePromise = new Promise(resolve => {
      const handler = (data) => {
        const p = data.players.find(x => x.id === guestSocket.id);
        if (p && p.isReady) {
          hostSocket.off('lobby:player_update', handler);
          resolve(data);
        }
      };
      hostSocket.on('lobby:player_update', handler);
      guestSocket.emit('lobby:ready', { isReady: true });
    });
    const updateData = await readyUpdatePromise;
    const remoteInHostView = updateData.players.find(p => p.id === guestSocket.id);
    assert.equal(remoteInHostView.isReady, true);

    // 4. Host marks READY and starts match
    hostSocket.emit('lobby:ready', { isReady: true });
    await new Promise(r => setTimeout(r, 60));

    const matchStartPromises = Promise.all([
      new Promise(resolve => hostSocket.once('game:start', resolve)),
      new Promise(resolve => guestSocket.once('game:start', resolve))
    ]);

    hostSocket.emit('lobby:start');
    const [hostStart, guestStart] = await matchStartPromises;

    assert.equal(hostStart.roomCode, createdRoomCode);
    assert.equal(guestStart.roomCode, createdRoomCode);
    assert.equal(hostStart.players.length, 2);
    assert.equal(guestStart.players.length, 2);
    assert.equal(hostStart.matchDuration, 480);
  });

  it('synchronizes real-time movements and 30Hz authoritative snapshots via reverse proxy', async () => {
    // Both players stream movement packets through the proxy
    hostSocket.emit('player:move', { seq: 1, x: 0, y: 0, z: 20, yaw: 0, pitch: 0 });
    guestSocket.emit('player:move', { seq: 1, x: 0, y: 0, z: -20, yaw: Math.PI, pitch: 0 });

    const snapshotPromise = new Promise(resolve => {
      guestSocket.once('world:snapshot', resolve);
    });

    const snapshot = await snapshotPromise;
    assert.ok(snapshot.players);
    assert.ok(snapshot.players.length >= 2);

    const hostSnapshot = snapshot.players.find(p => p.id === hostSocket.id);
    const guestSnapshot = snapshot.players.find(p => p.id === guestSocket.id);
    assert.ok(hostSnapshot);
    assert.ok(guestSnapshot);
  });
});
