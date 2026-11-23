"""Provision the isolated development-only cheater_demo account with TOTP MFA."""

import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))
load_dotenv(BACKEND_DIR / ".env")


def main():
    app_env = os.getenv("APP_ENV", "").strip().lower()
    if app_env not in {"development", "dev", "local"}:
        print("[ERROR] Demo account provisioning is disabled in non-development environments.")
        print("Set APP_ENV=development in backend/.env for local evaluation.")
        return 1

    if os.getenv("SECUREFPS_ENABLE_DEMO") != "1":
        print("[ERROR] Demo account provisioning is disabled.")
        print("Set SECUREFPS_ENABLE_DEMO=1 in backend/.env to opt into demonstration mode.")
        return 1

    # Configurable via environment variable DEMO_CHEATER_PASSWORD
    password = os.getenv("DEMO_CHEATER_PASSWORD", "SecureFPS@Demo2026!")

    from pymongo.errors import DuplicateKeyError
    import pyotp
    import qrcode

    from database.db import users
    from services.auth import hash_password, validate_password

    if not validate_password(password):
        print("[ERROR] DEMO_CHEATER_PASSWORD must meet the existing SecureFPS password policy (min 8 chars, 1 uppercase, 1 lowercase, 1 digit, 1 special).")
        return 1

    username = "cheater_demo"
    email = "cheater_demo@example.test"
    existing = users.find_one({"$or": [{"email": email}, {"username": username}]})

    force_reset_mfa = "--reset-mfa" in sys.argv or "--new-mfa" in sys.argv
    env_mfa_secret = os.getenv("DEMO_CHEATER_MFA_SECRET", "").strip()

    if env_mfa_secret:
        mfa_secret = env_mfa_secret
    elif existing and existing.get("mfa_secret") and not force_reset_mfa:
        mfa_secret = existing["mfa_secret"]
    else:
        mfa_secret = pyotp.random_base32()

    now_utc = datetime.now(timezone.utc)
    if existing:
        is_demo_account = (
            existing.get("demo") is True
            and existing.get("account_type") == "demo_test"
            and (existing.get("username") == username or existing.get("email") == email)
        )
        if not is_demo_account:
            print("[SECURITY ERROR] Refusing to modify an existing non-demo player account with this username or email.")
            return 1

        print(f"[INFO] Updating existing development-only demonstration account: {username}")
        users.update_one(
            {"_id": existing["_id"]},
            {
                "$set": {
                    "username": username,
                    "email": email,
                    "name": "Cheater Demonstration Operator",
                    "password_hash": hash_password(password),
                    "mfa_secret": mfa_secret,
                    "mfa_enabled": True,
                    "role": "player",
                    "account_type": "demo_test",
                    "account_status": "active",
                    "demo": True,
                    "is_demo": True,
                    "demo_label": "CHEATER DEMONSTRATION TEST ACCOUNT",
                    "honour_score": 100,
                    "updated_at": now_utc,
                }
            }
        )
    else:
        account = {
            "username": username,
            "name": "Cheater Demonstration Operator",
            "email": email,
            "password_hash": hash_password(password),
            "mfa_secret": mfa_secret,
            "mfa_enabled": True,
            "role": "player",
            "account_type": "demo_test",
            "account_status": "active",
            "demo": True,
            "is_demo": True,
            "demo_label": "CHEATER DEMONSTRATION TEST ACCOUNT",
            "honour_score": 100,
            "created_at": now_utc,
            "updated_at": now_utc,
        }
        try:
            users.insert_one(account)
        except DuplicateKeyError:
            print("[ERROR] A conflicting account was created concurrently.")
            return 1

    totp = pyotp.TOTP(mfa_secret)
    issuer = "SecureFPS"
    provisioning_uri = totp.provisioning_uri(name=email, issuer_name=issuer)

    # Format secret into 4-char chunks for easy reading
    spaced_secret = " ".join([mfa_secret[i:i+4] for i in range(0, len(mfa_secret), 4)])

    # Generate QR Code PNG image and save to frontend static directory
    qr_img = qrcode.make(provisioning_uri)
    frontend_dir = BACKEND_DIR.parent / "frontend"
    qr_frontend_file = frontend_dir / "demo_cheater_mfa_qr.png"
    qr_img.save(str(qr_frontend_file))

    # Also save to frontend/public for fallback
    public_dir = frontend_dir / "public"
    if public_dir.is_dir():
        qr_img.save(str(public_dir / "demo_cheater_mfa_qr.png"))

    current_code = totp.now()
    time_remaining = 30 - (int(time.time()) % 30)

    print("\n" + "=" * 68)
    print("      SECUREFPS CHEATER DEMONSTRATION ACCOUNT PROVISIONED")
    print("=" * 68)
    print(f"  Environment:        {app_env.upper()} (DEMO MODE)")
    print(f"  Username:           {username}")
    print(f"  Email:              {email}")
    print(f"  Password Storage:   Bcrypt hashed (plain password NOT stored)")
    print(f"  MFA Secret (Raw):   {mfa_secret}")
    print(f"  MFA Secret (Spaced):{spaced_secret}")
    print(f"  Provisioning URI:   {provisioning_uri}")
    print(f"  QR Image File:      {qr_frontend_file}")
    print(f"  Browser QR URL:     http://127.0.0.1:5000/demo_cheater_mfa_qr.png")
    print(f"  Current TOTP Code:  {current_code} (valid for {time_remaining}s)")
    print("=" * 68)
    print("\nScan this QR code with Google Authenticator or Microsoft Authenticator:\n")

    try:
        if sys.platform == "win32":
            try:
                sys.stdout.reconfigure(encoding="utf-8")
            except Exception:
                pass
        qr = qrcode.QRCode(border=2)
        qr.add_data(provisioning_uri)
        qr.print_ascii(invert=True)
    except Exception as qr_err:
        print(f"[NOTE] Terminal QR code rendering skipped: {qr_err}")
        print(f"Please use manual secret entry in your Authenticator app: {spaced_secret}")

    print("\n" + "=" * 68)
    print("  LOGIN INSTRUCTIONS:")
    print("  1. Navigate to:    http://127.0.0.1:5000/login.html")
    print("  2. Enter Username: cheater_demo (or cheater_demo@example.test)")
    print("  3. Enter Password: [Configured via DEMO_CHEATER_PASSWORD]")
    print(f"  4. Enter 6-digit TOTP code: [e.g. {current_code} from Authenticator app]")
    print("=" * 68 + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
