"""Seed the opt-in demo_cheater player account in development only."""

import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))
load_dotenv(BACKEND_DIR / ".env")


def main():
    app_env = os.getenv("APP_ENV", "").strip().lower()
    if app_env not in {"development", "dev", "local"}:
        print("Demo account seeding is disabled. Set APP_ENV=development for local testing.")
        return 1
    if os.getenv("SECUREFPS_ENABLE_DEMO") != "1":
        print("Demo account seeding is disabled. Set SECUREFPS_ENABLE_DEMO=1 to opt in.")
        return 1

    password = os.getenv("DEMO_CHEATER_PASSWORD")
    if not password:
        print("Set DEMO_CHEATER_PASSWORD to a private password, then rerun this command.")
        return 1

    from pymongo.errors import DuplicateKeyError
    import pyotp

    from database.db import users
    from services.auth import hash_password, validate_password

    if not validate_password(password):
        print("DEMO_CHEATER_PASSWORD must meet the existing account password policy.")
        return 1

    email = "demo_cheater@example.test"
    username = "demo_cheater"
    existing = users.find_one({"$or": [{"email": email}, {"username": username}]})
    if existing:
        is_demo_account = (
            existing.get("demo") is True
            and existing.get("account_type") == "demo_test"
            and existing.get("username") == username
            and existing.get("email") == email
            and existing.get("role") == "player"
        )
        if is_demo_account:
            print("The demo_cheater account already exists; its credentials were not changed.")
            return 0
        print("Refusing to modify an existing non-demo account with the requested username or email.")
        return 1

    mfa_secret = pyotp.random_base32()
    account = {
        "username": username,
        "name": "Demo Cheater",
        "email": email,
        "password_hash": hash_password(password),
        "mfa_secret": mfa_secret,
        "mfa_enabled": True,
        "role": "player",
        "account_type": "demo_test",
        "demo": True,
        "demo_label": "DEMO CHEATER TEST ACCOUNT",
        "created_at": datetime.now(timezone.utc)
    }

    try:
        users.insert_one(account)
    except DuplicateKeyError:
        print("A conflicting account was created concurrently. No existing account was modified.")
        return 1

    print("Created the development-only demo_cheater player account.")
    print("Configure an authenticator app with this one-time MFA setup secret:")
    print(mfa_secret)
    print("The account password was stored only as a bcrypt hash.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
