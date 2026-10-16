import os
from datetime import datetime, timezone

import pyotp
from flask import Flask, jsonify, request, session
from flask_cors import CORS
from database.db import sessions_db, test_connection, users
from routes.auth_routes import auth_bp
from routes.game_routes import game_bp
from routes.player_routes import player_bp
from services.auth import hash_password, validate_password

app = Flask(__name__)
app.config["SECRET_KEY"] = os.getenv("FLASK_SECRET_KEY", "dev-only-change-this-secret")
AUTH_SESSION_IDLE_TIMEOUT_SECONDS = int(os.getenv("AUTH_SESSION_IDLE_TIMEOUT_SECONDS", "120"))
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=False,  # Set True when deployed behind HTTPS
)

CORS(
    app,
    resources={
        r"/api/*": {
            "origins": [
                os.getenv("FRONTEND_ORIGIN", "http://127.0.0.1:5500"),
                "http://localhost:5500",
                "http://127.0.0.1:5500",
            ]
        }
    },
    supports_credentials=True,
)

app.register_blueprint(auth_bp)
app.register_blueprint(game_bp)
app.register_blueprint(player_bp)


@app.before_request
def validate_auth_session():
    # Validate every signed-in browser against the server-side session record so
    # a revoked or replaced browser cannot keep using a stale Flask cookie.
    if request.path in {
        "/api/health",
        "/api/auth/login",
        "/api/auth/verify-mfa",
        "/api/auth/signup",
        "/api/auth/forgot-password",
        "/api/auth/logout",
    } or request.method == "OPTIONS":
        return None

    user_id = session.get("user_id")
    record_id = session.get("auth_session_record_id")
    if not user_id:
        return None

    from bson import ObjectId
    try:
        active_record = sessions_db.find_one(
            {"_id": ObjectId(record_id), "user_id": ObjectId(user_id), "is_active": True},
            {"_id": 1},
        ) if record_id else None
        owns_active_lock = bool(record_id) and bool(users.find_one(
            {"_id": ObjectId(user_id), "active_auth_session_id": record_id},
            {"_id": 1},
        ))
        active = bool(active_record and owns_active_lock)
    except Exception:
        active = False

    if not active:
        session.clear()
        return jsonify({"message": "Your sign-in session has ended. Please sign in again."}), 401
    sessions_db.update_one(
        {"_id": ObjectId(record_id), "is_active": True},
        {"$set": {"last_activity": datetime.now(timezone.utc)}},
    )
    return None


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
                    "created_at": datetime.now(timezone.utc)
                },
                # The configured administrator email is the authority for
                # the admin role. Repair older accounts created as players.
                "$set": {"role": "admin"}
            },
            upsert=True
        )
    except Exception as exc:
        print("[SecureFPS] Could not ensure the default admin account:", exc)
        return

    if result.upserted_id:
        print("[SecureFPS] Default admin account created:", email)
    else:
        print("[SecureFPS] Configured administrator account ready:", email)

@app.get("/api/health")
def health():
    connected = test_connection()
    return {
        "status": "ok" if connected else "unavailable",
        "database": "connected" if connected else "unavailable",
    }, (200 if connected else 503)

if __name__ == "__main__":
    # Development defaults are documented credentials; override them in deployment.
    ensure_default_admin()
    app.run(host="127.0.0.1", port=5000, debug=True, threaded=True)
