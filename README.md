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
  - **Hybrid ML Ensemble:** The v2 runtime combines supervised Random Forest probability (60%) with normalized Isolation Forest anomaly score (40%) when both are available.
  - **Evidence Handling:** Model-only predictions are distinguished from confirmed server-validated violations.
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

### 5. Seed Demo Accounts
In a third terminal:
```bash
python scripts/seed_demo.py
```
- Demo credentials are configured through environment variables and must not be copied into application code or documentation.

### 6. Run Adversarial Cheat Simulator
```bash
node scripts/cheat_simulator.js --mode all
```

---

## 🧪 Automated Testing & Benchmarks

Run the complete test suite covering all layers of the architecture:

```bash
# 1. Full Backend Hardening & ML Model Tests (56 tests)
pytest backend/tests/ -v

# 2. Authoritative Multiplayer Server & Simulated WAN Harness (11 tests)
npm --prefix multiplayer-server test

# 3. Three.js Client Articulated Rig & Dataset Bot Verification (12 tests)
node --test frontend/public/games/three-fps/test/ai_hud_verification.test.js

# 4. GLB Binary Integrity Validator
python tools/validate_glb.py

# 5. Measure Real-Time Latencies & Generate Benchmark Report (50 trials)
python scripts/measure_realtime.py

# 6. Comprehensive 5-Fold ML Model Benchmark (6 Supervised + 3 Anomaly Detectors)
python scripts/evaluate_models.py
```
**Status:** Report only the latest locally executed suite counts; current results may vary as tests are added or the environment changes.

---

## 📚 Technical Documentation Directory

- 📖 [**Demonstration Walkthrough Script (docs/DEMO_SCRIPT.md)**](docs/DEMO_SCRIPT.md): Step-by-step localhost demo guide.
- 🏛️ [**Platform Architecture (docs/ARCHITECTURE.md)**](docs/ARCHITECTURE.md): Technical architecture, Mermaid diagrams, and data flow.
- 🛡️ [**Threat Model & Mitigation Matrix (docs/THREAT_MODEL.md)**](docs/THREAT_MODEL.md): Security vectors, defenses, and test coverage.
- 📊 [**Real-Time Latency Benchmark (docs/REALTIME_RESULTS.md)**](docs/REALTIME_RESULTS.md): 50-trial empirical latency metrics.
- 📈 [**Feature Engineering & Dataset Specs (docs/FEATURES_AND_DATASET.md)**](docs/FEATURES_AND_DATASET.md): Feature definitions, formulas, and human dataset placeholder.
- ⚠️ [**Limitations & Formulas Appendix (docs/LIMITATIONS.md)**](docs/LIMITATIONS.md): Limitations, credits, and mathematical derivations.
- 🎨 [**Character Assets & Rigging Guide (docs/CHARACTER_ASSETS.md)**](docs/CHARACTER_ASSETS.md): Asset requirements, bone hierarchy, and procedural fallback.

---

## 📦 3D Asset & Binary File Integrity (.glb, .wasm, .data)

> [!IMPORTANT]
> **GLB & 3D Asset Binary Integrity:**
> `.glb` 3D model files (such as `models/Soldier.glb` and `models/FemaleOperator.glb`) are binary container formats holding packed JSON chunks and raw binary buffers (geometry, skinning weights, animations).
> **Never copy, filter, or process `.glb` files using text mode** or editors that enforce UTF-8 conversion. Text-mode conversion inserts UTF-8 replacement byte sequences (`0xEF 0xBF 0xBD` / `\ufffd`) whenever invalid UTF-8 byte sequences are encountered, permanently corrupting the binary header magic, chunk lengths, and vertex buffers.
> 
> `.gitattributes` is configured to mark `*.glb binary` to enforce binary checkouts across all platforms. When models fail binary validation, the game engine logs a clear diagnostic error and seamlessly activates the high-fidelity procedural anatomical tactical operator rig.

