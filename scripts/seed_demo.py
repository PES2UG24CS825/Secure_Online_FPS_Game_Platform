#!/usr/bin/env python3
"""
SecureFPS: Demo Environment Seeder
Seeds:
1. Demo Administrator (admin1@gmail.com / Admin@12345)
2. Verified Clean Player (player1@gmail.com / Player@12345)
3. Flagged Suspicious Cheater (cheater_demo@example.com / Cheater@12345)
4. Realistic Completed Match History & Security Alerts
"""

import os
import sys
import uuid
from pathlib import Path
from datetime import datetime, timezone, timedelta
import pyotp

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "backend"))

from backend.database.db import (
    users, game_sessions, matches, security_events, reward_transactions,
    honour_transactions, ban_appeals, mfa_lockouts
)
from backend.services.auth import hash_password


def seed_demo_environment():
    now = datetime.now(timezone.utc)
    print("====================================================")
    print("SecureFPS: Seeding Local Demo Environment...")
    print("====================================================")

    # 1. Admin Account
    admin_email = "admin1@gmail.com"
    admin_pw = os.getenv("ADMIN_PASSWORD", "Admin@12345")
    admin_mfa = os.getenv("ADMIN_MFA_SECRET", "JBSWY3DPEHPK3PXP")
    users.update_one(
        {"email": admin_email},
        {"$set": {
            "name": "Lead Security Admin",
            "email": admin_email,
            "password_hash": hash_password(admin_pw),
            "mfa_secret": admin_mfa,
            "mfa_enabled": True,
            "role": "admin",
            "account_status": "active",
            "account_type": "admin",
            "revoked": False,
            "updated_at": now
        }},
        upsert=True
    )
    print(f"[+] Admin Account:   {admin_email} | Password: {admin_pw} | MFA: {admin_mfa}")

    # 2. Normal Player Account
    player_email = "player1@gmail.com"
    player_pw = "Player@12345"
    player_mfa = "JBSWY3DPEHPK3PXP"
    player_res = users.update_one(
        {"email": player_email},
        {"$set": {
            "name": "Operator Sarah",
            "email": player_email,
            "password_hash": hash_password(player_pw),
            "mfa_secret": player_mfa,
            "mfa_enabled": True,
            "role": "player",
            "account_status": "active",
            "account_type": "player",
            "honour_score": 100,
            "coins": 450,
            "xp": 1850,
            "revoked": False,
            "updated_at": now
        }},
        upsert=True
    )
    player_id = users.find_one({"email": player_email})["_id"]
    print(f"[+] Clean Player:    {player_email} | Password: {player_pw} | MFA: {player_mfa}")

    # 3. Flagged Cheater Account (Suspended Pending Admin Review)
    cheater_email = "cheater_demo@example.com"
    cheater_pw = "Cheater@12345"
    cheater_mfa = "JBSWY3DPEHPK3PXP"
    cheater_res = users.update_one(
        {"email": cheater_email},
        {"$set": {
            "name": "Hacker_SpeedSnap",
            "email": cheater_email,
            "password_hash": hash_password(cheater_pw),
            "mfa_secret": cheater_mfa,
            "mfa_enabled": True,
            "role": "player",
            "account_status": "suspended",
            "account_type": "demo_test",
            "hacker_profile": "rage_aimbot",
            "risk_score": 94.8,
            "suspended_by": "system_auto",
            "suspension_reason": ["Real-time anti-cheat trigger: Inhuman aim velocity and 96% headshot accuracy"],
            "appeal_note": "Suspended by automated anti-cheat pending review. You may submit an appeal via the player dashboard.",
            "pending_admin_review": True,
            "revoked": True,
            "updated_at": now
        }},
        upsert=True
    )
    cheater_id = users.find_one({"email": cheater_email})["_id"]
    print(f"[+] Flagged Cheater: {cheater_email} | Password: {cheater_pw} (Status: Suspended)")

    # 4. Seed Ban Appeal for Cheater
    ban_appeals.update_one(
        {"user_id": cheater_id},
        {"$set": {
            "user_id": cheater_id,
            "player_name": "Hacker_SpeedSnap",
            "player_email": cheater_email,
            "ban_reason": "Inhuman aim velocity and 96% headshot accuracy",
            "appeal_text": "I was just having a lucky game with high DPI mouse settings. I never used third-party memory injection software!",
            "status": "pending",
            "created_at": now - timedelta(minutes=45)
        }},
        upsert=True
    )

    # 5. Seed Realistic Matches
    for i in range(5):
        s_id = str(uuid.uuid4())
        game_sessions.update_one(
            {"session_id": s_id},
            {"$set": {
                "session_id": s_id,
                "user_id": player_id,
                "game": "CyberStrike_3D",
                "game_mode": "bot_match",
                "status": "completed",
                "started_at": now - timedelta(hours=i * 2, minutes=15),
                "ended_at": now - timedelta(hours=i * 2, minutes=5),
                "risk_score": round(15.2 + i * 2.1, 1),
                "kills": 12 + i,
                "deaths": 4 + i,
                "accuracy": round(0.42 + i * 0.02, 2)
            }},
            upsert=True
        )

    # 6. Seed Flagged Security Event
    flagged_session_id = str(uuid.uuid4())
    security_events.update_one(
        {"session_id": flagged_session_id},
        {"$set": {
            "session_id": flagged_session_id,
            "user_id": str(cheater_id),
            "player_name": "Hacker_SpeedSnap",
            "game": "CyberStrike_3D",
            "risk_score": 94.8,
            "risk_category": "Critical",
            "review_status": "pending_review",
            "detected_in": "1.52s",
            "detection_latency_ms": 25.4,
            "features": {
                "accuracy": 0.96,
                "headshot_ratio": 0.91,
                "reaction_time_median": 0.065,
                "aim_speed_max": 920.0,
                "flick_rate": 9.5
            },
            "created_at": now - timedelta(minutes=50)
        }},
        upsert=True
    )

    print("\n[+] Demo environment successfully seeded.")
    print("====================================================")


if __name__ == "__main__":
    seed_demo_environment()
