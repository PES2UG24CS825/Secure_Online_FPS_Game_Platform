import os
from pathlib import Path
from pymongo import MongoClient
from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parents[1]
load_dotenv(BACKEND_DIR / ".env")

MONGO_URI = os.getenv(
    "MONGO_URI",
    "mongodb://127.0.0.1:27017/"
)

DB_NAME = os.getenv(
    "MONGO_DB",
    os.getenv("DB_NAME", "secure_fps")
)

client = MongoClient(
    MONGO_URI,
    serverSelectionTimeoutMS=int(os.getenv("MONGO_SERVER_SELECTION_TIMEOUT_MS", "5000")),
)

db = client[DB_NAME]

# Collections
users = db["users"]
matches = db["matches"]
login_history = db["login_history"]
sessions_db = db["sessions"]

# Raw gameplay telemetry coming from Unity
game_telemetry = db["game_telemetry"]

# Processed ML features + detection results
game_events = db["game_events"]

# Individual game sessions
game_sessions = db["game_sessions"]

# Security alerts
security_events = db["security_events"]
# Backwards-compatible name used by older integrations.
detections = security_events
support_tickets = db["support_tickets"]
reward_transactions = db["reward_transactions"]
honour_history = db["honour_history"]


def test_connection():
    try:
        client.admin.command("ping")
        print("MongoDB connected successfully.")
        return True
    except Exception as e:
        print("MongoDB connection failed:", e)
        return False
