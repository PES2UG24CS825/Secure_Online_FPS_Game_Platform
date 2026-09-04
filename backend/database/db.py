import os
import bcrypt
from datetime import datetime, timezone
from pymongo import MongoClient

client = MongoClient(os.getenv("MONGO_URI", "mongodb://localhost:27017/"))
db = client[os.getenv("DB_NAME", "fps_security")]

users = db["users"]
game_events = db["game_events"]
security_events = db["security_events"]

def ensure_admin():
	email = os.getenv("ADMIN_EMAIL", "admin1@gmail.com").strip().lower()
	password = os.getenv("ADMIN_PASSWORD", "Admin@12345")
	mfa_secret = os.getenv("ADMIN_MFA_SECRET", "JBSWY3DPEHPK3PXP")
	users.update_one(
		{"email": email},
		{
			"$set": {
				"role": "admin",
				"mfa_enabled": True,
				"created_at": datetime.now(timezone.utc),
			},
			"$setOnInsert": {
				"name": "Security Admin",
				"email": email,
				"password_hash": bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8"),
			},
		},
		upsert=True,
	)
	users.update_one(
		{"email": email, "mfa_secret": {"$exists": False}},
		{"$set": {"mfa_secret": mfa_secret}},
	)

ensure_admin()

# Useful indexes
users.create_index("email", unique=True)
game_events.create_index([("user_id", 1), ("created_at", -1)])
security_events.create_index([("user_id", 1), ("created_at", -1)])
