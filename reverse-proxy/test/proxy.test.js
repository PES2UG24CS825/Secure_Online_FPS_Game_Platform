const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const { server } = require('../proxy');

describe('SecureFPS Reverse Proxy Verification', () => {
  let proxyServer;
  let mockFlaskServer;
  let mockSocketServer;
  let proxyPort;
  let flaskPort;
  let socketPort;

  before(async () => {
    // 1. Start mock Flask backend
    mockFlaskServer = http.createServer((req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'X-Backend': 'Flask',
        'X-Received-Proto': req.headers['x-forwarded-proto'] || 'unknown',
        'X-Received-Host': req.headers['x-forwarded-host'] || 'unknown'
      });
      res.end(JSON.stringify({ backend: 'flask', path: req.url }));
    });
    await new Promise(r => mockFlaskServer.listen(0, '127.0.0.1', r));
    flaskPort = mockFlaskServer.address().port;

    // 2. Start mock Socket.IO backend
    mockSocketServer = http.createServer((req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'X-Backend': 'SocketIO',
        'X-Received-Proto': req.headers['x-forwarded-proto'] || 'unknown'
      });
      res.end(JSON.stringify({ backend: 'socket_io', path: req.url }));
    });

    // Mock WebSocket upgrade handler
    mockSocketServer.on('upgrade', (req, socket, head) => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n' +
        '\r\n'
      );
      socket.write('WSS_CONFIRMED');
    });
    await new Promise(r => mockSocketServer.listen(0, '127.0.0.1', r));
    socketPort = mockSocketServer.address().port;

    // Override targets in proxy environment
    process.env.FLASK_PORT = String(flaskPort);
    process.env.SOCKET_PORT = String(socketPort);

    // 3. Start Proxy Server on dynamic port
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    proxyPort = server.address().port;
  });

  after(async () => {
    await new Promise(r => server.close(r));
    await new Promise(r => mockFlaskServer.close(r));
    await new Promise(r => mockSocketServer.close(r));
  });

  it('serves /proxy-health with healthy JSON status', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/proxy-health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'healthy');
  });

  it('routes standard HTTP and API requests to the Flask backend', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/api/player/profile`, {
      headers: {
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'demo-securefps.trycloudflare.com'
      }
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-backend'), 'Flask');
    assert.equal(res.headers.get('x-received-proto'), 'https');
    assert.equal(res.headers.get('x-received-host'), 'demo-securefps.trycloudflare.com');
    const body = await res.json();
    assert.equal(body.backend, 'flask');
    assert.equal(body.path, '/api/player/profile');
  });

  it('routes /socket.io/ polling HTTP requests to the Socket.IO backend', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/socket.io/?EIO=4&transport=polling`, {
      headers: {
        'X-Forwarded-Proto': 'https'
      }
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-backend'), 'SocketIO');
    assert.equal(res.headers.get('x-received-proto'), 'https');
    const body = await res.json();
    assert.equal(body.backend, 'socket_io');
  });

  it('routes WebSocket upgrade handshakes on /socket.io/ to the Socket.IO backend with 101 Switching Protocols', async () => {
    const received = await new Promise((resolve, reject) => {
      const client = net.createConnection({ port: proxyPort, host: '127.0.0.1' }, () => {
        client.write(
          'GET /socket.io/?EIO=4&transport=websocket HTTP/1.1\r\n' +
          'Host: demo-securefps.trycloudflare.com\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          'Sec-WebSocket-Version: 13\r\n' +
          'X-Forwarded-Proto: https\r\n\r\n'
        );
      });

      let buffer = '';
      client.on('data', (chunk) => {
        buffer += chunk.toString();
        if (buffer.includes('101 Switching Protocols') && buffer.includes('WSS_CONFIRMED')) {
          client.end();
          resolve(buffer);
        }
      });
      client.on('error', reject);
      setTimeout(() => reject(new Error('Upgrade timeout')), 3000);
    });

    assert.match(received, /HTTP\/1\.1 101 Switching Protocols/);
    assert.match(received, /Upgrade: websocket/i);
    assert.match(received, /Connection: Upgrade/i);
    assert.match(received, /WSS_CONFIRMED/);
  });
});
