/**
 * SecureFPS: High-Performance Reverse Proxy
 * Unifies Flask (HTTP/REST on port 5000) and Socket.IO (WebSockets on port 4001)
 * behind a single port (8080) for seamless Cloudflare Tunnel / HTTPS remote multiplayer.
 *
 * Built using native Node.js http and fs modules (Zero external dependencies).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// Simple native .env loader without external dependencies
function loadEnvFile(envPath) {
  try {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const match = trimmed.match(/^([^=]+)=(.*)$/);
        if (match) {
          const key = match[1].trim();
          let val = match[2].trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (!(key in process.env)) {
            process.env[key] = val;
          }
        }
      }
    }
  } catch (_) {}
}

loadEnvFile(path.resolve(__dirname, '../backend/.env'));
loadEnvFile(path.resolve(__dirname, '../multiplayer-server/.env'));
loadEnvFile(path.resolve(__dirname, '.env'));

function getTargetConfig() {
  return {
    proxyPort: parseInt(process.env.PROXY_PORT || '8080', 10),
    proxyHost: process.env.PROXY_HOST || '0.0.0.0',
    flaskPort: parseInt(process.env.FLASK_PORT || '5000', 10),
    flaskHost: process.env.FLASK_HOST || '127.0.0.1',
    socketPort: parseInt(process.env.SOCKET_PORT || '4001', 10),
    socketHost: process.env.SOCKET_HOST || '127.0.0.1'
  };
}

// Build the unified HTTP Server
const server = http.createServer((req, res) => {
  const config = getTargetConfig();

  // Built-in Health Endpoint
  if (req.url === '/proxy-health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      proxy_port: config.proxyPort,
      flask_target: `${config.flaskHost}:${config.flaskPort}`,
      socket_target: `${config.socketHost}:${config.socketPort}`,
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // Determine target backend service
  const isSocketIo = req.url.startsWith('/socket.io/');
  const targetHost = isSocketIo ? config.socketHost : config.flaskHost;
  const targetPort = isSocketIo ? config.socketPort : config.flaskPort;

  // Determine forwarding headers
  const clientIp = req.headers['x-forwarded-for']
    ? `${req.headers['x-forwarded-for']}, ${req.socket.remoteAddress}`
    : req.socket.remoteAddress;

  const forwardedProto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  const forwardedHost = req.headers['x-forwarded-host'] || req.headers['host'];
  const forwardedPort = req.headers['x-forwarded-port'] || (forwardedProto === 'https' ? '443' : String(config.proxyPort));

  const proxyHeaders = {
    ...req.headers,
    'x-forwarded-for': clientIp,
    'x-forwarded-proto': forwardedProto,
    'x-forwarded-host': forwardedHost,
    'x-forwarded-port': forwardedPort,
    host: req.headers['host'] || `${targetHost}:${targetPort}`
  };

  const proxyReq = http.request({
    hostname: targetHost,
    port: targetPort,
    path: req.url,
    method: req.method,
    headers: proxyHeaders
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.warn(`[Proxy Error] Unable to route ${req.method} ${req.url} -> ${targetHost}:${targetPort} (${err.code || err.message})`);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Bad Gateway',
        message: `Service at ${targetHost}:${targetPort} is currently unreachable. Ensure Flask and Multiplayer servers are running.`,
        target: isSocketIo ? 'Multiplayer Socket.IO Server' : 'Flask Web Application'
      }));
    }
  });

  req.pipe(proxyReq);
});

// Handle WebSocket Upgrades (for Socket.IO real-time gameplay synchronization)
server.on('upgrade', (req, socket, head) => {
  const config = getTargetConfig();
  const isSocketIo = req.url.startsWith('/socket.io/');
  const targetHost = isSocketIo ? config.socketHost : config.flaskHost;
  const targetPort = isSocketIo ? config.socketPort : config.flaskPort;

  const clientIp = req.headers['x-forwarded-for']
    ? `${req.headers['x-forwarded-for']}, ${req.socket.remoteAddress}`
    : req.socket.remoteAddress;

  const forwardedProto = req.headers['x-forwarded-proto'] || 'https';
  const forwardedHost = req.headers['x-forwarded-host'] || req.headers['host'];

  const proxyHeaders = {
    ...req.headers,
    'x-forwarded-for': clientIp,
    'x-forwarded-proto': forwardedProto,
    'x-forwarded-host': forwardedHost,
    host: req.headers['host'] || `${targetHost}:${targetPort}`
  };

  const proxyReq = http.request({
    hostname: targetHost,
    port: targetPort,
    path: req.url,
    method: req.method,
    headers: proxyHeaders
  });

  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    proxySocket.on('error', () => {
      socket.destroy();
    });
    socket.on('error', () => {
      proxySocket.destroy();
    });

    // Write HTTP Switching Protocols response to client socket
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n`);
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (Array.isArray(value)) {
        for (const v of value) socket.write(`${key}: ${v}\r\n`);
      } else {
        socket.write(`${key}: ${value}\r\n`);
      }
    }
    socket.write('\r\n');

    if (proxyHead && proxyHead.length) socket.write(proxyHead);
    if (head && head.length) proxySocket.write(head);

    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });

  proxyReq.on('error', (err) => {
    console.warn(`[Proxy Upgrade Error] WebSocket upgrade failed for ${req.url}:`, err.message);
    socket.destroy();
  });

  proxyReq.end();
});

if (require.main === module) {
  const initialConfig = getTargetConfig();
  server.listen(initialConfig.proxyPort, initialConfig.proxyHost, () => {
    console.log('===============================================================');
    console.log(`[SecureFPS Reverse Proxy] Listening on http://${initialConfig.proxyHost}:${initialConfig.proxyPort}`);
    console.log(`  -> Forwarding /socket.io/* (HTTP/WSS) to http://${initialConfig.socketHost}:${initialConfig.socketPort}`);
    console.log(`  -> Forwarding all other requests      to http://${initialConfig.flaskHost}:${initialConfig.flaskPort}`);
    console.log('===============================================================');
  });
}

module.exports = { server, getTargetConfig };
