# GameHub Unity Integration File Change Log

The user approved the first launch milestone on 2026-10-30. Implementation is currently blocked at Unity WebGL script compilation; frontend and backend integration has not started. Later multiplayer migration work remains out of scope and pending separate approval.

| File/path | Action | Reason | Status |
|---|---|---|---|
| `unity-games/Multiplayer_FPS/Assets/Editor/GameHubWebGLBuild.cs` | Create | Deterministic WebGL build target at the audited Flask static location. | Complete; build blocked by Windows paging-file limit |
| `unity-games/Multiplayer_FPS/Assets/Editor/GameHubWebGLBuild.cs.meta` | Generated | Unity asset metadata for the build entry point. | Complete |
| `unity-games/Multiplayer_FPS/Assets/Scripts/UI/Game/PauseMenu.cs` | Modify | Remove a null comparison on the generated value-type `UIActions` wrapper. | Complete; player compilation not verified |
| `unity-games/Multiplayer_FPS/Assets/Scripts/Gameplay/UI/RespawnScreen.cs` | Modify | Use the client `World` lifecycle to guard the `EntityManager` and query. | Complete; player compilation not verified |
| `unity-games/Multiplayer_FPS/Assets/Scripts/Gameplay/UI/LeaderboardUi.cs` | Modify | Remove a null comparison on the generated value-type `UIActions` wrapper and use the owning `World` lifecycle. | Complete; player compilation not verified |
| `frontend/player.html` | Modify | Update the existing `#games` GameHub card in place; do not create a second dashboard. | Pending |
| `frontend/css/player.css` | Modify | Reuse the current game-card design for a real thumbnail and multiplayer label. | Pending |
| `frontend/js/player.js` | Modify | Wire the existing Play Game action to the approved authenticated launch and return flow. | Pending |
| `frontend/game.html` | Modify | Reuse the existing launch shell/iframe for the Multiplayer_FPS build and secure launch grant. | Pending |
| `frontend/public/games/Multiplayer_FPS/` | Create generated output | Host an explicit Unity build under the existing static game-asset convention. | Blocked; no Unity output generated after Bee failed to launch due pagefile limit |
| `frontend/public/games/Multiplayer_FPS/thumbnail.*` | Create | Provide an actual Multiplayer_FPS card thumbnail after selecting an approved image source. | Pending |
| `.gitignore` | Modify if required | Narrowly allow generated Multiplayer_FPS web build assets under the chosen deployment path. | Pending |
| `backend/routes/game_routes.py` | Modify | Bind launch/session/telemetry to the actual Multiplayer_FPS game identity and later expose session results. | Pending |
| `backend/webrtc_signaling.py` | Modify | Bind authenticated signaling rooms to game-session membership and later persistence. | Pending |
| `backend/database/db.py` | Conditional modify | Add a room collection binding only if existing game-session data cannot safely support the approved design. | Pending |
| `backend/tests/test_gamehub_unity_launch.py` | Create | Test authenticated game-bound launch, grant expiry/replay, and ownership boundaries. | Pending |
| `backend/tests/` | Modify/create focused tests | Cover room lifecycle, bounded telemetry, session completion, and role/privacy rules. | Pending |
| `frontend/admin.html` | Modify in later phase | Extend the current Game monitoring section; do not create a second admin dashboard. | Pending |
| `frontend/js/admin.js` | Modify in later phase | Render Multiplayer_FPS session and security evidence from active API routes. | Pending |
| `frontend/css/admin.css` | Modify in later phase | Style the added monitoring details using existing admin design. | Pending |
| `frontend/player.html` | Modify in later phase | Extend existing match/security views with only the signed-in player's game results. | Pending |
| `frontend/js/player.js` | Modify in later phase | Fetch and render personal Multiplayer_FPS session summaries. | Pending |
| `frontend/css/player.css` | Modify in later phase | Style the existing player's match-result extension. | Pending |
| `unity-games/Multiplayer_FPS/Assets/WebGLTemplates/FPSWebRTC/` | Create | Adapt Unity's default template for reproducible Socket.IO/API configuration and host integration. | Pending |
| `unity-games/Multiplayer_FPS/Assets/Plugins/WebGL/WebRTCBridge.jslib` | Modify in later phase | Configure signaling origin and safe launch handoff; harden lifecycle/message handling. | Pending |
| `unity-games/Multiplayer_FPS/Assets/Scripts/Networking/WebRTCManager.cs` | Modify in later phase | Complete authenticated room/session and connection lifecycle. | Pending |
| `unity-games/Multiplayer_FPS/Assets/Scripts/Networking/WebRTCMessageProtocol.cs` | Create in later phase | Define bounded, sequenced, versioned gameplay messages. | Pending |
| `unity-games/Multiplayer_FPS/Assets/Scripts/Networking/WebRTCPlayerNetwork.cs` | Create in later phase | Adapt DataChannel messages to the chosen host simulation and player lifecycle. | Pending |
| `unity-games/Multiplayer_FPS/Assets/Scenes/Persistents.unity` | Modify in later phase | Install one verified WebRTC manager/bootstrap; currently it is absent. | Pending |
| `unity-games/Multiplayer_FPS/Assets/Scripts/Gameplay/...` | Conditional modify after feasibility gate | Adapt only the systems required by a tested browser-host simulation; preserve current gameplay behavior. | Pending |
| `unity-games/Multiplayer_FPS/Assets/Editor/GameHubWebGLBuild.cs` | Create only if needed | Add deterministic build automation if the existing build configuration is insufficient. | Pending |
| `frontend/public/games/FPS_Microgame/` | Keep | Preserve the current hosted game until the replacement flow is verified. | Pending |
| `unity-games/FPS_Microgame/` | Keep | Preserve the separate legacy Unity project. | Pending |
| `backend/routes/admin_routes.py` | Keep | It exists but is not registered by the canonical app; active monitoring uses `game_routes.py`. | Pending |
| Unity NetCode/Ghost files, player prefabs, scenes, weapons, camera, animations, audio | Keep until tested migration | Preserve existing functionality; do not delete or bypass the old architecture before the WebRTC host proof. | Pending |
| Login/MFA and existing authenticated session policy | Keep | Reuse established account security and avoid breaking sign-in. | Pending |
