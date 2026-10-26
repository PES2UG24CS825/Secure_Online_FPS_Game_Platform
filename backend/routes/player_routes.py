import base64
import binascii
from datetime import datetime, timezone, timedelta
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
    support_tickets,
    reward_transactions,
)

REWARD_STORE = {
    "guardian_badge": {"name": "Guardian badge", "description": "A shield badge for your player profile.", "price": 100, "icon": "⬡"},
    "marksman_badge": {"name": "Marksman badge", "description": "A reticle badge for your player profile.", "price": 180, "icon": "◎"},
    "elite_badge": {"name": "Elite sentinel badge", "description": "A premium SecureFPS profile badge.", "price": 300, "icon": "✦"},
}

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
    player_account = users.find_one(
        {"_id": user_oid},
        {"hacker_profile": 1, "account_type": 1},
    ) or {}
    total_matches = game_sessions.count_documents({"user_id": user_oid})
    player_matches = list(game_sessions.find({"user_id": user_oid}).sort("started_at", -1).limit(10))
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
            "headshot_ratio": raw.get("headshot_ratio"),
            "risk_score": analysis.get("risk_score", result.get("risk_score")),
            "analysis_status": analysis.get("status", "pending"),
            "missing_features": analysis.get("missing_features", []),
            "analysis_error": analysis.get("error"),
            "alert_severity": analysis.get("alert_severity"),
            "enforcement_action": analysis.get("enforcement_action") or game_session.get("enforcement_action"),
            "enforcement_state": analysis.get("enforcement_state") or game_session.get("enforcement_state"),
            "hacker_profile": player_account.get("hacker_profile"),
            "demo_test": player_account.get("account_type") == "demo_test",
        })
    
    return jsonify({
        "matches": result_matches,
        "total_matches": total_matches,
    })


@player_bp.get("/leaderboard")
def get_leaderboard():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401

    risk_by_user = {
        item["_id"]: item.get("average_risk")
        for item in game_events.aggregate([
            {"$match": {"analysis_type": "game_session", "risk_score": {"$type": "number"}}},
            {"$group": {"_id": "$user_id", "average_risk": {"$avg": "$risk_score"}}},
        ])
    }
    players = []
    for user in users.find(
        {"role": {"$ne": "admin"}},
        {"name": 1},
    ):
        completed_sessions = list(game_sessions.find(
            {"user_id": user["_id"], "status": "completed"},
            {"session_id": 1},
        ))
        session_ids = [item.get("session_id") for item in completed_sessions if item.get("session_id")]
        kills = game_telemetry.count_documents({"user_id": user["_id"], "session_id": {"$in": session_ids}, "event_type": "enemy_killed"}) if session_ids else 0
        deaths = game_telemetry.count_documents({"user_id": user["_id"], "session_id": {"$in": session_ids}, "event_type": "player_death"}) if session_ids else 0
        accuracy_values = [
            float(item.get("raw_features", {}).get("accuracy", 0) or 0)
            for item in game_events.find(
                {"user_id": user["_id"], "analysis_type": "game_session", "session_id": {"$in": session_ids}},
                {"raw_features.accuracy": 1},
            )
            if item.get("raw_features", {}).get("accuracy") is not None
        ]
        matches_played = len(completed_sessions)
        kd = round(kills / max(deaths, 1), 2)
        accuracy = round((sum(accuracy_values) / len(accuracy_values)) * 100, 1) if accuracy_values else 0
        performance = round((kills * 3) + (kd * 10) + (accuracy * 0.25), 1)
        players.append({
            "id": str(user["_id"]),
            "name": user.get("name", "Player"),
            "matches": matches_played,
            "kills": kills,
            "deaths": deaths,
            "kd": kd,
            "accuracy": accuracy,
            "performance": performance,
            "average_risk": round(float(risk_by_user.get(user["_id"], 0) or 0), 1),
        })

    players = [
        item for item in players
        if item["matches"] > 0
        and item["name"].strip().lower() not in {"live check", "test", "test player", "demo player"}
    ]
    players.sort(key=lambda item: (-item["performance"], -item["kills"], -item["matches"], item["name"].lower()))
    for rank, player in enumerate(players, start=1):
        player["rank"] = rank

    current_id = str(user_id)
    current_player = next((item for item in players if item["id"] == current_id), None)
    return jsonify({
        "leaderboard": players[:10],
        "current_player": current_player,
        "total_ranked": len(players),
    })


@player_bp.get("/rewards")
def get_rewards():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401
    user_oid = ObjectId(user_id)
    user = users.find_one({"_id": user_oid}, {"rewards": 1}) or {}
    rewards = user.get("rewards") or {}
    transactions = list(reward_transactions.find({"user_id": user_oid}).sort("created_at", -1).limit(10))
    return jsonify({
        "coins": int(rewards.get("coins", 0)),
        "xp": int(rewards.get("xp", 0)),
        "level": int(rewards.get("xp", 0)) // 250 + 1,
        "daily_streak": int(rewards.get("daily_streak", 0)),
        "last_daily_login": rewards.get("last_daily_login"),
        "owned_items": rewards.get("owned_items", []),
        "equipped_item": rewards.get("equipped_item"),
        "store": [{"id": item_id, **item} for item_id, item in REWARD_STORE.items()],
        "transactions": [{
            "type": item.get("type", "reward"),
            "description": item.get("description", "Reward earned"),
            "coins": item.get("coins", 0),
            "xp": item.get("xp", 0),
            "created_at": item["created_at"].isoformat() if item.get("created_at") else None,
        } for item in transactions],
    })


@player_bp.post("/rewards/claim-daily")
def claim_daily_reward():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401
    user_oid = ObjectId(user_id)
    today = datetime.now(timezone.utc).date()
    today_key = today.isoformat()
    user = users.find_one({"_id": user_oid}, {"rewards": 1}) or {}
    rewards = user.get("rewards") or {}
    previous_key = rewards.get("last_daily_login")
    if previous_key == today_key:
        return jsonify({"claimed": False, "message": "Today's login reward is already claimed."})

    yesterday_key = (today - timedelta(days=1)).isoformat()
    streak = int(rewards.get("daily_streak", 0)) + 1 if previous_key == yesterday_key else 1
    condition = {"_id": user_oid}
    if previous_key:
        condition["rewards.last_daily_login"] = previous_key
    else:
        condition["rewards.last_daily_login"] = {"$exists": False}
    claimed_at = datetime.now(timezone.utc)
    result = users.update_one(condition, {
        "$inc": {"rewards.coins": 25, "rewards.xp": 25},
        "$set": {"rewards.last_daily_login": today_key, "rewards.daily_streak": streak},
    })
    if not result.modified_count:
        return jsonify({"claimed": False, "message": "Today's login reward is already claimed."})
    reward_transactions.insert_one({
        "user_id": user_oid,
        "type": "daily_login",
        "description": "Daily login bonus",
        "coins": 25,
        "xp": 25,
        "created_at": claimed_at,
    })
    updated = users.find_one({"_id": user_oid}, {"rewards.coins": 1, "rewards.xp": 1}) or {}
    updated_rewards = updated.get("rewards") or {}
    return jsonify({"claimed": True, "coins_earned": 25, "xp_earned": 25, "coins": updated_rewards.get("coins", 25), "xp": updated_rewards.get("xp", 25), "daily_streak": streak})


@player_bp.post("/rewards/purchase")
def purchase_reward_item():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401
    data = request.get_json(silent=True) or {}
    item_id = data.get("item_id")
    if not isinstance(item_id, str):
        return jsonify({"message": "That store item is not available."}), 404
    item = REWARD_STORE.get(item_id)
    if not item:
        return jsonify({"message": "That store item is not available."}), 404
    user_oid = ObjectId(user_id)
    result = users.update_one(
        {"_id": user_oid, "rewards.coins": {"$gte": item["price"]}, "rewards.owned_items": {"$ne": item_id}},
        {"$inc": {"rewards.coins": -item["price"]}, "$addToSet": {"rewards.owned_items": item_id}},
    )
    if not result.modified_count:
        user = users.find_one({"_id": user_oid}, {"rewards": 1}) or {}
        rewards = user.get("rewards") or {}
        if item_id in rewards.get("owned_items", []):
            return jsonify({"message": "You already own this badge."}), 409
        return jsonify({"message": "You do not have enough coins for this badge."}), 409
    reward_transactions.insert_one({"user_id": user_oid, "type": "purchase", "description": f"Purchased {item['name']}", "coins": -item["price"], "xp": 0, "created_at": datetime.now(timezone.utc)})
    return jsonify({"message": f"Purchased {item['name']}.", "item_id": item_id})


@player_bp.post("/rewards/equip")
def equip_reward_item():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401
    item_id = (request.get_json(silent=True) or {}).get("item_id")
    if item_id is not None and (not isinstance(item_id, str) or item_id not in REWARD_STORE):
        return jsonify({"message": "That badge is not available."}), 404
    user_oid = ObjectId(user_id)
    query = {"_id": user_oid}
    update = {"$unset": {"rewards.equipped_item": ""}}
    if item_id:
        query["rewards.owned_items"] = item_id
        update = {"$set": {"rewards.equipped_item": item_id}}
    result = users.update_one(query, update)
    if not result.matched_count:
        return jsonify({"message": "Purchase this badge before equipping it."}), 409
    return jsonify({"message": "Profile badge updated.", "equipped_item": item_id})


@player_bp.route("/support/tickets", methods=["GET", "POST"])
def player_support_tickets():
    user_id = current_user()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401
    user_oid = ObjectId(user_id)
    if request.method == "GET":
        tickets = list(support_tickets.find({"user_id": user_oid}).sort("created_at", -1).limit(30))
        return jsonify({"tickets": [{
            "id": str(ticket["_id"]),
            "category": ticket.get("category", "other"),
            "message": ticket.get("message", ""),
            "status": ticket.get("status", "open"),
            "admin_reply": ticket.get("admin_reply"),
            "attachment_name": (ticket.get("attachment") or {}).get("name"),
            "created_at": ticket["created_at"].isoformat() if ticket.get("created_at") else None,
            "replied_at": ticket["replied_at"].isoformat() if ticket.get("replied_at") else None,
        } for ticket in tickets]})

    data = request.get_json(silent=True) or {}
    category = data.get("category", "other")
    message = data.get("message", "")
    allowed_categories = {"account", "match", "security", "rewards", "other"}
    if not isinstance(category, str) or category not in allowed_categories or not isinstance(message, str) or not message.strip() or len(message) > 3000:
        return jsonify({"message": "Choose a topic and enter a message up to 3000 characters."}), 400
    message = message.strip()
    attachment_data = data.get("attachment")
    attachment = None
    if attachment_data is not None:
        if not isinstance(attachment_data, dict):
            return jsonify({"message": "Invalid attachment."}), 400
        mime = attachment_data.get("mime_type")
        data_url = attachment_data.get("data_url")
        name = str(attachment_data.get("name", "proof"))[:120]
        if not isinstance(mime, str) or mime not in {"image/png", "image/jpeg", "image/webp"} or not isinstance(data_url, str) or len(data_url) > 900_000:
            return jsonify({"message": "Attach a PNG, JPG, or WebP image up to 650 KB."}), 400
        try:
            header, encoded = data_url.split(",", 1)
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error):
            return jsonify({"message": "The attachment could not be read."}), 400
        valid_header = header == f"data:{mime};base64"
        signatures = {"image/png": raw.startswith(b"\x89PNG\r\n\x1a\n"), "image/jpeg": raw.startswith(b"\xff\xd8\xff"), "image/webp": len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP"}
        if not valid_header or len(raw) > 650_000 or not signatures[mime]:
            return jsonify({"message": "The image must be a valid PNG, JPG, or WebP smaller than 650 KB."}), 400
        attachment = {"name": name, "mime_type": mime, "data_url": data_url}

    user = users.find_one({"_id": user_oid}, {"name": 1, "email": 1}) or {}
    ticket = {"user_id": user_oid, "player_name": user.get("name", "Player"), "player_email": user.get("email", ""), "category": category, "message": message, "attachment": attachment, "status": "open", "created_at": datetime.now(timezone.utc)}
    inserted = support_tickets.insert_one(ticket)
    try:
        from routes.game_routes import publish_live_update
        publish_live_update(user_oid, None, "support_ticket_created", force=True)
    except Exception:
        pass
    return jsonify({"message": "Your message was sent to admin.", "ticket_id": str(inserted.inserted_id)}), 201

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
    warnings = list(security_events.find(
        {"user_id": user_oid, "type": "gameplay_alert_review", "action": "warn"}
    ).sort("created_at", -1).limit(10))
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
        "account_status": user.get("account_status") or ("suspended" if user.get("revoked") else "active"),
        "security_warnings": [
            {
                "note": item.get("note", "A gameplay security warning was recorded."),
                "created_at": item["created_at"].isoformat() if item.get("created_at") else None,
            }
            for item in warnings
        ],
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
