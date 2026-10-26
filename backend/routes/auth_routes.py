import base64
import io
import os
from datetime import datetime, timezone, timedelta

import pyotp
import qrcode
from flask import Blueprint, jsonify, request, session
from pymongo.errors import DuplicateKeyError

AUTH_SESSION_IDLE_TIMEOUT_SECONDS = int(os.getenv("AUTH_SESSION_IDLE_TIMEOUT_SECONDS", "120"))

from database.db import login_history, sessions_db, users
from services.auth import PASSWORD_RULES_MESSAGE, hash_password, validate_password, verify_password

auth_bp = Blueprint("auth", __name__, url_prefix="/api/auth")

def utcnow():
    return datetime.now(timezone.utc)

def blocked_account_message(user):
    status = user.get("account_status")
    if status == "suspended":
        return "This account has been suspended. Contact support if you believe this is an error."
    if status == "banned" or user.get("revoked") is True:
        return "This account is permanently banned."
    ban_until = user.get("ban_until")
    if ban_until and ban_until.tzinfo is None:
        ban_until = ban_until.replace(tzinfo=timezone.utc)
    if status == "banned" and ban_until and ban_until <= utcnow():
        users.update_one(
            {"_id": user["_id"], "account_status": "banned"},
            {"$set": {"account_status": "active", "revoked": False, "account_status_updated_at": utcnow()},
             "$unset": {"ban_until": ""}},
        )
        return None
    if not user.get("revoked") and status not in {"suspended", "banned"}:
        return None
    return "This account is permanently banned."

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
        {"$set": {"password_hash": hash_password(new_password)}}
    )
    return jsonify({
        "message": "If a player account exists, its password has been updated."
    })

@auth_bp.post("/login")
def login():
    data = request.get_json(silent=True) or {}
    email = data.get("email", "").strip().lower()
    password = data.get("password", "")

    user = users.find_one({"email": email})
    if not user or not verify_password(password, user["password_hash"]):
        login_history.insert_one({
            "user_id": user["_id"] if user else None,
            "identifier": email,
            "type": "login_failed",
            "status": "failed",
            "reason": "invalid_password" if user else "unknown_account",
            "ip_address": request.remote_addr or "Unknown",
            "device": request.user_agent.string[:250],
            "user_agent": request.user_agent.string[:250],
            "created_at": utcnow(),
        })
        return jsonify({"message": "Invalid email or password."}), 401

    blocked_message = blocked_account_message(user)
    if blocked_message:
        login_history.insert_one({
            "user_id": user["_id"],
            "identifier": email,
            "type": "login_failed",
            "status": "failed",
            "reason": "account_banned" if user.get("account_status") == "banned" else "account_suspended",
            "ip_address": request.remote_addr or "Unknown",
            "device": request.user_agent.string[:250],
            "user_agent": request.user_agent.string[:250],
            "created_at": utcnow(),
        })
        return jsonify({"message": blocked_message}), 403

    # The user's pointer is the authoritative lock. Historical session rows
    # can remain active after older clients logged out without a session id.
    active_record_id = user.get("active_auth_session_id")
    session_takeover = bool(data.get("takeover"))
    if active_record_id:
        from bson import ObjectId
        try:
            active_record = sessions_db.find_one({
                "_id": ObjectId(active_record_id),
                "user_id": user["_id"],
                "is_active": True,
            }, {"_id": 1, "last_activity": 1})
        except Exception:
            active_record = None
        if active_record:
            last_activity = active_record.get("last_activity")
            if isinstance(last_activity, str):
                try:
                    last_activity = datetime.fromisoformat(last_activity.replace("Z", "+00:00"))
                except ValueError:
                    last_activity = None
            if last_activity and last_activity.tzinfo is None:
                last_activity = last_activity.replace(tzinfo=timezone.utc)
            is_recent = bool(
                last_activity
                and utcnow() - last_activity <= timedelta(seconds=AUTH_SESSION_IDLE_TIMEOUT_SECONDS)
            )
            if is_recent and not session_takeover:
                login_history.insert_one({
                    "user_id": user["_id"],
                    "identifier": email,
                    "type": "login_failed",
                    "status": "failed",
                    "reason": "active_session",
                    "ip_address": request.remote_addr or "Unknown",
                    "device": request.user_agent.string[:250],
                    "user_agent": request.user_agent.string[:250],
                    "created_at": utcnow(),
                })
                return jsonify({
                    "message": "This account is already signed in in another browser. Log out there first, or choose Sign in here to end that session.",
                    "can_takeover": True,
                }), 409
            elif not is_recent or session_takeover:
                sessions_db.update_one(
                    {"_id": ObjectId(active_record_id), "user_id": user["_id"]},
                    {"$set": {"is_active": False, "last_activity": utcnow()}},
                )
        if not session_takeover:
            users.update_one(
                {"_id": user["_id"], "active_auth_session_id": active_record_id},
                {"$unset": {"active_auth_session_id": ""}},
            )

    session.clear()
    session["mfa_pending_user"] = str(user["_id"])
    session["mfa_attempts"] = 0
    session["mfa_takeover"] = session_takeover

    return jsonify({
        "message": "Password verified. MFA required.",
        "mfa_required": True,
        "replace_other_session": session_takeover,
    })

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

    blocked_message = blocked_account_message(user)
    if blocked_message:
        session.clear()
        login_history.insert_one({
            "user_id": user["_id"],
            "identifier": user.get("email"),
            "type": "login_failed",
            "status": "failed",
            "reason": "account_banned" if user.get("account_status") == "banned" else "account_suspended",
            "ip_address": request.remote_addr or "Unknown",
            "device": request.user_agent.string[:250],
            "user_agent": request.user_agent.string[:250],
            "created_at": utcnow(),
        })
        return jsonify({"message": blocked_message}), 403

    attempts = int(session.get("mfa_attempts", 0))
    if attempts >= 5:
        session.clear()
        return jsonify({"message": "Too many MFA attempts. Please log in again."}), 429

    if not pyotp.TOTP(user["mfa_secret"]).verify(code, valid_window=1):
        session["mfa_attempts"] = attempts + 1
        login_history.insert_one({
            "user_id": user["_id"],
            "identifier": user.get("email"),
            "type": "login_failed",
            "status": "failed",
            "reason": "invalid_mfa",
            "ip_address": request.remote_addr or "Unknown",
            "device": request.user_agent.string[:250],
            "user_agent": request.user_agent.string[:250],
            "created_at": utcnow(),
        })
        return jsonify({"message": "Invalid MFA code."}), 401

    logged_in_at = utcnow()

    # Record the network address only after password and MFA both succeed.
    ip_address = request.remote_addr or "Unknown"
    session_record = {
        "user_id": user["_id"],
        "ip": ip_address,
        "ip_address": ip_address,
        "device": request.user_agent.string[:250],
        "created_at": logged_in_at,
        "last_activity": logged_in_at,
        "is_active": True,
    }
    session_result = sessions_db.insert_one(session_record)
    session_record_id = str(session_result.inserted_id)
    if session.get("mfa_takeover"):
        claim = users.update_one(
            {"_id": user["_id"]},
            {"$set": {"active_auth_session_id": session_record_id}},
        )
    else:
        claim = users.update_one(
            {
                "_id": user["_id"],
                "$or": [
                    {"active_auth_session_id": {"$exists": False}},
                    {"active_auth_session_id": None},
                ],
            },
            {"$set": {"active_auth_session_id": session_record_id}},
        )
    if claim.modified_count != 1:
        sessions_db.update_one(
            {"_id": session_result.inserted_id},
            {"$set": {"is_active": False, "last_activity": utcnow()}},
        )
        session.clear()
        return jsonify({
            "message": "This account is already signed in in another browser. Log out there before signing in here."
        }), 409

    # Retire legacy/orphaned active rows after the new browser has claimed the
    # account, so their stale cookies cannot continue to pass session checks.
    sessions_db.update_many(
        {"user_id": user["_id"], "is_active": True, "_id": {"$ne": session_result.inserted_id}},
        {"$set": {"is_active": False, "last_activity": utcnow()}},
    )

    session.clear()
    session["user_id"] = str(user["_id"])
    session["login_at"] = logged_in_at.isoformat()
    session["auth_session_record_id"] = session_record_id
    login_history.insert_one({
        "user_id": user["_id"],
        "type": "login_success",
        "status": "success",
        "ip": ip_address,
        "ip_address": ip_address,
        "authentication_method": "password+mfa",
        "device": request.user_agent.string[:250],
        "user_agent": request.user_agent.string[:250],
        "created_at": logged_in_at,
    })

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
            "role": user.get("role", "player"),
            "created_at": user["created_at"].isoformat(),
        }
    })

@auth_bp.post("/logout")
def logout():
    record_id = session.get("auth_session_record_id")
    user_id = session.get("user_id")
    pending_user_id = session.get("mfa_pending_user")
    if record_id:
        from bson import ObjectId
        try:
            record_oid = ObjectId(record_id)
            sessions_db.update_one(
                {"_id": record_oid},
                {"$set": {"is_active": False, "last_activity": utcnow()}},
            )
        except Exception:
            pass
    if user_id:
        try:
            # Clear the account pointer even if an old browser lost its
            # session-record cookie; otherwise another browser remains locked.
            users.update_one(
                {"_id": ObjectId(user_id)},
                {"$unset": {"active_auth_session_id": ""}},
            )
        except Exception:
            pass
    elif pending_user_id:
        try:
            from bson import ObjectId
            pending_oid = ObjectId(pending_user_id)
            account = users.find_one(
                {"_id": pending_oid},
                {"active_auth_session_id": 1},
            ) or {}
            pending_record_id = account.get("active_auth_session_id")
            pending_record = None
            if pending_record_id:
                try:
                    pending_record = sessions_db.find_one({
                        "_id": ObjectId(pending_record_id),
                        "user_id": pending_oid,
                    }, {"is_active": 1})
                except Exception:
                    pending_record = None
            if pending_record and not pending_record.get("is_active", False):
                users.update_one(
                    {"_id": pending_oid, "active_auth_session_id": pending_record_id},
                    {"$unset": {"active_auth_session_id": ""}},
                )
        except Exception:
            pass
    session.clear()
    return jsonify({"message": "Logged out successfully."})
