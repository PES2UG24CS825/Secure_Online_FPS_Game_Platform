import os
import logging
from pathlib import Path
from pymongo import MongoClient
from dotenv import load_dotenv

logger = logging.getLogger("securefps.db")
if not logger.handlers:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

BACKEND_DIR = Path(__file__).resolve().parents[1]
load_dotenv(BACKEND_DIR / ".env")

MONGO_URI = os.getenv(
    "MONGO_URI",
    "mongodb://127.0.0.1:27017/"
)

DB_NAME = os.getenv(
    "MONGO_DB",
    os.getenv("DB_NAME", "secure_fps")
)

client = MongoClient(
    MONGO_URI,
    serverSelectionTimeoutMS=int(os.getenv("MONGO_SERVER_SELECTION_TIMEOUT_MS", "5000")),
)

db = client[DB_NAME]

# Collections
users = db["users"]
matches = db["matches"]
login_history = db["login_history"]
sessions_db = db["sessions"]

# Raw gameplay telemetry coming from Unity
game_telemetry = db["game_telemetry"]

# Processed ML features + detection results
game_events = db["game_events"]

# Individual game sessions
game_sessions = db["game_sessions"]

# Security alerts
security_events = db["security_events"]
# Backwards-compatible name used by older integrations.
detections = security_events
support_tickets = db["support_tickets"]
reward_transactions = db["reward_transactions"]
honour_history = db["honour_history"]
mfa_lockouts = db["mfa_lockouts"]
ban_appeals = db["ban_appeals"]
player_notifications = db["player_notifications"]
admin_audit_log = db["admin_audit_log"]


def init_indexes():
    try:
        game_sessions.create_index([("session_id", 1), ("game_token", 1)])
        game_sessions.create_index("expires_at", expireAfterSeconds=0)
        sessions_db.create_index("expires_at", expireAfterSeconds=0)
        sessions_db.create_index([("user_id", 1), ("is_active", 1)])
        game_telemetry.create_index("created_at", expireAfterSeconds=2592000)
        game_telemetry.create_index([("session_id", 1), ("timestamp", 1)])
        game_events.create_index("created_at", expireAfterSeconds=2592000)
        game_events.create_index([("session_id", 1), ("timestamp", 1)])
        reward_transactions.create_index([("user_id", 1), ("created_at", 1)])
        users.create_index("email", unique=True, sparse=True)
        users.create_index([("role", 1), ("account_status", 1), ("created_at", -1)])
        mfa_lockouts.create_index([("user_id", 1), ("ip", 1)])
        ban_appeals.create_index([("user_id", 1), ("status", 1)])
        ban_appeals.create_index([("created_at", -1)])
        player_notifications.create_index([("user_id", 1), ("is_read", 1), ("created_at", -1)])
        admin_audit_log.create_index([("timestamp", -1)])
        admin_audit_log.create_index([("target_user_id", 1)])
    except Exception as exc:
        logger.debug("MongoDB index creation notice: %s", exc)


init_indexes()


def test_connection():
    try:
        client.admin.command("ping")
        logger.info("MongoDB connected successfully.")
        return True
    except Exception as e:
        logger.error("MongoDB connection failed: %s", e)
        return False
