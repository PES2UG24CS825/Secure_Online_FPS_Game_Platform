import os
from datetime import datetime, timedelta, timezone

import bcrypt
from bson import ObjectId
from pymongo import MongoClient


# ============================================================
# DATABASE CONNECTION
# ============================================================

client = MongoClient(
    os.getenv(
        "MONGO_URI",
        "mongodb://localhost:27017/",
    )
)

db = client[
    os.getenv(
        "DB_NAME",
        "fps_security",
    )
]


# ============================================================
# COLLECTIONS
# ============================================================

users = db["users"]
matches = db["matches"]
telemetry = db["telemetry"]
detections = db["detections"]
security_events = db["security_events"]

# Session / authentication collections
sessions = db["sessions"]
sessions_db = sessions

login_history = db["login_history"]

# Backward compatibility
game_events = telemetry


# ============================================================
# TIME HELPERS
# ============================================================

def utcnow():
    """
    Return the current UTC time as a timezone-aware datetime.
    """
    return datetime.now(timezone.utc)


def iso_or_none(value):
    """
    Convert datetime values to ISO-8601 UTC strings.
    """
    if value is None:
        return None

    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat()

    return value


# ============================================================
# SECURITY EVENT LOGGING
# ============================================================

def log_security_event(
    user_id,
    event_type,
    severity="low",
    description="",
    ip_address=None,
    source="platform",
    status="recorded",
    metadata=None,
):
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


# ============================================================
# SESSION MANAGEMENT
# ============================================================

def create_session_record(
    user_id,
    role,
    ip_address=None,
    user_agent=None,
):
    """
    Create one database-backed login session.

    The returned document contains the MongoDB session ID.
    The caller should store that ID inside the Flask session.
    """

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


def get_active_session(
    user_id,
    session_id=None,
):
    """
    Find the active database session for the current user.

    If session_id is supplied, only that exact session is checked.
    """

    query = {
        "user_id": str(user_id),
        "revoked": False,
        "expires_at": {
            "$gt": utcnow(),
        },
    }

    if session_id:
        try:
            query["_id"] = ObjectId(session_id)
        except (TypeError, ValueError):
            return None

    return sessions.find_one(query)


def revoke_session_records(
    user_id,
    session_id=None,
    keep_current=False,
):
    """
    Revoke database sessions.

    Normal logout:
        revoke_session_records(user_id, session_id)

    Logout other sessions:
        revoke_session_records(
            user_id,
            session_id=current_session_id,
            keep_current=True,
        )

    When keep_current=True, the supplied session remains active.
    """

    user_id = str(user_id)

    # --------------------------------------------------------
    # Logout ONLY the supplied/current session
    # --------------------------------------------------------

    if session_id and not keep_current:
        try:
            session_object_id = ObjectId(session_id)
        except (TypeError, ValueError):
            return 0

        result = sessions.update_one(
            {
                "_id": session_object_id,
                "user_id": user_id,
            },
            {
                "$set": {
                    "revoked": True,
                    "revoked_at": utcnow(),
                    "status": "revoked",
                }
            },
        )

        return result.modified_count

    # --------------------------------------------------------
    # Logout every session EXCEPT current session
    # --------------------------------------------------------

    if session_id and keep_current:
        try:
            current_session_object_id = ObjectId(session_id)
        except (TypeError, ValueError):
            return 0

        result = sessions.update_many(
            {
                "user_id": user_id,
                "_id": {
                    "$ne": current_session_object_id,
                },
                "revoked": False,
            },
            {
                "$set": {
                    "revoked": True,
                    "revoked_at": utcnow(),
                    "status": "revoked",
                }
            },
        )

        return result.modified_count

    # --------------------------------------------------------
    # Backward-compatible behavior:
    # revoke ALL sessions for this user
    # --------------------------------------------------------

    result = sessions.update_many(
        {
            "user_id": user_id,
            "revoked": False,
        },
        {
            "$set": {
                "revoked": True,
                "revoked_at": utcnow(),
                "status": "revoked",
            }
        },
    )

    return result.modified_count


# ============================================================
# ADMIN ACCOUNT
# ============================================================

def ensure_admin():
    email = os.getenv(
        "ADMIN_EMAIL",
        "admin1@gmail.com",
    ).strip().lower()

    password = os.getenv(
        "ADMIN_PASSWORD",
        "Admin@12345",
    )

    mfa_secret = os.getenv(
        "ADMIN_MFA_SECRET",
        "JBSWY3DPEHPK3PXP",
    )

    users.update_one(
        {
            "email": email,
        },
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
                "password_hash": bcrypt.hashpw(
                    password.encode("utf-8"),
                    bcrypt.gensalt(),
                ).decode("utf-8"),
            },
        },
        upsert=True,
    )

    users.update_one(
        {
            "email": email,
            "password_hash": {
                "$exists": False,
            },
        },
        {
            "$set": {
                "password_hash": bcrypt.hashpw(
                    password.encode("utf-8"),
                    bcrypt.gensalt(),
                ).decode("utf-8")
            }
        },
    )


ensure_admin()


# ============================================================
# INDEXES
# ============================================================

# Users
users.create_index(
    "email",
    unique=True,
)

users.create_index(
    [
        ("role", 1),
        ("status", 1),
    ]
)


# Matches
matches.create_index(
    [
        ("user_id", 1),
        ("created_at", -1),
    ]
)

matches.create_index(
    [
        ("user_id", 1),
    ]
)

matches.create_index(
    [
        ("player_id", 1),
        ("start_time", -1),
    ]
)


# Telemetry
game_events.create_index(
    [
        ("user_id", 1),
        ("created_at", -1),
    ]
)

telemetry.create_index(
    [
        ("player_id", 1),
        ("timestamp", -1),
    ]
)


# Detections
detections.create_index(
    [
        ("player_id", 1),
        ("timestamp", -1),
    ]
)


# Security events
security_events.create_index(
    [
        ("user_id", 1),
        ("created_at", -1),
    ]
)

security_events.create_index(
    [
        ("user_id", 1),
        ("timestamp", -1),
    ]
)


# Sessions
sessions_db.create_index(
    [
        ("user_id", 1),
    ]
)

sessions.create_index(
    [
        ("user_id", 1),
        ("expires_at", -1),
    ]
)

sessions.create_index(
    [
        ("revoked", 1),
        ("expires_at", 1),
    ]
)


# Login history
login_history.create_index(
    [
        ("user_id", 1),
        ("created_at", -1),
    ]
)

login_history.create_index(
    [
        ("user_id", 1),
        ("timestamp", -1),
    ]
)