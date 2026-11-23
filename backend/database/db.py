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

# Super Admin Command Center Collections
system_config = db["system_config"]
admin_permissions = db["admin_permissions"]
model_versions = db["model_versions"]
system_backups = db["system_backups"]
admin_approvals = db["admin_approvals"]


def seed_two_tier_system():
    """Seed initial records for Super Admin Command Center if not present."""
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)

    # 1. Platform & Risk Engine Configuration
    if not system_config.find_one({"type": "global_config"}):
        system_config.insert_one({
            "type": "global_config",
            "version": 1,
            "risk_engine": {
                "low_threshold": 35,
                "medium_threshold": 65,
                "high_threshold": 85,
                "critical_threshold": 95,
                "weights": {
                    "aim_weight": 0.35,
                    "reaction_weight": 0.25,
                    "movement_weight": 0.20,
                    "input_weight": 0.10,
                    "account_weight": 0.10
                },
                "auto_flag_enabled": True,
                "auto_flag_threshold": 75,
                "auto_quarantine_enabled": False,
                "auto_quarantine_threshold": 90
            },
            "security_policies": {
                "session_timeout_minutes": 60,
                "max_login_attempts": 5,
                "lockout_duration_minutes": 15,
                "require_admin_mfa": True,
                "emergency_lockdown": False,
                "lockdown_reason": "",
                "lockdown_initiated_by": "",
                "lockdown_at": None,
                "maintenance_mode": False,
                "maintenance_message": "SecureFPS Platform is undergoing routine maintenance."
            },
            "notification_settings": {
                "email_alerts_enabled": True,
                "security_alert_email": "security@securefps.io",
                "notify_on_high_risk": True,
                "notify_on_admin_login": True
            },
            "created_at": now,
            "updated_at": now
        })

    # 2. Centralized Roles & Permissions Matrix
    if not admin_permissions.find_one({"role": "NORMAL_ADMIN"}):
        admin_permissions.insert_one({
            "role": "NORMAL_ADMIN",
            "level": 1,
            "display_name": "Normal Administrator (Level 1)",
            "description": "Operational administrator with player investigation, moderation, appeals, and support privileges.",
            "modules": [
                "overview", "players", "security", "appeals", "threats", "support", "analytics", "health"
            ],
            "permissions": {
                "players:read": True,
                "players:warn": True,
                "players:suspend": True,
                "players:ban": True,
                "players:notes": True,
                "appeals:review": True,
                "support:reply": True,
                "threats:read": True,
                "analytics:read": True,
                "audit:read": True,
                "health:read": True,
                "players:delete": False,
                "players:purge": False,
                "database:export": False,
                "admins:manage": False,
                "roles:manage": False,
                "ml:tune": False,
                "ml:rollback": False,
                "risk_engine:manage": False,
                "system:lockdown": False,
                "backups:manage": False,
                "config:manage": False
            },
            "updated_at": now
        })

    if not admin_permissions.find_one({"role": "SUPER_ADMIN"}):
        admin_permissions.insert_one({
            "role": "SUPER_ADMIN",
            "level": 2,
            "display_name": "Super Administrator (Level 2 - Executive Root)",
            "description": "Platform-wide executive authority with full system controls, administrator management, ML tuning, and disaster recovery.",
            "modules": [
                "overview", "players", "security", "appeals", "threats", "support", "analytics", "health",
                "super_admins", "super_roles", "super_ml", "super_risk", "super_command", "super_control", "super_backups", "super_config"
            ],
            "permissions": {
                "players:read": True,
                "players:warn": True,
                "players:suspend": True,
                "players:ban": True,
                "players:notes": True,
                "players:delete": True,
                "players:purge": True,
                "appeals:review": True,
                "support:reply": True,
                "threats:read": True,
                "analytics:read": True,
                "audit:read": True,
                "health:read": True,
                "database:export": True,
                "admins:manage": True,
                "roles:manage": True,
                "ml:tune": True,
                "ml:rollback": True,
                "risk_engine:manage": True,
                "system:lockdown": True,
                "backups:manage": True,
                "config:manage": True
            },
            "updated_at": now
        })

    # Seed no model-performance claims. The runtime reports actual evaluation
    # artifacts only; legacy catalog rows retain metadata without fabricated metrics.
    if model_versions.count_documents({}) == 0:
        model_versions.insert_many([
            {
                "version": "v2.0-rf",
                "name": "SecureFPS Random Forest Anti-Cheat v2.0",
                "algorithm": "Random Forest / Isolation Forest bundle",
                "features_count": len(FEATURE_NAMES_V2) if "FEATURE_NAMES_V2" in globals() else 21,
                "is_active": True,
                "deployed_at": "2026-11-12T18:04:20Z",
                "metrics_status": "Unavailable: no verified evaluation report is loaded",
                "changelog": "Runtime model-v2 artifact metadata.",
            },
            {
                "version": "v1.5-rf",
                "name": "SecureFPS Legacy Anti-Cheat v1.5",
                "algorithm": "Random Forest + Isolation Forest",
                "features_count": 5,
                "is_active": False,
                "deployed_at": None,
                "metrics_status": "Unavailable: no verified evaluation report is loaded",
                "changelog": "Legacy runtime fallback.",
            },
        ])
    model_versions.update_many(
        {"version": {"$in": ["v2.0-rf", "v1.5-rf"]}},
        {"$unset": {
            "accuracy": "",
            "precision": "",
            "recall": "",
            "f1_score": "",
            "false_positive_rate": "",
            "false_negative_rate": "",
        }},
    )

def init_indexes():
    index_specs = (
        (game_sessions, [("session_id", 1), ("game_token", 1)], {}),
        (game_sessions, "expires_at", {"expireAfterSeconds": 0}),
        (sessions_db, "expires_at", {"expireAfterSeconds": 0}),
        (sessions_db, [("user_id", 1), ("is_active", 1)], {}),
        (game_telemetry, "created_at", {"expireAfterSeconds": 2592000}),
        (game_telemetry, [("session_id", 1), ("timestamp", 1)], {}),
        (game_events, "created_at", {"expireAfterSeconds": 2592000}),
        (game_events, [("session_id", 1), ("timestamp", 1)], {}),
        (reward_transactions, [("user_id", 1), ("created_at", 1)], {}),
        (users, "email", {"unique": True, "sparse": True}),
        (users, [("role", 1), ("account_status", 1), ("created_at", -1)], {}),
        (mfa_lockouts, [("user_id", 1), ("ip", 1)], {}),
        (ban_appeals, [("user_id", 1), ("status", 1)], {}),
        (ban_appeals, [("created_at", -1)], {}),
        (player_notifications, [("user_id", 1), ("is_read", 1), ("created_at", -1)], {}),
        (admin_audit_log, [("timestamp", -1)], {}),
        (admin_audit_log, [("target_user_id", 1)], {}),
    )
    for collection, keys, options in index_specs:
        try:
            collection.create_index(keys, **options)
        except Exception as exc:
            logger.warning(
                "MongoDB index creation failed for %s.%s: %s",
                collection.name,
                keys,
                exc,
            )


init_indexes()
try:
    seed_two_tier_system()
except Exception as _seed_err:
    logger.debug("Seed notice: %s", _seed_err)


def test_connection():
    try:
        client.admin.command("ping")
        logger.info("MongoDB connected successfully.")
        return True
    except Exception as e:
        logger.error("MongoDB connection failed: %s", e)
        return False
