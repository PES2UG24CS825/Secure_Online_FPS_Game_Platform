"""Run an opt-in development-only cheater-like telemetry fixture."""

import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))
load_dotenv(BACKEND_DIR / ".env")

APP_ENV = os.getenv("APP_ENV", "").strip().lower()
if APP_ENV not in {"development", "dev", "local"}:
    raise SystemExit("Demo blocked: set APP_ENV=development for local testing only.")
if os.getenv("SECUREFPS_ENABLE_DEMO") != "1":
    raise SystemExit("Demo disabled: set SECUREFPS_ENABLE_DEMO=1 to opt in locally.")

from bson import ObjectId

from database.db import game_events, game_telemetry, security_events
from models.ml_model import FEATURES
from routes.game_routes import analyze_game_session, gameplay_alert_severity

SESSION_ID = os.getenv("DEMO_SESSION_ID", "demo-cheater-like-fixture")
DEMO_LABEL = "cheater-like-development-fixture"
if not SESSION_ID.startswith("demo-"):
    raise SystemExit("DEMO_SESSION_ID must start with 'demo-' to avoid real sessions.")


def build_demo_telemetry(user_id, session_id, started_at):
    events = [{
        "event_type": "game_started",
        "telemetry": {},
        "created_at": started_at
    }]

    # These yield accuracy=.95 and fire_rate=8 from the ordinary extractor.
    for shot_number in range(20):
        shot_at = started_at + timedelta(seconds=0.1 * (shot_number + 1))
        events.append({
            "event_type": "weapon_fire",
            "telemetry": {"weapon": "development-fixture"},
            "created_at": shot_at
        })
        if shot_number < 19:
            events.append({
                "event_type": "enemy_hit",
                "telemetry": {"target_id": "development-fixture", "damage": 1},
                "created_at": shot_at + timedelta(milliseconds=5)
            })

    events.append({
        "event_type": "player_behavior",
        "telemetry": {"speed": 0.5},
        "created_at": started_at + timedelta(seconds=2.05)
    })
    events.append({
        "event_type": "aim_behavior",
        "telemetry": {"rotation_change": (1 / 0.95) - 1},
        "created_at": started_at + timedelta(seconds=2.1)
    })
    for kill_number in range(9):
        events.append({
            "event_type": "enemy_killed",
            "telemetry": {"enemy": "development-fixture"},
            "created_at": started_at + timedelta(seconds=2.15 + kill_number * 0.01)
        })
    events.append({
        "event_type": "player_death",
        "telemetry": {},
        "created_at": started_at + timedelta(seconds=2.24)
    })
    events.append({
        "event_type": "game_completed",
        "telemetry": {},
        "created_at": started_at + timedelta(seconds=2.5)
    })

    return [
        {
            "user_id": user_id,
            "session_id": session_id,
            "demo": True,
            "event_type": event["event_type"],
            "telemetry": event["telemetry"],
            "created_at": event["created_at"]
        }
        for event in events
    ]


def main():
    existing_analysis = game_events.find_one({
        "session_id": SESSION_ID,
        "analysis_type": "game_session"
    })
    if existing_analysis and existing_analysis.get("demo") is not True:
        raise SystemExit("Demo blocked: this session ID already belongs to a non-demo analysis.")

    existing_alert = security_events.find_one({
        "session_id": SESSION_ID,
        "type": "gameplay_anomaly"
    })
    if existing_alert and existing_alert.get("demo") is not True:
        raise SystemExit("Demo blocked: this session ID already belongs to a non-demo alert.")

    user_id = (
        existing_analysis.get("user_id")
        if existing_analysis and existing_analysis.get("user_id")
        else ObjectId()
    )

    # Replace only this fixture's tagged raw events; retries remain isolated/idempotent.
    game_telemetry.delete_many({"session_id": SESSION_ID, "demo": True})
    security_events.delete_one({
        "session_id": SESSION_ID,
        "type": "gameplay_anomaly",
        "demo": True
    })
    game_telemetry.insert_many(
        build_demo_telemetry(user_id, SESSION_ID, datetime.now(timezone.utc))
    )

    analysis = analyze_game_session(user_id, SESSION_ID)
    result = analysis.get("result") or {}
    severity = gameplay_alert_severity(result, analysis.get("status"))
    alert_status = (
        "pending" if severity
        else "not_triggered" if analysis.get("status") == "success"
        else "analysis_incomplete"
    )

    game_events.update_one(
        {"session_id": SESSION_ID, "analysis_type": "game_session"},
        {"$set": {
            "demo": True,
            "demo_label": DEMO_LABEL,
            "alert_status": alert_status
        }},
        upsert=True
    )

    if severity:
        security_events.update_one(
            {"session_id": SESSION_ID, "type": "gameplay_anomaly"},
            {"$set": {
                "demo": True,
                "demo_label": DEMO_LABEL,
                "review_status": "pending"
            }},
            upsert=True
        )

    summary = {
        "session_id": SESSION_ID,
        "demo": True,
        "analysis_type": "game_session",
        "active_features": FEATURES,
        "raw_features": analysis.get("raw_features", {}),
        "features": analysis.get("features", {}),
        "missing_features": analysis.get("missing_features", []),
        "random_forest": result.get("random_forest"),
        "isolation_forest": result.get("isolation_forest"),
        "risk_score": result.get("risk_score"),
        "status": analysis.get("status"),
        "alert_status": alert_status,
        "alert_severity": severity,
        "created_at": datetime.now(timezone.utc).isoformat()
    }
    print(json.dumps(summary, indent=2, default=str))


if __name__ == "__main__":
    main()
