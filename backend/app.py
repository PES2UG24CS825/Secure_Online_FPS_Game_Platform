import os
import mimetypes
import re
import secrets
import time
import logging
from pathlib import Path
from datetime import datetime, timezone

import pyotp
from flask import Flask, jsonify, redirect, request, send_from_directory, session
from flask_cors import CORS
from werkzeug.middleware.proxy_fix import ProxyFix
from database.db import sessions_db, test_connection, users
from routes.auth_routes import auth_bp
from routes.game_routes import game_bp
from routes.player_routes import player_bp
from routes.admin_routes import admin_bp
from services.auth import hash_password, validate_password
from extensions import limiter

logger = logging.getLogger("securefps")
if not logger.handlers:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

FRONTEND_DIR = Path(__file__).resolve().parents[1] / "frontend"
app = Flask(__name__, static_folder=None)

# Configurable ProxyFix for Reverse Proxy Deployment
num_proxies = int(os.getenv("NUM_PROXIES", os.getenv("PROXIES_COUNT", "0")))
if num_proxies > 0:
    app.wsgi_app = ProxyFix(
        app.wsgi_app,
        x_for=num_proxies,
        x_proto=num_proxies,
        x_host=num_proxies,
        x_prefix=num_proxies
    )

# Environment and Security Startup Validation
APP_ENV = os.getenv("APP_ENV", "production").strip().lower()
IS_LOCAL_DEV = (
    os.getenv("SECUREFPS_LOCAL_DEV", "").strip().lower() in {"1", "true", "yes"}
    or APP_ENV in {"development", "dev", "local", "test"}
)

FLASK_SECRET_KEY = os.getenv("FLASK_SECRET_KEY", "").strip()
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "").strip()
ADMIN_MFA_SECRET = os.getenv("ADMIN_MFA_SECRET", "").strip()

if not IS_LOCAL_DEV:
    if not FLASK_SECRET_KEY or FLASK_SECRET_KEY in {"dev-only-change-this-secret", "secret", "change-me"}:
        raise RuntimeError(
            "Startup refused: FLASK_SECRET_KEY is missing or using an insecure default. "
            "Set FLASK_SECRET_KEY in environment or enable SECUREFPS_LOCAL_DEV=true for local dev."
        )
    if not ADMIN_PASSWORD or ADMIN_PASSWORD in {"Admin@12345", "password", "admin"}:
        raise RuntimeError(
            "Startup refused: ADMIN_PASSWORD is missing or using an insecure default."
        )
    if not ADMIN_MFA_SECRET or ADMIN_MFA_SECRET in {"JBSWY3DPEHPK3PXP"}:
        raise RuntimeError(
            "Startup refused: ADMIN_MFA_SECRET is missing or using an insecure default."
        )

app.config["SECRET_KEY"] = FLASK_SECRET_KEY or "dev-only-change-this-secret"
AUTH_SESSION_IDLE_TIMEOUT_SECONDS = int(os.getenv("AUTH_SESSION_IDLE_TIMEOUT_SECONDS", "3600"))

is_production_mode = not IS_LOCAL_DEV
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=is_production_mode or (os.getenv("SESSION_COOKIE_SECURE", "0").lower() in {"1", "true"}),
)

if os.getenv("PYTEST_CURRENT_TEST") or app.config.get("TESTING") or os.getenv("RATELIMIT_ENABLED", "1").lower() in {"0", "false"}:
    app.config["RATELIMIT_ENABLED"] = False

# Initialize Rate Limiter
limiter.init_app(app)

frontend_origin = os.getenv("FRONTEND_ORIGIN", "").strip()
allowed_origins_env = os.getenv("ALLOWED_ORIGINS", os.getenv("CORS_ORIGINS", "")).strip()

cors_origins = [
    re.compile(r"^https?://(localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})(:\d+)?$"),
    re.compile(r"^https?://[a-zA-Z0-9-]+\.trycloudflare\.com$"),
    "http://127.0.0.1:5500",
    "http://localhost:5500",
    "http://127.0.0.1:3000",
    "http://localhost:3000",
    "http://127.0.0.1:5000",
    "http://localhost:5000",
    "http://127.0.0.1:8080",
    "http://localhost:8080",
]
if frontend_origin:
    cors_origins.append(frontend_origin)
if allowed_origins_env:
    for orig in allowed_origins_env.split(","):
        orig_clean = orig.strip()
        if orig_clean and orig_clean not in cors_origins:
            cors_origins.append(orig_clean)

CORS(
    app,
    resources={r"/api/*": {"origins": cors_origins}},
    supports_credentials=True,
)

app.register_blueprint(auth_bp)
app.register_blueprint(admin_bp)
app.register_blueprint(player_bp)
app.register_blueprint(game_bp)


def network_server_settings(environ=None):
    env = environ if environ is not None else os.environ
    truthy = {"1", "true", "yes", "on"}
    port = int(env.get("FLASK_PORT", "5000"))
    is_prod = (
        env.get("APP_ENV") == "production"
        or env.get("FLASK_ENV") == "production"
        or env.get("SECUREFPS_LOCAL_DEV", "").lower() in {"0", "false", "no"}
    )
    default_host = "127.0.0.1" if is_prod else "0.0.0.0"
    default_debug = False if is_prod else True

    if "FLASK_DEBUG" in env:
        debug_requested = env.get("FLASK_DEBUG", "0").strip().lower() in truthy
    else:
        debug_requested = default_debug

    host = env.get("FLASK_HOST", default_host).strip() or default_host
    return host, port, debug_requested


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


@app.get("/.well-known/appspecific/com.chrome.devtools.json")
def chrome_devtools_json():
    return jsonify({}), 200


@app.get("/<path:filename>")
def frontend_file(filename):
    # Support /public/player.html, /public/admin.html, etc. by redirecting to root page
    if filename.startswith("public/"):
        alt_name = filename[len("public/"):]
        if (FRONTEND_DIR / alt_name).is_file() and not (FRONTEND_DIR / filename).is_file():
            return redirect(f"/{alt_name}")

    # Support /frontend/player.html, /frontend/login.html, etc. by redirecting to root page
    if filename.startswith("frontend/"):
        alt_name = filename[len("frontend/"):]
        if (FRONTEND_DIR / alt_name).is_file():
            return redirect(f"/{alt_name}")

    # Support .htm -> .html redirects (e.g., player.htm -> player.html)
    if filename.endswith(".htm") and (FRONTEND_DIR / (filename + "l")).is_file():
        return redirect(f"/{filename}l")

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
        ".glb": "model/gltf-binary",
        ".gltf": "model/gltf+json",
    }.get(suffix) or mimetypes.guess_type(content_filename)[0]
    if content_type:
        response.headers["Content-Type"] = content_type
    if content_encoding:
        response.headers["Content-Encoding"] = content_encoding
        response.vary.add("Accept-Encoding")

    # Authoritative Static File Caching Policy
    # Long-cache heavy 3D models, wasm/data, audio, and vendor libraries (1 day)
    if suffix in {".glb", ".gltf", ".wasm", ".data", ".png", ".jpg", ".jpeg", ".svg", ".ico", ".woff", ".woff2", ".mp3", ".wav"}:
        response.headers["Cache-Control"] = "public, max-age=86400, stale-while-revalidate=604800"
    elif "libs/" in filename:
        response.headers["Cache-Control"] = "public, max-age=86400"
    elif suffix in {".css", ".js"}:
        response.headers["Cache-Control"] = "public, max-age=300, must-revalidate"
    elif suffix in {".html"}:
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
    return response


# In-memory short-TTL session validation cache & throttled activity writer
_last_activity_writes = {}


@app.before_request
def validate_auth_session():
    # Validate every signed-in browser against the server-side session record so
    # a revoked or replaced browser cannot keep using a stale Flask cookie.
    if request.path in {
        "/api/health",
        "/api/auth/login",
        "/api/auth/verify-mfa",
        "/api/auth/verify-recovery-code",
        "/api/auth/signup",
        "/api/auth/register",
        "/api/auth/verify-email",
        "/api/auth/forgot-password",
        "/api/auth/reset-password",
        "/api/auth/logout",
    } or request.method == "OPTIONS":
        return None

    user_id = session.get("user_id")
    record_id = session.get("auth_session_record_id")
    if not user_id:
        return None

    now = time.monotonic()
    cache_key = (str(user_id), str(record_id))

    from bson import ObjectId
    is_appeal_route = False
    try:
        account = users.find_one(
            {"_id": ObjectId(user_id)},
            {"account_status": 1, "revoked": 1, "active_auth_session_id": 1},
        )
        # Allow banned/suspended players to access status, profile, and appeal endpoints
        appeal_allowed_endpoints = {
            "/api/player/profile",
            "/api/player/account-status",
            "/api/player/appeal",
            "/api/player/notifications",
        }
        is_appeal_route = bool(account and record_id and account.get("account_status") in {"banned", "suspended"} and request.path in appeal_allowed_endpoints)

        if account and account.get("account_status") == "suspended" and not is_appeal_route:
            session.clear()
            return jsonify({"message": "This account has been suspended."}), 403

        if account and (account.get("revoked") is True or account.get("account_status") == "banned") and not is_appeal_route:
            session.clear()
            return jsonify({"message": "This account is permanently banned."}), 403

        active_record = sessions_db.find_one(
            {"_id": ObjectId(record_id), "user_id": ObjectId(user_id), "is_active": True},
            {"_id": 1},
        ) if record_id else None

        owns_active_lock = bool(record_id) and account.get("active_auth_session_id") == record_id
        active = bool(active_record and owns_active_lock)
    except Exception:
        active = False

    if not active and not is_appeal_route:
        session.clear()
        return jsonify({"message": "Your sign-in session has ended. Please sign in again."}), 401


    # Throttled write to DB
    last_write = _last_activity_writes.get(cache_key, 0)
    if now - last_write >= 45.0:
        _last_activity_writes[cache_key] = now
        try:
            sessions_db.update_one(
                {"_id": ObjectId(record_id), "is_active": True},
                {"$set": {"last_activity": datetime.now(timezone.utc)}},
            )
        except Exception:
            pass

    return None


def ensure_default_admin():
    if not IS_LOCAL_DEV:
        # Never create default admin in production
        return

    email = os.getenv("ADMIN_EMAIL", "admin1@gmail.com").strip().lower()
    password = os.getenv("ADMIN_PASSWORD")
    mfa_secret = os.getenv("ADMIN_MFA_SECRET")

    generated = False
    if not password:
        password = os.getenv("ADMIN_PASSWORD", "Admin@12345")
    if not mfa_secret:
        mfa_secret = os.getenv("ADMIN_MFA_SECRET", "JBSWY3DPEHPK3PXP").strip()

    if not validate_password(password):
        raise ValueError("ADMIN_PASSWORD does not satisfy the configured password policy")

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
                "$set": {"role": "normal_admin", "is_super_admin": False}
            },
            upsert=True
        )
        if result.upserted_id:
            logger.info("[SecureFPS] Default admin account created: %s", email)
            if generated:
                logger.info("[SecureFPS] Dev Admin Creds -> Email: %s | Password: %s | MFA Secret: %s", email, password, mfa_secret)
        else:
            logger.info("[SecureFPS] Configured administrator account ready: %s", email)
    except Exception as exc:
        logger.error("[SecureFPS] Could not ensure the default admin account: %s", exc)

    super_email = os.getenv("SUPER_ADMIN_EMAIL", "superadmin@securefps.io").strip().lower()
    super_password = os.getenv("SUPER_ADMIN_PASSWORD", "")
    super_mfa_secret = os.getenv("SUPER_ADMIN_MFA_SECRET", "").strip()
    if super_password and super_mfa_secret:
        if not validate_password(super_password):
            raise ValueError("SUPER_ADMIN_PASSWORD does not satisfy the configured password policy")
        pyotp.TOTP(super_mfa_secret)
        users.update_one(
            {"email": super_email},
            {
                "$setOnInsert": {
                    "name": "Super Administrator",
                    "email": super_email,
                    "password_hash": hash_password(super_password),
                    "mfa_secret": super_mfa_secret,
                    "mfa_enabled": True,
                    "created_at": datetime.now(timezone.utc),
                },
                "$set": {
                    "role": "super_admin",
                    "is_super_admin": True,
                    "account_status": "active",
                    "revoked": False,
                },
            },
            upsert=True,
        )


@app.get("/api/health")
def health():
    connected = test_connection()
    return {
        "status": "ok" if connected else "unavailable",
        "database": "connected" if connected else "unavailable",
        "database_name": os.getenv("MONGO_DB", os.getenv("DB_NAME", "secure_fps")),
    }, (200 if connected else 503)


# Uploads Directory and WebP Media Serving
UPLOADS_DIR = Path(__file__).resolve().parent / "uploads"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
(UPLOADS_DIR / "avatars").mkdir(exist_ok=True)
(UPLOADS_DIR / "banners").mkdir(exist_ok=True)


@app.get("/api/media/<category>/<filename>")
def serve_media(category, filename):
    if category not in {"avatars", "banners"}:
        return jsonify({"message": "Invalid media category."}), 404
    if not re.match(r"^[a-zA-Z0-9_\-]+\.webp$", filename):
        return jsonify({"message": "Invalid filename format."}), 400
    cat_dir = UPLOADS_DIR / category
    if not (cat_dir / filename).exists():
        return jsonify({"message": "Media file not found."}), 404
    return send_from_directory(cat_dir, filename, mimetype="image/webp")


if __name__ == "__main__":
    ensure_default_admin()
    flask_host, flask_port, debug_enabled = network_server_settings()
    app.run(
        host=flask_host,
        port=flask_port,
        debug=debug_enabled,
        threaded=True,
    )
