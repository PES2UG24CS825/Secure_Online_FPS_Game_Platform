import os
from datetime import datetime, timezone

import pyotp
from flask import Flask
from flask_cors import CORS
from database.db import users
from routes.auth_routes import auth_bp
from routes.game_routes import game_bp
from services.auth import hash_password, validate_password

app = Flask(__name__)
app.config["SECRET_KEY"] = os.getenv("FLASK_SECRET_KEY", "dev-only-change-this-secret")
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=False,  # Set True when deployed behind HTTPS
)

allowed_origins = [
    "http://127.0.0.1:5500",
    "http://127.0.0.1:3000",
    "http://localhost:5500",
    "http://localhost:3000",
    "http://localhost:8080",
]
frontend_origin = os.getenv("FRONTEND_ORIGIN")
if frontend_origin:
    allowed_origins.append(frontend_origin)

CORS(
    app,
    resources={r"/api/*": {"origins": allowed_origins}},
    supports_credentials=True,
    allow_headers=["Content-Type", "Authorization"],
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
)

app.register_blueprint(auth_bp)
app.register_blueprint(game_bp)
app.register_blueprint(player_bp)
app.register_blueprint(admin_bp)


def ensure_default_admin():
    email = os.getenv("ADMIN_EMAIL", "admin1@gmail.com").strip().lower()
    password = os.getenv("ADMIN_PASSWORD", "Admin@12345")
    mfa_secret = os.getenv("ADMIN_MFA_SECRET", "JBSWY3DPEHPK3PXP").strip()

    if not validate_password(password):
        raise ValueError("ADMIN_PASSWORD does not satisfy the configured password policy")

    # Validate that the configured MFA secret can be used by the login flow.
    pyotp.TOTP(mfa_secret)

    try:
        result = users.update_one(
            {"email": email},
            {
                "$setOnInsert": {
                    "name": "Security Admin",
                    "email": email,
                    "password_hash": hash_password(password),
                    "mfa_secret": mfa_secret,
                    "mfa_enabled": True,
                    "role": "admin",
                    "created_at": datetime.now(timezone.utc)
                }
            },
            upsert=True
        )
    except Exception as exc:
        print("[SecureFPS] Could not ensure the default admin account:", exc)
        return

    if result.upserted_id:
        print("[SecureFPS] Default admin account created:", email)
    else:
        print("[SecureFPS] Existing account preserved for admin email:", email)

@app.get("/api/health")
def health():
    return {"status": "ok"}

if __name__ == "__main__":
    # Development defaults are documented credentials; override them in deployment.
    ensure_default_admin()
    app.run(host="127.0.0.1", port=5000, debug=True)
