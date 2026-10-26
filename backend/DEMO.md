# SecureFPS hacker demo

These controls are development-only. They are blocked when `APP_ENV` is
production (or any value other than `development`, `dev`, or `local`).

## Prepare

From the repository root, create `backend/.env` from `backend/.env.example` and
set private values that are not committed:

```powershell
Set-Location backend
Copy-Item .env.example .env
$env:APP_ENV = "development"
$env:HACKER_DEMO_PASSWORD = "Use-a-private-demo-password"
$env:HACKER_DEMO_MFA_SECRET = "A-valid-base32-TOTP-secret"
python scripts/seed_hackers.py
```

Start MongoDB and the Flask server as usual:

```powershell
Set-Location backend
.\.venv\Scripts\python.exe app.py
```

## Presentation flow

1. Sign in to the admin console and open **Game monitoring**.
2. Click **Run hacker demo** and confirm.
3. Keep the gameplay security alerts list visible. Four simulations start two
   seconds apart and send telemetry at approximately five events per second.
4. Show each red `PERMANENTLY BANNED` alert, the risk score, profile, and the
   `terminated_banned` session status. The red toast appears without refreshing.
5. Attempt to sign in as one of the hacker accounts to show the permanent-ban
   response.
6. Click **Reset demo hackers** when repeating the presentation. This removes
   only the four reserved hacker profiles' sessions, telemetry, analyses,
   security events, and auth sessions.

The CLI equivalent for one profile is:

```powershell
Set-Location backend
python scripts/simulate_hacker.py aimbot --fast
python scripts/simulate_hacker.py all --fast
```
