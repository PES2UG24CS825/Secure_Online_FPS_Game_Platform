# Secure FPS Gaming Platform — Starter Implementation

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
From the frontend directory:
```bash
python -m http.server 5500
```

Open:
http://127.0.0.1:5500/login.html

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

MongoDB uses `MONGO_DB` when set, or `DB_NAME` from the example configuration. Keep the backend and MongoDB running while playing; dashboards read saved sessions and analysis from MongoDB.

## Security notes
- Do not store plaintext passwords.
- The MFA secret/QR is returned only during local account setup for this student prototype. In production, complete MFA enrollment through a controlled setup flow and do not expose the secret after setup.
- Use HTTPS and set SESSION_COOKIE_SECURE=True in production.
- Add CSRF protection, rate limiting, email verification, audit logging, and secure secret management before production deployment.
