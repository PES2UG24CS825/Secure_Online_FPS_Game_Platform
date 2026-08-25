from datetime import datetime, timezone
from flask import Blueprint, jsonify, request, session
from bson import ObjectId

from database.db import game_events, security_events
from models.ml_model import predict, FEATURES

game_bp = Blueprint("game", __name__, url_prefix="/api")

def current_user():
    return session.get("user_id")

@game_bp.post("/detect")
def detect():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401

    data = request.get_json(silent=True) or {}
    features = data.get("features", {})

    missing = [name for name in FEATURES if name not in features]
    if missing:
        return jsonify({"message": f"Missing features: {', '.join(missing)}"}), 400

    try:
        result = predict(features)
    except (TypeError, ValueError) as exc:
        return jsonify({"message": f"Invalid feature values: {exc}"}), 400

    event = {
        "user_id": ObjectId(user_id),
        "features": {k: float(features[k]) for k in FEATURES},
        "result": result,
        "created_at": datetime.now(timezone.utc),
    }
    game_events.insert_one(event)

    if result.get("random_forest") == "cheater" or result.get("isolation_forest") == "anomaly":
        security_events.insert_one({
            "user_id": ObjectId(user_id),
            "type": "gameplay_anomaly",
            "severity": "high" if result.get("random_forest") == "cheater" else "medium",
            "result": result,
            "created_at": datetime.now(timezone.utc),
        })

    return jsonify(result)

@game_bp.get("/dashboard")
def dashboard():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401

    oid = ObjectId(user_id)
    recent = list(game_events.find({"user_id": oid}).sort("created_at", -1).limit(8))
    alerts = list(security_events.find({"user_id": oid}).sort("created_at", -1).limit(6))

    return jsonify({
        "stats": {
            "matches_analyzed": game_events.count_documents({"user_id": oid}),
            "alerts": security_events.count_documents({"user_id": oid, "severity": {"$in": ["medium", "high"]}}),
            "security_status": "Protected"
        },
        "recent_detections": [
            {
                "rf": item.get("result", {}).get("random_forest"),
                "if": item.get("result", {}).get("isolation_forest"),
                "risk_score": item.get("result", {}).get("risk_score"),
                "created_at": item["created_at"].isoformat()
            } for item in recent
        ],
        "alerts": [
            {
                "type": a["type"],
                "severity": a["severity"],
                "created_at": a["created_at"].isoformat()
            } for a in alerts
        ]
    })
