from datetime import datetime, timezone
from flask import Blueprint, jsonify, request, session
from bson import ObjectId

from database.db import users, matches, security_events, login_history, sessions_db

player_bp = Blueprint("player", __name__, url_prefix="/api/player")

def current_user():
    return session.get("user_id")

def get_user_role():
    user_id = current_user()
    if not user_id:
        return None
    user = users.find_one({"_id": ObjectId(user_id)})
    return user.get("role") if user else None

@player_bp.before_request
def check_player_access():
    if get_user_role() not in ("player", "admin"):
        return jsonify({"message": "Player access required."}), 403

@player_bp.get("/profile")
def get_profile():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401
    user = users.find_one({"_id": ObjectId(user_id)}, {"password_hash": 0, "mfa_secret": 0})
    if not user:
        return jsonify({"message": "User not found."}), 404
    return jsonify({
        "id": str(user["_id"]),
        "name": user["name"],
        "email": user["email"],
        "mfa_enabled": user.get("mfa_enabled", False),
        "created_at": user["created_at"].isoformat(),
    })

@player_bp.get("/matches")
def get_matches():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401
    
    user_oid = ObjectId(user_id)
    player_matches = list(matches.find({"user_id": user_oid}).sort("created_at", -1))
    
    return jsonify({
        "matches": [
            {
                "id": str(m["_id"]),
                "date": m["created_at"].isoformat(),
                "duration": m.get("duration", 0),
                "kills": m.get("kills", 0),
                "deaths": m.get("deaths", 0),
                "kd": round(m.get("kills", 0) / max(m.get("deaths", 1), 1), 2),
                "headshots": m.get("headshots", 0),
                "headshot_percentage": m.get("headshot_percentage", 0),
                "accuracy": m.get("accuracy", 0),
                "shots_fired": m.get("shots_fired", 0),
                "shots_hit": m.get("shots_hit", 0),
                "risk_score": m.get("risk_score", 0),
            }
            for m in player_matches
        ]
    })

@player_bp.get("/detections")
def get_detections():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401
    
    user_oid = ObjectId(user_id)
    detections = list(security_events.find({"user_id": user_oid}).sort("created_at", -1).limit(50))
    
    return jsonify({
        "detections": [
            {
                "id": str(d["_id"]),
                "type": d.get("type", "unknown"),
                "severity": d.get("severity", "low"),
                "confidence": d.get("confidence", 0),
                "timestamp": d["created_at"].isoformat(),
                "description": d.get("description", ""),
                "status": d.get("status", "detected"),
            }
            for d in detections
        ]
    })

@player_bp.get("/security-events")
def get_security_events():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401
    
    user_oid = ObjectId(user_id)
    events = list(login_history.find({"user_id": user_oid}).sort("created_at", -1).limit(20))
    
    return jsonify({
        "events": [
            {
                "id": str(e["_id"]),
                "type": e.get("type", "login"),
                "timestamp": e["created_at"].isoformat(),
                "ip": e.get("ip", "Unknown"),
                "description": e.get("description", ""),
                "status": e.get("status", "success"),
            }
            for e in events
        ]
    })

@player_bp.get("/sessions")
def get_active_sessions():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401
    
    user_oid = ObjectId(user_id)
    active_sessions = list(sessions_db.find({"user_id": user_oid, "is_active": True}))
    
    return jsonify({
        "sessions": [
            {
                "id": str(s["_id"]),
                "ip": s.get("ip", "Unknown"),
                "device": s.get("device", "Unknown"),
                "created_at": s["created_at"].isoformat(),
                "last_activity": s.get("last_activity", s["created_at"]).isoformat(),
            }
            for s in active_sessions
        ]
    })

@player_bp.post("/sessions/<session_id>/revoke")
def revoke_session(session_id):
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401
    
    try:
        sid = ObjectId(session_id)
    except Exception:
        return jsonify({"message": "Invalid session id."}), 400
    
    user_oid = ObjectId(user_id)
    result = sessions_db.update_one(
        {"_id": sid, "user_id": user_oid},
        {"$set": {"is_active": False}}
    )
    
    if result.matched_count == 0:
        return jsonify({"message": "Session not found."}), 404
    
    return jsonify({"message": "Session revoked."})

@player_bp.get("/account-status")
def get_account_status():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401
    
    user = users.find_one({"_id": ObjectId(user_id)})
    if not user:
        return jsonify({"message": "User not found."}), 404
    
    user_oid = ObjectId(user_id)
    recent_login = login_history.find_one(
        {"user_id": user_oid, "type": "login_success"},
        sort=[("created_at", -1)]
    )
    
    return jsonify({
        "mfa_enabled": user.get("mfa_enabled", False),
        "account_status": "active",
        "risk_score": user.get("risk_score", 0),
        "created_at": user["created_at"].isoformat(),
        "last_login": recent_login["created_at"].isoformat() if recent_login else None,
        "active_sessions": sessions_db.count_documents({"user_id": user_oid, "is_active": True}),
    })
