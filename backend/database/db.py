import os
from pymongo import MongoClient

client = MongoClient(os.getenv("MONGO_URI", "mongodb://localhost:27017/"))
db = client[os.getenv("DB_NAME", "fps_security")]

users = db["users"]
game_events = db["game_events"]
security_events = db["security_events"]

# Useful indexes
users.create_index("email", unique=True)
game_events.create_index([("user_id", 1), ("created_at", -1)])
security_events.create_index([("user_id", 1), ("created_at", -1)])
