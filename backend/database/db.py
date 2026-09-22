import os
from datetime import datetime, timedelta, timezone

import bcrypt
from bson import ObjectId
from pymongo import MongoClient

client = MongoClient(os.getenv("MONGO_URI", "mongodb://localhost:27017/"))
db = client[os.getenv("DB_NAME", "fps_security")]

users = db["users"]
matches = db["matches"]
telemetry = db["telemetry"]
detections = db["detections"]
security_events = db["security_events"]
login_history = db["login_history"]
sessions = db["sessions"]

# Backward compatibility for older code paths that still reference game_events.
game_events = telemetry


def utcnow():
    return datetime.now(timezone.utc)


def iso_or_none(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat()
    return value


def log_security_event(user_id, event_type, severity="low", description="", ip_address=None, source="platform", status="recorded", metadata=None):
    payload = {
        "user_id": str(user_id) if user_id else None,
        "event_type": event_type,
        "severity": severity,
        "description": description,
        "timestamp": utcnow(),
        "created_at": utcnow(),
        "ip_address": ip_address,
        "source": source,
        "status": status,
    }
    if metadata:
        payload["metadata"] = metadata
    security_events.insert_one(payload)
    return payload


def create_session_record(user_id, role, ip_address=None, user_agent=None):
    now = utcnow()
    session_doc = {
        "user_id": str(user_id),
        "role": role,
        "ip_address": ip_address or "127.0.0.1",
        "user_agent": user_agent or "unknown",
        "created_at": now,
        "expires_at": now + timedelta(minutes=30),
        "revoked": False,
        "status": "active",
    }
    result = sessions.insert_one(session_doc)
    session_doc["_id"] = result.inserted_id
    return session_doc


def revoke_session_records(user_id, session_id=None):
    query = {"user_id": str(user_id)}
    if session_id:
        try:
            query["_id"] = ObjectId(session_id)
        except (TypeError, ValueError):
            pass
    sessions.update_many(query, {"$set": {"revoked": True, "revoked_at": utcnow(), "status": "revoked"}})


def ensure_admin():
    email = os.getenv("ADMIN_EMAIL", "admin1@gmail.com").strip().lower()
    password = os.getenv("ADMIN_PASSWORD", "Admin@12345")
    mfa_secret = os.getenv("ADMIN_MFA_SECRET", "JBSWY3DPEHPK3PXP")

    users.update_one(
        {"email": email},
        {
            "$set": {
                "name": "Security Admin",
                "role": "admin",
                "status": "active",
                "mfa_enabled": True,
                "mfa_secret": mfa_secret,
                "created_at": utcnow(),
            },
            "$setOnInsert": {
                "email": email,
                "password_hash": bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8"),
            },
        },
        upsert=True,
    )

    users.update_one(
        {"email": email, "password_hash": {"$exists": False}},
        {"$set": {"password_hash": bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")}},
    )


ensure_admin()

users.create_index("email", unique=True)
users.create_index([("role", 1), ("status", 1)])
matches.create_index([("player_id", 1), ("start_time", -1)])
telemetry.create_index([("player_id", 1), ("timestamp", -1)])
detections.create_index([("player_id", 1), ("timestamp", -1)])
security_events.create_index([("user_id", 1), ("timestamp", -1)])
login_history.create_index([("user_id", 1), ("timestamp", -1)])
sessions.create_index([("user_id", 1), ("expires_at", -1)])
sessions.create_index([("revoked", 1), ("expires_at", 1)])
