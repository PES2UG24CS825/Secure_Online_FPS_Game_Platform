<<<<<<< HEAD
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
Build your Unity game as WebGL and place it under:
frontend/unity-games/<game-name>/

Then replace the launch button alert in frontend/js/dashboard.js with the URL/page that hosts your Unity WebGL build.

## Security notes
- Do not store plaintext passwords.
- The MFA secret/QR is returned only during local account setup for this student prototype. In production, complete MFA enrollment through a controlled setup flow and do not expose the secret after setup.
- Use HTTPS and set SESSION_COOKIE_SECURE=True in production.
- Add CSRF protection, rate limiting, email verification, audit logging, and secure secret management before production deployment.
=======
# Secure_Online_FPS_Game_Platform
>>>>>>> 214354a6791730c0e1915ad995be5dad07a57a61
