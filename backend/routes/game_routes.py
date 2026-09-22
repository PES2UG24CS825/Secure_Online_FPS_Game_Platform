from datetime import datetime, timedelta, timezone
from functools import wraps

from bson import ObjectId
from flask import Blueprint, jsonify, request, session

from database.db import (detections, login_history, log_security_event, matches, security_events, sessions,
                          telemetry, users, utcnow)
from models.ml_model import FEATURES, predict

game_bp = Blueprint("game", __name__, url_prefix="/api")


def current_user_record():
    user_id = session.get("user_id")
    if not user_id:
        return None
    try:
        user = users.find_one({"_id": ObjectId(user_id)})
    except Exception:
        return None
    if not user:
        session.clear()
        return None
    if user.get("status") == "suspended":
        session.clear()
        return None
    active_session = sessions.find_one({"user_id": user_id, "revoked": False, "expires_at": {"$gt": utcnow()}})
    if not active_session:
        session.clear()
        return None
    return user


def require_auth(func):
    @wraps(func)
    def wrapper(*args, **kwargs):
        user = current_user_record()
        if not user:
            return jsonify({"message": "Authentication required."}), 401
        return func(*args, **kwargs)

    return wrapper


def require_role(required_role):
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            user = current_user_record()
            if not user:
                return jsonify({"message": "Authentication required."}), 401
            if user.get("role") != required_role:
                return jsonify({"message": f"{required_role.title()} access required."}), 403
            return func(*args, **kwargs)

        return wrapper

    return decorator


@game_bp.get("/admin/overview")
@require_role("admin")
def admin_overview():
    players = list(users.find({"role": {"$ne": "admin"}}, {"password_hash": 0, "mfa_secret": 0}).sort("created_at", -1))
    events = list(security_events.find({}).sort("timestamp", -1).limit(100))
    total_matches = matches.count_documents({})
    active_sessions = sessions.count_documents({"role": {"$ne": "admin"}, "revoked": False, "expires_at": {"$gt": utcnow()}})
    active_players = users.count_documents({"status": "active", "role": {"$ne": "admin"}})
    high_severity = security_events.count_documents({"severity": {"$in": ["high", "critical"]}})
    suspicious_players = users.count_documents({"role": {"$ne": "admin"}, "risk_score": {"$gte": 70}})
    login_count = login_history.count_documents({"success": True})

    return jsonify({
        "players": [{
            "id": str(player["_id"]),
            "name": player.get("name"),
            "email": player.get("email"),
            "role": player.get("role", "player"),
            "status": player.get("status", "active"),
            "mfa_enabled": player.get("mfa_enabled", False),
            "risk_score": player.get("risk_score", 0),
            "created_at": player.get("created_at").isoformat() if player.get("created_at") else None,
            "last_login": (login_history.find_one({"user_id": str(player["_id"]), "success": True}, sort=[("timestamp", -1)]) or {}).get("timestamp").isoformat() if login_history.find_one({"user_id": str(player["_id"]), "success": True}, sort=[("timestamp", -1)]) else None,
        } for player in players],
        "events": [{
            "id": str(event.get("_id")),
            "type": event.get("event_type", event.get("type", "security_event")),
            "severity": event.get("severity", "low"),
            "user": event.get("user_id") or event.get("user") or "unknown",
            "description": event.get("description", "Security event recorded."),
            "timestamp": event.get("timestamp").isoformat() if isinstance(event.get("timestamp"), datetime) else event.get("timestamp"),
        } for event in events],
        "summary": {
            "total_players": len(players),
            "active_players": active_players,
            "active_sessions": active_sessions,
            "matches_analyzed": total_matches,
            "security_events": len(events),
            "high_severity_events": high_severity,
            "suspicious_players": suspicious_players,
            "login_count": login_count,
        },
        "login_count": login_count,
    })


@game_bp.get("/admin/players")
@require_role("admin")
def admin_players():
    players = list(users.find({"role": {"$ne": "admin"}}, {"password_hash": 0, "mfa_secret": 0}).sort("created_at", -1))
    rows = []
    for player in players:
        last_login = login_history.find_one({"user_id": str(player["_id"]), "success": True}, sort=[("timestamp", -1)])
        rows.append({
            "id": str(player["_id"]),
            "username": player.get("name"),
            "email": player.get("email"),
            "role": player.get("role", "player"),
            "mfa_status": "Enabled" if player.get("mfa_enabled") else "Disabled",
            "account_status": player.get("status", "active"),
            "created_at": player.get("created_at").isoformat() if player.get("created_at") else None,
            "last_login": last_login.get("timestamp").isoformat() if last_login and last_login.get("timestamp") else None,
            "risk_score": player.get("risk_score", 0),
        })
    return jsonify({"players": rows})


@game_bp.get("/admin/players/<player_id>")
@require_role("admin")
def admin_player_detail(player_id):
    try:
        oid = ObjectId(player_id)
    except Exception:
        return jsonify({"message": "Invalid player id."}), 400
    player = users.find_one({"_id": oid, "role": {"$ne": "admin"}}, {"password_hash": 0, "mfa_secret": 0})
    if not player:
        return jsonify({"message": "Player not found."}), 404

    last_login = login_history.find_one({"user_id": str(player["_id"]), "success": True}, sort=[("timestamp", -1)])
    player_matches = list(matches.find({"player_id": str(player["_id"])}))
    player_detections = list(detections.find({"player_id": str(player["_id"])}).sort("timestamp", -1))
    player_events = list(security_events.find({"user_id": str(player["_id"])}).sort("timestamp", -1))
    active_sessions = list(sessions.find({"user_id": str(player["_id"]), "revoked": False, "expires_at": {"$gt": utcnow()}}).sort("created_at", -1))
    login_events = list(login_history.find({"user_id": str(player["_id"])}).sort("timestamp", -1))

    kills = sum(int(m.get("kills", 0)) for m in player_matches)
    deaths = sum(int(m.get("deaths", 0)) for m in player_matches)
    kd = round(kills / deaths, 2) if deaths else float(kills)
    headshots = sum(int(m.get("headshots", 0)) for m in player_matches)
    shots_fired = sum(int(item.get("shots", 0)) for item in telemetry.find({"player_id": str(player["_id"])}))
    shots_hit = sum(int(item.get("hits", 0)) for item in telemetry.find({"player_id": str(player["_id"])}))
    accuracy = round((shots_hit / shots_fired) * 100, 2) if shots_fired else 0
    headshot_percentage = round((headshots / shots_hit) * 100, 2) if shots_hit else 0

    return jsonify({
        "user": {
            "id": str(player["_id"]),
            "username": player.get("name"),
            "email": player.get("email"),
            "role": player.get("role", "player"),
            "created_at": player.get("created_at").isoformat() if player.get("created_at") else None,
            "mfa_status": "Enabled" if player.get("mfa_enabled") else "Disabled",
            "account_status": player.get("status", "active"),
            "last_login": last_login.get("timestamp").isoformat() if last_login and last_login.get("timestamp") else None,
        },
        "security": {
            "risk_score": player.get("risk_score", 0),
            "security_alerts": len([event for event in player_events if event.get("severity") in {"medium", "high", "critical"}]),
            "detections": [{
                "id": str(item.get("_id")),
                "match_id": item.get("match_id"),
                "type": item.get("detection_type"),
                "severity": item.get("severity"),
                "confidence": item.get("confidence"),
                "timestamp": item.get("timestamp").isoformat() if isinstance(item.get("timestamp"), datetime) else item.get("timestamp"),
                "description": item.get("description"),
                "status": item.get("status", "open"),
            } for item in player_detections],
            "login_history": [{
                "timestamp": item.get("timestamp").isoformat() if item.get("timestamp") else None,
                "success": item.get("success"),
                "ip_address": item.get("ip_address"),
                "authentication_method": item.get("authentication_method"),
                "location": item.get("location"),
            } for item in login_events],
            "active_sessions": [{
                "id": str(item.get("_id")),
                "ip_address": item.get("ip_address"),
                "created_at": item.get("created_at").isoformat() if item.get("created_at") else None,
                "expires_at": item.get("expires_at").isoformat() if item.get("expires_at") else None,
            } for item in active_sessions],
        },
        "gameplay": {
            "total_matches": len(player_matches),
            "kills": kills,
            "deaths": deaths,
            "kd": kd,
            "headshot_percentage": headshot_percentage,
            "accuracy": accuracy,
            "suspicious_matches": len([item for item in player_detections if item.get("severity") in {"high", "critical"}]),
        },
    })


@game_bp.post("/admin/players/<player_id>/<action>")
@require_role("admin")
def admin_player_action(player_id, action):
    if action not in {"activate", "revoke", "suspend", "delete"}:
        return jsonify({"message": "Unsupported action."}), 400
    try:
        oid = ObjectId(player_id)
    except Exception:
        return jsonify({"message": "Invalid player id."}), 400

    player = users.find_one({"_id": oid, "role": {"$ne": "admin"}})
    if not player:
        return jsonify({"message": "Player not found."}), 404

    if action == "delete":
        users.delete_one({"_id": oid})
        matches.delete_many({"player_id": str(oid)})
        detections.delete_many({"player_id": str(oid)})
        telemetry.delete_many({"player_id": str(oid)})
        security_events.delete_many({"user_id": str(oid)})
        login_history.delete_many({"user_id": str(oid)})
        sessions.delete_many({"user_id": str(oid)})
        log_security_event(
            str(oid),
            "account_deleted",
            "critical",
            "Admin deleted player account.",
            ip_address=request.remote_addr or "127.0.0.1",
            source="admin",
            status="success",
        )
        return jsonify({"message": "Player account deleted."})

    if action == "activate":
        users.update_one({"_id": oid}, {"$set": {"status": "active"}})
        log_security_event(
            str(oid),
            "account_activation",
            "medium",
            "Admin activated player account.",
            ip_address=request.remote_addr or "127.0.0.1",
            source="admin",
            status="success",
        )
        return jsonify({"message": "Player account activated."})

    users.update_one({"_id": oid}, {"$set": {"status": "suspended"}})
    sessions.update_many({"user_id": str(oid)}, {"$set": {"revoked": True, "revoked_at": utcnow(), "status": "revoked"}})
    log_security_event(
        str(oid),
        "account_suspension",
        "high",
        f"Admin suspended player account ({action}).",
        ip_address=request.remote_addr or "127.0.0.1",
        source="admin",
        status="success",
    )
    return jsonify({"message": f"Player account {action}d."})


@game_bp.get("/admin/security-events")
@require_role("admin")
def admin_security_events():
    filters = {}
    if request.args.get("player"):
        filters["user_id"] = request.args.get("player")
    if request.args.get("severity"):
        filters["severity"] = request.args.get("severity")
    if request.args.get("event_type"):
        filters["event_type"] = request.args.get("event_type")
    if request.args.get("date"):
        filters["timestamp"] = {"$gte": datetime.fromisoformat(request.args.get("date"))}

    rows = list(security_events.find(filters).sort("timestamp", -1).limit(200))
    return jsonify({
        "events": [{
            "id": str(item.get("_id")),
            "timestamp": item.get("timestamp").isoformat() if isinstance(item.get("timestamp"), datetime) else item.get("timestamp"),
            "event_type": item.get("event_type"),
            "user": item.get("user_id"),
            "severity": item.get("severity"),
            "description": item.get("description"),
            "ip_address": item.get("ip_address"),
            "source": item.get("source", "platform"),
            "status": item.get("status", "recorded"),
        } for item in rows],
    })


@game_bp.get("/admin/game-monitoring")
@require_role("admin")
def admin_game_monitoring():
    active_matches = list(matches.find({"status": "active"}))
    active_sessions = sessions.count_documents({"role": "player", "revoked": False, "expires_at": {"$gt": utcnow()}})
    recent_telemetry = list(telemetry.find({"timestamp": {"$gte": utcnow() - timedelta(minutes=5)}}))
    active_match_ids = {item.get("match_id") for item in active_matches}
    for item in recent_telemetry:
        if item.get("match_id") not in active_match_ids:
            active_matches.append({
                "match_id": item.get("match_id"),
                "game_id": item.get("game_id", "fps-microgame"),
                "player_id": item.get("player_id"),
                "start_time": item.get("timestamp"),
                "status": "active",
            })
            active_match_ids.add(item.get("match_id"))
    total_matches = matches.count_documents({})
    detection_count = detections.count_documents({})
    suspicion_total = sum(float(item.get("risk_score", item.get("confidence", 0)) or 0) for item in detections.find({}))
    suspicion_rate = round((suspicion_total / detection_count) * 100, 2) if detection_count else 0
    return jsonify({
        "active_games": [{
            "match_id": item.get("match_id"),
            "game_id": item.get("game_id", "fps-microgame"),
            "player_id": item.get("player_id"),
            "started_at": item.get("start_time").isoformat() if isinstance(item.get("start_time"), datetime) else item.get("start_time"),
        } for item in active_matches],
        "total_matches": total_matches,
        "average_suspicion_rate": suspicion_rate,
        "detections": detection_count,
        "supported_games": [{"id": "fps-microgame", "name": "FPS Microgame", "status": "available"}],
        "active_player_count": len({item.get("player_id") for item in active_matches if item.get("player_id")}) or active_sessions,
    })


@game_bp.get("/admin/sessions")
@require_role("admin")
def admin_sessions():
    rows = list(sessions.find({"revoked": False, "expires_at": {"$gt": utcnow()}}).sort("created_at", -1))
    return jsonify({
        "sessions": [{
            "id": str(item.get("_id")),
            "user_id": item.get("user_id"),
            "role": item.get("role"),
            "ip_address": item.get("ip_address"),
            "created_at": item.get("created_at").isoformat() if item.get("created_at") else None,
            "expires_at": item.get("expires_at").isoformat() if item.get("expires_at") else None,
        } for item in rows],
    })


@game_bp.get("/dashboard")
@require_role("player")
def dashboard():
    user_id = session["user_id"]
    player_matches = list(matches.find({"player_id": user_id}).sort("start_time", -1).limit(10))
    recent_detections = list(detections.find({"player_id": user_id}).sort("timestamp", -1).limit(10))
    alerts = list(security_events.find({"user_id": user_id}).sort("timestamp", -1).limit(10))

    return jsonify({
        "stats": {
            "matches_analyzed": len(player_matches),
            "security_alerts": len([a for a in alerts if a.get("severity") in {"medium", "high", "critical"}]),
            "mfa_enabled": bool(users.find_one({"_id": ObjectId(user_id)}, {"mfa_enabled": 1}).get("mfa_enabled")),
            "account_status": users.find_one({"_id": ObjectId(user_id)}, {"status": 1}).get("status", "active"),
            "recent_detections": len(recent_detections),
            "recent_security_activity": len(alerts),
            "risk_score": users.find_one({"_id": ObjectId(user_id)}, {"risk_score": 1}).get("risk_score", 0),
        },
        "recent_detections": [{
            "detection_id": str(item.get("_id")),
            "detection_type": item.get("detection_type", "anomaly_detected"),
            "severity": item.get("severity", "low"),
            "confidence": item.get("confidence", 0),
            "description": item.get("description", "Gameplay anomaly detected."),
            "timestamp": item.get("timestamp").isoformat() if isinstance(item.get("timestamp"), datetime) else item.get("timestamp"),
        } for item in recent_detections],
        "alerts": [{
            "type": a.get("event_type", "security_event"),
            "severity": a.get("severity", "low"),
            "description": a.get("description", "Security alert."),
            "created_at": a.get("timestamp").isoformat() if isinstance(a.get("timestamp"), datetime) else a.get("timestamp"),
        } for a in alerts],
        "matches": [{
            "match_id": m.get("match_id"),
            "status": m.get("status", "completed"),
            "duration": m.get("duration_seconds"),
            "kills": m.get("kills", 0),
            "deaths": m.get("deaths", 0),
            "accuracy": m.get("accuracy", 0),
            "headshots": m.get("headshots", 0),
            "risk_score": m.get("risk_score", 0),
            "start_time": m.get("start_time").isoformat() if isinstance(m.get("start_time"), datetime) else m.get("start_time"),
        } for m in player_matches],
    })


@game_bp.get("/player/matches")
@require_role("player")
def player_matches():
    user_id = session["user_id"]
    rows = list(matches.find({"player_id": user_id}).sort("start_time", -1))
    response = []
    for row in rows:
        telemetry_rows = list(telemetry.find({"player_id": user_id, "match_id": row.get("match_id")}))
        shots_fired = sum(int(item.get("shots", 0)) for item in telemetry_rows)
        shots_hit = sum(int(item.get("hits", 0)) for item in telemetry_rows)
        suspicious_events = len(list(security_events.find({"user_id": user_id, "metadata.match_id": row.get("match_id")})))
        killings = row.get("kills", sum(int(item.get("kills", 0)) for item in telemetry_rows))
        deaths = row.get("deaths", sum(int(item.get("deaths", 0)) for item in telemetry_rows))
        headshots = row.get("headshots", sum(int(item.get("headshots", 0)) for item in telemetry_rows))
        headshot_percentage = round((headshots / shots_hit) * 100, 2) if shots_hit else 0
        accuracy = row.get("accuracy", round((shots_hit / shots_fired) * 100, 2) if shots_fired else 0)
        kd = round((killings / deaths), 2) if deaths else float(killings)
        response.append({
            "match_id": row.get("match_id"),
            "date": row.get("start_time").isoformat() if isinstance(row.get("start_time"), datetime) else row.get("start_time"),
            "duration": row.get("duration_seconds"),
            "kills": killings,
            "deaths": deaths,
            "kd": kd,
            "headshots": headshots,
            "headshot_percentage": headshot_percentage,
            "accuracy": accuracy,
            "shots_fired": shots_fired,
            "shots_hit": shots_hit,
            "suspicious_events": suspicious_events,
            "risk_score": row.get("risk_score", 0),
            "status": row.get("status", "completed"),
        })
    return jsonify({"matches": response})


@game_bp.get("/player/detections")
@require_role("player")
def player_detections():
    user_id = session["user_id"]
    rows = list(detections.find({"player_id": user_id}).sort("timestamp", -1))
    return jsonify({
        "detections": [{
            "detection_id": str(item.get("_id")),
            "match_id": item.get("match_id"),
            "detection_type": item.get("detection_type", "anomaly_detected"),
            "severity": item.get("severity", "low"),
            "confidence_score": item.get("confidence", 0),
            "timestamp": item.get("timestamp").isoformat() if isinstance(item.get("timestamp"), datetime) else item.get("timestamp"),
            "description": item.get("description", "Detected anomaly."),
            "status": item.get("status", "open"),
            "risk_score": item.get("risk_score", item.get("confidence", 0)),
        } for item in rows],
    })


@game_bp.get("/player/security")
@require_role("player")
def player_security():
    user_id = session["user_id"]
    user = users.find_one({"_id": ObjectId(user_id)}, {"password_hash": 0, "mfa_secret": 0})
    active_sessions = list(sessions.find({"user_id": user_id, "revoked": False, "expires_at": {"$gt": utcnow()}}).sort("created_at", -1))
    history_rows = list(login_history.find({"user_id": user_id}).sort("timestamp", -1))
    last_login = login_history.find_one({"user_id": user_id, "success": True}, sort=[("timestamp", -1)])
    return jsonify({
        "mfa_status": "enabled" if user.get("mfa_enabled") else "disabled",
        "active_sessions": [{
            "id": str(item.get("_id")),
            "ip_address": item.get("ip_address"),
            "user_agent": item.get("user_agent"),
            "created_at": item.get("created_at").isoformat() if item.get("created_at") else None,
            "expires_at": item.get("expires_at").isoformat() if item.get("expires_at") else None,
        } for item in active_sessions],
        "login_history": [{
            "timestamp": item.get("timestamp").isoformat() if isinstance(item.get("timestamp"), datetime) else item.get("timestamp"),
            "success": item.get("success"),
            "authentication_method": item.get("authentication_method", "mfa"),
            "ip_address": item.get("ip_address"),
            "location": item.get("location"),
        } for item in history_rows],
        "last_login": last_login.get("timestamp").isoformat() if last_login and last_login.get("timestamp") else None,
        "password_status": "Protected" if user.get("password_hash") else "Needs reset",
        "account_status": user.get("status", "active"),
    })


@game_bp.get("/player/login-history")
@require_role("player")
def player_login_history():
    user_id = session["user_id"]
    rows = list(login_history.find({"user_id": user_id}).sort("timestamp", -1))
    return jsonify({
        "login_history": [{
            "timestamp": row.get("timestamp").isoformat() if isinstance(row.get("timestamp"), datetime) else row.get("timestamp"),
            "success": row.get("success", True),
            "authentication_method": row.get("authentication_method", "mfa"),
            "ip_address": row.get("ip_address", "127.0.0.1"),
            "location": row.get("location", "Localhost"),
        } for row in rows],
    })


@game_bp.get("/player/security-status")
@require_role("player")
def player_security_status():
    user_id = session["user_id"]
    user = users.find_one({"_id": ObjectId(user_id)}, {"password_hash": 0, "mfa_secret": 0})
    last_login = login_history.find_one({"user_id": user_id, "success": True}, sort=[("timestamp", -1)])
    return jsonify({
        "status": user.get("status", "active"),
        "mfa_enabled": user.get("mfa_enabled", False),
        "last_login": last_login.get("timestamp").isoformat() if last_login and last_login.get("timestamp") else None,
    })


@game_bp.post("/telemetry")
@require_role("player")
def collect_telemetry():
    user_id = session["user_id"]
    payload = request.get_json(silent=True) or {}
    item = {
        "player_id": user_id,
        "match_id": payload.get("match_id") or "manual-match",
        "game_id": payload.get("game_id", "fps-microgame"),
        "timestamp": datetime.now(timezone.utc),
        "kills": payload.get("kills", 0),
        "deaths": payload.get("deaths", 0),
        "shots": payload.get("shots", 0),
        "hits": payload.get("hits", 0),
        "headshots": payload.get("headshots", 0),
        "accuracy": payload.get("accuracy", 0),
        "movement": payload.get("movement", {}),
        "gameplay_events": payload.get("gameplay_events", []),
        "created_at": datetime.now(timezone.utc),
    }
    telemetry.insert_one(item)
    return jsonify({"message": "Telemetry stored."})


@game_bp.post("/matches")
@require_role("player")
def create_match():
    user_id = session["user_id"]
    payload = request.get_json(silent=True) or {}
    match_id = payload.get("match_id") or f"match-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}"
    preview = {
        "match_id": match_id,
        "player_id": user_id,
        "game_id": payload.get("game_id", "fps-microgame"),
        "status": payload.get("status", "active"),
        "start_time": payload.get("start_time") or datetime.now(timezone.utc),
        "end_time": payload.get("end_time"),
        "duration_seconds": payload.get("duration_seconds", 0),
        "kills": payload.get("kills", 0),
        "deaths": payload.get("deaths", 0),
        "accuracy": payload.get("accuracy", 0),
        "headshots": payload.get("headshots", 0),
        "risk_score": payload.get("risk_score", 0),
        "created_at": datetime.now(timezone.utc),
    }
    matches.update_one({"match_id": match_id}, {"$set": preview}, upsert=True)
    return jsonify({"match_id": match_id, "status": preview["status"]})


@game_bp.post("/detect")
@require_role("player")
def detect():
    user_id = session["user_id"]
    data = request.get_json(silent=True) or {}
    features = data.get("features", {})

    missing = [name for name in FEATURES if name not in features]
    if missing:
        return jsonify({"message": f"Missing features: {', '.join(missing)}"}), 400

    try:
        result = predict(features)
    except (TypeError, ValueError) as exc:
        return jsonify({"message": f"Invalid feature values: {exc}"}), 400

    timestamp = datetime.now(timezone.utc)
    detection_record = {
        "player_id": user_id,
        "match_id": data.get("match_id") or "manual-detection",
        "detection_type": "anomaly_detected",
        "severity": "medium" if result.get("risk_score", 0) >= 0.5 else "low",
        "confidence": result.get("risk_score", 0),
        "risk_score": result.get("risk_score", 0),
        "description": "Gameplay anomaly detected and reviewed by the security model.",
        "timestamp": timestamp,
        "created_at": timestamp,
        "status": "open",
        "result": result,
    }
    detections.insert_one(detection_record)

    if result.get("random_forest") == "cheater" or result.get("isolation_forest") == "anomaly":
        security_events.insert_one({
            "user_id": user_id,
            "event_type": "gameplay_anomaly",
            "severity": "high" if result.get("random_forest") == "cheater" else "medium",
            "confidence": result.get("risk_score", 0),
            "description": "Suspicious behaviour pattern was detected using ML telemetry analysis.",
            "result": result,
            "timestamp": timestamp,
            "created_at": timestamp,
            "risk_score": result.get("risk_score", 0),
            "status": "open",
            "source": "ml_model",
            "metadata": {"match_id": data.get("match_id") or "manual-detection"},
        })

    return jsonify(result)
