from datetime import datetime, timezone
from flask import Blueprint, jsonify, request, session
from bson import ObjectId

from database.db import game_events, security_events, users
from models.ml_model import predict, FEATURES

game_bp = Blueprint("game", __name__, url_prefix="/api")

def current_user():
    return session.get("user_id")

def is_admin():
    user_id = current_user()
    return bool(user_id and users.find_one({"_id": ObjectId(user_id), "role": "admin"}))

@game_bp.get("/admin/overview")
def admin_overview():
    if not is_admin():
        return jsonify({"message": "Admin access required."}), 403
    players = list(users.find({"role": {"$ne": "admin"}}, {"password_hash": 0, "mfa_secret": 0}))
    events = list(security_events.find().sort("created_at", -1).limit(100))
    return jsonify({
        "players": [{"id": str(player["_id"]), "name": player["name"], "email": player["email"], "role": player.get("role", "player"), "mfa_enabled": player.get("mfa_enabled", False), "created_at": player["created_at"].isoformat()} for player in players],
        "events": [{"type": event.get("type", "security_event"), "severity": event.get("severity", "low")} for event in events],
        "login_count": 0,
    })

@game_bp.post("/admin/players/<player_id>/<action>")
def admin_player_action(player_id, action):
    if not is_admin() or action not in {"revoke", "delete"}:
        return jsonify({"message": "Admin access required."}), 403
    try:
        oid = ObjectId(player_id)
    except Exception:
        return jsonify({"message": "Invalid player id."}), 400
    if action == "delete":
        users.delete_one({"_id": oid, "role": {"$ne": "admin"}})
    else:
        users.update_one({"_id": oid, "role": {"$ne": "admin"}}, {"$set": {"revoked": True}})
    return jsonify({"message": f"Player {action} complete."})

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
