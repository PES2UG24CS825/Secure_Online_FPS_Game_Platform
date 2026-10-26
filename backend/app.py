import os
import mimetypes
from pathlib import Path
from datetime import datetime, timezone

import pyotp
from flask import Flask, jsonify, redirect, request, send_from_directory, session
from flask_cors import CORS
from database.db import sessions_db, test_connection, users
from routes.auth_routes import auth_bp
from routes.game_routes import game_bp
from routes.player_routes import player_bp
from services.auth import hash_password, validate_password

FRONTEND_DIR = Path(__file__).resolve().parents[1] / "frontend"
app = Flask(__name__, static_folder=None)
app.config["SECRET_KEY"] = os.getenv("FLASK_SECRET_KEY", "dev-only-change-this-secret")
AUTH_SESSION_IDLE_TIMEOUT_SECONDS = int(os.getenv("AUTH_SESSION_IDLE_TIMEOUT_SECONDS", "120"))
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=False,  # Set True when deployed behind HTTPS
)

frontend_origin = os.getenv("FRONTEND_ORIGIN", "").strip()
if frontend_origin:
    CORS(
        app,
        resources={r"/api/*": {"origins": [frontend_origin]}},
        supports_credentials=True,
    )

app.register_blueprint(auth_bp)
app.register_blueprint(game_bp)
app.register_blueprint(player_bp)


def network_server_settings(environ=None):
    env = environ if environ is not None else os.environ
    truthy = {"1", "true", "yes", "on"}
    port = int(env.get("FLASK_PORT", "5000"))
    debug_requested = env.get("FLASK_DEBUG", "1").strip().lower() in truthy
    return "127.0.0.1", port, debug_requested


@app.get("/")
def frontend_home():
    return redirect("/login.html")


def _accepts_encoding(accept_encoding, encoding):
    for item in accept_encoding.split(","):
        name, *parameters = item.strip().lower().split(";", 1)
        if name != encoding:
            continue
        quality = 1.0
        if parameters:
            for parameter in parameters[0].split(";"):
                key, separator, value = parameter.strip().partition("=")
                if separator and key == "q":
                    try:
                        quality = float(value)
                    except ValueError:
                        quality = 0.0
        return quality > 0
    return False


@app.get("/<path:filename>")
def frontend_file(filename):
    served_filename = filename
    content_filename = filename
    content_encoding = None

    if filename.endswith(".br"):
        content_filename = filename[:-3]
        content_encoding = "br"
    elif filename.endswith(".gz"):
        content_filename = filename[:-3]
        content_encoding = "gzip"
    else:
        accepted = request.headers.get("Accept-Encoding", "")
        for encoding, suffix in (("br", ".br"), ("gzip", ".gz")):
            if not _accepts_encoding(accepted, encoding):
                continue
            candidate = FRONTEND_DIR / f"{filename}{suffix}"
            if candidate.is_file():
                served_filename = f"{filename}{suffix}"
                content_encoding = encoding
                break

    response = send_from_directory(FRONTEND_DIR, served_filename, conditional=True)
    suffix = Path(content_filename).suffix.lower()
    content_type = {
        ".wasm": "application/wasm",
        ".data": "application/octet-stream",
        ".js": "application/javascript",
    }.get(suffix) or mimetypes.guess_type(content_filename)[0]
    if content_type:
        response.headers["Content-Type"] = content_type
    if content_encoding:
        response.headers["Content-Encoding"] = content_encoding
        response.vary.add("Accept-Encoding")
    return response


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
        account = users.find_one(
            {"_id": ObjectId(user_id)},
            {"account_status": 1, "revoked": 1},
        )
        if account and account.get("account_status") == "suspended":
            session.clear()
            return jsonify({"message": "This account has been suspended."}), 403
        if account and (account.get("revoked") is True or account.get("account_status") == "banned"):
            session.clear()
            return jsonify({"message": "This account is permanently banned."}), 403
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
        "database_name": os.getenv("MONGO_DB", os.getenv("DB_NAME", "secure_fps")),
    }, (200 if connected else 503)

if __name__ == "__main__":
    # Development defaults are documented credentials; override them in deployment.
    ensure_default_admin()
    flask_host, flask_port, debug_enabled = network_server_settings()
    app.run(
        host=flask_host,
        port=flask_port,
        debug=debug_enabled,
        threaded=True,
    )
