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

    # 3. Model Versions Catalog
    if model_versions.count_documents({}) == 0:
        model_versions.insert_many([
            {
                "version": "v2.0-rf",
                "name": "SecureFPS Random Forest Anti-Cheat v2.0",
                "algorithm": "Random Forest (scikit-learn)",
                "accuracy": 0.984,
                "precision": 0.979,
                "recall": 0.981,
                "f1_score": 0.980,
                "false_positive_rate": 0.008,
                "false_negative_rate": 0.011,
                "features_count": 8,
                "is_active": True,
                "deployed_at": "2026-11-01T00:00:00Z",
                "approved_by": "superadmin@securefps.io",
                "changelog": "Model bundle v2.0 with temporal sequence windowing, jitter variance ratio, and angle anomaly metrics."
            },
            {
                "version": "v1.5-rf",
                "name": "SecureFPS Random Forest Anti-Cheat v1.5 (Baseline)",
                "algorithm": "Random Forest",
                "accuracy": 0.962,
                "precision": 0.954,
                "recall": 0.958,
                "f1_score": 0.956,
                "false_positive_rate": 0.019,
                "false_negative_rate": 0.024,
                "features_count": 6,
                "is_active": False,
                "deployed_at": "2026-10-15T00:00:00Z",
                "approved_by": "superadmin@securefps.io",
                "changelog": "Initial production anti-cheat classifier trained on baseline human vs bot telemetry."
            }
        ])

    # 4. System Backup Records
    if system_backups.count_documents({}) == 0:
        system_backups.insert_many([
            {
                "backup_id": "bak_20261113_000001",
                "type": "daily_automated",
                "status": "verified",
                "scope": "full_cluster",
                "database_name": "secure_fps",
                "size_mb": 42.8,
                "collections_count": 18,
                "documents_count": 4820,
                "checksum": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                "created_at": now,
                "retention_days": 30,
                "created_by": "System Scheduled Job"
            },
            {
                "backup_id": "bak_20261112_000001",
                "type": "daily_automated",
                "status": "verified",
                "scope": "full_cluster",
                "database_name": "secure_fps",
                "size_mb": 41.5,
                "collections_count": 18,
                "documents_count": 4610,
                "checksum": "sha256:ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
                "created_at": now,
                "retention_days": 30,
                "created_by": "System Scheduled Job"
            }
        ])


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
