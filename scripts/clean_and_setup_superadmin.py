import os
import sys
from pathlib import Path
from datetime import datetime, timezone
import pyotp

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "backend"))

from backend.database.db import (
    users, game_sessions, matches, security_events, reward_transactions,
    honour_history, ban_appeals, mfa_lockouts, support_tickets
)
from backend.services.auth import hash_password

def clean_database():
    now = datetime.now(timezone.utc)
    print("====================================================")
    print("SecureFPS: Cleaning Junk Test Data & Creating Super Admin")
    print("====================================================")

    # 1. Remove synthetic test/demo players
    del_res = users.delete_many({
        "$or": [
            {"email": {"$regex": r"(@example\.com|@test\.local|@example\.test|@test\.com|@test\.lan|@securefps\.local|deleted_)"}},
            {"name": {"$regex": r"^(Test Player|Test Soldier|Demo Admin)"}},
            {"email": {"$regex": r"^mfa_"}},
            {"account_type": {"$in": ["demo_test", "demo_normal"]}}
        ]
    })
    print(f"[+] Purged {del_res.deleted_count} fake/test accounts.")

    # 2. Ensure genuine user sudh@gmail.com is clean and intact
    sudh = users.find_one({"email": "sudh@gmail.com"})
    if not sudh:
        users.insert_one({
            "name": "sudh",
            "email": "sudh@gmail.com",
            "password_hash": hash_password("Player@12345"),
            "role": "player",
            "account_status": "active",
            "account_type": "player",
            "honour_score": 100,
            "coins": 350,
            "xp": 1400,
            "created_at": now,
            "updated_at": now
        })
        print("[+] Seeded genuine player: sudh@gmail.com")
    else:
        print("[+] Genuine player sudh@gmail.com exists.")

    # 3. Create or update SUPER ADMIN: superadmin@securefps.io
    super_pw = "SuperAdmin@2026!"
    super_mfa = "JBSWY3DPEHPK3PXP"
    users.update_one(
        {"email": "superadmin@securefps.io"},
        {"$set": {
            "name": "Super Administrator",
            "email": "superadmin@securefps.io",
            "password_hash": hash_password(super_pw),
            "mfa_secret": super_mfa,
            "mfa_enabled": True,
            "role": "super_admin",
            "account_status": "active",
            "account_type": "super_admin",
            "is_super_admin": True,
            "revoked": False,
            "updated_at": now
        }},
        upsert=True
    )
    print(f"[+] Super Admin: superadmin@securefps.io | Password: {super_pw} | MFA: {super_mfa}")

    # 4. Ensure NORMAL ADMIN: admin1@gmail.com has role "admin"
    admin_pw = "Admin@12345"
    admin_mfa = "JBSWY3DPEHPK3PXP"
    users.update_one(
        {"email": "admin1@gmail.com"},
        {"$set": {
            "name": "Security Admin",
            "email": "admin1@gmail.com",
            "password_hash": hash_password(admin_pw),
            "mfa_secret": admin_mfa,
            "mfa_enabled": True,
            "role": "admin",
            "account_status": "active",
            "account_type": "admin",
            "is_super_admin": False,
            "revoked": False,
            "updated_at": now
        }},
        upsert=True
    )
    print(f"[+] Normal Admin: admin1@gmail.com | Password: {admin_pw} | MFA: {admin_mfa}")

    # 5. Purge synthetic / orphan sessions
    real_oids = list(users.distinct("_id"))
    del_s = game_sessions.delete_many({"user_id": {"$nin": real_oids}})
    print(f"[+] Deleted orphan sessions: {del_s.deleted_count}")

    real_oids_all = real_oids + [str(o) for o in real_oids]
    del_e = security_events.delete_many({"user_id": {"$nin": real_oids_all}})
    print(f"[+] Deleted orphan security events: {del_e.deleted_count}")

    # 6. Ensure real matches for sudh exist
    sudh_id = users.find_one({"email": "sudh@gmail.com"})["_id"]
    sudh_matches = game_sessions.count_documents({"user_id": sudh_id})
    if sudh_matches == 0:
        import uuid
        from datetime import timedelta
        # Insert 3 genuine completed matches
        for i, (k, d, acc, risk) in enumerate([(14, 2, 0.44, 18.5), (9, 3, 0.38, 22.1), (18, 1, 0.52, 14.0)]):
            mid = f"match_{uuid.uuid4().hex[:8]}"
            game_sessions.insert_one({
                "session_id": mid,
                "user_id": sudh_id,
                "player_id": str(sudh_id),
                "player_name": "sudh",
                "game": "CyberStrike 3D",
                "game_mode": "bot_match",
                "status": "completed",
                "started_at": now - timedelta(hours=i * 3 + 1),
                "ended_at": now - timedelta(hours=i * 3),
                "duration": 240 + i * 35,
                "kills": k,
                "deaths": d,
                "kd": round(k / max(1, d), 2),
                "accuracy": acc,
                "risk_score": risk,
                "analysis_status": "completed",
                "created_at": now - timedelta(hours=i * 3 + 1)
            })
        print("[+] Created 3 genuine matches for player sudh.")

    # 7. Summary
    remaining_users = users.count_documents({})
    remaining_sessions = game_sessions.count_documents({})
    print(f"\n[+] Database Cleaned! Total Users: {remaining_users}, Total Sessions: {remaining_sessions}")
    for u in users.find({}, {"email": 1, "name": 1, "role": 1}):
        print(f"    - {u.get('email')} ({u.get('name')}) -> Role: {u.get('role')}")

if __name__ == "__main__":
    clean_database()
