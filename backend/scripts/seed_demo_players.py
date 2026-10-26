"""Seed two login-capable normal player fixtures in development only."""

import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))
load_dotenv(BACKEND_DIR / ".env")

NORMAL_PLAYERS = (
    ("demo_player_one@example.test", "Demo Player One", "demo_player_one"),
    ("demo_player_two@example.test", "Demo Player Two", "demo_player_two"),
)


def build_demo_player(email, name, username, password_hash, mfa_secret):
    return {
        "name": name,
        "username": username,
        "email": email,
        "password_hash": password_hash,
        "mfa_secret": mfa_secret,
        "mfa_enabled": True,
        "role": "player",
        "demo": True,
        "demo_label": "NORMAL DEMO PLAYER",
        "account_type": "demo_normal",
        "account_status": "active",
        "revoked": False,
    }


def seed_normal_demo_players(users, password, mfa_secret):
    if not password or not mfa_secret:
        raise ValueError("Set DEMO_PLAYER_PASSWORD and DEMO_PLAYER_MFA_SECRET before seeding.")

    import pyotp
    from pymongo.errors import DuplicateKeyError

    from services.auth import hash_password, validate_password

    if not validate_password(password):
        raise ValueError("DEMO_PLAYER_PASSWORD must meet the existing account password policy.")
    try:
        pyotp.TOTP(mfa_secret)
    except (TypeError, ValueError) as error:
        raise ValueError("DEMO_PLAYER_MFA_SECRET must be a valid TOTP secret.") from error

    password_hash = hash_password(password)
    now = datetime.now(timezone.utc)
    created = []
    updated = []
    for email, name, username in NORMAL_PLAYERS:
        existing = users.find_one({"$or": [{"email": email}, {"username": username}]})
        if existing and not (
            existing.get("email") == email
            and existing.get("username") == username
            and existing.get("role") == "player"
            and existing.get("demo") is True
            and existing.get("account_type") == "demo_normal"
        ):
            raise ValueError(f"Refusing to modify a conflicting non-demo account for {email}.")

        account = build_demo_player(email, name, username, password_hash, mfa_secret)
        try:
            result = users.update_one(
                {"email": email},
                {"$set": account, "$setOnInsert": {"created_at": now}},
                upsert=True,
            )
        except DuplicateKeyError as error:
            raise ValueError(f"Refusing to overwrite a conflicting account for {email}.") from error
        (created if result.upserted_id else updated).append(email)

    return {"players": [email for email, _, _ in NORMAL_PLAYERS], "created": created, "updated": updated}


def main():
    if os.getenv("APP_ENV", "").strip().lower() not in {"development", "dev", "local"}:
        print("Normal demo player seeding is disabled outside development mode.")
        return 1

    from database.db import users
    try:
        result = seed_normal_demo_players(
            users,
            os.getenv("DEMO_PLAYER_PASSWORD", ""),
            os.getenv("DEMO_PLAYER_MFA_SECRET", "").strip(),
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
