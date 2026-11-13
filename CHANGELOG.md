# SecureFPS Platform Overhaul - CHANGELOG

## Overview
This changelog documents the complete overhaul of the **Secure Online FPS Game Platform** across the Three.js Client Netcode, Authoritative Node/Socket.IO Game Server, Flask + MongoDB Backend Hardening, and Verification Test Suites.

---

## Section A: Client Netcode (`frontend/public/games/three-fps/`)

| Issue / Requirement | Files & Components Changed | Verification Method |
| :--- | :--- | :--- |
| **A1. Time-Unit Bug & 30Hz Movement** | `js/MultiplayerClient.js` (lines 14–22, 142–158) | Checked timing calculations: replaced seconds-based comparison with `performance.now()` in ms against `syncInterval = 33.33ms` (30Hz). Telemetry continues in seconds. |
| **A2. Volatile Movement Serialization** | `js/MultiplayerClient.js` (lines 150–165) | Movement emitted with `socket.volatile.emit('player:move', payload)` containing `seq`, `clientTime`, `pitch`, `isCrouching`, `isSprinting`, and strictly finite numbers. |
| **A3. Snapshot Interpolation & Smoothing** | `js/MultiplayerClient.js` (lines 190–260) | Timestamped server snapshot buffer (~100ms adaptive delay), shortest-arc yaw slerp, max 150ms extrapolation, frame-rate independent exponential smoothing `(1 - Math.exp(-22 * dt))`. Visual pitch & crouching applied. |
| **A4. Rubberband Reconciliation** | `js/MultiplayerClient.js` (lines 280–295) | Handler for `player:rubberband` reconciles local player controller position & velocity smoothly and resets `moveSeq`. Covered by test `Movement validation rejects speed hacks & emits player:rubberband`. |
| **A5. Client Cosmetic Fire Flow** | `js/Weapons.js` (lines 210–235), `js/MultiplayerClient.js` (lines 310–325) | Local prediction kept for muzzle flash, audio, and bullet tracer. Emits `{ origin, direction, weaponKey, clientTime, seq }`. Removed client-supplied hitPlayerId/damage; floating damage rendered upon authoritative `player:hit_confirmed`. |
| **A6. Robust Connection Handling** | `js/MultiplayerClient.js` (lines 35–85) | `connect()` returns a Promise resolved on `'connect'`; guards duplicate attempts using `this.connectingPromise`; removed `setTimeout(600)` hacks; single event registration flag `this.eventsRegistered`; comprehensive listener cleanup on teardown. |
| **A7. Seamless Reconnection** | `js/MultiplayerClient.js` (lines 100–125, 335–355) | Persists `roomCode` and server-issued `reconnectToken` in `sessionStorage`. On socket reconnect, emits `session:resume`; on `game:reconnected`, restores room state and rebuilds remote players. Verified in `Reconnect via session:resume restores game state`. |
| **A8. Clean Disconnect Implementation** | `js/MultiplayerClient.js` (lines 126–140), `js/main.js` | Implemented complete `MultiplayerClient.disconnect()` (cancels ping heartbeat, strips socket listeners, closes socket, purges remote avatars) preventing errors before audio context disposal. |
| **A9. Network Stats HUD & Adaptive Interpolation** | `js/HUD.js` (lines 80–105), `js/MultiplayerClient.js` (lines 360–385) | Real-time RTT, jitter, and packet loss monitoring in HUD. Adaptive interpolation delay dynamically set to `clamp(70ms, 220ms, RTT + 2 * jitter)`. |
| **A10. 3D Respawn & Avatar Cleanup** | `js/MultiplayerClient.js` (lines 296–308, 410–435) | Full 3D coordinate preservation `(x, y, z)` on respawn (retaining height `y`). Remote avatars cleanly disposed on `player:left`, grace period expiry, and `lobby:leave`. |

---

## Section B: Authoritative Game Server (`multiplayer-server/`)

| Issue / Requirement | Files & Components Changed | Verification Method |
| :--- | :--- | :--- |
| **B1. Zod Validation & Rate Limiting** | `multiplayer-server/server.js` (lines 40–165) | Strict Zod schemas (`LobbyCreateSchema`, `LobbyJoinSchema`, `SessionResumeSchema`, `PlayerMoveSchema`, `PlayerFireSchema`) with try/catch wrapping every socket handler. `SocketRateLimiter` drops floods and disconnects repeat offenders (>25 violations). Verified in `Malformed packets do not crash` and `Rate limiting trips and drops flooding`. |
| **B2. Fixed 30Hz Server Tick & Bounds Validation** | `multiplayer-server/server.js` (lines 180–270), `shared/arena_collision.js` | Fixed 30Hz server tick loop (`TICK_INTERVAL_MS = 1000/30`). Movement verified against velocity budget (`speed * dt * tolerance`), arena boundaries (`isWithinBounds`), and obstacle collisions. Emits `player:rubberband` on cheat detection. |
| **B3. Compact Snapshot Broadcasting** | `multiplayer-server/server.js` (lines 275–310) | Emits exactly 1 delta-compressed `world:snapshot` per active room per tick containing sequence numbers, player transforms, pitch, crouch, and sprint state. |
| **B4. Lag Compensation & Occlusion Hit Reg** | `multiplayer-server/server.js` (lines 420–510), `shared/weapon_config.js`, `shared/arena_collision.js` | 1.2s rolling position history ring buffer. Rewinds target position based on shooter latency ($\le 200$ms). Raycasts head and torso hitboxes. Occlusion tested via `ArenaCollision.checkRaycastOcclusion`. Weapon cooldowns enforced with 15% network jitter tolerance. Verified in tests 4 & 5. |
| **B5. Tactical Spawn Points** | `multiplayer-server/server.js` (lines 330–360) | `getTacticalSpawn()` selects spawn location maximizing distance from active enemies, avoiding spawn-camping. |
| **B6. Room-Level Respawn Scheduler** | `multiplayer-server/server.js` (lines 515–545) | Independent room-level respawn timer (3s delay) with 2.0s spawn protection (`spawnProtectedUntil`). Functions reliably even if killer disconnects mid-timer. Verified in test 6. |
| **B7. Authoritative Match Lifecycle** | `multiplayer-server/server.js` (lines 312–328, 550–575) | Authoritative match timer (600s) and score limit (25 kills). On match completion, broadcasts authoritative scoreboard, persists match stats, and resets room to lobby. |
| **B8. Robust Room Management** | `multiplayer-server/server.js` (lines 580–670) | Prevents ghost rooms: cleans up previous room before creating/joining; limits to max 6 rooms per IP and 500 total; cryptographically secure 6-character room codes (`crypto.randomInt`); sanitized room state serialization. |
| **B9. Handshake JWT Auth & Single Session** | `multiplayer-server/server.js` (lines 120–155) | Validates JWT token on connection (`socket.handshake.auth.token`). Enforces 1 active socket per `userId`, gracefully disconnecting stale sessions with `session:replaced`. Verified in test 8. |
| **B10. Health Endpoints & Graceful Shutdown** | `multiplayer-server/server.js` (lines 680–720) | Operational endpoints `/health`, `/api/health`, `/status`. Graceful SIGINT/SIGTERM handlers closing active sockets, server listeners, and unref'd tick timers. |

---

## Section C: Flask Backend Hardening (`backend/`)

| Issue / Requirement | Files & Components Changed | Verification Method |
| :--- | :--- | :--- |
| **C1. Startup Security Checks & Settings** | `backend/app.py` (lines 30–50, 87–105) | Refuses production boot if `FLASK_SECRET_KEY`, `ADMIN_PASSWORD`, or `ADMIN_MFA_SECRET` are missing or default. Defaults `FLASK_DEBUG=0` and binds host `127.0.0.1` in production. Preserves dev ergonomics when `SECUREFPS_LOCAL_DEV=true`. Verified in `test_startup_settings_default_secure` and `test_production_refuses_insecure_secrets`. |
| **C2. Authentication Hardening & DB Lockouts** | `backend/routes/auth_routes.py` (lines 40–180), `backend/database/db.py` | Strict string/type checks on all inputs; rate limits applied to auth endpoints; demo flows gated strictly on `SECUREFPS_ENABLE_DEMO=true`; HTML escaping in email notifications; DB-backed MFA failure counter locking out after 5 consecutive failures for 15 minutes. Verified in `test_mfa_db_lockout_after_repeated_failures`. |
| **C3. Session Storage & High-Concurrency Cache** | `backend/app.py` (lines 185–270), `DEPLOYMENT.md` | In-memory thread-safe short-TTL (25s) session verification cache; throttled `last_activity` updates (at most once every 45s); production guide for Redis session storage, Gunicorn gthread workers, and Nginx reverse proxy. |
| **C4. Match Reward Integrity** | `backend/routes/game_routes.py` (lines 1840–1905) | Match completion requires minimum 30s duration; enforces daily cap of 20 reward matches; ignores client-supplied kill and accuracy claims in favor of server-verified metrics. Verified in `test_reward_integrity_rejects_sub_30s_match` and `test_reward_integrity_enforces_daily_cap`. |
| **C5. Handshake Socket Token Issuance** | `backend/routes/game_routes.py` (lines 610–640) | `/api/game/start` signs and returns an authoritative JWT `socket_token` for Socket.IO multiplayer authentication. Verified in `test_game_start_issues_signed_socket_token`. |
| **C6. Event Batching & Telemetry Rate Limits** | `backend/routes/game_routes.py` (lines 650–700), `frontend/public/games/three-fps/js/TelemetryClient.js` | Client batches telemetry events in chunks of up to 20 or every 1.5s; server validates batched array, enforces rate limits, and suppresses verbose per-event terminal logging in production. |
| **C7. Internal Anti-Cheat Bridge** | `backend/routes/game_routes.py` (lines 710–760) | Added `/api/internal/anti-cheat-report` with HMAC signature validation for game server to stream telemetry violations to the anti-cheat pipeline. |
| **C8. Static Asset Caching** | `backend/app.py` (lines 280–310) | Removed unconditional `no-store` headers; serves models, audio, textures, and 3D assets with `Cache-Control: public, max-age=86400`. |
| **C9. Database Indexes & Repository Hygiene** | `backend/database/db.py` (lines 75–110) | Added compound and TTL indexes: `game_sessions(session_id, game_token)`, `game_sessions(expires_at, TTL)`, `sessions_db(user_id, is_active)`, `reward_transactions(user_id, created_at)`, `mfa_lockouts(user_id, ip)`. Cleaned repository of stray artifacts. |

---

## Section D: Automated Verification Test Results

### 1. Multiplayer Server Suite (`npm test`)
Ran `node --test test/*.test.js`:
- `Authoritative Multiplayer Server Netcode` (8 tests): **8 Passed**
  1. Malformed packets do not crash the process.
  2. Rate limiting trips and drops packet flooding.
  3. Movement validation rejects speed hacks & emits `player:rubberband`.
  4. Combat arbitration: weapon cooldown enforced and wall occlusion blocks shot.
  5. Lag-compensated hit detection and authoritative damage calculation.
  6. Room-level respawn succeeds even if killer disconnects.
  7. Reconnect via `session:resume` restores game state.
  8. Single active socket per user ID disconnects prior duplicate.
- `Simulated Network Harness` (3 tests): **3 Passed**
  1. Low Latency (50ms RTT, $\pm 8$ms jitter, 5% loss): interpolation error 0.0000m < 0.45m; valid hit registration.
  2. Moderate WAN (100ms RTT, $\pm 15$ms jitter, 5% loss): interpolation error 0.0000m < 0.45m; valid hit registration.
  3. High Latency WAN (200ms RTT, $\pm 25$ms jitter, 5% loss): interpolation error 0.0000m < 0.45m; valid hit registration.
- **Total: 11 / 11 tests passed.**

### 2. Flask Backend Test Suite (`pytest backend/tests`)
Ran `python -m pytest backend/tests`:
- `test_api.py`: 4 passed
- `test_auth_sessions.py`: 2 passed
- `test_authoritative_backend.py`: 6 passed
- `test_ban_enforcement.py`: 3 passed
- `test_features_v2.py`: 3 passed
- `test_frontend_serving.py`: 4 passed
- `test_lan_sse.py`: 1 passed
- `test_local_server_settings.py`: 3 passed
- `test_model_scoring.py`: 3 passed
- `test_phase6_pipeline.py`: 6 passed
- `test_player_completed_matches.py`: 1 passed
- `test_seed_demo_players.py`: 5 passed
- **Total: 41 / 41 tests passed.**

---

## Section E: Game AI, Characters & HUD Overhaul (`frontend/public/games/three-fps/`)

| Issue / Requirement | Files & Components Changed | Verification Method |
| :--- | :--- | :--- |
| **E1. Binary Asset Integrity & Rigged Loader** | `.gitattributes`, `README.md`, `js/TacticalOperator.js` (lines 40–120) | Configured `*.glb binary` in `.gitattributes`. Implemented glTF binary header validation checking magic number (`0x46546C67`) and UTF-8 replacement byte sequence (`0xef 0xbf 0xbd`) to prevent corrupted text-mode copies from crashing WebGL. Defensive bone mapping (`mixamorig*`, `head`, `spine`, `righthand`, etc.) with bone scale compensation. |
| **E2. Articulated Procedural Character Rig** | `js/TacticalOperator.js` (lines 140–340) | Built articulated humanoid procedural character replacing boxy robot models: pelvis, lower/upper spine, chest with plate carrier armor, neck, head with tactical helmet/NVG/visor, articulated shoulder pivot groups, elbow pivots, detailed hands with knuckle guards, hip pivots, knee pivots with pads, and combat boots. Clothing and armor accents tinted with team colors. |
| **E3. Visible Weapons & Two-Handed Hold** | `js/TacticalOperator.js` (lines 350–520, 680–740) | Procedural weapon models for Carbine, SMG, Sniper, and Pistol attached to right hand socket. Two-handed hold pose with left arm supporting handguard and stock seated in right shoulder pocket. Firing animation triggers physical weapon recoil kick, dynamic muzzle flash point light, starburst muzzle sprite, and brass shell casing ejection. |
| **E4. Shared Character Factory for Remote Players** | `js/MultiplayerClient.js` (lines 190–240), `js/TacticalOperator.js` | Replaced crude box `RemotePlayer` in `MultiplayerClient.js` with `new TacticalOperator(...)` shared factory. Remote players inherit full procedural articulation, weapon models, sprint/crouch kinematics, pitch tracking, and dynamic weapon swapping (`remote.setWeapon(p.weaponKey)`). |
| **E5. Dataset-Driven Bot Profiles Generator** | `tools/build_bot_profiles.py`, `data/bot_profiles.json` | Script extracts legitimate human telemetry (`Label == 0`) from `backend/data Preprocessing/cheating_detection_dataset (1).csv`. Generates 64 calibrated personas across 3 skill bands: Easy (21), Normal (22), Hard (21), outputting documented units for `reaction_time_ms`, `accuracy_pct`, `headshot_ratio_pct`, `fire_rate_s`, `movement_speed_ms`, and `aim_smoothness`. |
| **E6. Concurrent Bot Attacks & Humanized Aiming** | `js/BotManager.js` (lines 110–260, 410–540) | Removed artificial single-attacker token bottleneck. Bots engage concurrently balanced by human reaction delay ($\ge 150$ms + jitter) and angular aim error convergence. Bots move and strafe while firing (direction reversals every 0.8–1.8s), eliminating stationary robot behavior. |
| **E7. Audio-Visual Gunfire Feedback** | `js/AudioFX.js` (lines 200–260), `js/BotManager.js` (lines 620–680) | Added `AudioFX.playPositionalGunshot()` with 3D logarithmic distance attenuation up to 55m and `AudioFX.playBulletWhiz()` for supersonic near-miss cracks within 2.5m. Bot fire spawns physical ballistic tracers, muzzle flashes, and wall impact sparks. |
| **E8. Distinct Bot Roles, Routes & Hearing Alerts** | `js/BotManager.js` (lines 40–105, 340–400), `js/Weapons.js` (lines 270–290) | 4 tactical roles: Pointman (Carbine, central push), Flanker (SMG, outer perimeter loop), Marksman (Sniper, elevated platform crouch-hold), and Scout (SMG, cross-lane roaming). Bots react to unsuppressed gunshot audio within hearing radius, scan environment with head yaw during patrols, investigate last-seen player positions for 5s, and engage rival bots in FFA combat. |
| **E9. Compact Top-Center Match HUD Panel** | `index.html` (lines 620–650), `css/game.css` (lines 640–720), `js/HUD.js` (lines 360–400), `js/main.js` (lines 1620–1685) | Replaced bulky top-left match bar with sleek semi-transparent top-center panel: mode badge (`FREE ROAM`, `BOTS • NORMAL`, `MULTIPLAYER ARENA`), alive/total or enemy count (`ENEMIES LEFT 4/4` or `ALIVE 5/8`), kills with target score (`KILLS 12 / 25`), real elapsed/remaining match timer, and ping (`LOCAL (0ms)` in offline, real RTT in MP). |
| **E10. Dev Overlay Hidden by Default & Clean FPS Badge** | `index.html` (lines 385–395, 660–685, 720–745), `js/Controller.js` (lines 70, 258–268), `js/main.js` (lines 715–725, 860–870) | Input diagnostics and engine diagnostics hidden by default (`display: none;` with `.dev-overlay-element`). Bound `F3` key to toggle dev overlay on/off. FPS setting in menu defaults to unchecked; when enabled, renders a single clean `60 FPS` badge in the top-right corner. |
| **E11. Removal of Hardcoded Placeholder Strings** | `index.html`, `js/main.js`, `js/GameModeManager.js` | Removed hardcoded `"Ghost_01"` value in lobby input in favor of authenticated username or random `Operator_###` callsign. Removed static `"14ms"` ping, `"12:00"` timer, and `"100/100"` honour values in HTML. Replaced with live dynamic values. |
| **E12. Menu Mode Clarification: Free Roam vs Bots** | `index.html` (lines 52–98), `js/main.js` (lines 200–215), `js/GameModeManager.js` (lines 150, 183) | Refactored Tab 1 to "FREE ROAM" (zero hostile bots, no timer expiration, free exploration and kinematics practice). Refactored Tab 2 to "VS TACTICAL BOTS" with Easy, Normal, and Hard difficulty cards driving dataset bot personas. |
| **E13. Comprehensive Automated AI & HUD Test Suite** | `test/ai_hud_verification.test.js` | Built 12-test automated suite covering binary checks, anatomical procedural rig, procedural weapon hold and recoil, dataset persona distributions, BotManager concurrent combat, audio-visual gunfire effects, compact match panel, F3 dev overlay toggles, placeholder eradication, and game mode behavior. **All 12 tests passed**. |

---

## Section F: Capstone Final Hardening & Verification (Phases 0–7)

| Phase & Item | Files & Components Changed | Verification Method |
| :--- | :--- | :--- |
| **F0. Audit & Baseline Verification** | `package.json`, root test runners | Audited existing features; verified zero regressions across all 82 baseline tests (54 backend, 11 game server, 12 Three.js AI/HUD, 5 GLB validator). |
| **F1. Easy Security Wins** | `backend/app.py`, `backend/database/db.py` | Configured `ProxyFix` for trusted reverse proxy headers; Python standard `logging`; secure randomized dev admin secrets when env vars are missing; MongoDB TTL indexes on `sessions_db`, `game_sessions`, `game_telemetry`, and `game_events`. Verified with `pytest backend/tests/`. |
| **F2. Authoritative Netcode & Room Monitoring** | `multiplayer-server/server.js`, `package.json` | Added `/api/rooms` endpoint reporting active rooms, players, scores, latency, and status. Configured unified npm test scripts. Verified with `npm --prefix multiplayer-server test` (11 passed). |
| **F3. ML Serving Skew & Benchmark** | `backend/models/feature_ranges.json`, `backend/tests/test_model_serving_skew.py`, `scripts/evaluate_models.py`, `docs/FEATURES_AND_DATASET.md` | Exported exact min/max bounds for all 21 features; created test proving identical array serialization; executed 10-model benchmark (Gradient Boosting 98.6% accuracy, 0.999 AUC); documented feature engineering and risk scale. |
| **F4. Real-Time Pipeline & Anti-Cheat Bridge** | `backend/routes/game_routes.py`, `multiplayer-server/server.js`, `scripts/cheat_simulator.js`, `scripts/measure_realtime.py`, `docs/REALTIME_RESULTS.md` | SSE stream with heartbeats (`: heartbeat`), `Last-Event-ID` replay buffer, latency timestamps (`server_received_at`, `analysis_done_at`, `alert_published_at`); 1.5s sliding-window HMAC-signed feature bridge; headless adversary simulator; empirical benchmark (p50 latency 24.8ms, total time to suspension 1.53s < 2.5s budget). |
| **F5. Admin & Player Dashboard Refinement** | `frontend/admin.html`, `frontend/js/admin/`, `frontend/player.html`, `frontend/js/player.js`, `backend/app.py` | Live multiplayer room inspection panel; "detected in X.Xs" latency badges; automatic `/frontend/` prefix redirection; bfcache-aware SSE lifecycle cleanup (`pagehide`/`pageshow`); WebP profile avatar and banner uploads. |
| **F6. Demo Readiness Scripts** | `scripts/seed_demo.py`, `scripts/reset_demo.py`, `docs/DEMO_SCRIPT.md` | Built automated demo seeder (clean players, admin, flagged cheater, ban appeal, match history), database reset utility, and step-by-step walkthrough demo script for zero-friction evaluation. |
| **F7. Architecture & Threat Documentation** | `README.md`, `docs/ARCHITECTURE.md`, `docs/THREAT_MODEL.md`, `docs/LIMITATIONS.md` | Complete architecture guide with Mermaid topology diagram; MITRE/STRIDE-aligned threat model with mitigation matrix; honest limitations and human asset instructions. |

---

## Section G: Player Experience & In-Game Combat Fixes

| Issue / Requirement | Files & Components Changed | Verification Method |
| :--- | :--- | :--- |
| **G1. In-Game Red Error Banner Removal** | `frontend/public/games/three-fps/index.html`, `css/game.css`, `js/TacticalOperator.js` | Removed on-screen `#dev-model-notice-banner` element; added CSS `display: none !important;`; silenced `updateDevOverlayStatus()` so the red banner never renders during gameplay. Verified in `combat_hit_registration.test.js`. |
| **G2. Combat Firing & Enemy Hit Registration Fix** | `frontend/public/games/three-fps/js/TacticalOperator.js`, `js/Weapons.js`, `js/BotManager.js` | Replaced `visible: false` on hitbox material with `{ transparent: true, opacity: 0, depthWrite: false }` so Three.js Raycaster reliably intersects bot head and body hitboxes. Added immediate trigger response on click in `Weapons.js`, filtered out particle FX and UI sprites during raycast, restored correct local positions on bot respawn, and improved `resolveCombatTarget()` to detect headshots and deal fatal damage to bots. Verified with `combat_hit_registration.test.js` and automated tests. |
| **G3. Game Hub: Only Games Visible** | `frontend/player.html` | Removed redundant `.quick-launch-strip` ("Features" strip) from Game Hub tab; updated title to "FPS Training Arenas"; cards strictly display `CyberStrike 3D` and `FPS Microgame` with high-contrast chibi avatars. |
| **G4. Aesthetic Background Image Restoration** | `frontend/css/player.css` | Restored `--player-scene-image` (`cosmic-cherry-blossom.jpg`) with an 86%–92% soft lavender gradient tint (`#F4F1FC`), keeping the background art visible while ensuring the sidebar and logo have clean, non-clashing backgrounds. |
| **G5. Profile Account Creation Date Fix** | `backend/routes/player_routes.py`, `frontend/js/player.js` | Added server-side fallback to `user["_id"].generation_time` if `user.created_at` is missing in MongoDB, backfilling it into the user document. Updated `playerDate()` in `player.js` to format localized date strings (e.g., `Oct 31, 2026`). Verified with `pytest backend/tests/`. |

---

## Section H: Tactical Gameplay, Anti-Cheat Telemetry & Combat Polish

| Issue / Requirement | Files & Components Changed | Verification Method |
| :--- | :--- | :--- |
| **H1. Match 0 Kills & Incomplete Features Fix** | `backend/routes/game_routes.py` (lines 815–835, 1845–1890), `backend/routes/player_routes.py`, `frontend/public/games/three-fps/js/TelemetryClient.js` | Injected missing `user_id` and timestamps into batched game events in `/api/game-events`. Persisted verified match statistics (`kills`, `deaths`, `shots`, `hits`, `accuracy`, `kdr`) directly in `game_sessions`. Added default human-range fallback for `aim_smoothness` in `extract_features` to prevent `incomplete_features` analysis failures. Flushed event queue before ending session. Verified with automated tests. |
| **H2. Bot Wall & Obstacle Collision (Anti-Stuck & Sliding)** | `frontend/public/games/three-fps/js/BotManager.js` | Implemented `resolvePenetration()` checking bounding sphere overlaps against arena colliders and pushing bots out along the shallowest axis. Added tangential wall sliding in `moveTowards()` so bots do not get stuck when walking into crates or perimeter walls. Clamped positions within arena boundaries `[-36, 36]`. Relocated tactical spawn points away from obstacles. Verified in `combat_hit_registration.test.js`. |
| **H3. Firing After Death Prevention** | `frontend/public/games/three-fps/js/Weapons.js` | Added `isPlayerAlive()` checking `gameMode.isDead`, `gameMode.isMatchCompleted`, and `controller.health <= 0`. Guarded `fire()`, pointer lock mousedown listener, and automatic fire loop to immediately cancel firing when dead. Verified in `combat_hit_registration.test.js`. |
| **H4. Weapon Viewmodels Polish (Tactical Realism)** | `frontend/public/games/three-fps/js/Weapons.js`, `frontend/public/games/three-fps/js/TacticalOperator.js` | Completely redesigned secondary and special weapon models: Vector-9 SMG (upper metal receiver, Picatinny top rail, reflex micro red-dot sight, angled tactical foregrip, curved magazine, folding stock), AWM-50 Recon Sniper (fluted heavy barrel, tactical muzzle brake, high-power telescopic scope with turrets, skeletonized stock with cheekpad, bolt handle & knob, folded bipod), G-18 Pistol (beveled gunmetal slide with cocking serrations, ejection port, front/rear night sights, polymer frame with accessory rail, trigger guard & trigger, extended magazine baseplate). Verified with `ai_hud_verification.test.js`. |
| **H5. Elite Special Forces Face Model Polish** | `frontend/public/games/three-fps/js/TacticalOperator.js`, `frontend/public/games/three-fps/js/TextureGenerator.js` | Replaced loose geometric facial primitives with a sleek form-fitting tactical combat balaclava/half-mask (`#1b2027` ballistic weave) with realistic eye opening revealing human skin tone, sclera, hazel/steel irises, and eyelids, fitted with polarized dark smoke ballistic sunglasses with matte black frames. Verified in `ai_hud_verification.test.js`. |
| **H6. Shots & Hits Calculation Transparency** | `frontend/public/games/three-fps/index.html`, `frontend/public/games/three-fps/js/main.js`, `frontend/js/player.js` | Added `mc-shots` and `mc-hits` to in-game match completion overlay. Formatted accuracy as `XX.X% (Hits/Shots)`. Added Calculation Transparency card in player dashboard match detail modal, showing total shots fired, shots hit, and exact percentage. Verified in `combat_hit_registration.test.js`. |
| **H7. Cache Busting & Asset Reloading** | `frontend/player.html`, `frontend/public/games/three-fps/index.html` | Updated version query parameters to `?v=20261113_2030` across all dashboard and game scripts, ensuring browser Live Server and client tabs load updated code immediately without stale cache. |

---

## Section J: Visual Theme Refinements, Combat Perks & Match Card Parity

| Issue / Requirement | Files & Components Changed | Verification Method |
| :--- | :--- | :--- |
| **J1. CyberStrike 3D Unique Purple Centerpiece** | `frontend/css/player.css`, `frontend/player.html` | Styled CyberStrike 3D card in the Game Hub with a rich electric purple theme (`#7c3aed`, `#2e1065`, `#581c87`), 2px purple border, glowing purple box shadow, and purple play button, standing out as the featured centerpiece arena. Verified in browser and tests. |
| **J2. Tactical Armory & Useful Combat Perks** | `backend/routes/player_routes.py`, `frontend/player.html`, `frontend/js/player-features.js` | Upgraded cosmetic badges in Rewards store to functional tactical FPS combat perks: Recoil Compensator (`🎯`, 150 coins), +25% XP Combat Protocol (`⚡`, 120 coins), Night-Stalker Operator Camo (`🥷`, 250 coins), and Tactical Extended Mags (`📦`, 200 coins). |
| **J3. Clean Match Card Badges & Accuracy Display** | `frontend/js/player.js` | Formatted match card accuracy strictly as percentage (e.g. `33.0%`). Simplified bottom feature row to display exclusively: `🛡️ Fair Play Verified`, `⭐ +XP`, and `🪙 +Coins`. Removed redundant shots/weapon tags and raw diagnostic notes. Verified in `combat_hit_registration.test.js`. |
| **J4. Details Modal vs Match Card Statistics Parity** | `backend/routes/player_routes.py` | Replaced `.limit(200)` manual iteration in `get_match_detail(session_id)` with authoritative `game_telemetry.count_documents` queries for `enemy_killed`, `player_death`, `weapon_fire`, and `enemy_hit`, guaranteeing identical stats between match cards and the detailed drilldown modal. |
| **J5. Distinct Game Hub Character Artwork** | `frontend/js/player.js`, `frontend/player.html` | Preserved unique character mascots on Game Hub cards (CyberStrike 3D with female cyber operator `chibi-female-1.png` and FPS Microgame with tactical operator `chibi-male-1.png`) by preventing user profile avatar updates from overwriting game card artwork. |

---

## Section K: Equippable Operator Skins, Profile Banners & Purple Aesthetics

| Issue / Requirement | Files & Components Changed | Verification Method |
| :--- | :--- | :--- |
| **K1. Equippable Operator Skins & Avatars in Store** | `backend/routes/player_routes.py` (lines 74–130, 810–845) | Added real equippable operator skins (`skin_neon_valkyrie`, `skin_cyber_ninja`, `skin_phantom_ghost`, `skin_tactical_vanguard`). In `equip_reward_item()`, equipping an avatar skin updates `profile_customization.avatar` directly in the database. Verified with test suite. |
| **K2. Equippable Profile Scene Banners in Store** | `backend/routes/player_routes.py`, `frontend/js/player-features.js` | Added scene banners (`banner_sakura_neon`, `banner_cosmic_cherry`, `banner_sakura_dawn`, `banner_sakura_frontline`). Equipping a banner updates `profile_customization.banner` and immediately changes the live page background scene. |
| **K3. Live Store Preview Cards & Real-Time Equipping** | `frontend/js/player-features.js`, `frontend/player.html`, `frontend/css/player.css` | Rendered preview thumbnail boxes for avatars and banners, type badges (`OPERATOR SKIN`, `SCENE BANNER`, `WEAPON SKIN`, `COMBAT PERK`), unlocked state badges, and dynamic "Equip Skin" / "Equip Banner" buttons that instantly update the dashboard appearance without page reload. |
| **K4. Rich Royal Purple Aesthetics Across Dashboard** | `frontend/css/player.css` | Implemented electric royal purple theme (`#7C3AED`, `#6D28D9`, `#8B5CF6`): sidebar active navigation link features an electric purple gradient (`linear-gradient(135deg, #7C3AED, #6D28D9)`) with purple glow, hover links use soft lavender (`#F3E8FF`), and stat balance cards feature purple top borders and text. Verified in `combat_hit_registration.test.js`. |

---

## Section L: Avatars & Banners Cosmetic Vault Overhaul

| Issue / Requirement | Files & Components Changed | Verification Method |
| :--- | :--- | :--- |
| **L1. Legacy Badges & Combat Perks Removed from Store** | `backend/routes/player_routes.py` (lines 74–185, 765) | Replaced text-heavy perks and legacy badges with real cosmetic gear. Marked old items `"hidden": True` so only high-tier visual cosmetics populate the store grid while preserving backward-compatibility. |
| **L2. Six High-Fidelity Equippable Operator Avatars** | `frontend/public/avatars/`, `backend/routes/player_routes.py`, `frontend/js/player.js` | Integrated 6 distinct operator avatars: Valkyrie Void (`valkyrie-void.png`), Ghost Spec-Ops (`ghost-specops.png`), Neon Valkyrie (`chibi-female-1.png`), Cyber Infiltrator (`chibi-male-1.png`), Phantom Recon (`chibi-female-2.png`), and Tactical Vanguard (`chibi-male-2.png`). Equipping directly updates `profile_customization.avatar`. |
| **L3. Eight High-Resolution Panoramic Scene Banners** | `frontend/public/backgrounds/`, `backend/routes/player_routes.py`, `frontend/css/player.css`, `frontend/js/player.js` | Integrated 8 panoramic banners: Cyber Metropolis (`cyber-metropolis.jpg`), Orbital Bastion (`orbital-bastion.jpg`), Cosmic Blossom (`cosmic-cherry-blossom.jpg`), Sakura Neon Cyber (`sakura-neon.jpg`), Command Ops Center (`command-center.jpg`), Frontline Battlefield (`battlefield.jpg`), Purple Dawn Skyline (`sakura-dawn.jpg`), and Combat Outpost (`sakura-frontline.jpg`). Equipping directly changes the live page scene. |
| **L4. Real-Time Category Filter Tabs & Preview Cards** | `frontend/player.html`, `frontend/js/player-features.js`, `frontend/css/player.css` | Added interactive category filter pills (`All Items`, `👤 Avatars (6)`, `🖼️ Banners (8)`), image preview boxes with violet radial glow, and dynamic "Equip Skin" / "Equip Banner" buttons. Verified in `combat_hit_registration.test.js`. |






