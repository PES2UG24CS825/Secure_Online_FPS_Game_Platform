# GameHub Unity Integration Plan

**Status:** Stage 1 plan prepared; pending approval before implementation. This request's Stage 1 made documentation changes only. The worktree already contains earlier uncommitted integration changes; see `GameHub_Unity_Integration_Audit.md`.
**Constraint:** Do not proceed to Stage 2 until the user approves this plan. No Unity Editor or browser multiplayer test was run during this audit.

## 0. Existing build evidence and current status

The existing integration notes record a previous Unity 6000.3.26f1 build attempt. It exposed existing C# source errors in:

- `Assets/Scripts/UI/Game/PauseMenu.cs:82`: `InputSystem_Actions.UIActions` is a value type and cannot be compared to `null`.
- `Assets/Scripts/Gameplay/UI/RespawnScreen.cs:71,139,144`: the installed `EntityManager` API has no `IsCreated` member.
- `Assets/Scripts/Gameplay/UI/LeaderboardUi.cs:99`: `InputSystem_Actions.UIActions` is a value type and cannot be compared to `null`.
- `Assets/Scripts/Gameplay/UI/LeaderboardUi.cs:107,130,185`: the installed `EntityManager` API has no `IsCreated` member.

The existing integration notes say those checks were subsequently changed. The next recorded attempt failed when Unity's Bee pipeline could not launch `BeeLocalCacheTool` (Windows error 1455, paging file too small); player-script compilation was not verified. This is historical documentation, not a build rerun or an independently verified result in this audit.

The existing integration notes recorded 6 GB physical memory and about 595 MB free at the prior attempt. Current disk inspection found a Unity project WebGL output (large `WebGL.data` and `WebGL.wasm` files dated 2026-10-29, and an `index.html` dated 2026-10-30) and a separate, partial `frontend/public/games/Multiplayer_FPS/Build/` containing old `WebBuild.*` files dated 2026-10-23. Neither is evidence of a fresh, complete, served, or browser-tested build.

## 1. Proposed integration decision

Integrate the `unity-games/Multiplayer_FPS` project through the existing player dashboard's Game Hub section at `frontend/player.html#games`. Keep the existing `frontend/game.html` launch shell and replace its legacy game target only after the new Unity build and launch checks pass.

Do not create a second GameHub, player dashboard, admin dashboard, website, React app, or Flask backend. Keep the existing `FPS_Microgame` artifact/project working until the Multiplayer_FPS flow is verified.

### Hosting target

Use the established static asset convention:

```text
frontend/public/games/Multiplayer_FPS/
├── index.html
├── Build/
├── StreamingAssets/
└── TemplateData/
```

This is the same hosting root already used for `FPS_Microgame` and is below Flask's configured `FRONTEND_DIR`. `Assets/Editor/GameHubWebGLBuild.cs` already targets this directory and builds the enabled scenes; use that build entry point after ensuring its template/client loading is reproducible. The target directory currently contains only stale `Build/WebBuild.*` files, not a complete player. The broad `.gitignore` `Build/` rule currently ignores these files, so add narrow target allowlist rules if the deployment artifact is expected in the repository. Do not copy arbitrary files, use stale output, or edit generated `index.html` as the sole durable fix.

The Unity project settings select Brotli (`webGLCompressionFormat: 2`) and disable decompression fallback. Recommend Brotli with the current Flask server's `.br` negotiation and `Content-Encoding: br` behavior; verify the fresh build actually emits Brotli sidecars and that responses retain `.wasm`/`.data` MIME types. Existing `backend/tests/test_frontend_serving.py` covers a compressed WASM response, but that test was not run during Stage 1.

The GameHub should use the current game-card design. Add an actual Multiplayer_FPS thumbnail from an approved image source and a visible multiplayer label; do not reuse an unrelated legacy game's image. Keep the existing player dashboard sections and styles.

## 2. Proposed user and system flow

```mermaid
sequenceDiagram
    participant Player
    participant Hub as player.html#games
    participant Launch as game.html
    participant API as Canonical Flask API
    participant Unity as Multiplayer_FPS WebGL
    participant Signal as Flask-SocketIO
    participant Peer as Other browser
    participant DB as Existing MongoDB

    Player->>Hub: Sign in with existing login + MFA
    Hub->>API: GET /api/auth/me (session cookie)
    API-->>Hub: Authenticated player identity
    Player->>Hub: Click Multiplayer FPS card
    Hub->>Launch: Navigate using existing application flow
    Launch->>API: POST authenticated game launch request
    API->>DB: Verify access and create game-bound session/grant
    API-->>Launch: Short-lived, single-use launch grant in response body
    Launch->>Unity: Load same-origin WebGL build; deliver grant via controlled postMessage
    Unity->>API: Redeem grant; verify active game session
    Player->>Unity: Create Session or Join Session with room code
    Unity->>Signal: Authenticated Socket.IO create/join + WebRTC offer/answer/ICE
    Signal->>DB: Persist/validate room membership if required by approved schema
    Signal-->>Peer: Relay authorized offer/answer/ICE
    Unity<<->>Peer: Browser RTCPeerConnection / RTCDataChannel
    Unity->>API: Send bounded, session-bound telemetry batches
    API->>DB: Store raw events, analyses, and review alerts
    API-->>Player: Return to GameHub/session summary
    API-->>DB: Feed existing player/admin dashboard APIs
```

The dashboard, API, and Unity game should be same-origin where possible. If the frontend and backend are deployed on different origins, provide a single explicit application configuration for API and Socket.IO origins and verify cookie/CORS/SameSite behavior. Never put passwords or reusable/long-lived game tokens in URL query parameters. A launch grant should be short-lived, single-use, bound to the authenticated player/game/session, stored hashed server-side if persisted, and redeemed before gameplay.

### Existing data and proposed MongoDB records

Reuse MongoDB collections already bound in `backend/database/db.py`:

| Collection | Proposed Multiplayer_FPS use |
|---|---|
| `sessions` | Existing browser-authentication sessions only. Never use as game-session storage. |
| `game_sessions` | One player-owned participation record per player, with a unique participation `session_id` and common `match_id`, game ID, owner `user_id`, status/timestamps, and launch-grant hash/expiry/consumed state. Store no reusable plaintext grant. |
| `game_telemetry` | Append bounded gameplay and connection events; derive `user_id`, `game_id`, and participation from server-side records rather than trusting client-supplied identity. |
| `game_events` | Per-player or match-level analysis result, risk score, model status, and supporting feature summary. |
| `security_events` | Suspicious signals and confirmed protocol/validation violations with evidence and review state; no one-event automatic ban. |
| `multiplayer_matches` (new, justified if approved) | Shared match/room lifecycle and roster because `game_sessions` is player-owned and current signaling rooms exist only in process memory. Store match ID, hashed room code, host/participant IDs, capacity, state and expiry; do not store passwords or HMAC keys in plaintext. |

Use the existing collection names where possible. A separate shared match collection is needed only if a durable cross-player room/match record cannot be represented safely by participant documents. Keep room codes short-lived, unique while active, and protected against guessing/rate abuse.

### Proposed API and signaling contract

These are proposed additions to the existing `game_bp` (`/api`) and existing Flask-SocketIO server, not endpoints that exist today:

| Method / event | Proposed purpose and checks |
|---|---|
| `POST /api/games/multiplayer-fps/launch` | Require an active authenticated player and game access; create a game-bound, random launch grant with expiry under 60 seconds; store only its hash; return the grant in a JSON body. |
| `POST /api/games/multiplayer-fps/launch/redeem` | Redeem once for the signed-in player and fixed game ID; reject expired, replayed, revoked, wrong-player/game grants; return a per-player participation ID and short-lived session configuration. |
| `POST /api/games/multiplayer-fps/sessions` | Create the shared match, host membership, participant record and room code; only after grant redemption. |
| `POST /api/games/multiplayer-fps/sessions/join` | Validate room code, active/unexpired state, two-player capacity, player distinctness and authenticated membership; create joiner participation record. |
| Socket.IO `create_room`, `join_room`, `signal` | Evolve the existing events to require the corresponding active game participation/match membership. Preserve bounded offer/answer/ICE validation; reject nonmembers. |
| `POST /api/games/multiplayer-fps/sessions/{match_id}/telemetry` | Accept a bounded batch for a registered participant; authenticate the browser, bind IDs server-side, validate schema/HMAC/sequence/rate and persist. |
| `POST /api/games/multiplayer-fps/sessions/{match_id}/complete` | Flush/finalize the requesting participant; finalize match only after both participants finish or defined timeout/forfeit handling. Trigger validation and detection after final accepted telemetry. |
| Existing `GET /api/player/matches` and `/api/player/security` | Extend to return only the authenticated player's own match results and security status. |
| Existing `GET /api/admin/overview` plus new `GET /api/admin/gameplay/sessions/{match_id}` | Extend the active admin API for totals and authorized session/event drill-down; do not assume `admin_routes.py` is registered. |

The existing Socket.IO room code handlers currently authenticate only the browser session and are not tied to a game session. The current `POST /api/game/start`, `/api/game-events`, and `/api/game/end` routes are FPS_Microgame-specific and should remain compatible for the legacy game while the new routes are tested.

### DataChannel protocol

Use browser `RTCPeerConnection` + `RTCDataChannel` inside `WebRTCBridge.jslib`, with Unity callbacks through `SendMessage` (or `dynCall` where a C callback is actually needed); do not use `com.unity.webrtc`, Unity NetCode/Ghosts, raw sockets, or threads for the WebGL gameplay channel.

Every DataChannel message uses a versioned canonical UTF-8 envelope:

```json
{
  "v": 1,
  "match_id": "uuid",
  "participation_id": "uuid",
  "sender_id": "server-issued opaque player id",
  "seq": 42,
  "type": "input",
  "sent_at_ms": 123456789,
  "payload": {},
  "mac": "base64(HMAC-SHA256(session_key, canonical_fields_without_mac))"
}
```

Define allowed message types and payload keys explicitly: `ready`, `ping`, `pong`, `input`, `snapshot`, `fire_intent`, `reload_intent`, `game_event`, and `leave`. Inputs carry bounded movement/look/jump intent; only host-generated snapshots/events carry resolved position, health, ammo, hit/damage, death and respawn state. Include a monotonic per-sender sequence number, reject duplicate/replayed or malformed messages, cap a message at 8 KiB, and use the same schema for validation and HMAC canonicalization. Keep HMAC keys out of logs/URLs and in memory only on clients; because either client can extract a shared key, HMAC prevents network alteration/replay but cannot prove a client or host is honest.

Use ICE configuration injected from deployment configuration, not hard-coded in `.jslib`: STUN may establish same-LAN and some NAT paths; different networks and symmetric/restrictive NAT commonly require TURN. Use a reachable HTTPS/WSS Flask origin and TURN over UDP/TCP/TLS as available; TURN credentials should be short-lived. Do not claim internet connectivity until separately tested with TURN.

### Telemetry schema and detection configuration

Send event-based records, not per-frame telemetry. Both participants report bounded batches, including host and client views for cross-checking. Server-derived fields: `game_id`, `match_id`, `participation_id`, `user_id`, `received_at`, authenticated membership and verified `source`. Event fields: `event_type`, `seq`, optional client monotonic timestamp, and a typed payload for position delta/speed, jump, weapon/fire interval/ammo, hit/miss, damage/health, death/respawn, connection, or invalid request. Suggested initial transport limits are 64 events and 32 KiB per batch, no more than 2 batches/second/player; tune from real WebGL behavior and configure them rather than allowing unbounded payloads.

Create `backend/config/multiplayer_fps_detection.json` for thresholds and risk weights. Initial candidate keys:

- movement: max configured speed, speed multiplier/tolerance, minimum exceed duration/sample count, teleport slack, maximum jump height;
- weapon: weapon allowlist, minimum cooldown, ammo/magazine bounds, reload duration tolerance, repeated-violation window/count;
- protocol: maximum message/batch bytes, maximum event rate, sequence policy, timestamp skew;
- cross-report: host/client mismatch tolerance for shots, hits, damage, health and match result;
- risk: per-rule weights, suspicious/high-risk cutoffs, and separate `suspicious` vs `confirmed_validation_violation` states.

Candidate initial rules are sustained movement above the configured physical maximum, a displacement larger than max-speed × elapsed time plus tolerance, fire intervals below the approved weapon cooldown, impossible weapon/ammo/reload transitions, repeated/replayed sequence or invalid HMAC, and contradictory host/client outcomes. Protocol/weapon validation failures can be recorded as confirmed violations; speed/fire/report anomalies remain suspicious until repeated and cross-checked. Score evidence into a capped 0–100 risk value and route for admin review; never automatically ban on one uncertain anomaly. Freeze numerical thresholds only after the WebGL host simulation's actual units/tick timing are verified, because the current weapon cooldown naming and one movement prefab field are ambiguous (audit details above).

## 3. Implementation phases after approval

Stop at a failed phase; do not advertise later features as available before they pass.

### Phase A — GameHub card and build contract

1. Modify the existing `#games` card in `frontend/player.html`; preserve all other dashboard sections and current card component styling.
2. Add the multiplayer badge, accurate game description, actual thumbnail, loading/error states, and existing Play Game affordance.
3. Define a deterministic Unity build/deploy output at `frontend/public/games/Multiplayer_FPS/`. Use a source template, include the required Socket.IO browser client in a reproducible way, and apply narrow `.gitignore` rules consistent with the legacy game output.
4. Verify static serving, Unity loader URLs, StreamingAssets paths, WASM MIME type, compression behavior, browser console, and return-to-dashboard UI.
5. Keep the new card disabled or clearly marked in development until the built game can load; do not point it to the legacy build as a fallback that looks like Multiplayer_FPS.

### Phase B — Authenticated launch and session ownership

1. Reuse the current authenticated Flask browser session and `/api/auth/me` flow.
2. Adapt the existing game launch API in `backend/routes/game_routes.py` to accept only an approved game identifier and create an appropriately bound `Multiplayer_FPS` game session.
3. Replace the current reusable token-in-query pattern for this game with a short-lived single-use launch grant returned by the authenticated API and delivered to the same-origin Unity iframe without URL parameters. Redeem it once before exposing gameplay/session controls.
4. Derive player identity from the server-side session/grant. Reject stale, revoked, suspended, wrong-game, expired, replayed, or already-consumed grants.
5. Reuse `game_sessions` for per-player game session records and existing end/abandon behavior. Do not repurpose the `sessions` collection, which represents authentication sessions.
6. Preserve the existing legacy `FPS_Microgame` path while tests prove the new path.

### Phase C — Stage 3 WebRTC proof of concept (before gameplay)

1. Ensure Unity starts one `WebRTCManager` before the existing UI Toolkit `MainMenu` subscribes; the current `Persistents` scene does not contain one.
2. Configure Socket.IO to reach the canonical backend, not merely the web page origin when the frontend is served separately.
3. Create and join rooms only for valid authenticated game sessions. Validate player identity, room code, capacity, role, expiry, and signaling payload size/type on every operation.
4. Reuse `backend/webrtc_signaling.py`; avoid a second Flask/Socket.IO service. Its current process-memory rooms are a development limitation. Before relying on multiple backend workers/restarts, persist room membership or enforce a tested single-process deployment with cleanup and expiry.
5. In Unity's existing main menu, display Create Session, Join Session, room code, player count, connection/waiting status, and Leave Session. Do not claim a match has started merely because signaling or DataChannel connected.
6. Exchange a timestamped ping/pong through the Unity `.jslib` bridge and report measured latency, state transitions and visible failures.
7. Test two tabs on one computer, two laptops on the same Wi-Fi, then two laptops on different networks. Use STUN only for the first proof attempt; add configured TURN for restrictive/different networks. Stop here and wait for the user's confirmation before gameplay work.

### Phase D — Browser host feasibility gate

This gate must pass before starting gameplay replication.

1. Keep the requested topology: Laptop 1's browser is the host; no external dedicated Linux game server.
2. Prove a WebGL browser can own and advance the local authoritative gameplay world. Current `GameManager` creates a client-only WebGL world, and `EntityDriverConstructor` rejects WebGL server/host mode. Current server systems require NetCode/Ghost connection, tick, and command state.
3. Select and document a controlled approach only after inspecting/testing actual code:
   - a supported local authoritative simulation path that reuses appropriate movement/combat logic without requiring a NetCode server driver; or
   - a deliberate gameplay-networking migration with explicitly bounded scope.
4. If the proof fails, stop and report the blocking API/platform constraint. Do not imitate server authority with client-supplied state, start a dedicated server contrary to the approved architecture, or bypass the NetCode error with an unsafe fallback.
5. Be explicit that the host browser is user-controlled and can cheat; browser-hosted authority is a capstone/demo topology, not equivalent to a trusted dedicated server.

### Phase E — Stage 4A: two player models and ownership

After Phase D passes, implement only this step, test it, report, and wait for approval:

1. Define player IDs from authenticated server-issued membership, not untrusted client position messages.
2. Spawn the host's local player and joining player's remote representation in the same scene; assign camera/input only to the local player.
3. Implement player registration, waiting-for-player state, and leave/disconnect cleanup; do not add movement replication yet.
4. Preserve the existing player variants, camera, controls, animations, and sounds. Adapt only proven dependencies.

### Phase F — Stage 4B: movement

After Stage 4A is approved, implement movement only, then report and wait:

1. Send bounded, sequenced input intent; host simulates and validates movement.
2. Synchronize position/rotation/jump state at a bounded snapshot rate and interpolate remote models.
3. Test movement, jump, sequence rejection and disconnect cleanup in both browsers.

### Phase G — Stage 4C: shooting and damage

After Stage 4B is approved, implement combat only, then report and wait:

1. Host validates weapon, ammo, reload state, fire rate and hit detection; the client sends intent only.
2. Host applies damage and synchronizes shots, hit/miss, ammo, health and score; preserve rifle/shotgun models, effects, audio and HUD.
3. Test valid shots, cooldown, ammo depletion/reload, hit/miss and health sync in both browsers.

### Phase H — Stage 4D: death, respawn, and match completion

After Stage 4C is approved, implement death/respawn only, then report and wait:

1. Host controls death, respawn timer/position, health/score updates and completion.
2. Handle both player leave/disconnect paths and clean up remote state.
3. Test death, respawn, repeated rounds, disconnect/forfeit and match completion in both browsers.

### Phase I — Stage 5 telemetry, session end, and detection

1. Reuse `game_telemetry`, `game_events`, `security_events`, and `game_sessions` where they fit. Add a new room collection only if room membership/state cannot be safely represented in existing game-session records.
2. Define a versioned bounded event schema and HMAC/sequence rules as specified above; collect both players' event reports. Do not send per-rendered-frame events.
3. Derive user/game/session identity server-side; validate types, ranges, batch size, rate, sequence/replay, and session ownership. Treat browser-host telemetry as untrusted evidence.
4. At completion, flush bounded batches, finalize each player's session consistently, compute supported statistics, and run detection only on available validated measures.
5. Label ML/anomaly output as suspicious/review evidence. Distinguish deterministic validation violations from uncertain behavior and do not automatically ban based on one anomaly.

Stop after session-end detection and MongoDB evidence are verified; report and wait before dashboard changes.

### Phase J — Stage 6 existing dashboard reporting

1. Extend the existing admin Game monitoring section and its active game API in `backend/routes/game_routes.py`; do not create a separate admin dashboard or rely on unregistered `admin_routes.py`.
2. Include active/completed sessions, players, suspicious/high-risk sessions, movement/teleport/fire anomalies, alerts, match reports, and per-session evidence with pagination/authorization.
3. Extend the existing player's Matches/security sections and `backend/routes/player_routes.py` to return only that player's games, duration, kills/deaths, damage, results, and own security summaries.
4. Keep account/private match data scoped to the current player. Test admin/player role boundaries and ownership filtering.

### Phase K — final build, two-laptop demo, and complete test report

1. Run Unity Editor compilation and a fresh WebGL build from the approved source/template.
2. Serve the artifact through the existing Flask static route and verify content type, compression, cookies, HTTPS/WSS, API origin, and browser console.
3. Run two separately authenticated clients (different player accounts) through create/join, player spawn, movement, firing/damage, death/respawn, leave, telemetry persistence, analysis, and both dashboards.
4. Run security-focused negative tests, including malformed messages, out-of-order sequences, oversized batches, invalid weapon/ammo, speed/teleport attempts, expired sessions, and unauthorized room joining.
5. Mark each check Passed, Failed, Not tested, or Blocked with evidence. Only then create/update the complete demo and troubleshooting guide.

## 5. Proposed existing/new file list

### Existing files proposed for modification

| File | Proposed reason |
|---|---|
| `frontend/player.html` | Update the actual existing GameHub card in place. |
| `frontend/css/player.css` | Retain card design and support the approved thumbnail/multiplayer label. |
| `frontend/js/player.js` | Wire the existing card action to authenticated launch and dashboard return behavior. |
| `frontend/game.html` | Reuse the existing launch/iframe shell for Multiplayer_FPS with safe authorization. |
| `backend/routes/game_routes.py` | Add game-specific launch authorization and later validated telemetry/summary integration. |
| `backend/webrtc_signaling.py` | Enforce the approved authenticated room/session lifecycle and later persistence. |
| `backend/database/db.py` | Only if the approved data model needs a distinct room collection. |
| `frontend/admin.html`, `frontend/js/admin.js`, `frontend/css/admin.css` | Extend existing monitoring after data is available. |
| `frontend/player.html`, `frontend/js/player.js`, `frontend/css/player.css` | Extend existing personal match/security views after results are available. |
| `unity-games/Multiplayer_FPS/Assets/Plugins/WebGL/WebRTCBridge.jslib` | Correctly configure same-origin/backend signaling and launch handoff; harden lifecycle. |
| `unity-games/Multiplayer_FPS/Assets/Scripts/Networking/WebRTCManager.cs` | Complete room/session lifecycle, state, and error handling. |
| `unity-games/Multiplayer_FPS/Assets/Scripts/UI/Game/MainMenu.cs` | Reuse existing room UI and add approved session/leave/waiting behavior. |
| `unity-games/Multiplayer_FPS/Assets/Scenes/Persistents.unity` | Add the WebRTC manager/bootstrap only after verifying Unity lifecycle. |
| Unity gameplay input/movement/spawn/weapon/health systems | Only after a host-simulation feasibility gate; exact subset depends on tested design. |
| `.gitignore` | Narrowly allow the explicit WebGL deployment artifact; the current broad `Build/` ignore excludes it. |

### New files/artifacts proposed

| File/path | Proposed reason |
|---|---|
| `frontend/public/games/Multiplayer_FPS/` | Replace partial stale `Build/` files with a complete Unity build. |
| `frontend/public/games/Multiplayer_FPS/thumbnail.*` | Actual game card thumbnail after image source/format approval. |
| `unity-games/Multiplayer_FPS/Assets/WebGLTemplates/FPSWebRTC/` | Reproducible Unity default-derived WebGL template with required client loading. |
| `unity-games/Multiplayer_FPS/Assets/Scripts/Networking/WebRTCMessageProtocol.cs` | Structured versioned/bounded protocol and sequence checks. |
| `unity-games/Multiplayer_FPS/Assets/Scripts/Networking/WebRTCPlayerNetwork.cs` | DataChannel-to-gameplay adapter after simulation choice. |
| `backend/tests/test_gamehub_unity_launch.py` | Launch grant, game binding, expiry/replay, and authentication tests. |
| `backend/config/multiplayer_fps_detection.json` | Versioned detection limits and risk weights, calibrated after host movement/combat validation. |
| `backend/database/db.py` | Add `multiplayer_matches` only if a shared durable match record is approved as necessary. |
| `backend/tests/test_multiplayer_fps_*.py` | Focused signaling, telemetry, end-of-match, detection, and player/admin authorization coverage. |
| Focused browser/Unity test harness | Validate bridge, room flow, player replication, and gameplay incrementally; Unity Editor cannot be run by this assistant. |
| `Documentation/File_Change_Log.md` | Maintain the requested stage-by-stage file change record. |

### Files intentionally left unchanged

Keep all login/MFA code and active session policy unless an approved tested contract requires a minimal modification; keep the existing legacy `FPS_Microgame` project/build; keep all existing dashboard pages and non-game functionality; keep the canonical Flask app and active blueprints; keep `backend/routes/admin_routes.py` unregistered/unchanged; keep Unity NetCode/Ghost source and prefabs until a tested browser-host migration explicitly requires changes; keep generated WebGL output out of source-only edits.

## 6. Acceptance checklist and current evidence

Tests below were not executed as part of this read-only audit unless explicitly marked as code inspection. Statuses describe current evidence; they do not imply the future implementation passes.

| Check | Initial status |
|---|---|
| Identify actual GameHub, game card and launch shell | **PASSED (code inspection)** — `frontend/player.html#games` and `frontend/game.html`. |
| Identify authentication/MFA and player identity | **PASSED (code inspection)** — Flask session cookie, MongoDB active-session record; one active browser per account. |
| Identify Flask static hosting and compression behavior | **PASSED (code inspection)** — existing route serves `frontend/` and sets Unity MIME/encoding headers; focused test exists but was not run. |
| Verify complete Multiplayer_FPS deployment artifact | **FAILED (inspection)** — target static folder has only stale `WebBuild.*` files and lacks a launchable page/template bundle. |
| Fresh Unity build from current source | **NOT TESTED** — no Editor invocation in this audit; historical build attempt is documented above. |
| Safe game-specific launch grant | **NOT TESTED** — existing endpoint is FPS_Microgame-specific and returns a two-hour token currently placed in the URL. |
| Browser SDP/ICE/DataChannel proof | **NOT TESTED** — the signaling unit test file is present but was not run, and does not prove browser WebRTC. |
| WebGL NetCode server/host mode | **BLOCKED** — project code explicitly rejects a WebGL server/host; a custom host simulation is a feasibility gate. |
| Two player models / movement / combat / respawn | **NOT TESTED** — no gameplay DataChannel protocol or replication adapter exists. |
| Multiplayer_FPS telemetry/detection in MongoDB | **NOT TESTED** — existing telemetry/detection is for the current FPS_Microgame flow. |
| Multiplayer_FPS data in admin/player dashboards | **NOT TESTED** — suitable existing surfaces exist, but no Multiplayer_FPS match reporting is wired. |
| Two-laptop HTTPS/WSS/STUN/TURN demo | **BLOCKED** — no deployment endpoint, TURN configuration, or network setup was supplied or tested. |

## Approval gate

Stage 1 is complete. Approve or revise this proposed implementation plan before any Stage 2 source changes:

- **Location:** the existing `frontend/player.html#games` card, reusing `frontend/game.html` and the existing Flask/static/MongoDB/dashboard architecture.
- **Build hosting:** explicit Unity build/deploy output at `frontend/public/games/Multiplayer_FPS/`.
- **First implementation gate:** build and securely launch the actual Unity project, then prove browser-native WebRTC/DataChannel, then pass the browser-host simulation feasibility gate before migrating gameplay.

The WebGL Ghost/NetCode replication files, existing FPS_Microgame, authentication flow, and existing dashboards must remain intact until the corresponding migration step is tested and approved.
