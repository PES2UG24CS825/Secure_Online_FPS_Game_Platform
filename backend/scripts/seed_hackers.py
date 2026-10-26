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


def seed_hacker_accounts(users, password, mfa_secret):
    if not password or not mfa_secret:
        raise ValueError("Set HACKER_DEMO_PASSWORD and HACKER_DEMO_MFA_SECRET before seeding.")

    import pyotp
    from pymongo.errors import DuplicateKeyError

    from services.auth import hash_password, validate_password

    if not validate_password(password):
        raise ValueError("HACKER_DEMO_PASSWORD must meet the existing account password policy.")
    try:
        pyotp.TOTP(mfa_secret)
    except (TypeError, ValueError) as error:
        raise ValueError("HACKER_DEMO_MFA_SECRET must be a valid TOTP secret.") from error

    now = datetime.now(timezone.utc)
    password_hash = hash_password(password)
    created = []
    updated = []
    for email, name, profile in HACKERS:
        username = email.split("@", 1)[0]
        existing = users.find_one({"$or": [{"email": email}, {"username": username}]})
        if existing and not (
            existing.get("email") == email
            and existing.get("username") == username
            and existing.get("role") == "player"
            and existing.get("demo") is True
            and existing.get("account_type") == "demo_test"
            and existing.get("hacker_profile") == profile
        ):
            raise ValueError(f"Refusing to modify a conflicting non-demo account for {email}.")
        account = {
            "name": name,
            "username": username,
            "email": email,
            "password_hash": password_hash,
            "mfa_secret": mfa_secret,
            "mfa_enabled": True,
            "role": "player",
            "demo": True,
            "account_type": "demo_test",
            "hacker_profile": profile,
            "account_status": "active",
            "revoked": False,
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
            raise ValueError(f"Refusing to overwrite a conflicting account for {email}.")
        (created if result.upserted_id else updated).append(email)
    return {"players": [email for email, _, _ in HACKERS], "created": created, "updated": updated}


def main():
    if os.getenv("APP_ENV", "").strip().lower() not in {"development", "dev", "local"}:
        print("Hacker account seeding is disabled outside development mode.")
        return 1

    from database.db import users
    try:
        result = seed_hacker_accounts(
            users,
            os.getenv("HACKER_DEMO_PASSWORD", ""),
            os.getenv("HACKER_DEMO_MFA_SECRET", "").strip(),
        )
    except ValueError as error:
        print(error)
        return 1

    for email in result["created"]:
        print(f"Created {email}.")
    for email in result["updated"]:
        print(f"Updated {email}.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
