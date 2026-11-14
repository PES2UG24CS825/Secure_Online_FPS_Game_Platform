# SecureFPS Platform Deployment & Operations Guide

This guide details the production architecture, server security configuration, reverse proxy setup, and operational scaling for the SecureFPS Anti-Cheat & Multiplayer Platform.

---

## 1. Architecture Overview

```
                      +-----------------------------+
                      |   TLS / Reverse Proxy       |
                      |   (Nginx / Cloudflare CDN)  |
                      +--------------+--------------+
                                     |
               +---------------------+---------------------+
               |                                           |
   /api, /, static HTML/WebGL                 WebSocket / Game Netcode
               |                                           |
+--------------v---------------+             +-------------v--------------+
| Flask Application Backend    |             | Node.js Game Server        |
| Gunicorn (gthread/gevent)    |             | Port 4001                  |
| Python 3.12 (Port 5000)      |             | 30Hz Authoritative Engine  |
+--------------+---------------+             +-------------+--------------+
               |                                           |
               |                                           |
+--------------v---------------+             +-------------v--------------+
| MongoDB 7.0 Cluster          |             | Flask Internal Anti-Cheat  |
| Telemetry, Users, Sessions   |             | /api/internal/report (HMAC)|
+------------------------------+             +----------------------------+
```

---

## 2. Production Security & Secret Enforcement

When running with `APP_ENV=production` and `SECUREFPS_LOCAL_DEV=false`, Flask will refuse to start if secrets are missing or left at development default values.

### Required Environment Variables:
```bash
APP_ENV=production
SECUREFPS_LOCAL_DEV=false
FLASK_SECRET_KEY=<32+ byte cryptographically random secret>
GAME_SERVER_SECRET=<32+ byte cryptographically random shared secret>
ADMIN_EMAIL=security-admin@yourdomain.com
ADMIN_PASSWORD=<16+ char high-entropy password>
ADMIN_MFA_SECRET=<Base32 TOTP Secret>
FLASK_HOST=127.0.0.1
FLASK_PORT=5000
FLASK_DEBUG=0
SESSION_COOKIE_SECURE=1
RATELIMIT_STORAGE_URI=redis://127.0.0.1:6379/0
```

---

## 3. WSGI Server Configuration (Gunicorn)

Run the Flask application behind Gunicorn using the multi-threaded worker model (`gthread`):

```bash
gunicorn \
  --workers 4 \
  --threads 8 \
  --worker-class gthread \
  --bind 127.0.0.1:5000 \
  --timeout 60 \
  --access-logfile - \
  --error-logfile - \
  "backend.app:app"
```

For Redis session storage, configure Flask-Session:
```bash
SESSION_TYPE=redis
SESSION_REDIS=redis://127.0.0.1:6379/1
```

---

## 4. Reverse Proxy Configuration (Nginx)

Place Nginx in front of both Flask and the Node.js Socket.IO server:

```nginx
# Nginx /etc/nginx/sites-available/securefps.conf

upstream flask_backend {
    server 127.0.0.1:5000;
}

upstream multiplayer_server {
    ip_hash; # Sticky sessions required if clustering Node.js
    server 127.0.0.1:4001;
}

server {
    listen 443 ssl http2;
    server_name fps.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/fps.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/fps.yourdomain.com/privkey.pem;

    # Gzip & Brotli Compression
    gzip on;
    gzip_types text/plain text/css application/json application/javascript application/wasm image/svg+xml;
    gzip_min_length 1024;

    # Static 3D Asset Caching (WebGL Models, Unity Wasm, Textures)
    location ~* \.(glb|gltf|wasm|data|png|jpg|jpeg|svg|mp3|wav|woff2)$ {
        root /var/www/securefps/frontend;
        expires 30d;
        add_header Cache-Control "public, max-age=2592000, immutable";
        access_log off;
    }

    # Authoritative Multiplayer Socket.IO WebSocket
    location /socket.io/ {
        proxy_pass http://multiplayer_server;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
    }

    # Flask Application & Web API
    location / {
        proxy_pass http://flask_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## 5. Multiplayer Horizontal Scaling Considerations

1. **Current Design (Single Authoritative Node)**:
   - In-memory room maps (`rooms = new Map()`) operate on a single Node.js process.
   - Low CPU and memory footprint: supports up to 500 active match rooms per host.
2. **Multi-Node Cluster Scaling**:
   - When scaling beyond a single host, install `@socket.io/redis-adapter` or `@socket.io/cluster-adapter`.
   - Ensure reverse proxy uses sticky sessions (`ip_hash` or cookie stickiness) so WebSockets reconnect to the authoritative room host.
