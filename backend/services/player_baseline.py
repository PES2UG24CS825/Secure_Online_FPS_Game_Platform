"""
SecureFPS — Player Skill Baseline & Historical Profiling System
Builds auditable, tamper-resistant skill profiles for legitimate human players.
Ensures new players and skilled players are recognized accurately without false alerts.
"""

from datetime import datetime, timezone
from typing import Dict, Optional, Any
from bson import ObjectId


def get_player_baseline(db_users, db_game_events, user_id: Any) -> Dict[str, Any]:
    """
    Retrieves or calculates the player's legitimate gameplay baseline
    from completed, non-corrupted historical matches.
    """
    try:
        user_oid = ObjectId(user_id) if not isinstance(user_id, ObjectId) else user_id
    except Exception:
        return {"sample_count": 0, "status": "invalid_id"}

    # Fetch last 20 successful analyses for this player
    cursor = db_game_events.find({
        "user_id": user_oid,
        "analysis_type": "game_session",
        "status": "success"
    }).sort("created_at", -1).limit(20)

    records = list(cursor)
    if not records:
        return {
            "sample_count": 0,
            "status": "new_player",
            "confidence": "insufficient_history",
            "avg_accuracy": 0.50,
            "avg_kdr": 1.0,
            "avg_movement_speed": 2.5,
            "avg_aim_smoothness": 0.65
        }

    accuracies = []
    kdrs = []
    speeds = []
    smoothnesses = []

    for r in records:
        raw = r.get("raw_features", {}) or {}
        acc = raw.get("accuracy")
        kdr = raw.get("kdr")
        spd = raw.get("movement_speed")
        sm = raw.get("aim_smoothness")

        if acc is not None and isinstance(acc, (int, float)):
            accuracies.append(float(acc))
        if kdr is not None and isinstance(kdr, (int, float)):
            kdrs.append(float(kdr))
        if spd is not None and isinstance(spd, (int, float)):
            speeds.append(float(spd))
        if sm is not None and isinstance(sm, (int, float)):
            smoothnesses.append(float(sm))

    n_samples = len(records)
    confidence = "high" if n_samples >= 10 else ("medium" if n_samples >= 3 else "low")

    return {
        "sample_count": n_samples,
        "status": "established_profile" if n_samples >= 3 else "building_profile",
        "confidence": confidence,
        "avg_accuracy": round(sum(accuracies) / len(accuracies), 4) if accuracies else 0.50,
        "avg_kdr": round(sum(kdrs) / len(kdrs), 2) if kdrs else 1.0,
        "avg_movement_speed": round(sum(speeds) / len(speeds), 2) if speeds else 2.5,
        "avg_aim_smoothness": round(sum(smoothnesses) / len(smoothnesses), 4) if smoothnesses else 0.65,
        "last_updated": datetime.now(timezone.utc).isoformat()
    }
