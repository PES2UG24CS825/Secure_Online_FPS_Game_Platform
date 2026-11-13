#!/usr/bin/env python3
"""
SecureFPS: Demo Reset Utility
Purges demo fixtures and re-seeds clean baseline state.
"""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "backend"))

from backend.database.db import (
    users, game_sessions, matches, security_events, reward_transactions,
    honour_transactions, ban_appeals, mfa_lockouts, sessions_db
)
from scripts.seed_demo import seed_demo_environment


def reset_demo():
    print("====================================================")
    print("SecureFPS: Resetting Demo Environment...")
    print("====================================================")

    # Clean demo accounts and test fixtures
    demo_emails = [
        "admin1@gmail.com",
        "player1@gmail.com",
        "cheater_demo@example.com",
        "demo_player_one@example.test",
        "demo_player_two@example.test"
    ]
    users.delete_many({"email": {"$in": demo_emails}})
    users.delete_many({"account_type": {"$in": ["demo_test", "demo_normal"]}})

    # Clear associated test collections
    ban_appeals.delete_many({"player_email": {"$in": demo_emails}})
    security_events.delete_many({"source": {"$in": ["authoritative_game_server", "demo_seed"]}})
    mfa_lockouts.delete_many({})

    print("[+] Purged existing demo accounts and security events.")

    # Re-seed fresh clean demo data
    seed_demo_environment()


if __name__ == "__main__":
    reset_demo()
