# SecureFPS local audit

## Findings

| Severity | Finding | Repair or verification status |
| --- | --- | --- |
| Critical | The remote launcher enabled development settings, demo mode and a fixed multiplayer signing key. Internal Flask routes also accepted the fallback key alongside the configured key. | Loopback-only launch by default. The explicit public mode disables demo, debugging and anonymous Socket.IO access. Production rejects the known multiplayer defaults and the internal routes use only the effective key. |
| High | Browser match completion could overwrite closed results and supply statistics and progression inputs. | Multiplayer receipts now carry the server outcome, combat totals and duration. Flask binds each receipt to one player/session and uses the existing idempotent reward ledger. Unverified browser completions retain history and analysis but award no match coins or XP. |
| High | The game-session TTL could remove finalized match history. | Finalization clears the active-session expiry. Startup also clears this metadata from existing completed and abandoned records. Records that already expired cannot be recovered by this change. |
| High | MFA lockout was skipped for local requests and development mode. | Failed authenticator attempts now reach the same lockout path in local and production use. Existing authenticated sessions and recovery-code workflows are retained. |
| High | The shutdown script stopped unrelated processes based on executable name or port. | The launcher tracks process IDs and start times. Shutdown checks that identity before stopping each service. |
| High | Match-chart tooltip markup was reconstructed from a decoded HTML attribute. | The tooltip uses text content. |
| Medium | The proxy sent multiplayer status to Flask, and HTML boot guards bypassed the local proxy. Startup treated an open TCP port as proof that the stack was healthy. | The proxy routes `/status` and Socket.IO to Node. The launcher checks MongoDB via Flask, the direct and proxied HTTP routes, and an Engine.IO WebSocket opening packet. |
| Medium | The admin overview fabricated a security-event count and displayed connection and detection timing before verification. Several admin views lacked navigation links. | Real counts and unavailable states replace those defaults. Match Monitoring, Role Permissions, Backups and Platform Configuration have navigation links. |
| Medium | Enforcement history lacked working filters and pagination and returned arbitrary detail payloads. | Search, date range, action, administrator and severity filters use the existing audit records. Event details expose selected audit fields and keep the original action codes. |
| Medium | Settings lost saved graphics quality after reload and could retain a cleared multiplayer URL. | Arena settings now restore supported controls, clear overridden URLs, and accept versioned JSON imports limited to gameplay preferences. |
| Low | Only two Chibi portraits were selectable even though four portrait files exist. | All four are selectable. The default profile uses the existing tactical portrait. Vanguard and Valkyrie are the selectable arena models. No dedicated Chibi Version 4 gameplay mesh was found in the tracked assets. |

## Statistics and progression

- Multiplayer wins, losses, draws, assists and headshots use matches with a signed server result. Win rate is wins divided by verified matches, including draws, times 100.
- Accuracy is hits divided by shots times 100. Headshot percentage is verified headshot hits divided by verified hits times 100. A zero denominator is shown as unavailable. K/D divides kills by deaths, with deaths treated as one for a player who has zero deaths.
- Career totals continue to include recorded historical and local results where available. They can include browser telemetry. Recorded playtime adds the available durations on completed sessions.
- The existing rewards level is `1 + floor(XP / 250)`. Progress is `XP mod 250`. Existing balances keep their value. A verified multiplayer match of at least 30 seconds can earn 50 XP and 20 coins under the daily match-credit cap. The existing daily login claim remains available.

## Local hosting

Run `powershell -File scripts/start_host.ps1` for the loopback stack. The default ports are Flask 5000, Socket.IO 4001 and proxy 8080. Use `-FlaskPort` or `-SocketPort` on the launcher and health script if an upstream port is occupied. Shutdown is `powershell -File scripts/stop_all.ps1`.

`-PublicTunnel` requires Cloudflared and production secrets. For production deployments, use the WSGI setup in [DEPLOYMENT.md](../DEPLOYMENT.md). Public URL acquisition, login across two internet connections, and a real WAN match require an authorized live hosting test.

## Remaining verification and feature gaps

- The MongoDB-backed Python suite passed 95 tests and skipped 5. The JavaScript suites passed 64 tests. Both tracked GLB files passed binary validation.
- The local launcher passed six health checks, including a WebSocket upgrade through the reverse proxy. The test used alternate Flask and Socket.IO ports because the default ports were occupied. Shutdown stopped the three test services and preserved the pre-existing listeners.
- Chromium headless could not complete the browser smoke test in this environment. Its GPU process failed to start. Layout at multiple viewport sizes, MediaRecorder output, and manual controller and character-animation checks still need hands-on verification.
- Arena settings are browser-local. Account sync, granular notification preferences, and controls for unsupported rendering/audio channels are still absent.
- The browser submits the signed completion receipt. Prolonged disconnects or closing the tab before delivery can lose the result. Fully durable server-to-server delivery remains open.
- Imported and legacy gameplay telemetry has different provenance from signed multiplayer data. Historical XP and statistics were retained.
