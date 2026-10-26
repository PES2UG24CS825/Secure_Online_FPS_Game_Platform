# Secure FPS Gaming Platform

This repository contains the SecureFPS final-year demonstration platform:
authenticated FPS gameplay, MFA, MongoDB persistence, ML-based gameplay analysis,
live admin alerts, and a development-only hacker detection fixture.

## Stack
Frontend: HTML, CSS, JavaScript
Backend: Flask
Database: MongoDB
Security: bcrypt + TOTP MFA + HttpOnly Flask session
ML: Random Forest + Isolation Forest

## 1. Start MongoDB
Make sure MongoDB is running locally.

## 2. Backend
Open a terminal:
```bash
cd backend
python -m venv .venv
# Windows:
.venv\Scripts\activate
# macOS/Linux:
# source .venv/bin/activate

pip install -r requirements.txt
```

Copy `.env.example` to `.env` and set a strong FLASK_SECRET_KEY.

Run:
```bash
python app.py
```

Backend: http://127.0.0.1:5000

The local admin account is created automatically on startup. Defaults are:
- Email: `admin1@gmail.com`
- Password: `Admin@12345`
- MFA key: `JBSWY3DPEHPK3PXP`

Set `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and `ADMIN_MFA_SECRET` before deployment to replace these development credentials.

## 3. Frontend
From the frontend directory, run:
```bash
cd frontend
python -m http.server 5500
```

Open the group project login page:
`http://127.0.0.1:5500/login.html`

Keep the backend running on port 5000 while signing in.

## Run on another laptop

1. Connect the host and other laptop to the same Wi-Fi. If the network isolates
   devices, use the host's Windows Mobile hotspot instead.
2. On the host laptop, run `start_demo.bat` from the project root. It starts
   Flask in LAN mode, detects the host's current private IPv4 address, and prints
   the exact URL to open. LAN mode disables Flask debug and leaves MongoDB on
   the host laptop.
3. If Windows Firewall blocks the page, run PowerShell as Administrator and
   execute `allow_firewall.ps1`. It allows TCP port 5000 on the Private profile
   only. For a trusted home or hotspot network marked Public by Windows, change
   that network profile to Private in Windows Settings; do not open the port on
   the Public profile.
4. On the other laptop, open the printed `http://<host-ip>:5000/login.html`
   address. The host laptop can use `http://127.0.0.1:5000/login.html`.

Troubleshooting:

- Confirm both laptops are on the same Wi-Fi or hotspot and that the host
  backend window is still running.
- Check the active network profile and the Private-only firewall rule.
- College and office Wi-Fi may block connections between devices. Use a
  personal hotspot if that network isolates clients.
- Do not expose MongoDB port 27017; the demo connects to MongoDB locally on the
  host laptop.

## 4. ML models
Put your trained files here:
- ml_models/random_forest_model.pkl
- ml_models/isolation_forest_model.pkl

The feature order must match:
reaction_time, accuracy, headshot_ratio, fire_rate, movement_speed, aim_smoothness, kdr

## 5. Unity
The single supported game is the FPS Microgame. Its Unity project is `unity-games/FPS_Microgame`; the WebGL build loaded by the platform is `frontend/public/games/FPS_Microgame/`.

## Live dashboard and risk analysis
The player and admin dashboards subscribe to the authenticated `/api/live/events` server-sent event stream. Gameplay telemetry, match completion, detections, and risk results notify the dashboards immediately. A 15-second refresh remains as a recovery path if the stream disconnects.

Live analysis starts after 24 telemetry events and runs at most once every five seconds when all five model inputs are measurable. Configure this with `GAMEPLAY_REALTIME_ENABLED`, `GAMEPLAY_REALTIME_MIN_EVENTS`, `GAMEPLAY_REALTIME_WINDOW_EVENTS`, and `GAMEPLAY_REALTIME_INTERVAL_SECONDS` in `backend/.env`.

MongoDB uses `MONGO_DB` when set, or `DB_NAME` from the example configuration. The
project database is `secure_fps`; keep the backend and MongoDB running while
playing. Dashboards read saved sessions and analysis from this database.

## Admin console behavior

Open the admin console after signing in as an administrator:

```text
http://127.0.0.1:5500/admin.html
```

### Players directory

The Players directory intentionally excludes generated API-test fixtures such as
`playerXXXXXXXX@example.com` and `Test Player`. It shows:

- genuine player accounts;
- the four reserved hacker accounts, marked `HACKER DEMO`;
- match count, MFA state, risk, account status, and admin actions.

The preserved `demo_cheater` development fixture is used by the original
`Seed demo data` comparison flow but is not shown as a genuine player.

### Gameplay alerts

- Normal-player alerts remain reviewable with **Approve**, **Warn**, **Suspend**,
  and **Ban** actions.
- Hacker demo alerts are enforcement evidence, not manual-review alerts. They
  show **CHEATER AUTO-BANNED**, **PERMANENTLY BANNED**, the hacker profile,
  model results, the measured risk score, and the reason for detection.
- Hacker profiles have different evidence-based scores; the score is not a
  single hardcoded value. The original ML score is retained separately as
  `model_risk_score`.
- When a hacker is banned while the admin page is open, a red, accessible
  real-time popup appears at the top of the overview without a page refresh.
- Before a run, use **Reset demo hackers** so stale alerts and matches are
  removed. The overview then starts with no hacker alerts. Alerts appear only
  after the next run.

## Security notes
- Do not store plaintext passwords.
- The MFA secret/QR is returned only during local account setup for this student prototype. In production, complete MFA enrollment through a controlled setup flow and do not expose the secret after setup.
- Use HTTPS and set SESSION_COOKIE_SECURE=True in production.
- Add CSRF protection, rate limiting, email verification, audit logging, and secure secret management before production deployment.

## Development hacker demo

This is a development-only presentation fixture. It is blocked when
`APP_ENV=production`. Never enable it for real users or production data.

1. In `backend/.env`, set:

   ```env
   APP_ENV=development
   HACKER_DEMO_PASSWORD=HackerDemoPassword123!
   HACKER_DEMO_MFA_SECRET=JBSWY3DPEHPK3PXP
   DEMO_HACKER_BAN_RISK_THRESHOLD=85
   ```

   The password and MFA secret are local demo values; do not commit `backend/.env`.
   When both trained models classify a hacker fixture as cheating/anomalous, the
   development-only enforcement score is calibrated to at least 85 for the demo;
   the original model score is retained as `model_risk_score`.
2. With MongoDB running, seed the four accounts:

   ```powershell
   cd backend
   .\.venv\Scripts\python.exe scripts\seed_hackers.py
   ```

   The accounts are `hacker_aimbot@example.test`, `hacker_wallhack@example.test`,
   `hacker_speed@example.test`, and `hacker_silent@example.test`. They all use the
   configured password and TOTP secret. The seed command is safe to run repeatedly.
3. Restart the backend after changing `.env`, then sign in as an admin. Open
   **Game monitoring** to confirm all four accounts and their match counts are listed.
4. Click **Run hacker demo** and confirm. Four simulations start two seconds apart.
   The admin Gameplay security alerts list updates without a page refresh, shows the
   model outputs, profile-specific reasons, different evidence-based risk scores,
   and a red **PERMANENTLY BANNED** badge when a demo account is automatically
   banned. The red popup appears at the top of the overview.
5. To replay the presentation, click **Reset demo hackers**, confirm, and run the
   seed command again if the accounts were removed manually. Reset only affects the
   four `account_type=demo_test` hacker accounts.

Each simulator can also be run directly:

```powershell
cd backend
.\.venv\Scripts\python.exe scripts\simulate_hacker.py aimbot --fast
.\.venv\Scripts\python.exe scripts\simulate_hacker.py all --fast
```

The simulator uses the real login, MFA, game-start, telemetry, and game-complete
endpoints. A banned hacker cannot log in or submit more gameplay events. Their
completed/terminated matches remain visible in the admin Game history and in the
player Match history when the account is reset and logged in before the next run.

### What each hacker demonstrates

| Account | Profile | Evidence shown in the alert |
|---|---|---|
| `hacker_aimbot@example.test` | `aimbot` | Near-zero aim corrections and highly consistent target hits |
| `hacker_wallhack@example.test` | `wallhack` | Hits/tracking against enemies without line of sight |
| `hacker_speed@example.test` | `speedhack` | Excessive movement speed and teleport jumps |
| `hacker_silent@example.test` | `silent_aim` | Hits registered while the crosshair is off target |

Each alert also lists the Random Forest classification, Isolation Forest
classification, top contributing features, model score, enforcement score,
session ID, and ban time.

### If a reviewer asks you to play one hacker account

Use this exact sequence so the reviewer can see both the gameplay and the stored
evidence:

1. In the admin console, click **Reset demo hackers**.
2. Log in using one seeded account, for example
   `hacker_aimbot@example.test`, with `HACKER_DEMO_PASSWORD`.
3. Enter the FPS Microgame and play for at least 10 seconds. The normal game
   client sends each telemetry event to `/api/game-events`; the backend stores
   it in `game_telemetry` under the current `session_id`.
4. Open the admin **Game monitoring** page. Show:
   - the hacker account card and its match count;
   - **Game history** with the saved session;
   - **Analyzed sessions** with the feature values and model results;
   - **Gameplay security alerts** with the risk score and
     **PERMANENTLY BANNED** badge.
5. In MongoDB, the same evidence is stored in `game_sessions`,
   `game_telemetry`, `game_events`, and `security_events`. The auto-ban record
   has type `auto_ban`, the user ID, session ID, risk score, reasons, and ban
   timestamp.

For a guaranteed, repeatable cheating signal during a short presentation, use
**Run hacker demo** instead of pretending that ordinary human mouse movement is
an aimbot. It still uses the real login, MFA, game-start, telemetry, analysis,
ban, and database-write paths; it is not a mock-only result.

### Troubleshooting

- **Accounts are missing:** run the seed command from the `backend` directory and
  verify `APP_ENV=development`; then refresh the admin page.
- **Only old hacker alerts are visible:** click **Reset demo hackers**, wait for
  the reset confirmation, then run the demo again. Reset removes the four
  hackers' demo telemetry, sessions, analyses, and security alerts only.
- **Generated Test Player rows are visible:** refresh the Players view. The
  directory excludes `playerXXXXXXXX@example.com` fixtures; do not use the
  `Include test data` checkbox in the sign-in audit unless reviewing test login
  records.
- **No automatic ban:** add `DEMO_HACKER_BAN_RISK_THRESHOLD=85` to the actual
  `backend/.env` (not only `.env.example`) and restart Flask.
- **No live alert:** keep the admin page open and signed in while the simulation
  runs. The popup requires the admin page to remain open; the dashboard also
  refreshes every 15 seconds if SSE reconnects.
- **API or database unavailable:** verify
  `http://127.0.0.1:5000/api/health` returns `database: connected`, then restart
  Flask from `backend` using the project virtual environment:
  `.venv\Scripts\python.exe app.py`.
- **401/403 after a run:** the account was probably permanently banned. Use
  **Reset demo hackers**, then sign in again.
- **Account already signed in:** the login page now offers **Sign in here**.
  Confirm it to end the old browser session and continue with MFA. If you close a
  browser before signing out, wait for the configured idle timeout or use this
  explicit takeover option; no account data is deleted.
