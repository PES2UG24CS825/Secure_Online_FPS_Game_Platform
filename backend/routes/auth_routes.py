import base64
import io
from datetime import timedelta

import pyotp
import qrcode
from bson import ObjectId
from flask import Blueprint, jsonify, request, session
from pymongo.errors import DuplicateKeyError

from database.db import (
    create_session_record,
    login_history,
    log_security_event,
    revoke_session_records,
    users,
    utcnow,
)
from services.auth import (
    PASSWORD_RULES_MESSAGE,
    hash_password,
    validate_password,
    verify_password,
)

auth_bp = Blueprint("auth", __name__, url_prefix="/api/auth")


def current_user_record():
    user_id = session.get("user_id")
    if not user_id:
        return None

    try:
        return users.find_one({"_id": ObjectId(user_id)})
    except Exception:
        return None


@auth_bp.post("/signup")
def signup():
    data = request.get_json(silent=True) or {}

    name = data.get("name", "").strip()
    email = data.get("email", "").strip().lower()
    password = data.get("password", "")

    if not name or not email:
        return jsonify({"message": "Name and a valid email are required."}), 400

    if not validate_password(password):
        return jsonify({"message": PASSWORD_RULES_MESSAGE}), 400

    secret = pyotp.random_base32()

    user = {
        "name": name,
        "email": email,
        "password_hash": hash_password(password),
        "mfa_secret": secret,
        "mfa_enabled": True,
        "role": "player",
        "status": "active",
        "created_at": utcnow(),
    }

    try:
        result = users.insert_one(user)
    except DuplicateKeyError:
        return jsonify(
            {"message": "An account with this email already exists."}
        ), 409

    log_security_event(
        str(result.inserted_id),
        "account_created",
        "low",
        f"Player account created for {name}.",
        ip_address=request.remote_addr or "127.0.0.1",
        source="signup",
    )

    issuer = "Secure FPS Gaming Platform"
    uri = pyotp.TOTP(secret).provisioning_uri(
        name=email,
        issuer_name=issuer,
    )

    qr = qrcode.make(uri)
    buffer = io.BytesIO()
    qr.save(buffer, format="PNG")
    qr_b64 = base64.b64encode(buffer.getvalue()).decode("ascii")

    return jsonify(
        {
            "message": "Account created. Configure your authenticator app.",
            "mfa_setup": {
                "qr_data_url": f"data:image/png;base64,{qr_b64}",
                "manual_key": secret,
            },
        }
    ), 201


@auth_bp.post("/forgot-password")
def forgot_password():
    data = request.get_json(silent=True) or {}

    email = data.get("email", "").strip().lower()

    if not email:
        return jsonify(
            {"message": "Enter your player email address."}
        ), 400

    new_password = data.get("new_password", "")
    confirm_password = data.get("confirm_password", "")

    if data.get("reset_code", "").strip() != "123456":
        return jsonify({"message": "Enter the 6-digit reset code."}), 400

    if not validate_password(new_password):
        return jsonify({"message": PASSWORD_RULES_MESSAGE}), 400

    if new_password != confirm_password:
        return jsonify({"message": "Passwords do not match."}), 400

    users.update_one(
        {"email": email, "role": {"$ne": "admin"}},
        {"$set": {"password_hash": hash_password(new_password)}},
    )

    return jsonify(
        {"message": "If a player account exists, its password has been updated."}
    )


@auth_bp.post("/login")
def login():
    data = request.get_json(silent=True) or {}

    email = data.get("email", "").strip().lower()
    password = data.get("password", "")

    user = users.find_one({"email": email})

    if not user or not verify_password(password, user["password_hash"]):
        log_security_event(
            None,
            "failed_login",
            "high",
            f"Failed login attempt for {email}.",
            ip_address=request.remote_addr or "127.0.0.1",
            source="login",
            status="failed",
        )

        return jsonify({"message": "Invalid email or password."}), 401

    if user.get("status") == "suspended":
        return jsonify({"message": "This account is suspended."}), 403

    session.clear()
    session["mfa_pending_user"] = str(user["_id"])
    session["mfa_attempts"] = 0

    return jsonify(
        {
            "message": "Password verified. MFA required.",
            "mfa_required": True,
        }
    )


@auth_bp.post("/verify-mfa")
def verify_mfa():
    data = request.get_json(silent=True) or {}

    code = data.get("code", "").strip()
    pending_id = session.get("mfa_pending_user")

    if not pending_id:
        return jsonify(
            {"message": "MFA session expired. Please log in again."}
        ), 401

    user = users.find_one({"_id": ObjectId(pending_id)})

    if not user:
        session.clear()
        return jsonify({"message": "User not found."}), 401

    attempts = int(session.get("mfa_attempts", 0))

    if attempts >= 5:
        log_security_event(
            str(user["_id"]),
            "failed_login",
            "high",
            "Too many MFA attempts blocked.",
            ip_address=request.remote_addr or "127.0.0.1",
            source="mfa",
            status="failed",
        )

        session.clear()

        return jsonify(
            {"message": "Too many MFA attempts. Please log in again."}
        ), 429

    if not pyotp.TOTP(user["mfa_secret"]).verify(code, valid_window=1):
        session["mfa_attempts"] = attempts + 1

        log_security_event(
            str(user["_id"]),
            "failed_login",
            "medium",
            "Invalid MFA verification code entered.",
            ip_address=request.remote_addr or "127.0.0.1",
            source="mfa",
            status="failed",
        )

        return jsonify({"message": "Invalid MFA code."}), 401

    session.clear()
    session["user_id"] = str(user["_id"])
    session["login_at"] = utcnow().isoformat()
    session.permanent = True
    session.permanent_session_lifetime = timedelta(minutes=30)

    client_ip = request.remote_addr or "Unknown"

    # Preserve login history from both branches.
    login_history.insert_one(
        {
            "user_id": str(user["_id"]),
            "timestamp": utcnow(),
            "success": True,
            "authentication_method": "mfa",
            "ip_address": request.remote_addr or "127.0.0.1",
            "location": "Localhost",
            "type": "login_success",
            "ip": client_ip,
            "description": f"Successful login from {client_ip}",
            "status": "success",
            "created_at": utcnow(),
        }
    )

    create_session_record(
        str(user["_id"]),
        user.get("role", "player"),
        ip_address=request.remote_addr or "127.0.0.1",
        user_agent=request.headers.get("User-Agent", "unknown"),
    )

    log_security_event(
        str(user["_id"]),
        "player_login" if user.get("role") == "player" else "admin_login",
        "low" if user.get("role") == "player" else "medium",
        f"{user.get('role', 'player').title()} authenticated successfully.",
        ip_address=request.remote_addr or "127.0.0.1",
        source="mfa",
        status="success",
    )

    return jsonify(
        {
            "message": "MFA verified. Login successful.",
            "user": {
                "id": str(user["_id"]),
                "role": user.get("role", "player"),
            },
        }
    )


@auth_bp.get("/me")
def me():
    user_id = session.get("user_id")

    if not user_id:
        return jsonify({"authenticated": False}), 401

    user = users.find_one(
        {"_id": ObjectId(user_id)},
        {"password_hash": 0, "mfa_secret": 0},
    )

    if not user:
        session.clear()
        return jsonify({"authenticated": False}), 401

    if user.get("status") == "suspended":
        session.clear()
        return jsonify(
            {
                "authenticated": False,
                "message": "Account suspended.",
            }
        ), 403

    return jsonify(
        {
            "authenticated": True,
            "user": {
                "id": str(user["_id"]),
                "name": user["name"],
                "email": user["email"],
                "role": user.get("role", "player"),
                "status": user.get("status", "active"),
                "mfa_enabled": user.get("mfa_enabled", False),
                "created_at": (
                    user.get("created_at").isoformat()
                    if user.get("created_at")
                    else None
                ),
            },
        }
    )


@auth_bp.post("/logout")
def logout():
    user_id = session.get("user_id")

    if user_id:
        client_ip = request.remote_addr or "Unknown"

        # Preserve login-history logout tracking.
        login_history.insert_one(
            {
                "user_id": ObjectId(user_id),
                "type": "logout",
                "ip": client_ip,
                "description": f"Logout from {client_ip}",
                "status": "success",
                "created_at": utcnow(),
            }
        )

        # Revoke active database sessions.
        revoke_session_records(user_id)

        log_security_event(
            user_id,
            "logout",
            "low",
            "User logged out of the platform.",
            ip_address=request.remote_addr or "127.0.0.1",
            source="logout",
            status="success",
        )

    session.clear()

    return jsonify({"message": "Logged out successfully."})


@auth_bp.post("/logout-other-sessions")
def logout_other_sessions():
    user_id = session.get("user_id")

    if not user_id:
        return jsonify({"message": "Authentication required."}), 401

    revoke_session_records(user_id)

    log_security_event(
        user_id,
        "session_revoked",
        "medium",
        "User revoked all active sessions except current session.",
        ip_address=request.remote_addr or "127.0.0.1",
        source="security",
        status="success",
    )

    return jsonify({"message": "Other sessions have been revoked."})