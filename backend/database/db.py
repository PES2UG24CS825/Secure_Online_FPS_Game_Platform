import os
from pymongo import MongoClient
from dotenv import load_dotenv

load_dotenv()

MONGO_URI = os.getenv(
    "MONGO_URI",
    "mongodb://127.0.0.1:27017/"
)

DB_NAME = os.getenv(
    "MONGO_DB",
    "secure_fps"
)

client = MongoClient(MONGO_URI)

db = client[DB_NAME]

# Collections
users = db["users"]

# Raw gameplay telemetry coming from Unity
game_telemetry = db["game_telemetry"]

# Processed ML features + detection results
game_events = db["game_events"]

# Individual game sessions
game_sessions = db["game_sessions"]

# Security alerts
security_events = db["security_events"]


def test_connection():
    try:
        client.admin.command("ping")
        print("MongoDB connected successfully.")
        return True
    except Exception as e:
        print("MongoDB connection failed:", e)
        return False