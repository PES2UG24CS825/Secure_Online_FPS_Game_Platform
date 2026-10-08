import base64
import binascii
from datetime import datetime, timezone
from flask import Blueprint, jsonify, request, session
from bson import ObjectId

from database.db import (
    game_events,
    game_sessions,
    game_telemetry,
    users,
    matches,
    security_events,
    login_history,
    sessions_db,
)

player_bp = Blueprint("player", __name__, url_prefix="/api/player")

def current_user():
    return session.get("user_id")

def get_user_role():
    user_id = current_user()
    if not user_id:
        return None
    user = users.find_one({"_id": ObjectId(user_id)})
    # Accounts created before roles were persisted are player accounts.
    return user.get("role", "player") if user else None

@player_bp.before_request
def check_player_access():
    # Browsers send OPTIONS preflights before cross-origin JSON requests.
    # Let Flask-CORS answer those without requiring a player session; the
    # actual GET/POST/PUT requests still go through the role check below.
    if request.method == "OPTIONS":
        return None
    if get_user_role() != "player":
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
        "created_at": user["created_at"].isoformat() if user.get("created_at") else None,
        "profile_customization": user.get("profile_customization", {
            "avatar": "initial",
            "banner": "midnight",
        }),
    })


@player_bp.put("/profile/customization")
def update_profile_customization():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401

    data = request.get_json(silent=True) or {}
    avatar = data.get("avatar")
    banner = data.get("banner")
    avatar_image = data.get("avatar_image") or None
    banner_image = data.get("banner_image") or None
    allowed_avatars = {"initial", "shield", "target", "bolt"}
    allowed_banners = {"midnight", "arctic", "ember", "forest"}
    if avatar_image:
        avatar = "custom"
    if banner_image:
        banner = "custom"
    if avatar not in allowed_avatars | {"custom"} or banner not in allowed_banners | {"custom"}:
        return jsonify({"message": "Choose an available avatar and banner."}), 400

    def valid_image_data(value):
        if value is None:
            return True
        if not isinstance(value, str) or len(value) > 720_000:
            return False
        try:
            header, encoded = value.split(",", 1)
            if header not in {"data:image/jpeg;base64", "data:image/png;base64", "data:image/webp;base64"}:
                return False
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error):
            return False
        if len(raw) > 512_000:
            return False
        signatures = {
            "data:image/jpeg;base64": raw.startswith(b"\xff\xd8\xff"),
            "data:image/png;base64": raw.startswith(b"\x89PNG\r\n\x1a\n"),
            "data:image/webp;base64": len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP",
        }
        return signatures.get(header, False)

    if not valid_image_data(avatar_image) or not valid_image_data(banner_image):
        return jsonify({"message": "Upload a valid JPG, PNG, or WebP image under 512 KB."}), 400

    customization = {
        "avatar": avatar,
        "banner": banner,
        "avatar_image": avatar_image,
        "banner_image": banner_image,
    }
    result = users.update_one(
        {"_id": ObjectId(user_id)},
        {"$set": {"profile_customization": customization}},
    )
    if not result.matched_count:
        return jsonify({"message": "Player account not found."}), 404
    return jsonify({"message": "Profile appearance saved.", "profile_customization": customization})

@player_bp.get("/matches")
def get_matches():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401
    
    user_oid = ObjectId(user_id)
    player_matches = list(game_sessions.find({"user_id": user_oid}).sort("started_at", -1))
    analyses = {}
    for item in game_events.find(
        {"user_id": user_oid, "analysis_type": "game_session"}
    ).sort("created_at", -1):
        if item.get("session_id"):
            analyses.setdefault(item["session_id"], item)

    def event_count(session_id, event_type):
        return game_telemetry.count_documents({
            "user_id": user_oid,
            "session_id": session_id,
            "event_type": event_type,
        })

    result_matches = []
    for game_session in player_matches:
        session_id = game_session.get("session_id", "")
        analysis = analyses.get(session_id, {})
        result = analysis.get("result") or {}
        raw = analysis.get("raw_features") or {}
        started_at = game_session.get("started_at") or game_session.get("created_at")
        ended_at = game_session.get("ended_at")
        duration = None
        if started_at and ended_at:
            if started_at.tzinfo is None and ended_at.tzinfo is not None:
                started_at = started_at.replace(tzinfo=ended_at.tzinfo)
            elif ended_at.tzinfo is None and started_at.tzinfo is not None:
                ended_at = ended_at.replace(tzinfo=started_at.tzinfo)
            duration = max(0, int((ended_at - started_at).total_seconds()))
        kills = event_count(session_id, "enemy_killed")
        deaths = event_count(session_id, "player_death")
        result_matches.append({
            "id": session_id,
            "match_id": session_id[:8] if session_id else str(game_session.get("_id", ""))[-8:],
            "date": started_at.isoformat() if started_at else None,
            "duration": duration,
            "game": game_session.get("game", "FPS Microgame"),
            "status": game_session.get("status", "unknown"),
            "kills": kills,
            "deaths": deaths,
            "kd": round(kills / max(deaths, 1), 2),
            "accuracy": round(float(raw.get("accuracy", 0) or 0) * 100, 1),
            "risk_score": analysis.get("risk_score", result.get("risk_score")),
            "analysis_status": analysis.get("status", "pending"),
            "missing_features": analysis.get("missing_features", []),
            "analysis_error": analysis.get("error"),
        })
    
    return jsonify({
        "matches": result_matches,
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
                "timestamp": d["created_at"].isoformat() if d.get("created_at") else None,
                "description": d.get("description", ""),
                "status": d.get("status", "detected"),
                "risk_score": d.get("risk_score"),
            }
            for d in detections
        ]
    })

@player_bp.get("/security")
def get_security_summary():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401

    user_oid = ObjectId(user_id)
    user = users.find_one({"_id": user_oid}) or {}
    recent_login = login_history.find_one(
        {"user_id": user_oid, "type": "login_success"},
        sort=[("created_at", -1)],
    )
    logins = list(login_history.find(
        {"user_id": user_oid, "type": "login_success"}
    ).sort("created_at", -1).limit(50))
    active_sessions = list(sessions_db.find(
        {"user_id": user_oid, "is_active": True}
    ).sort("last_activity", -1).limit(20))
    latest_analysis = game_events.find_one(
        {"user_id": user_oid, "analysis_type": "game_session", "status": "success"},
        sort=[("created_at", -1)],
    ) or {}
    latest_result = latest_analysis.get("result") or {}
    risk_score = latest_analysis.get("risk_score", latest_result.get("risk_score"))

    return jsonify({
        "mfa_status": "enabled" if user.get("mfa_enabled") else "disabled",
        "account_status": "suspended" if user.get("revoked") else "active",
        "risk_score": risk_score,
        "last_login": recent_login["created_at"].isoformat() if recent_login and recent_login.get("created_at") else None,
        "active_sessions": [
            {
                "ip_address": item.get("ip_address", item.get("ip", "Unknown")),
                "device": item.get("device", "Unknown device"),
                "created_at": item["created_at"].isoformat() if item.get("created_at") else None,
                "last_activity": item.get("last_activity", item.get("created_at")).isoformat()
                    if item.get("last_activity", item.get("created_at")) else None,
            }
            for item in active_sessions
        ],
        "login_history": [
            {
                "timestamp": item["created_at"].isoformat() if item.get("created_at") else None,
                "ip_address": item.get("ip_address", item.get("ip", "Unknown")),
                "authentication_method": item.get("authentication_method", "password+mfa"),
                "success": item.get("status", "success") == "success",
            }
            for item in logins
        ],
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

@player_bp.get("/login-history")
def get_login_history():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401

    user_oid = ObjectId(user_id)
    history = list(
        login_history.find({"user_id": user_oid}).sort("created_at", -1).limit(50)
    )
    return jsonify({
        "login_history": [
            {
                "timestamp": item["created_at"].isoformat()
                if item.get("created_at") else None,
                "ip_address": item.get("ip_address", item.get("ip", "Unknown")),
                "authentication_method": item.get(
                    "authentication_method", "password+mfa"
                ),
                "success": item.get("status", "success") == "success",
            }
            for item in history
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
