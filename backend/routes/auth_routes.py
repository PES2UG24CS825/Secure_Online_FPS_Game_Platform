import base64
import io
import os
import re
from datetime import datetime, timezone, timedelta
from bson import ObjectId

import pyotp
import qrcode
from flask import Blueprint, jsonify, request, session
from pymongo.errors import DuplicateKeyError

from database.db import login_history, sessions_db, users
from services.auth import PASSWORD_RULES_MESSAGE, hash_password, validate_password, verify_password
from services.auth_security import (
    is_production,
    is_demo_email,
    send_security_email,
    create_email_verification_token,
    verify_email_token,
    create_password_reset_token,
    reset_password_with_token,
    generate_backup_recovery_codes,
    verify_backup_recovery_code,
)

AUTH_SESSION_IDLE_TIMEOUT_SECONDS = int(os.getenv("AUTH_SESSION_IDLE_TIMEOUT_SECONDS", "3600"))

auth_bp = Blueprint("auth", __name__, url_prefix="/api/auth")

EMAIL_REGEX = re.compile(r"^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$")


def utcnow():
    return datetime.now(timezone.utc)


def format_iso(dt):
    if not dt:
        return None
    if isinstance(dt, str):
        return dt
    if hasattr(dt, "isoformat"):
        return dt.isoformat()
    return str(dt)


def blocked_account_message(user):
    """
    Returns an error message if the account is banned or suspended; otherwise None.
    Reactivates temporary bans if ban_until has elapsed.
    """
    status = user.get("account_status")
    if status == "suspended":
        return "This account has been suspended. Contact security support if you believe this is an error."
    if status == "banned" or user.get("revoked") is True:
        ban_until = user.get("ban_until")
        if ban_until:
            if isinstance(ban_until, str):
                try:
                    ban_until = datetime.fromisoformat(ban_until.replace("Z", "+00:00"))
                except ValueError:
                    ban_until = None
            if ban_until and ban_until.tzinfo is None:
                ban_until = ban_until.replace(tzinfo=timezone.utc)
            if ban_until and ban_until <= utcnow():
                users.update_one(
                    {"_id": user["_id"]},
                    {"$set": {"account_status": "active", "revoked": False, "account_status_updated_at": utcnow()},
                     "$unset": {"ban_until": ""}},
                )
                return None
        return "This account is permanently banned."
    return None


# =========================================================================
# REGISTRATION / SIGNUP
# =========================================================================

@auth_bp.post("/signup")
@auth_bp.post("/register")
def signup():
    data = request.get_json(silent=True) or {}
    name = data.get("name", "").strip()
    email = data.get("email", "").strip().lower()
    password = data.get("password", "")

    if not name or not email:
        return jsonify({"message": "Name and a valid email address are required."}), 400
    if not EMAIL_REGEX.match(email):
        return jsonify({"message": "Please provide a valid email address format (e.g. operator@domain.com)."}), 400
    if not validate_password(password):
        return jsonify({"message": PASSWORD_RULES_MESSAGE}), 400

    # Demo identity validation
    is_demo = is_demo_email(email)
    if is_demo and is_production():
        return jsonify({"message": "Demo test accounts are strictly forbidden in production mode."}), 403

    role = "demo_player" if is_demo else "player"
    secret = pyotp.random_base32()
    now = utcnow()

    user_doc = {
        "name": name,
        "email": email,
        "password_hash": hash_password(password),
        "mfa_secret": secret,
        "mfa_enabled": True,
        "role": role,
        "account_status": "active",
        "email_verified": is_demo,  # Demo accounts auto-verified in dev
        "created_at": now,
        "honour_score": 100,
        "rewards": {
            "coins": 50,
            "xp": 100,
            "daily_streak": 1,
            "last_daily_login": now.strftime("%Y-%m-%d"),
            "owned_items": ["standard_tactical_patch"],
            "equipped_item": "standard_tactical_patch"
        }
    }

    try:
        res = users.insert_one(user_doc)
        user_id = res.inserted_id
    except DuplicateKeyError:
        return jsonify({"message": "An account with this email already exists."}), 409

    # Generate 8 single-use hashed backup recovery codes
    recovery_codes = generate_backup_recovery_codes(user_id)

    # Email Verification Handling
    email_verification_status = {"sent": False, "message": "Email verification not required for demo accounts."}
    if not is_demo:
        token = create_email_verification_token(user_id, email)
        verify_url = f"{request.host_url.rstrip('/')}/api/auth/verify-email?token={token}"
        subject = "SecureFPS — Verify Your Account Email"
        html_body = f"""
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #7c3aed; border-radius: 8px;">
          <h2 style="color: #6d28d9;">Welcome to SecureFPS, {name}!</h2>
          <p>Please verify your email address to complete your competitive player profile.</p>
          <p style="margin: 25px 0;">
            <a href="{verify_url}" style="background-color: #7c3aed; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Verify Email Address</a>
          </p>
          <p style="color: #64748b; font-size: 13px;">This link will expire in 24 hours. If you did not create a SecureFPS account, please disregard this email.</p>
        </div>
        """
        text_body = f"Welcome to SecureFPS, {name}!\n\nVerify your account by opening this link:\n{verify_url}\n\nExpires in 24 hours."
        sent, msg, is_dev = send_security_email(email, subject, html_body, text_body)
        email_verification_status = {
            "sent": sent,
            "message": msg,
            "dev_mode": is_dev
        }

    # Generate MFA provisioning QR Code
    issuer = "Secure FPS Gaming Platform"
    uri = pyotp.TOTP(secret).provisioning_uri(name=email, issuer_name=issuer)
    qr = qrcode.make(uri)
    buffer = io.BytesIO()
    qr.save(buffer, format="PNG")
    qr_b64 = base64.b64encode(buffer.getvalue()).decode("ascii")

    return jsonify({
        "message": "Account created successfully. Configure your authenticator app and save your recovery codes.",
        "mfa_setup": {
            "qr_data_url": f"data:image/png;base64,{qr_b64}",
            "manual_key": secret
        },
        "recovery_codes": recovery_codes,
        "email_verification": email_verification_status
    }), 201


# =========================================================================
# EMAIL VERIFICATION
# =========================================================================

@auth_bp.route("/verify-email", methods=["GET", "POST"])
def verify_email():
    token = request.args.get("token") or (request.get_json(silent=True) or {}).get("token")
    if not token:
        return jsonify({"message": "Verification token is required."}), 400

    success, msg = verify_email_token(token)
    if not success:
        return jsonify({"message": msg, "success": False}), 400

    if request.method == "GET":
        # Redirect or render friendly confirmation page
        return f"""
        <html>
          <head><title>Email Verified | SecureFPS</title></head>
          <body style="font-family: Arial, sans-serif; background: #f5f3ff; color: #1e1b4b; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
            <div style="background: white; padding: 40px; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.1); text-align: center; max-width: 450px;">
              <h2 style="color: #6d28d9; margin-top: 0;">✓ Email Verified Successfully!</h2>
              <p>Your SecureFPS account is now fully verified.</p>
              <a href="/login.html" style="display: inline-block; margin-top: 20px; background: #7c3aed; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold;">Proceed to Sign In</a>
            </div>
          </body>
        </html>
        """

    return jsonify({"message": msg, "success": True}), 200


# =========================================================================
# PASSWORD RESET (Generic Responses - Enumeration Protected)
# =========================================================================

@auth_bp.post("/forgot-password")
def forgot_password():
    data = request.get_json(silent=True) or {}
    email = data.get("email", "").strip().lower()
    if not email:
        return jsonify({"message": "Enter your registered player email address."}), 400

    # Always return a generic success message to prevent user enumeration
    generic_response = {
        "message": "If an account with that email address is registered, password reset instructions have been dispatched."
    }

    user = users.find_one({"email": email})
    if not user:
        return jsonify(generic_response), 200

    # If demo identity in development
    if is_demo_email(email):
        token = create_password_reset_token(email)
        print(f"[SecureFPS Demo Password Reset] Single-use reset token for {email}: {token}")
        return jsonify({
            "message": "Demo identity recognized. Reset token generated in development logs.",
            "demo_reset_token": token
        }), 200

    token = create_password_reset_token(email)
    if not token:
        return jsonify(generic_response), 200

    reset_url = f"{request.host_url.rstrip('/')}/reset-password.html?token={token}"
    subject = "SecureFPS — Password Reset Request"
    html_body = f"""
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #7c3aed; border-radius: 8px;">
      <h2 style="color: #6d28d9;">Password Reset Request</h2>
      <p>A request was received to reset the password for your SecureFPS account ({email}).</p>
      <p style="margin: 25px 0;">
        <a href="{reset_url}" style="background-color: #7c3aed; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Reset Password</a>
      </p>
      <p style="color: #64748b; font-size: 13px;">This single-use link expires in 30 minutes. If you did not request this, please secure your account immediately.</p>
    </div>
    """
    text_body = f"SecureFPS Password Reset\n\nReset your password here:\n{reset_url}\n\nExpires in 30 minutes."

    sent, msg, is_dev = send_security_email(email, subject, html_body, text_body)
    if not sent and not is_dev:
        # Inform the user clearly that SMTP is not configured rather than claiming an email was sent
        return jsonify({
            "message": "Email delivery service is currently not configured on this server. Contact your administrator or use development demo accounts."
        }), 503

    return jsonify(generic_response), 200


@auth_bp.post("/reset-password")
def reset_password():
    data = request.get_json(silent=True) or {}
    token = data.get("token", "").strip()
    new_password = data.get("new_password", "")
    confirm_password = data.get("confirm_password", "")

    if not token:
        return jsonify({"message": "Valid reset token is required."}), 400
    if not validate_password(new_password):
        return jsonify({"message": PASSWORD_RULES_MESSAGE}), 400
    if new_password != confirm_password:
        return jsonify({"message": "Passwords do not match."}), 400

    new_hash = hash_password(new_password)
    success, msg = reset_password_with_token(token, new_hash)
    if not success:
        return jsonify({"message": msg}), 400

    return jsonify({"message": msg, "success": True}), 200


# =========================================================================
# LOGIN & MFA VERIFICATION
# =========================================================================

@auth_bp.post("/login")
def login():
    data = request.get_json(silent=True) or {}
    email = data.get("email", "").strip().lower()
    password = data.get("password", "")

    user = users.find_one({"email": email})
    if not user or not verify_password(password, user.get("password_hash", "")):
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

    active_record_id = user.get("active_auth_session_id")
    session_takeover = bool(data.get("takeover"))

    if active_record_id:
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
        "message": "Password verified. Authenticator MFA required.",
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

    user = users.find_one({"_id": ObjectId(pending_id)})
    if not user:
        session.clear()
        return jsonify({"message": "User not found."}), 401

    blocked_message = blocked_account_message(user)
    if blocked_message:
        session.clear()
        return jsonify({"message": blocked_message}), 403

    attempts = int(session.get("mfa_attempts", 0))
    if attempts >= 5:
        session.clear()
        return jsonify({"message": "Too many failed MFA attempts. Please log in again."}), 429

    mfa_secret = user.get("mfa_secret")
    if not mfa_secret or not pyotp.TOTP(mfa_secret).verify(code, valid_window=1):
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
        return jsonify({"message": "Invalid MFA code. Check your authenticator app time synchronization."}), 401

    return complete_login_session(user)


@auth_bp.post("/verify-recovery-code")
def verify_recovery_code():
    data = request.get_json(silent=True) or {}
    code = data.get("code", "").strip()
    pending_id = session.get("mfa_pending_user")

    if not pending_id:
        return jsonify({"message": "Login session expired. Please log in again."}), 401

    user = users.find_one({"_id": ObjectId(pending_id)})
    if not user:
        session.clear()
        return jsonify({"message": "User not found."}), 401

    blocked_message = blocked_account_message(user)
    if blocked_message:
        session.clear()
        return jsonify({"message": blocked_message}), 403

    success, msg = verify_backup_recovery_code(pending_id, code)
    if not success:
        return jsonify({"message": msg}), 401

    return complete_login_session(user, auth_method="password+recovery_code")


def complete_login_session(user, auth_method="password+mfa"):
    logged_in_at = utcnow()
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

    # Retire other active rows
    sessions_db.update_many(
        {"user_id": user["_id"], "is_active": True, "_id": {"$ne": session_result.inserted_id}},
        {"$set": {"is_active": False, "last_activity": utcnow()}},
    )

    session.clear()
    session["user_id"] = str(user["_id"])
    session["login_at"] = logged_in_at.isoformat()
    session["auth_session_record_id"] = session_record_id
    session["user_role"] = user.get("role", "player")

    login_history.insert_one({
        "user_id": user["_id"],
        "type": "login_success",
        "status": "success",
        "ip": ip_address,
        "ip_address": ip_address,
        "authentication_method": auth_method,
        "device": request.user_agent.string[:250],
        "user_agent": request.user_agent.string[:250],
        "created_at": logged_in_at,
    })

    return jsonify({
        "message": "Authentication successful.",
        "user": {
            "id": str(user["_id"]),
            "name": user["name"],
            "email": user["email"],
            "role": user.get("role", "player")
        }
    }), 200


# =========================================================================
# SESSION & CURRENT USER STATUS
# =========================================================================

@auth_bp.get("/me")
def me():
    user_id = session.get("user_id")
    if not user_id:
        return jsonify({"authenticated": False}), 401

    user = users.find_one({"_id": ObjectId(user_id)}, {"password_hash": 0, "mfa_secret": 0})
    if not user:
        session.clear()
        return jsonify({"authenticated": False}), 401

    # Validate active status
    blocked = blocked_account_message(user)
    if blocked:
        session.clear()
        return jsonify({"authenticated": False, "message": blocked}), 403

    return jsonify({
        "authenticated": True,
        "user": {
            "id": str(user["_id"]),
            "name": user["name"],
            "email": user["email"],
            "role": user.get("role", "player"),
            "email_verified": user.get("email_verified", False),
            "account_status": user.get("account_status", "active"),
            "honour_score": user.get("honour_score", 100),
            "created_at": format_iso(user.get("created_at")),
        }
    })


@auth_bp.post("/logout")
def logout():
    record_id = session.get("auth_session_record_id")
    user_id = session.get("user_id")
    if record_id:
        try:
            sessions_db.update_one(
                {"_id": ObjectId(record_id)},
                {"$set": {"is_active": False, "last_activity": utcnow()}},
            )
        except Exception:
            pass
    if user_id:
        try:
            users.update_one(
                {"_id": ObjectId(user_id)},
                {"$unset": {"active_auth_session_id": ""}},
            )
        except Exception:
            pass

    session.clear()
    return jsonify({"message": "Logged out successfully."})


# =========================================================================
# SENSITIVE ACCOUNT SECURITY ACTIONS (Re-authentication Required)
# =========================================================================

@auth_bp.post("/change-password")
def change_password():
    user_id = session.get("user_id")
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401

    data = request.get_json(silent=True) or {}
    current_password = data.get("current_password", "")
    new_password = data.get("new_password", "")
    confirm_password = data.get("confirm_password", "")

    user = users.find_one({"_id": ObjectId(user_id)})
    if not user or not verify_password(current_password, user.get("password_hash", "")):
        return jsonify({"message": "Current password verification failed."}), 401

    if not validate_password(new_password):
        return jsonify({"message": PASSWORD_RULES_MESSAGE}), 400
    if new_password != confirm_password:
        return jsonify({"message": "New passwords do not match."}), 400

    new_hash = hash_password(new_password)
    users.update_one(
        {"_id": user["_id"]},
        {"$set": {"password_hash": new_hash, "password_updated_at": utcnow()}}
    )

    # Invalidate other sessions
    current_record_id = session.get("auth_session_record_id")
    if current_record_id:
        sessions_db.update_many(
            {"user_id": user["_id"], "is_active": True, "_id": {"$ne": ObjectId(current_record_id)}},
            {"$set": {"is_active": False, "last_activity": utcnow()}}
        )

    return jsonify({"message": "Password changed successfully. Other browser sessions terminated."}), 200


@auth_bp.post("/recovery-codes/generate")
def generate_recovery_codes():
    user_id = session.get("user_id")
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401

    data = request.get_json(silent=True) or {}
    password = data.get("password", "")

    user = users.find_one({"_id": ObjectId(user_id)})
    if not user or not verify_password(password, user.get("password_hash", "")):
        return jsonify({"message": "Password confirmation required to generate new recovery codes."}), 401

    plain_codes = generate_backup_recovery_codes(user_id)
    return jsonify({
        "message": "New backup recovery codes generated. Store them securely; previous codes are invalidated.",
        "recovery_codes": plain_codes
    }), 200
