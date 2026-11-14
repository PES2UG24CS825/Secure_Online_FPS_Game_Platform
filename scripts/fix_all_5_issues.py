import sys
sys.path.insert(0, 'backend')

from database.db import users, sessions_db, login_history, security_events, ban_appeals, admin_approvals, honour_history
from services.auth import hash_password

GENUINE_EMAILS = {
    "sudh@gmail.com",
    "pk123@gmail.com",
    "sudi12@gamil.com",
    "varun1234@gmail.com",
    "admin1@gmail.com",
    "superadmin@securefps.io"
}

# 1. Purge all non-genuine accounts
to_delete = []
for u in users.find():
    email = (u.get("email") or "").strip().lower()
    if email not in GENUINE_EMAILS:
        to_delete.append(u["_id"])
        print(f"Purging unwanted account: {u.get('name')} <{email}>")

if to_delete:
    r_u = users.delete_many({"_id": {"$in": to_delete}})
    r_l = login_history.delete_many({"user_id": {"$in": to_delete}})
    r_s = sessions_db.delete_many({"user_id": {"$in": to_delete}})
    r_h = honour_history.delete_many({"$or": [{"user_id": {"$in": to_delete}}, {"player_id": {"$in": [str(x) for x in to_delete]}}]})
    r_sec = security_events.delete_many({"user_id": {"$in": to_delete}})
    r_app = admin_approvals.delete_many({"player_id": {"$in": [str(x) for x in to_delete]}})
    print(f"[+] Purged {r_u.deleted_count} accounts and related records.")

# Clean test / werkzeug login history records that clutter audit views
login_history.delete_many({"identifier": {"$regex": r"(@test\.local|@example\.test|@securefps\.local)"}})

# 2. Reset exact roles and credentials
# Normal Admin: admin1@gmail.com
users.update_one(
    {"email": "admin1@gmail.com"},
    {"$set": {
        "name": "Security Admin",
        "role": "normal_admin",
        "is_super_admin": False,
        "account_status": "active",
        "password_hash": hash_password("Admin@12345"),
        "mfa_secret": "JBSWY3DPEHPK3PXP",
        "mfa_enabled": True,
        "revoked": False
    }},
    upsert=True
)
print("[+] normal_admin admin1@gmail.com configured (is_super_admin=False)")

# Super Admin: superadmin@securefps.io
users.update_one(
    {"email": "superadmin@securefps.io"},
    {"$set": {
        "name": "Super Administrator",
        "role": "super_admin",
        "is_super_admin": True,
        "account_status": "active",
        "password_hash": hash_password("SuperAdmin@2026!"),
        "mfa_secret": "JBSWY3DPEHPK3PXP",
        "mfa_enabled": True,
        "revoked": False
    }},
    upsert=True
)
print("[+] super_admin superadmin@securefps.io configured (is_super_admin=True)")

# Player: sudh@gmail.com
users.update_one(
    {"email": "sudh@gmail.com"},
    {"$set": {
        "name": "sudh",
        "role": "player",
        "account_status": "active",
        "revoked": False,
        "force_password_reset": False,
        "password_hash": hash_password("Sudh@12345"),
        "mfa_secret": "JBSWY3DPEHPK3PXP",
        "mfa_enabled": True,
        "honour_score": 100
    }}
)
print("[+] player sudh@gmail.com updated with fresh password Sudh@12345")

# Players: varun, sudi, prajwal
users.update_one({"email": "varun1234@gmail.com"}, {"$set": {"password_hash": hash_password("Varun@12345"), "account_status": "active", "revoked": False, "mfa_secret": "JBSWY3DPEHPK3PXP"}})
users.update_one({"email": "sudi12@gamil.com"}, {"$set": {"password_hash": hash_password("Sudi@12345"), "account_status": "active", "revoked": False, "mfa_secret": "JBSWY3DPEHPK3PXP"}})
users.update_one({"email": "pk123@gmail.com"}, {"$set": {"password_hash": hash_password("Prajwal@12345"), "account_status": "active", "revoked": False, "mfa_secret": "JBSWY3DPEHPK3PXP"}})

print("\n--- FINAL USERS IN DB ---")
for u in users.find():
    print(f"- {u.get('name')} <{u.get('email')}> | Role: {u.get('role')} | is_super: {u.get('is_super_admin')} | Status: {u.get('account_status')}")
