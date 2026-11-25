"""
Safe, Bounded Database Maintenance & Dry-Run Cleanup Utility
Project: Secure Online FPS Game Platform

Performs read-only inspection (default) or safe, bounded maintenance with
timestamped JSON backups before deleting verified disposable records:
- Automated test accounts (@example.com, @test.com, test_*@securefps.local)
- Expired/inactive HTTP user sessions (is_active == False or expires_at < now)
- Expired/used email_verifications & expired mfa_lockouts
- Orphaned reward_transactions, player_notifications, login_history, honour_history

STRICT PRESERVATION RULES:
- Never deletes genuine player accounts
- Never deletes normal_admin or super_admin accounts
- Never deletes designated demo accounts (cheater_demo@example.test)
- Never deletes completed match records (game_sessions / matches)
- Never deletes genuine security alerts, ban appeals, or admin audit logs
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from bson import ObjectId
from dotenv import load_dotenv
from pymongo import MongoClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
PROJECT_ROOT = BACKEND_DIR.parent
load_dotenv(BACKEND_DIR / ".env")

PROTECTED_EMAILS = {
    "cheater_demo@example.test",
    "admin1@gmail.com",
    "superadmin@securefps.io",
}
TEST_EXACT_EMAILS = {
    "test_normal_player@securefps.local",
    "test_admin_reviewer@securefps.local",
}


def _json_default(obj):
    if isinstance(obj, (datetime, ObjectId)):
        return str(obj)
    return str(obj)


def _is_verified_test_user(doc):
    email = (doc.get("email") or "").strip().lower()
    if not email or email in PROTECTED_EMAILS or doc.get("demo") is True:
        return False
    if doc.get("role") in ("super_admin", "normal_admin"):
        return False
    return email.endswith(("@example.com", "@test.com")) or email in TEST_EXACT_EMAILS


def run_maintenance(execute=False):
    mongo_uri = os.getenv("MONGO_URI", "mongodb://127.0.0.1:27017/")
    db_name = os.getenv("MONGO_DB", os.getenv("DB_NAME", "secure_fps"))
    now_utc = datetime.now(timezone.utc)

    print("=" * 64)
    print(" SecureFPS Safe Database Integrity & Maintenance Utility")
    print(f" Target Database: {db_name} | Mode: {'EXECUTE' if execute else 'DRY RUN'}")
    print(f" Timestamp: {now_utc.isoformat()}")
    print("=" * 64)

    client = MongoClient(mongo_uri, serverSelectionTimeoutMS=5000)
    db = client[db_name]
    db.command("ping")

    before_counts = {name: db[name].count_documents({}) for name in sorted(db.list_collection_names())}

    # 1. Identify verified automated test users & preserved users
    test_user_ids = []
    preserved_user_ids = set()
    for u in db.users.find({}, {"email": 1, "role": 1, "demo": 1}):
        if _is_verified_test_user(u):
            test_user_ids.append(u["_id"])
        else:
            preserved_user_ids.add(u["_id"])

    test_uid_set = set(test_user_ids)

    # 2. Identify exact IDs for verified disposable records
    stale_session_ids = [
        d["_id"] for d in db.sessions.find(
            {"$or": [{"is_active": False}, {"expires_at": {"$lt": now_utc}}, {"user_id": {"$in": test_user_ids}}]},
            {"_id": 1},
        )
    ]
    stale_verif_ids = [
        d["_id"] for d in db.email_verifications.find(
            {"$or": [{"used": True}, {"expires_at": {"$lt": now_utc}}]},
            {"_id": 1},
        )
    ]
    stale_lockout_ids = [
        d["_id"] for d in db.mfa_lockouts.find({"locked_until": {"$lt": now_utc}}, {"_id": 1})
    ]
    orphan_reward_ids = [
        d["_id"] for d in db.reward_transactions.find({}, {"_id": 1, "user_id": 1})
        if d.get("user_id") is not None and d["user_id"] not in preserved_user_ids
    ]
    orphan_notif_ids = [
        d["_id"] for d in db.player_notifications.find({}, {"_id": 1, "user_id": 1})
        if d.get("user_id") is not None and d["user_id"] not in preserved_user_ids
    ]
    test_login_ids = [
        d["_id"] for d in db.login_history.find({}, {"_id": 1, "user_id": 1})
        if d.get("user_id") is not None and d["user_id"] in test_uid_set
    ]
    test_honour_ids = [
        d["_id"] for d in db.honour_history.find({}, {"_id": 1, "user_id": 1})
        if d.get("user_id") is not None and d["user_id"] in test_uid_set
    ]

    plan = {
        "users": test_user_ids,
        "sessions": stale_session_ids,
        "email_verifications": stale_verif_ids,
        "mfa_lockouts": stale_lockout_ids,
        "reward_transactions": orphan_reward_ids,
        "player_notifications": orphan_notif_ids,
        "login_history": test_login_ids,
        "honour_history": test_honour_ids,
    }

    print("\n--- Dry-Run Deletion Plan (Exact Verified IDs) ---")
    for col_name, ids in plan.items():
        print(f"  {col_name}: {len(ids)} / {before_counts.get(col_name, 0)}")

    deleted_counts = {}
    backup_dir = None

    if execute:
        stamp = now_utc.strftime("%Y%m%d_%H%M%S")
        backup_dir = PROJECT_ROOT / "reports" / "db-backups" / stamp
        backup_dir.mkdir(parents=True, exist_ok=True)

        for col_name, ids in plan.items():
            if not ids:
                deleted_counts[col_name] = 0
                continue
            docs = list(db[col_name].find({"_id": {"$in": ids}}))
            with open(backup_dir / f"{col_name}.json", "w", encoding="utf-8") as fh:
                json.dump(docs, fh, default=_json_default, indent=2)
            res = db[col_name].delete_many({"_id": {"$in": ids}})
            deleted_counts[col_name] = res.deleted_count

        after_counts = {name: db[name].count_documents({}) for name in sorted(db.list_collection_names())}
        report = {
            "timestamp": now_utc.isoformat(),
            "database": db_name,
            "backup_dir": str(backup_dir),
            "before_counts": before_counts,
            "deleted_counts": deleted_counts,
            "after_counts": after_counts,
        }
        with open(backup_dir / "cleanup_report.json", "w", encoding="utf-8") as fh:
            json.dump(report, fh, indent=2)

        print(f"\nBackup saved to: {backup_dir}")
        print("Deleted counts:", deleted_counts)
        print("\n--- After-Cleanup Counts ---")
        for col_name, count in after_counts.items():
            print(f"  {col_name}: {count}")

    return 0


if __name__ == "__main__":
    sys.exit(run_maintenance(execute="--execute" in sys.argv))
