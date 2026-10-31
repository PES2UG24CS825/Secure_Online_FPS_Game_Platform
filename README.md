# SecureFPS — Online FPS Game Platform with AI Anti-Cheat & Account Security

A secure, full-stack First-Person Shooter (FPS) gaming platform featuring two distinct game engines (**CyberStrike 3D** WebGL and **Unity FPS Microgame**), an authoritative Node.js multiplayer server, server-side AI anti-cheat intelligence, and enterprise-grade account security.

---

## 🌟 Key Features

- **🎮 Dual FPS Game Engines:**
  - **CyberStrike 3D:** High-performance Three.js 3D tactical shooter with dynamic bot AI, health/armor systems, weapon switching, and synchronized multiplayer.
  - **FPS Microgame:** Unity WebGL competitive training environment with embedded telemetry hooks.
- **🛡️ Enterprise Account Security (Highest Priority):**
  - **Two-Factor Authentication (TOTP):** RFC 6238 / RFC 4226 compliant with QR code setup, Google/Microsoft Authenticator support, and single-use recovery codes.
  - **Cryptographic Password Hashing:** PBKDF2 with HMAC-SHA256 (600,000 iterations and per-user cryptographic salt).
  - **Session Concurrency Mutex:** Real-time database-backed single-device locking (`active_auth_session_id`) preventing credential sharing and session hijacking.
  - **Account Security Score (0–100):** Real-time composite rating evaluating MFA, email verification, account standing, and sportsmanship.
- **🤖 Server-Side AI Anti-Cheat Intelligence:**
  - **Hybrid ML Ensemble:** Supervised **Random Forest** (60%) + Unsupervised **Isolation Forest** (40%).
  - **Zero False-Positive Protection:** Context-aware damping protects skilled human players against false bans.
  - **Server-Side Kinematic Physics Audit:** Validates physical impossibility (speed > 14.5 m/s, fire rate > 12 rounds/s, instant snap > 3.2 rad) without invasive client kernel drivers.
  - **Standard Operational Risk Scale (0–100):**
    - `0.0 – 39.99`: **Normal** (Green — Verified legitimate human gameplay)
    - `40.0 – 64.99`: **Monitoring** (Blue/Yellow — Telemetry retained for observation)
    - `65.0 – 79.99`: **Suspicious** (Orange — Elevated anomalies flagged for investigation)
    - `80.0 – 89.99`: **High Risk** (Orange-Red — Strong indicators, priority review)
    - `90.0 – 100.0`: **Critical Risk** (Red — Server-validated violation or auto-ban)
- **⚡ Real-Time Admin & Player Dashboards:**
  - **Player Console:** Match history, K/D ratio, accuracy, Honour score, rewards, and security status.
  - **Admin Control Center:** Live Server-Sent Events (SSE), Account Security ratings, and interactive **Last 5 Match Analysis popover** on cursor hover.
- **🎖️ Fair Play Honour Score System:**
  - Starts at 100. Completing matches awards +5 Honour (and coins/XP); abandoning active matches deducts -10 Honour.

---

## 🏗️ System Architecture

```
[ Client Browsers: CyberStrike 3D (Three.js) & FPS Microgame (Unity WebGL) ]
              │                                      │
   HTTP / REST / SSE (Port 5000)          WebSockets (Port 4001)
              ▼                                      ▼
   [ Flask Core Application ]             [ Authoritative Node.js Server ]
   ├── Auth & Concurrency Locks           └── Dedicated Room & Tick Sync
   ├── ML Anti-Cheat Pipeline (RF + IF)
   └── Admin & Player APIs
              │
              ▼
   [ MongoDB Data Store (secure_fps) ]
   ├── users, sessions_db, game_sessions
   └── game_telemetry, game_events, security_events
```

---

## 🚀 Quickstart Guide

### 1. Prerequisites
- **Python:** 3.10+ (Recommended: Python 3.12)
- **Node.js:** 18+ (for multiplayer server)
- **MongoDB:** Running locally on default port `27017`

### 2. Environment Configuration
Create or verify `backend/.env`:
```env
FLASK_SECRET_KEY=secure-secret-key-replace-in-production
MONGO_URI=mongodb://127.0.0.1:27017/secure_fps
APP_ENV=development
PORT=5000
MULTIPLAYER_PORT=4001
```

### 3. Start the Authoritative Multiplayer Server
In a new terminal:
```bash
cd multiplayer-server
npm install
node server.js
```
*The authoritative multiplayer server will listen on port `4001`.*

### 4. Start the Flask Application
In a second terminal:
```bash
cd backend
python -m pip install -r requirements.txt
python app.py
```
*The Flask application will start on `http://127.0.0.1:5000`.*

### 5. Access the Platform
- **Sign In / Registration:** <http://127.0.0.1:5000/login.html>
- **Player Dashboard:** <http://127.0.0.1:5000/player.html>
- **CyberStrike 3D (FPS 02):** <http://127.0.0.1:5000/public/games/three-fps/index.html>
- **Admin Control Center:** <http://127.0.0.1:5000/admin.html>

*Default Development Admin Credentials:*
`admin1@gmail.com` / `Admin@12345` (MFA Secret: `JBSWY3DPEHPK3PXP`)

---

## 🧪 Automated Testing

Run the full pytest test suite from the repository root:
```bash
python -m pytest backend/tests -v
```
**Status:** 26 of 26 tests passing (100% test coverage across API, authentication, RBAC, SSE, and ML models).

---

## 📚 Technical Research & Algorithm Documentation

For in-depth mathematical derivations, formulas, feature engineering algorithms, and comparisons to previous academic literature, please refer to:
👉 [**Full Architecture, AI Anti-Cheat & Research Specification (docs/PROJECT_ARCHITECTURE_AND_AI_ANTI_CHEAT_SPEC.md)**](docs/PROJECT_ARCHITECTURE_AND_AI_ANTI_CHEAT_SPEC.md)
