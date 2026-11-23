"""Display the current active TOTP MFA code for cheater_demo."""

import os
import sys
import time
from pathlib import Path
from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))
load_dotenv(BACKEND_DIR / ".env")

import pyotp
from database.db import users

u = users.find_one({"$or": [{"email": "cheater_demo@example.test"}, {"username": "cheater_demo"}]})
if not u:
    print("[ERROR] Account cheater_demo not found in MongoDB. Run provision_demo_cheater.py first.")
    sys.exit(1)

secret = u.get("mfa_secret")
if not secret:
    print("[ERROR] No MFA secret found for cheater_demo.")
    sys.exit(1)

totp = pyotp.TOTP(secret)
code = totp.now()
remaining = 30 - (int(time.time()) % 30)

print("=" * 48)
print("  CHEATER DEMO ACCOUNT MFA CODE")
print("=" * 48)
print(f"  Account:    {u.get('username')} ({u.get('email')})")
print(f"  MFA Secret: {secret}")
print(f"  ACTIVE CODE: >>> {code} <<<")
print(f"  Valid for:   {remaining} seconds")
print("=" * 48)
