import os
import smtplib
import secrets
import hashlib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from datetime import datetime, timezone, timedelta
from bson import ObjectId
from database.db import db, users, sessions_db, login_history, system_config

# Collections for security tokens and audit logs
email_verifications = db["email_verifications"]
password_resets = db["password_resets"]
admin_audit_log = db["admin_audit_log"]

# Ensure unique index on tokens for security
try:
    email_verifications.create_index("token", unique=True)
    password_resets.create_index("token", unique=True)
except Exception:
    pass

# Supported Development Demo Accounts
DEMO_ACCOUNTS = {
    "demo_player_one@example.test": {"name": "Demo Player One", "role": "demo_player"},
    "demo_player_two@example.test": {"name": "Demo Player Two", "role": "demo_player"},
    "security_test@example.test": {"name": "Security Test Operator", "role": "demo_player"},
    "admin_test@example.test": {"name": "Admin Test Operator", "role": "demo_admin"}
}

def is_production():
    """Returns True if the environment is explicitly configured for production."""
    env = os.getenv("FLASK_ENV", os.getenv("APP_ENV", "development")).lower()
    return env == "production"

def is_demo_email(email):
    """Returns True if the given email is a recognized development demo identity."""
    return email.strip().lower() in DEMO_ACCOUNTS

def get_smtp_config():
    """Retrieves SMTP configuration from environment variables."""
    host = os.getenv("SMTP_HOST", "").strip()
    port = int(os.getenv("SMTP_PORT", "587"))
    user = os.getenv("SMTP_USER", "").strip()
    password = os.getenv("SMTP_PASSWORD", "").strip()
    from_addr = os.getenv("SMTP_FROM", user or "noreply@securefps.local").strip()
    use_tls = os.getenv("SMTP_USE_TLS", "true").lower() in ("true", "1", "yes")

    is_configured = bool(host and port and (user or not password))
    return {
        "is_configured": is_configured,
        "host": host,
        "port": port,
        "user": user,
        "password": password,
        "from_addr": from_addr,
        "use_tls": use_tls
    }

def send_security_email(to_email, subject, body_html, body_text):
    """
    Sends an email using configured SMTP or development demo handling.
    Returns: (success: bool, message: str, is_dev_mode: bool)
    """
    to_email = to_email.strip().lower()

    # 1. Development / Demo Mode Handling
    if is_demo_email(to_email):
        if is_production():
            return False, "Demo accounts are strictly forbidden in production mode.", False
        # In development, simulate delivery with full audit logging
        print(f"[SecureFPS Demo Email] Simulated dispatch to {to_email}: {subject}")
        return True, "Development demo email processed successfully (simulated delivery).", True

    # 2. Real Email Mode via SMTP
    smtp = get_smtp_config()
    if not smtp["is_configured"]:
        return False, "SMTP email service is not configured. Please set SMTP_HOST, SMTP_PORT, and credentials in .env.", False

    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = smtp["from_addr"]
        msg["To"] = to_email

        msg.attach(MIMEText(body_text, "plain"))
        msg.attach(MIMEText(body_html, "html"))

        if smtp["use_tls"]:
            server = smtplib.SMTP(smtp["host"], smtp["port"], timeout=10)
            server.starttls()
        else:
            server = smtplib.SMTP(smtp["host"], smtp["port"], timeout=10)

        if smtp["user"] and smtp["password"]:
            server.login(smtp["user"], smtp["password"])

        server.sendmail(smtp["from_addr"], [to_email], msg.as_string())
        server.quit()
        return True, "Email sent successfully.", False
    except Exception as e:
        print(f"[SecureFPS SMTP Error] Failed to send email to {to_email}: {e}")
        return False, f"SMTP delivery failed: {str(e)}", False

def create_email_verification_token(user_id, email):
    """Generates a cryptographically secure 48-char single-use verification token (expires in 24 hours)."""
    token = secrets.token_urlsafe(36)
    expires_at = datetime.now(timezone.utc) + timedelta(hours=24)
    email_verifications.insert_one({
        "token": token,
        "user_id": ObjectId(user_id) if isinstance(user_id, str) else user_id,
        "email": email.strip().lower(),
        "created_at": datetime.now(timezone.utc),
        "expires_at": expires_at,
        "used": False
    })
    return token

def verify_email_token(token):
    """Verifies and consumes a single-use email verification token."""
    record = email_verifications.find_one({"token": token, "used": False})
    if not record:
        return False, "Invalid or already used verification token."

    expires_at = record.get("expires_at")
    if expires_at and expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at and expires_at < datetime.now(timezone.utc):
        return False, "Verification token has expired. Please request a new verification email."

    email_verifications.update_one({"_id": record["_id"]}, {"$set": {"used": True, "used_at": datetime.now(timezone.utc)}})
    users.update_one({"_id": record["user_id"]}, {"$set": {"email_verified": True, "email_verified_at": datetime.now(timezone.utc)}})
    return True, "Email address successfully verified."

def create_password_reset_token(email):
    """Generates a cryptographically secure single-use password reset token (expires in 30 minutes)."""
    user = users.find_one({"email": email.strip().lower()})
    if not user:
        return None

    token = secrets.token_urlsafe(36)
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=30)
    password_resets.insert_one({
        "token": token,
        "user_id": user["_id"],
        "email": email.strip().lower(),
        "created_at": datetime.now(timezone.utc),
        "expires_at": expires_at,
        "used": False
    })
    return token

def reset_password_with_token(token, new_password_hash):
    """Validates reset token and updates the user's password."""
    record = password_resets.find_one({"token": token, "used": False})
    if not record:
        return False, "Invalid or expired password reset token."

    expires_at = record.get("expires_at")
    if expires_at and expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at and expires_at < datetime.now(timezone.utc):
        return False, "Password reset token has expired. Please request a new one."

    # Mark token used
    password_resets.update_one({"_id": record["_id"]}, {"$set": {"used": True, "used_at": datetime.now(timezone.utc)}})

    # Invalidate existing active sessions to protect account after password change
    user_id = record["user_id"]
    users.update_one(
        {"_id": user_id},
        {"$set": {"password_hash": new_password_hash, "force_password_reset": False, "password_updated_at": datetime.now(timezone.utc)},
         "$unset": {"active_auth_session_id": ""}}
    )
    sessions_db.update_many({"user_id": user_id, "is_active": True}, {"$set": {"is_active": False}})
    return True, "Password reset successfully. Please log in with your new password."

def player_login_paused(user):
    if user.get("role", "player") not in {"player", "demo_player"}:
        return False
    config = system_config.find_one({"type": "global_config"}, {"security_policies.emergency_lockdown": 1}) or {}
    return config.get("security_policies", {}).get("emergency_lockdown") is True


def generate_backup_recovery_codes(user_id, *, password_hash=None):
    """
    Generates 8 single-use backup recovery codes with 128 bits of randomness each.
    Stores them securely as SHA-256 hashes in MongoDB.
    Returns the plain-text codes once for the user to write down or download.
    """
    plain_codes = []
    hashed_records = []

    for _ in range(8):
        token = secrets.token_hex(16).upper()
        code = "-".join(token[i:i + 8] for i in range(0, len(token), 8))
        plain_codes.append(code)

        # Keep the hash format compatible with previously issued codes.
        hashed = hashlib.sha256(f"secfps:{code}".encode("utf-8")).hexdigest()
        hashed_records.append({"hash": hashed, "used": False, "used_at": None})

    user_oid = ObjectId(user_id) if isinstance(user_id, str) else user_id
    query = {"_id": user_oid}
    if password_hash is not None:
        query["password_hash"] = password_hash
    result = users.update_one(
        query,
        {"$set": {
            "recovery_codes": hashed_records,
            "recovery_codes_generated_at": datetime.now(timezone.utc)
        }}
    )
    return plain_codes if result.matched_count else None

def verify_backup_recovery_code(user_id, code):
    """
    Verifies and consumes a backup recovery code for emergency login.
    """
    clean_code = code.strip().upper()
    hashed = hashlib.sha256(f"secfps:{clean_code}".encode("utf-8")).hexdigest()

    user_oid = ObjectId(user_id) if isinstance(user_id, str) else user_id
    user = users.find_one({"_id": user_oid}) or {}
    codes = user.get("recovery_codes") or []

    for idx, c in enumerate(codes):
        if c.get("hash") == hashed and not c.get("used"):
            # Mark code as consumed
            result = users.update_one(
                {
                    "_id": user_oid,
                    f"recovery_codes.{idx}.hash": hashed,
                    f"recovery_codes.{idx}.used": False,
                },
                {"$set": {
                    f"recovery_codes.{idx}.used": True,
                    f"recovery_codes.{idx}.used_at": datetime.now(timezone.utc)
                }}
            )
            if result.modified_count:
                return True, "Backup recovery code accepted."

    return False, "Invalid or already used recovery code."

def log_admin_action(admin_id, admin_email, target_user_id, action, details=None):
    """Records an administrative action in the dedicated admin audit trail."""
    admin_audit_log.insert_one({
        "admin_id": ObjectId(admin_id) if isinstance(admin_id, str) and ObjectId.is_valid(admin_id) else admin_id,
        "admin_email": admin_email,
        "target_user_id": ObjectId(target_user_id) if isinstance(target_user_id, str) and ObjectId.is_valid(target_user_id) else target_user_id,
        "action": action,
        "details": details or {},
        "timestamp": datetime.now(timezone.utc)
    })
