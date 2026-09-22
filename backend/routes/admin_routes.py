from datetime import datetime, timezone
from flask import Blueprint, jsonify, request, session
from bson import ObjectId

from database.db import users, matches, security_events, login_history, sessions_db

admin_bp = Blueprint("admin", __name__, url_prefix="/api/admin")

def current_user():
    return session.get("user_id")

def is_admin():
    user_id = current_user()
    if not user_id:
        return False
    user = users.find_one({"_id": ObjectId(user_id), "role": "admin"})
    return bool(user)

@admin_bp.before_request
def check_admin_access():
    if not is_admin():
        return jsonify({"message": "Admin access required."}), 403

@admin_bp.get("/overview")
def overview():
    all_users = list(users.find({"role": {"$ne": "admin"}}, {"password_hash": 0, "mfa_secret": 0}))
    all_events = list(security_events.find().sort("created_at", -1).limit(100))
    all_matches = list(matches.find().sort("created_at", -1).limit(100))
    
    high_severity_count = security_events.count_documents({"severity": {"$in": ["high", "critical"]}})
    active_sessions_count = sessions_db.count_documents({"is_active": True})
    
    return jsonify({
        "stats": {
            "total_players": len(all_users),
            "active_sessions": active_sessions_count,
            "matches_analyzed": len(all_matches),
            "security_events": len(all_events),
            "high_severity_events": high_severity_count,
        },
        "players": [
            {
                "id": str(u["_id"]),
                "name": u["name"],
                "email": u["email"],
                "mfa_enabled": u.get("mfa_enabled", False),
                "created_at": u["created_at"].isoformat(),
                "risk_score": u.get("risk_score", 0),
                "account_status": "active" if not u.get("revoked") else "suspended",
            }
            for u in all_users
        ],
        "recent_events": [
            {
                "type": e.get("type", "unknown"),
                "severity": e.get("severity", "low"),
                "timestamp": e["created_at"].isoformat(),
                "description": e.get("description", ""),
            }
            for e in all_events[:10]
        ]
    })

@admin_bp.get("/players")
def list_players():
    limit = request.args.get("limit", 100, type=int)
    offset = request.args.get("offset", 0, type=int)
    
    all_players = list(users.find({"role": {"$ne": "admin"}}, {"password_hash": 0, "mfa_secret": 0})
                      .sort("created_at", -1)
                      .skip(offset)
                      .limit(limit))
    
    return jsonify({
        "players": [
            {
                "id": str(p["_id"]),
                "name": p["name"],
                "email": p["email"],
                "mfa_enabled": p.get("mfa_enabled", False),
                "created_at": p["created_at"].isoformat(),
                "risk_score": p.get("risk_score", 0),
                "account_status": "active" if not p.get("revoked") else "suspended",
            }
            for p in all_players
        ],
        "total": users.count_documents({"role": {"$ne": "admin"}})
    })

@admin_bp.get("/players/<player_id>")
def get_player_details(player_id):
    try:
        pid = ObjectId(player_id)
    except Exception:
        return jsonify({"message": "Invalid player id."}), 400
    
    player = users.find_one({"_id": pid, "role": {"$ne": "admin"}}, {"password_hash": 0, "mfa_secret": 0})
    if not player:
        return jsonify({"message": "Player not found."}), 404
    
    player_matches = list(matches.find({"user_id": pid}).sort("created_at", -1))
    player_detections = list(security_events.find({"user_id": pid}).sort("created_at", -1).limit(20))
    player_logins = list(login_history.find({"user_id": pid, "type": "login_success"}).sort("created_at", -1).limit(10))
    active_sessions_count = sessions_db.count_documents({"user_id": pid, "is_active": True})
    
    return jsonify({
        "account_info": {
            "id": str(player["_id"]),
            "name": player["name"],
            "email": player["email"],
            "mfa_enabled": player.get("mfa_enabled", False),
            "created_at": player["created_at"].isoformat(),
            "account_status": "active" if not player.get("revoked") else "suspended",
        },
        "security_info": {
            "risk_score": player.get("risk_score", 0),
            "detections_count": len(player_detections),
            "active_sessions": active_sessions_count,
            "logins_last_30_days": len(player_logins),
        },
        "gameplay_info": {
            "total_matches": len(player_matches),
            "kills": sum(m.get("kills", 0) for m in player_matches),
            "deaths": sum(m.get("deaths", 0) for m in player_matches),
            "avg_accuracy": round(sum(m.get("accuracy", 0) for m in player_matches) / max(len(player_matches), 1), 2),
        },
        "recent_detections": [
            {
                "type": d.get("type", "unknown"),
                "severity": d.get("severity", "low"),
                "timestamp": d["created_at"].isoformat(),
            }
            for d in player_detections[:5]
        ],
        "login_history": [
            {
                "timestamp": l["created_at"].isoformat(),
                "ip": l.get("ip", "Unknown"),
                "status": l.get("status", "success"),
            }
            for l in player_logins
        ]
    })

@admin_bp.post("/players/<player_id>/suspend")
def suspend_player(player_id):
    try:
        pid = ObjectId(player_id)
    except Exception:
        return jsonify({"message": "Invalid player id."}), 400
    
    result = users.update_one(
        {"_id": pid, "role": {"$ne": "admin"}},
        {"$set": {"revoked": True, "revoked_at": datetime.now(timezone.utc)}}
    )
    
    if result.matched_count == 0:
        return jsonify({"message": "Player not found."}), 404
    
    security_events.insert_one({
        "user_id": ObjectId(current_user()),
        "target_user_id": pid,
        "type": "player_suspended",
        "severity": "high",
        "description": f"Player {player_id} suspended by admin",
        "created_at": datetime.now(timezone.utc),
    })
    
    return jsonify({"message": "Player suspended."})

@admin_bp.post("/players/<player_id>/unsuspend")
def unsuspend_player(player_id):
    try:
        pid = ObjectId(player_id)
    except Exception:
        return jsonify({"message": "Invalid player id."}), 400
    
    result = users.update_one(
        {"_id": pid, "role": {"$ne": "admin"}},
        {"$set": {"revoked": False}}
    )
    
    if result.matched_count == 0:
        return jsonify({"message": "Player not found."}), 404
    
    return jsonify({"message": "Player unsuspended."})

@admin_bp.post("/players/<player_id>/delete")
def delete_player(player_id):
    try:
        pid = ObjectId(player_id)
    except Exception:
        return jsonify({"message": "Invalid player id."}), 400
    
    result = users.delete_one({"_id": pid, "role": {"$ne": "admin"}})
    
    if result.deleted_count == 0:
        return jsonify({"message": "Player not found."}), 404
    
    security_events.insert_one({
        "user_id": ObjectId(current_user()),
        "target_user_id": pid,
        "type": "player_deleted",
        "severity": "critical",
        "description": f"Player {player_id} deleted by admin",
        "created_at": datetime.now(timezone.utc),
    })
    
    return jsonify({"message": "Player deleted."})

@admin_bp.get("/security-events")
def list_security_events():
    limit = request.args.get("limit", 100, type=int)
    offset = request.args.get("offset", 0, type=int)
    severity = request.args.get("severity", None)
    event_type = request.args.get("type", None)
    
    query = {}
    if severity:
        query["severity"] = severity
    if event_type:
        query["type"] = event_type
    
    events = list(security_events.find(query)
                 .sort("created_at", -1)
                 .skip(offset)
                 .limit(limit))
    
    return jsonify({
        "events": [
            {
                "id": str(e["_id"]),
                "type": e.get("type", "unknown"),
                "severity": e.get("severity", "low"),
                "timestamp": e["created_at"].isoformat(),
                "user_id": str(e["user_id"]) if e.get("user_id") else None,
                "description": e.get("description", ""),
                "status": e.get("status", "detected"),
            }
            for e in events
        ],
        "total": security_events.count_documents(query)
    })

@admin_bp.get("/players/<player_id>/matches")
def get_player_matches(player_id):
    try:
        pid = ObjectId(player_id)
    except Exception:
        return jsonify({"message": "Invalid player id."}), 400
    
    player_matches = list(matches.find({"user_id": pid}).sort("created_at", -1).limit(50))
    
    return jsonify({
        "matches": [
            {
                "id": str(m["_id"]),
                "date": m["created_at"].isoformat(),
                "duration": m.get("duration", 0),
                "kills": m.get("kills", 0),
                "deaths": m.get("deaths", 0),
                "kd": round(m.get("kills", 0) / max(m.get("deaths", 1), 1), 2),
                "risk_score": m.get("risk_score", 0),
            }
            for m in player_matches
        ]
    })

@admin_bp.get("/players/<player_id>/detections")
def get_player_detections(player_id):
    try:
        pid = ObjectId(player_id)
    except Exception:
        return jsonify({"message": "Invalid player id."}), 400
    
    player_detections = list(security_events.find({"user_id": pid}).sort("created_at", -1).limit(50))
    
    return jsonify({
        "detections": [
            {
                "id": str(d["_id"]),
                "type": d.get("type", "unknown"),
                "severity": d.get("severity", "low"),
                "timestamp": d["created_at"].isoformat(),
                "description": d.get("description", ""),
            }
            for d in player_detections
        ]
    })
