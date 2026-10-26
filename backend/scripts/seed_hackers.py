"""Seed the four opt-in hacker demo accounts in development only."""

import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))
load_dotenv(BACKEND_DIR / ".env")

HACKERS = (
    ("hacker_aimbot@example.test", "Hacker Aimbot", "aimbot"),
    ("hacker_wallhack@example.test", "Hacker Wallhack", "wallhack"),
    ("hacker_speed@example.test", "Hacker Speed", "speedhack"),
    ("hacker_silent@example.test", "Hacker Silent Aim", "silent_aim"),
)


def main():
    if os.getenv("APP_ENV", "").strip().lower() not in {"development", "dev", "local"}:
        print("Hacker account seeding is disabled outside development mode.")
        return 1

    password = os.getenv("HACKER_DEMO_PASSWORD", "")
    mfa_secret = os.getenv("HACKER_DEMO_MFA_SECRET", "").strip()
    if not password or not mfa_secret:
        print("Set HACKER_DEMO_PASSWORD and HACKER_DEMO_MFA_SECRET before seeding.")
        return 1

    import pyotp
    from pymongo.errors import DuplicateKeyError

    from database.db import users
    from services.auth import hash_password, validate_password

    if not validate_password(password):
        print("HACKER_DEMO_PASSWORD must meet the existing account password policy.")
        return 1
    try:
        pyotp.TOTP(mfa_secret)
    except (TypeError, ValueError):
        print("HACKER_DEMO_MFA_SECRET must be a valid TOTP secret.")
        return 1

    now = datetime.now(timezone.utc)
    password_hash = hash_password(password)
    for email, name, profile in HACKERS:
        account = {
            "name": name,
            "username": email.split("@", 1)[0],
            "email": email,
            "password_hash": password_hash,
            "mfa_secret": mfa_secret,
            "mfa_enabled": True,
            "role": "player",
            "demo": True,
            "account_type": "demo_test",
            "hacker_profile": profile,
        }
        try:
            result = users.update_one(
                {"email": email},
                {
                    "$set": account,
                    "$setOnInsert": {"created_at": now},
                },
                upsert=True,
            )
        except DuplicateKeyError:
            print(f"Refusing to overwrite a conflicting account for {email}.")
            return 1
        print(f"{'Created' if result.upserted_id else 'Updated'} {email} ({profile}).")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
