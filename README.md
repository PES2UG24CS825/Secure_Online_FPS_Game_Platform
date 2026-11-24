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
  - Starts at 100. Match completion and abandonment can adjust Honour. Signed multiplayer results can earn match coins and XP.

See the [local platform audit](docs/PLATFORM_AUDIT.md) for hosting checks, match statistics and remaining verification.

## Player profile and account notices

The Sakura profile shows saved appearance, rewards level, and XP. Overview shows recorded match statistics, and Rewards shows earned achievements. Account Security shows authenticator status, the masked verified recovery address, sign-in history, and active devices. Players can change their password, sign out other devices, replace and download recovery codes after verification, and manage their account data.

The Notifications sidebar entry shows the unread count from MongoDB. Notification History supports category filters, unread filtering, pagination, marking notices read or unread, and dismissal. Match, rewards, and announcement preferences are optional. Security and account notices stay enabled. The player console also refreshes stored notices after reconnecting to its existing event stream.

The Player sidebar also includes an Activity History view populated only from recorded match activity, reward activity and security events. It does not use fabricated or locally stored records.

## Role-specific dashboard themes

The authenticated interface uses one shared dashboard component system with three complementary role themes:

- **Player:** Lavender and violet (`#EDE3F7`, `#6D28D9`)
- **Normal Admin:** Soft blue and indigo (`#E1EAF8`, `#315BA8`)
- **Super Admin:** Orchid and royal purple (`#F0DFEF`, `#862C91`)

The themes affect only presentation. Backend authorization continues to use Flask role checks and MongoDB-backed administrator identities. Player, Normal Admin and Super Admin sidebars share the same structure, logo, navigation sizing and collapse behavior.

**Authors** · Prajwal K and Sudarshan JN

## Dashboard artwork and administrator review

Player and administrator dashboards share the supplied [Sakura anime PNG](frontend/public/backgrounds/SecureFPS_Sakura_Anime_Background.png). The player's selected banner appears in Profile, separate from the shared dashboard artwork. The four original Sakura banners and all four Chibi portraits use the existing MongoDB appearance settings.

Normal and super administrators use the same monitoring layout. Critical alerts can be acknowledged by authorized reviewers, and the player investigation view lists recorded anti-cheat violations. Final anti-cheat decisions are protected against duplicate submissions. Confirming a cheat requires recorded hard evidence and a review note. Model pages label held-out evaluation separately from the fitted Random Forest feature importances.

The Super Admin roster shows stored roles, MFA status, active sessions, and the last successful sign-in. Provisioning a Normal Admin requires a verified authenticator enrollment key and a current code. Administrator MFA recovery remains a separate workflow pending verified recovery and enrollment delivery. Use the existing local launcher to preview the dashboards.

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
- Run the commands below from the SecureFPS project root in **PowerShell**.

### 2. Environment Configuration
Create or verify `backend/.env`:
```env
FLASK_SECRET_KEY=replace-with-a-random-secret-at-least-32-characters-long
MONGO_URI=mongodb://127.0.0.1:27017/secure_fps
APP_ENV=development
```

### 3. Start SecureFPS
Open PowerShell in the project root. Activate the virtual environment and start the local Flask app, multiplayer server, and proxy:
```powershell
.\.venv\Scripts\Activate.ps1
.\scripts\start_host.ps1
```

When startup succeeds, the terminal prints `SecureFPS is ready at http://127.0.0.1:8080`. Open that address in your browser. The launcher starts Flask on port `5000`, multiplayer on `4001`, and the local proxy on `8080`.

If PowerShell blocks the activation script, allow scripts for the current PowerShell process only, then activate and start:
```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned
.\.venv\Scripts\Activate.ps1
.\scripts\start_host.ps1
```
This execution policy change ends when that PowerShell process closes. You can also run `.\.venv\Scripts\Activate.ps1` directly from the activation prompt shown in the terminal example.

### 4. Stop SecureFPS
In the same project directory, run:
```powershell
.\scripts\stop_all.ps1
```
The stop script shuts down only the processes started and recorded by `start_host.ps1`.

The launcher requires ports `5000`, `4001`, and `8080` to be available. If startup reports that a launcher state file already exists, stop the previous launcher run with `.\scripts\stop_all.ps1` before starting again.

---

## 🧪 Academic Cheater Demonstration Mode & Real-Time Anti-Cheat Verification

SecureFPS includes a dedicated, server-governed **Cheater Demonstration Mode** designed for academic evaluation and defense of real-time anti-cheat detection architectures.

### 1. Purpose & Threat Emulation
The demonstration mode allows evaluators to observe live server-side detection, kinematic auditing, and machine learning risk scoring without installing external cheat software or altering normal player mechanics.

### 2. Account Authorization & Server Controls
- **Designated Account:** Reuses the existing `cheater_demo` account (`account_type: "demo_test"`, `demo: true`, `is_demo: true`).
- **Server-Side Enforcement:** Eligibility is strictly validated on the server via authenticated session identity (`/api/game/demo-status`). Client-side parameters or token tampering cannot grant demo privileges.
- **Fail-Closed Security:** Demo capabilities require `APP_ENV=development` and `SECUREFPS_ENABLE_DEMO=1`. Attempting demo activation in production returns `403 Forbidden`.
- **Zero Impact on Ordinary Gameplay:** Normal player accounts, multiplayer rankings, rewards, coins, and Honour scores remain completely unaffected. Demo matches award zero progression and are excluded from leaderboards.

### 3. Demonstration Abilities (Isolated Matches Only)
- **100% Headshots on Registered Hits:** Every bullet that successfully intersects a valid target hitbox registers as a headshot with headshot damage. Missed shots (firing into the sky or unpenetrated walls) are genuinely counted as misses, ensuring accurate accuracy and shot-accounting metrics.
- **4× Movement Speed:** Emulates speed-hack locomotion by scaling horizontal kinematic velocity to 28.0–46.0 m/s (4× normal walk/sprint). Gravity and wall collision remain active.
- **Wall Penetration:** Allows weapon raycasts to penetrate solid scene geometry, recording confirmed target hits without line-of-sight.
- **Strict Multiplayer Isolation:** Demo capabilities are strictly prohibited in multiplayer rooms (`mode: "multiplayer"`). Any attempt to activate demo privileges in multiplayer returns `400 Bad Request`.

### 4. Real-Time Detection Architecture & Separation of Concerns
- **Active ML Feature Vector (5 Features):** The deployed Random Forest and Isolation Forest models evaluate only the standardized 5-feature contract (`accuracy`, `fire_rate`, `movement_speed`, `aim_smoothness`, `kdr`). Model weights, thresholds, and feature spaces are preserved without unauthorized retraining.
- **Independent Rule-Based Detections:** Geometric and statistical anomalies are flagged via separate, server-authoritative netcode rules:
  - **Unusual Headshot Pattern:** Detected when 3 or more consecutive hits achieve a 100% headshot ratio (threshold: $\ge 80\%$, normal human variance $\le 40\%$).
  - **Excessive Movement Speed:** Detected when kinematic telemetry exceeds the physical sprint ceiling ($> 11.5\text{ m/s}$, observed $\ge 25\text{ m/s}$).
  - **Shot Through Obstacle:** Detected when raycast hit telemetry registers an impossible hit through solid geometry (`line_of_sight: false`, `through_obstacle: true`).
  - **Rapid Fire Violation:** Detected when shot intervals drop below the mechanical weapon limit ($< 0.055\text{ s}$).

### 5. Administrator Dashboards & Telemetry Persistence
- **Normal Admin (L1):** Receives real-time Server-Sent Events (SSE) in the **Anti-Cheat Lab — Isolated Demo Environment** feed and Threat Monitoring tab, displaying affected player, match ID, incident type, severity, observed vs. allowed limits, and telemetry evidence.
- **Super Admin (L2):** Global Security Command audits demo incidents labeled as `DEMONSTRATION` alongside active ML inference metrics and player inspection modals.
- **MongoDB Persistence:** Detections are stored in `security_events`, `game_telemetry`, `game_sessions`, and `game_events` with UTC timestamps and `is_demo: true` flags.

### 6. Testing & Verification
```bash
python -m unittest backend/tests/test_demo_cheater_system.py
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

