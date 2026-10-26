# SecureFPS demo

SecureFPS is a Flask and MongoDB demo for FPS gameplay, account security, and
gameplay telemetry analysis.

## Run locally

1. Start MongoDB on this computer. The backend connects to the local MongoDB
   service and uses the `secure_fps` database by default.
2. In PowerShell, prepare the backend once:

   ```powershell
   cd backend
   python -m venv .venv
   .\.venv\Scripts\Activate.ps1
   pip install -r requirements.txt
   Copy-Item .env.example .env
   ```

   Set `FLASK_SECRET_KEY` in `backend/.env` before using sign-in.
3. Start Flask from the `backend` directory:

   ```powershell
   python app.py
   ```

4. Open <http://127.0.0.1:5000/login.html>. Flask serves the frontend and API
   from the same origin. The root URL <http://127.0.0.1:5000/> redirects to the
   login page.

   To use the separate frontend server on port 5500, keep Flask running, open
   another terminal, and run:

   ```powershell
   cd frontend
   python -m http.server 5500
   ```

   Then open <http://127.0.0.1:5500/login.html>. This serves only the frontend;
   Flask must still be running on port 5000 for API requests. Admin sign-in is
   at <http://127.0.0.1:5500/admin.html>.

The development admin defaults are `admin1@gmail.com` / `Admin@12345` with MFA
secret `JBSWY3DPEHPK3PXP`. These are development credentials; change them before
sharing the demo.

## Honour score and fair play

Honour is a per-player score from 0 to 100. Accounts without a saved score start
at 100. It changes only when a match is completed or abandoned:

- Completing an active match adds up to 5 Honour, capped at 100. A player
  already at 100 may receive less than 5 or no additional Honour.
- Leaving an active match before it is completed removes 10 Honour, floored at
  0. That unfinished match awards no coins or XP.
- Honour by itself does not block matchmaking, including when the score is low.
  Other account restrictions, such as a ban or suspension, still apply.
- Closing an already completed or abandoned match does not apply the score
  change or match rewards a second time.

A completed match awards 20 coins and 50 XP in addition to its Honour change.
The separate daily sign-in reward is 25 coins and 25 XP; an unfinished match
does not remove or replace it.

Players can see their score and score color in **Account Security**. The player
page shows a warning when the score is below 80. Abandoning a match records a
`match_abandoned` security event and sends an update to the admin live stream.
Admins can review completed and abandoned match changes, grouped by player, in
**Security & access → Honour score report**. These records are stored in MongoDB
with the player account and the match reward or security event.

## Optional: four hacker demo accounts

This development-only demo seeds four test accounts and can run simulated
gameplay from the admin console. Do not enable it for production or real users.

1. In `backend/.env`, set `APP_ENV=development`, `HACKER_DEMO_PASSWORD`,
   `HACKER_DEMO_MFA_SECRET`, and `DEMO_HACKER_BAN_RISK_THRESHOLD=85`.
   `DEMO_PLAYER_PASSWORD` and `DEMO_PLAYER_MFA_SECRET` are optional; when left
   blank, the two normal demo players use the hacker demo credentials.
2. With MongoDB running, restart Flask, sign in as an admin, open **Game
   monitoring**, and choose **Run full demo**. One click prepares both normal
   player accounts and all four hacker accounts, adds model comparison matches,
   clears old hacker results, and starts the four simulations. Use **Reset demo
   hackers** to clear their results without running the demo again.

The accounts are `hacker_aimbot@example.test`,
`hacker_wallhack@example.test`, `hacker_speed@example.test`, and
`hacker_silent@example.test`. All use the configured demo password and MFA
secret. The full demo creates two login-capable normal player accounts:
`demo_player_one@example.test` and `demo_player_two@example.test`. Both use the
configured normal demo password and MFA secret (or the hacker demo credentials
when dedicated normal credentials are blank). They stay active while hacker
simulations run. For accounts only, you can also seed them from PowerShell:

```powershell
cd backend
.\.venv\Scripts\python.exe scripts\seed_demo_players.py
```

The standalone seeding script reads `DEMO_PLAYER_PASSWORD` and
`DEMO_PLAYER_MFA_SECRET` directly; set both in `backend/.env` before using that
command. The admin **Run full demo** action can use the hacker demo credentials
as a fallback when dedicated normal-player credentials are blank.

Do not commit `backend/.env`.

## Project paths

- Backend: `backend/` (Flask API and MongoDB access)
- Frontend: `frontend/`
- Unity project: `unity-games/FPS_Microgame/`
- Unity WebGL build: `frontend/public/games/FPS_Microgame/`
