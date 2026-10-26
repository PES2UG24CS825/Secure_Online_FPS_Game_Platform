# SecureFPS demo

SecureFPS is a Flask and MongoDB demo for FPS gameplay, account security, and
gameplay telemetry analysis.

## Run locally

1. Start MongoDB on this computer. The app uses the local database
   `secure_fps` by default.
2. In a terminal, install the backend requirements and create `backend/.env`:

   ```powershell
   cd backend
   python -m venv .venv
   .\.venv\Scripts\activate
   pip install -r requirements.txt
   Copy-Item .env.example .env
   ```

   Set a private `FLASK_SECRET_KEY` in `.env`.
3. Start Flask:

   ```powershell
   python app.py
   ```

4. Open <http://127.0.0.1:5000/login.html>. Flask serves the frontend and API
   on the same port. The old frontend server on port 5500 also works if needed:

   ```powershell
   cd frontend
   python -m http.server 5500
   ```

The development admin defaults are `admin1@gmail.com` / `Admin@12345` with MFA
secret `JBSWY3DPEHPK3PXP`. Change these values before sharing or deploying the
demo.

## Connect another laptop (Windows)

The host computer runs MongoDB and SecureFPS. The other laptop only needs a
browser.

1. Connect both computers to the same Wi-Fi. If that network blocks connections
between devices, use the host's Mobile hotspot.
2. Make sure MongoDB is running on the host.
3. If Windows Firewall blocks access, open PowerShell as Administrator in the
   project folder and run this once:

   ```powershell
   .\allow_firewall.ps1
   ```

   This allows TCP port 5000 on the Private network profile only. Set a trusted
   home or hotspot network to Private in Windows Settings if needed.
4. On the host, double-click `start_demo.bat` and keep its backend window open.
   It prints the URL for the other computer and a localhost URL for the host.
5. On the other laptop, open the printed `http://<host-ip>:5000/login.html`
   address. Use the exact IP printed by the script.

Only port 5000 needs to be reachable from the other laptop. Keep MongoDB bound
to the host; do not expose port 27017. LAN mode is off by default, and Flask
debug is off when started in LAN mode.

If the page does not load, check that both computers are on the same network,
the backend window is still open, the printed IP is current, and Windows
Firewall allows port 5000 on the Private profile. College and office Wi-Fi may
isolate devices; try a personal hotspot in that case.

**WebGL note:** the checked-in Unity build may still contain a localhost API
address. Rebuild the WebGL game from `unity-games/FPS_Microgame` after updating
the Unity client before testing gameplay telemetry from another laptop.

## Optional: four hacker demo accounts

This development-only demo seeds four test accounts and can run simulated
gameplay from the admin console. Do not enable it for production or real users.

1. In `backend/.env`, set `APP_ENV=development`, `HACKER_DEMO_PASSWORD`,
   `HACKER_DEMO_MFA_SECRET`, and `DEMO_HACKER_BAN_RISK_THRESHOLD=85`.
2. With MongoDB running, seed the accounts:

   ```powershell
   cd backend
   .\.venv\Scripts\python.exe scripts\seed_hackers.py
   ```

3. Restart Flask, sign in as an admin, open **Game monitoring**, and choose
   **Run hacker demo**. Use **Reset demo hackers** to clear the demo results.

The accounts are `hacker_aimbot@example.test`,
`hacker_wallhack@example.test`, `hacker_speed@example.test`, and
`hacker_silent@example.test`. All use the configured demo password and MFA
secret. Do not commit `backend/.env`.

## Project paths

- Backend: `backend/` (Flask API and MongoDB access)
- Frontend: `frontend/`
- Unity project: `unity-games/FPS_Microgame/`
- Unity WebGL build: `frontend/public/games/FPS_Microgame/`
