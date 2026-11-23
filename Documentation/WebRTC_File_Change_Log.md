# WebRTC File Change Log

The migration plan is approved. This log tracks the Phase 3 signaling milestone only; later work remains **Pending**. Phase 3 backend signaling tests pass, but browser DataChannel connectivity is unverified, so implementation is paused before Phase 4.

| File | Action | Reason | Status |
|------|--------|--------|--------|
| `unity-games\Multiplayer_FPS\Assets\Plugins\WebGL\WebRTCBridge.jslib` | Modify | Default signaling to the current page origin and send browser session cookies; full bridge hardening remains pending. | Complete |
| `unity-games\Multiplayer_FPS\Assets\Scripts\Networking\WebRTCManager.cs` | Modify | Remove the unusable placeholder signaling URL so the bridge can use its authenticated same-origin default; room/game lifecycle work remains pending. | Partial |
| `unity-games\Multiplayer_FPS\Assets\Scripts\Networking\WebRTCMessageProtocol.cs` | Create | Define bounded, versioned gameplay messages, player identity, sequences, and validation. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Scripts\Networking\WebRTCPlayerNetwork.cs` | Create | Bridge input/state/events between Unity gameplay, host simulation, and DataChannel peers. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Scripts\Networking\WebRTCRoomUI.cs` | Modify | Ensure room controls, player/status display, and retry behavior match the integrated manager. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Scripts\UI\Game\MainMenu.cs` | Modify | Connect the existing Create/Join controls to the approved room and gameplay lifecycle. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Scenes\Persistents.unity` | Modify | Wire one persistent manager into the existing persistent scene. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Scripts\Gameplay\GameManager\GameManager.cs` | Modify | Start/end local browser-host simulation and client gameplay without the current WebGL Relay-only path. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Scripts\GhostBridge\GhostBridgeBootstrap.cs` | Modify | Adapt local WebGL host world setup only after the feasibility spike identifies the safe ECS boundary. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Scripts\GhostBridge\GhostBridgeManager.cs` | Modify | Expose local simulation/player lifecycle to the WebRTC adapter if required by the approved host-world design. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Scripts\Networking\Client\ClientConnectionSystem.cs` | Modify | Keep WebRTC clients out of the NetCode `NetworkStreamConnection` reconnect loop. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Scripts\Networking\Client\ClientGameSystem.cs` | Modify | Replace WebGL NetCode join RPC flow with authenticated WebRTC membership while preserving legacy desktop behavior. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Scripts\Gameplay\Input\ClientInputReaderSystem.cs` | Modify | Forward existing input intent into the WebRTC adapter without breaking camera and controls. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Scripts\Gameplay\Input\ClientInputSenderSystem.cs` | Modify | Prevent the WebGL gameplay path from depending on NetCode tick command buffers. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Scripts\Gameplay\Input\PlayerCommandInput.cs` | Modify | Reuse input semantics while separating WebRTC DTOs from `ICommandData` and `NetworkTick`. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Scripts\Networking\Server\ServerGameSystem.cs` | Modify | Map authenticated WebRTC players to spawn, disconnect, and respawn state in the host simulation. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Scripts\Networking\Server\ServerGameData.cs` | Modify | Replace or adapt NetworkId-based `ClientsMap`/joined-player state if WebRTC player IDs become authoritative. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Scripts\Gameplay\Player\Movement\ServerPlayerMovementSystem.cs` | Modify | Consume validated host/client input and emit authoritative movement/state without network-driver assumptions. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Scripts\GhostBridge\Player\PlayerPredictionSystem.cs` | Modify | Retain or adapt local prediction while preventing client-predicted values from becoming authority. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Scripts\Gameplay\Player\Movement\ClientInterpolatedPlayerMovementSystem.cs` | Modify | Drive remote visuals from explicit host snapshots rather than assuming Ghost snapshots. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Scripts\GhostBridge\Player\PredictionComponents.cs` | Modify | Separate shared gameplay state from transport-specific GhostField/NetCode state as required. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Scripts\Gameplay\Player\PlayerGhost\PlayerGhost.cs` | Modify | Preserve camera, role, animation, and visual behavior with the new player-state source. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Scripts\Gameplay\Player\PlayerGhost\PlayerGhostManager.cs` | Modify | Track local/remote WebRTC player IDs, registration, and disconnects. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Scripts\Gameplay\Player\Projectile\Projectile.cs` | Modify | Keep projectile collision/damage host-authoritative and emit client-visible gameplay events. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Scripts\Gameplay\Player\Projectile\ProjectileReconciliationSystem.cs` | Modify | Replace NetCode-specific projectile reconciliation if retained in the WebRTC gameplay path. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Scripts\Gameplay\VisualEffects\VisualEffectManager.cs` | Modify | Replace Ghost RPC delivery for remote firing effects with explicit gameplay events. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Scripts\Gameplay\VisualEffects\GhostVisualEffect.cs` | Modify | Retain or replace Ghost lifecycle for network-visible visual effects. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Scripts\Gameplay\Leaderboard\GameLeaderboard.cs` | Modify | Replace GhostField/RPC leaderboard updates with explicit host-produced events/state. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Scripts\Gameplay\UI\InGameHUD.cs` | Modify | Read host-synchronized health/ammo/reload/weapon state while preserving current UI. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Scripts\Gameplay\UI\RespawnScreen.cs` | Modify | Show respawn state from the host protocol rather than client-world player existence. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Scripts\UI\SessionInfo\NetworkStatusSystem.cs` | Modify | Display WebRTC/signaling/DataChannel status rather than only NetCode transport status. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Scripts\GhostBridge\Spawning\GhostSpawner.cs` | Modify | Adapt host player/projectile/effect spawning only if the selected simulation retains GhostBridge locally. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Scripts\GhostBridge\Spawning\ManagerGhostsSpawner.cs` | Modify | Adapt server manager startup if the host simulation retains GhostBridge managers. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Prefabs\PlayerGhosts\ArmaturePlayer_Rifle.prefab` | Modify | Preserve the rifle player's controller, camera, animation, and visual setup while removing or isolating transport-only authoring as proven necessary. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Prefabs\PlayerGhosts\ArmaturePlayer_Shotgun.prefab` | Modify | Preserve the shotgun player's controller, camera, animation, and visual setup while removing or isolating transport-only authoring as proven necessary. | Pending |
| `unity-games\Multiplayer_FPS\ProjectSettings\ProjectSettings.asset` | Modify | Select the project-owned WebGL template after it is created. | Pending |
| `unity-games\Multiplayer_FPS\Assets\WebGLTemplates\FPSWebRTC\` | Create | Copy the Unity default template and add stable Socket.IO loading/configuration; do not replace it with a minimal HTML page. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Scripts\Networking\GameConnection\GameConnection.cs` | Keep | Retain existing Relay/direct desktop session setup as a legacy non-WebRTC path. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Scripts\Networking\GameConnection\EntityNetworkHandler.cs` | Keep | Retain the Unity Services transport handler for existing legacy sessions. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Scripts\Networking\GameConnection\EntityDriverConstructor.cs` | Keep | Preserve existing NetCode/Unity Transport behavior; the new WebRTC browser flow must bypass it rather than use WebGL UDP. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Scripts\Networking\Client\ConnectionSettings.cs` | Keep | Keep legacy endpoint/session settings for non-WebRTC builds. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Scripts\Gameplay\Input\ClientInputInitSystem.cs` | Keep | Keep NetCode command-target initialization for the existing desktop/server path; WebRTC must not rely on it. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Scripts\Networking\Shared\Rpcs.cs` | Keep | Preserve legacy NetCode join/respawn RPCs for non-WebRTC sessions. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Scripts\Gameplay\Player\Movement\PlayerMovementHistory.cs` | Keep | Retain prediction-drift diagnostics; it is not a cheat detector and need not be replaced by transport migration. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Scripts\DedicatedServer\ServerBootstrap.cs`, `UGS_ServerBootstrap.cs` | Keep | Preserve existing dedicated-server behavior; the two-browser demo will not launch these builds. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Scripts\GhostBridge\Ghosts\GhostGameObject\` and `Assets\Scripts\GhostBridge\Systems\` | Keep | Preserve the existing Ghost path for legacy builds; local reuse by a WebRTC host is a feasibility question and remote Ghost replication is not assumed. | Pending |
| `unity-games\Multiplayer_FPS\Assets\Prefabs\PlayerGhosts\ClientPlayerInput.prefab`, `Assets\Prefabs\UI.prefab` | Keep | Retain existing input/UI prefab wiring unless a tested WebRTC change requires a specific serialized reference update. | Pending |
| `backend\requirements.txt` | Modify | Declare Flask-SocketIO for the canonical Socket.IO server. | Complete |
| `backend\app.py` | Modify | Create/register Socket.IO on the canonical Flask app, use exact-origin CORS, and require a configured production secret. | Complete |
| `app.py` | Modify | Export and run the canonical Socket.IO server from the repository-root compatibility launcher. | Complete |
| `backend\webrtc_signaling.py` | Modify | Replace the standalone app with registered authenticated room/signaling handlers, membership enforcement, payload validation, and disconnect cleanup. | Complete |
| `backend\tests\test_webrtc_signaling.py` | Create | Cover authentication, session revocation, room create/join, offer/answer/ICE relay, invalid/oversized messages, and disconnect cleanup. | Complete |
| `backend\database\db.py` | Modify | Add MongoDB access for rooms/player presence if not represented in existing collections. | Pending |
| `backend\routes\game_routes.py` | Modify | Reuse/extend existing game-session token and event ingestion for host security events. | Pending |
| `frontend\admin.html` | Modify | Add room/player presence and WebRTC alert/history sections to the existing dashboard. | Pending |
| `frontend\js\admin.js` | Modify | Fetch/render active rooms and alerts and refresh them through the current SSE/API patterns. | Pending |
| `frontend\css\admin.css` | Modify | Style the new dashboard information using the existing design. | Pending |
| `frontend\game.html` | Modify | Launch the authenticated Multiplayer_FPS WebGL build instead of the legacy FPS_Microgame build. | Pending |
| `backend\routes\admin_routes.py` | Keep | This blueprint is not registered by the canonical app; extend/wire the active registered API surface instead of making an unserved route change. | Pending |
| `backend\routes\auth_routes.py` | Keep | Reuse existing password/MFA/session authentication unless implementation testing proves an auth contract change is required. | Pending |
| `frontend\js\api.js`, `frontend\js\config.js` | Keep | Preserve current API/session helper conventions unless the approved deployment changes the frontend/API origin. | Pending |
| `README.md` | Modify | Correct the Unity project/build paths and document the approved demo entry points. | Pending |
| `Documentation\WebRTC_Migration_Audit.md` | Modify | Record approval, Phase 3 implementation/test status, Unity OOM blocker, and the pause before Phase 4. | Complete |
| `Documentation\WebRTC_File_Change_Log.md` | Modify | Track completed Phase 3 files separately from pending later migration work. | Complete |
| `Documentation\Complete_Demo_Guide.md` | Create | Document setup, two-laptop play, security demonstrations, test outcomes, and troubleshooting after implementation is verified. | Pending |
| Unity art, environment, animation, audio, weapon assets, and spawn-point data | Keep | These assets are not transport-specific; preserve them unless the implementation proves a concrete dependency change is necessary. | Pending |
| Existing dedicated-server scripts/build profiles and non-WebGL NetCode paths | Keep | Preserve existing behavior; do not delete the dedicated/server code as part of the browser demo migration. | Pending |
| `unity-games\Multiplayer_FPS\WebGL\` generated output | Keep | Do not use edits to generated output as a replacement for a source WebGL template; regenerate it after approval and build verification. | Pending |
