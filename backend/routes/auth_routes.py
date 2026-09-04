import base64
import io
import os
from datetime import datetime, timezone

import pyotp
import qrcode
from flask import Blueprint, jsonify, request, session
from pymongo.errors import DuplicateKeyError

from database.db import users
from services.auth import PASSWORD_RULES_MESSAGE, hash_password, validate_password, verify_password

auth_bp = Blueprint("auth", __name__, url_prefix="/api/auth")

def utcnow():
    return datetime.now(timezone.utc)

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
        "created_at": utcnow(),
    }

    try:
        users.insert_one(user)
    except DuplicateKeyError:
        return jsonify({"message": "An account with this email already exists."}), 409

    # For local development, return the provisioning URI.
    # In production, show a QR code in a dedicated MFA setup page and never expose the secret again.
    issuer = "Secure FPS Gaming Platform"
    uri = pyotp.TOTP(secret).provisioning_uri(name=email, issuer_name=issuer)

    qr = qrcode.make(uri)
    buffer = io.BytesIO()
    qr.save(buffer, format="PNG")
    qr_b64 = base64.b64encode(buffer.getvalue()).decode("ascii")

    return jsonify({
        "message": "Account created. Configure your authenticator app.",
        "mfa_setup": {
            "qr_data_url": f"data:image/png;base64,{qr_b64}",
            "manual_key": secret
        }
    }), 201

@auth_bp.post("/forgot-password")
def forgot_password():
    data = request.get_json(silent=True) or {}
    email = data.get("email", "").strip().lower()
    if not email:
        return jsonify({"message": "Enter your player email address."}), 400

    # Keep the response identical for known and unknown addresses.
    return jsonify({
        "message": "If an account exists for that email, reset instructions will be sent."
    })

@auth_bp.post("/login")
def login():
    data = request.get_json(silent=True) or {}
    email = data.get("email", "").strip().lower()
    password = data.get("password", "")

    user = users.find_one({"email": email})
    if not user or not verify_password(password, user["password_hash"]):
        return jsonify({"message": "Invalid email or password."}), 401

    session.clear()
    session["mfa_pending_user"] = str(user["_id"])
    session["mfa_attempts"] = 0

    return jsonify({"message": "Password verified. MFA required.", "mfa_required": True})

@auth_bp.post("/verify-mfa")
def verify_mfa():
    data = request.get_json(silent=True) or {}
    code = data.get("code", "").strip()
    pending_id = session.get("mfa_pending_user")

    if not pending_id:
        return jsonify({"message": "MFA session expired. Please log in again."}), 401

    from bson import ObjectId
    user = users.find_one({"_id": ObjectId(pending_id)})
    if not user:
        session.clear()
        return jsonify({"message": "User not found."}), 401

    attempts = int(session.get("mfa_attempts", 0))
    if attempts >= 5:
        session.clear()
        return jsonify({"message": "Too many MFA attempts. Please log in again."}), 429

    if not pyotp.TOTP(user["mfa_secret"]).verify(code, valid_window=1):
        session["mfa_attempts"] = attempts + 1
        return jsonify({"message": "Invalid MFA code."}), 401

    session.clear()
    session["user_id"] = str(user["_id"])
    session["login_at"] = utcnow().isoformat()

    return jsonify({"message": "MFA verified. Login successful."})

@auth_bp.get("/me")
def me():
    user_id = session.get("user_id")
    if not user_id:
        return jsonify({"authenticated": False}), 401

    from bson import ObjectId
    user = users.find_one({"_id": ObjectId(user_id)}, {"password_hash": 0, "mfa_secret": 0})
    if not user:
        session.clear()
        return jsonify({"authenticated": False}), 401

    return jsonify({
        "authenticated": True,
        "user": {
            "id": str(user["_id"]),
            "name": user["name"],
            "email": user["email"],
            "created_at": user["created_at"].isoformat(),
        }
    })

@auth_bp.post("/logout")
def logout():
    session.clear()
    return jsonify({"message": "Logged out successfully."})
