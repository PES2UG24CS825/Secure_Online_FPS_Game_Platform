from datetime import datetime, timezone, timedelta
from flask import Blueprint, jsonify, request, session
from bson import ObjectId

from database.db import (
    users, matches, security_events, login_history, sessions_db,
    game_sessions, game_events, game_telemetry, honour_history, reward_transactions, db
)
from services.risk_scoring import clamp_risk_score, classify_risk_score
from services.auth_security import log_admin_action, admin_audit_log

admin_bp = Blueprint("admin", __name__, url_prefix="/api/admin")


def current_admin_id():
    return session.get("user_id")


def current_admin():
    admin_id = current_admin_id()
    if not admin_id:
        return None
    try:
        return users.find_one({"_id": ObjectId(admin_id), "role": {"$in": ["admin", "demo_admin"]}})
    except Exception:
        return None


def format_iso(dt):
    if not dt:
        return None
    if isinstance(dt, str):
        return dt
    if hasattr(dt, "isoformat"):
        return dt.isoformat()
    return str(dt)


@admin_bp.before_request
def check_admin_access():
    if request.method == "OPTIONS":
        return None
    if not current_admin():
        return jsonify({"message": "Admin authorization required."}), 403


# =========================================================================
# ADMIN OVERVIEW
# =========================================================================

@admin_bp.get("/overview")
def overview():
    all_users = list(users.find({"role": {"$nin": ["admin", "demo_admin"]}}, {"password_hash": 0, "mfa_secret": 0}))
    all_events = list(security_events.find().sort("created_at", -1).limit(100))
    all_game_sessions = list(game_sessions.find().sort("created_at", -1).limit(100))
    all_legacy_matches = list(matches.find().sort("created_at", -1).limit(50))

    user_name_map = {str(u["_id"]): u.get("name", "Operator") for u in all_users}

    formatted_matches = []
    for s in all_game_sessions:
        uid = str(s.get("user_id", ""))
        pname = user_name_map.get(uid, s.get("player_name", "Operator"))
        started_dt = s.get("started_at") or s.get("created_at")
        risk = s.get("risk_score")
        if risk is None:
            ana = game_events.find_one({"session_id": s.get("session_id"), "analysis_type": "game_session"}, {"risk_score": 1})
            if ana:
                risk = ana.get("risk_score")
        formatted_matches.append({
            "session_id": s.get("session_id", str(s["_id"])),
            "player_id": uid,
            "player_name": pname,
            "game": s.get("game", "CyberStrike 3D"),
            "started_at": format_iso(started_dt),
            "status": s.get("status", "completed"),
            "risk_score": clamp_risk_score(risk) if risk is not None else None,
            "risk_category": classify_risk_score(risk)["category"] if risk is not None else "Normal",
        })

    for m in all_legacy_matches:
        uid = str(m.get("user_id", ""))
        pname = user_name_map.get(uid, "Player")
        c_dt = m.get("created_at")
        formatted_matches.append({
            "session_id": str(m["_id"]),
            "player_id": uid,
            "player_name": pname,
            "game": "FPS Microgame",
            "started_at": format_iso(c_dt),
            "status": "completed",
            "risk_score": m.get("risk_score"),
        })

    total_matches_count = game_sessions.count_documents({}) + matches.count_documents({})
    high_severity_count = security_events.count_documents({"severity": {"$in": ["high", "critical"]}})
    active_sessions_count = sessions_db.count_documents({"is_active": True})

    return jsonify({
        "stats": {
            "total_players": len(all_users),
            "active_sessions": active_sessions_count,
            "matches_analyzed": total_matches_count,
            "security_events": len(all_events),
            "high_severity_events": high_severity_count,
        },
        "matches": formatted_matches,
        "players": [
            {
                "id": str(u["_id"]),
                "name": u.get("name", "Unknown"),
                "email": u.get("email", ""),
                "mfa_enabled": u.get("mfa_enabled", False),
                "created_at": format_iso(u.get("created_at")),
                "risk_score": u.get("risk_score", 0),
                "account_status": u.get("account_status") or ("suspended" if u.get("revoked") else "active"),
                "honour_score": u.get("honour_score", 100),
            }
            for u in all_users
        ],
        "events": [
            {
                "id": str(e["_id"]),
                "type": e.get("type", "unknown"),
                "severity": e.get("severity", "low"),
                "timestamp": format_iso(e.get("created_at")),
                "description": e.get("description", ""),
            }
            for e in all_events[:20]
        ],
        "summary": {
            "total_players": len(all_users),
            "active_sessions": active_sessions_count,
            "matches_analyzed": total_matches_count
        }
    })


# =========================================================================
# PLAYER MANAGEMENT & DETAIL
# =========================================================================

@admin_bp.get("/players")
def list_players():
    search = (request.args.get("q") or "").strip().lower()
    status_filter = (request.args.get("status") or "").strip().lower()
    limit = max(1, min(request.args.get("limit", 100, type=int), 200))
    offset = max(0, request.args.get("offset", 0, type=int))

    query = {"role": {"$nin": ["admin", "demo_admin"]}}
    if search:
        query["$or"] = [
            {"name": {"$regex": search, "$options": "i"}},
            {"email": {"$regex": search, "$options": "i"}}
        ]
    if status_filter in {"active", "suspended", "banned"}:
        if status_filter == "suspended":
            query["$or"] = [{"account_status": "suspended"}, {"revoked": True}]
        elif status_filter == "banned":
            query["account_status"] = "banned"
        elif status_filter == "active":
            query["$and"] = [
                {"account_status": {"$nin": ["suspended", "banned"]}},
                {"revoked": {"$ne": True}}
            ]

    all_players = list(
        users.find(query, {"password_hash": 0, "mfa_secret": 0})
        .sort("created_at", -1)
        .skip(offset)
        .limit(limit)
    )

    player_rows = []
    for p in all_players:
        pid = p["_id"]
        c1 = game_sessions.count_documents({"user_id": pid, "status": "completed"})
        c2 = matches.count_documents({"user_id": pid})
        matches_count = c1 + c2

        kills = game_telemetry.count_documents({"user_id": pid, "event_type": "enemy_killed"})
        deaths = game_telemetry.count_documents({"user_id": pid, "event_type": "player_death"})
        kdr = round(kills / max(deaths, 1), 2)

        # Retrieve latest risk score & category
        latest_analysis = game_events.find_one(
            {"user_id": pid, "analysis_type": "game_session", "status": "success"},
            sort=[("created_at", -1)]
        ) or {}
        raw_score = latest_analysis.get("risk_score")
        if raw_score is not None:
            clamped = clamp_risk_score(raw_score)
            classification = classify_risk_score(clamped)
            risk_score = clamped
            risk_category = classification["category"]
        else:
            risk_score = None
            risk_category = "Not analysed"

        recent_login = login_history.find_one(
            {"user_id": pid, "type": "login_success"},
            sort=[("created_at", -1)]
        )

        acc_status = p.get("account_status") or ("suspended" if p.get("revoked") else "active")

        # Fetch last 5 matches for this player with full statistics
        recent_sessions = list(game_sessions.find({"user_id": pid, "status": "completed"}).sort("created_at", -1).limit(5))
        recent_matches_list = []
        for s in recent_sessions:
            sid = s.get("session_id", str(s["_id"]))
            s_kills = game_telemetry.count_documents({"user_id": pid, "session_id": sid, "event_type": "enemy_killed"})
            s_deaths = game_telemetry.count_documents({"user_id": pid, "session_id": sid, "event_type": "player_death"})
            s_ana = game_events.find_one({"session_id": sid, "analysis_type": "game_session"}) or {}
            s_risk = s.get("risk_score") if s.get("risk_score") is not None else s_ana.get("risk_score")
            s_cat = classify_risk_score(s_risk)["category"] if s_risk is not None else "Normal"
            s_acc = s.get("accuracy")
            if s_acc is None:
                s_acc = s_ana.get("raw_features", {}).get("accuracy")
            raw_k = s_ana.get("raw_features", {}).get("kills", 0)
            raw_d = s_ana.get("raw_features", {}).get("deaths", 0)
            final_k = s_kills if s_kills > 0 else raw_k
            final_d = s_deaths if s_deaths > 0 else raw_d
            duration_s = None
            if s.get("ended_at") and s.get("started_at"):
                try:
                    duration_s = int((s["ended_at"] - s["started_at"]).total_seconds())
                except Exception:
                    pass
            recent_matches_list.append({
                "session_id": sid,
                "short_id": sid[:8] if len(sid) >= 8 else sid,
                "game": s.get("game", "CyberStrike 3D"),
                "date": format_iso(s.get("ended_at") or s.get("started_at") or s.get("created_at")),
                "duration_seconds": duration_s,
                "kills": final_k,
                "deaths": final_d,
                "kdr": round(final_k / max(1, final_d), 2),
                "accuracy": round(float(s_acc or 0) * 100, 1) if s_acc is not None else 0.0,
                "risk_score": round(float(s_risk), 1) if s_risk is not None else None,
                "risk_category": s_cat,
                "result": s.get("winner", "Victory" if final_k >= 25 else "Completed")
            })

        # Calculate comprehensive Account Security Score (0 - 100)
        sec_points = 0
        if p.get("mfa_enabled"):
            sec_points += 30
        if p.get("email_verified"):
            sec_points += 25
        if acc_status == "active":
            sec_points += 25
        h_score = p.get("honour_score", 100)
        sec_points += int(min(20, round(h_score * 0.2)))
        if risk_score is not None and risk_score >= 80:
            sec_points = max(0, sec_points - 30)
        elif risk_score is not None and risk_score >= 50:
            sec_points = max(0, sec_points - 15)

        sec_level = "Excellent" if sec_points >= 85 else ("Good" if sec_points >= 65 else ("Fair" if sec_points >= 40 else "At Risk"))

        player_rows.append({
            "id": str(pid),
            "name": p.get("name", "Unknown"),
            "email": p.get("email", ""),
            "role": p.get("role", "player"),
            "account_status": acc_status,
            "email_verified": p.get("email_verified", False),
            "mfa_enabled": p.get("mfa_enabled", False),
            "honour_score": p.get("honour_score", 100),
            "account_security_score": sec_points,
            "account_security_level": sec_level,
            "matches_played": matches_count,
            "kills": kills,
            "deaths": deaths,
            "kdr": kdr,
            "accuracy": round(float(latest_analysis.get("raw_features", {}).get("accuracy", 0) or 0) * 100, 1),
            "risk_score": risk_score,
            "risk_category": risk_category,
            "recent_matches": recent_matches_list,
            "last_login": format_iso(recent_login.get("created_at")) if recent_login else None,
            "created_at": format_iso(p.get("created_at")),
        })

    return jsonify({
        "players": player_rows,
        "total": users.count_documents(query),
        "limit": limit,
        "offset": offset
    })


@admin_bp.get("/players/<player_id>")
def get_player_details(player_id):
    try:
        pid = ObjectId(player_id)
    except Exception:
        return jsonify({"message": "Invalid player ID format."}), 400

    player = users.find_one({"_id": pid}, {"password_hash": 0, "mfa_secret": 0})
    if not player:
        return jsonify({"message": "Player not found."}), 404

    # 1. Matches & stats
    p_sessions = list(game_sessions.find({"user_id": pid, "status": "completed"}).sort("created_at", -1))
    legacy_matches = list(matches.find({"user_id": pid}).sort("created_at", -1))
    total_matches = len(p_sessions) + len(legacy_matches)

    kills = game_telemetry.count_documents({"user_id": pid, "event_type": "enemy_killed"})
    deaths = game_telemetry.count_documents({"user_id": pid, "event_type": "player_death"})
    kdr = round(kills / max(deaths, 1), 2)

    # 2. Latest ML analysis
    latest_analysis = game_events.find_one(
        {"user_id": pid, "analysis_type": "game_session", "status": "success"},
        sort=[("created_at", -1)]
    ) or {}
    raw_score = latest_analysis.get("risk_score")
    risk_score = clamp_risk_score(raw_score) if raw_score is not None else None
    risk_category = classify_risk_score(risk_score)["category"] if risk_score is not None else "Not analysed"

    # 3. Honour history
    honour_logs = list(honour_history.find(
        {"$or": [{"user_id": pid}, {"player_id": str(pid)}]}
    ).sort("timestamp", -1).limit(20))

    # 4. Rewards history
    reward_logs = list(reward_transactions.find({"user_id": pid}).sort("created_at", -1).limit(20))

    # 5. Login history & active sessions
    logins = list(login_history.find({"user_id": pid}).sort("created_at", -1).limit(20))
    active_devices = list(sessions_db.find({"user_id": pid, "is_active": True}).sort("last_activity", -1).limit(10))

    # 6. Security & ML events
    sec_events = list(security_events.find({"user_id": pid}).sort("created_at", -1).limit(20))
    ml_analyses = list(game_events.find({"user_id": pid, "analysis_type": "game_session"}).sort("created_at", -1).limit(20))

    # 7. Admin audit logs on this player
    audit_records = list(admin_audit_log.find({"target_user_id": pid}).sort("timestamp", -1).limit(20))

    # Format recent 5 matches
    recent_five = []
    for s in p_sessions[:5]:
        sid = s.get("session_id", "")
        s_kills = game_telemetry.count_documents({"user_id": pid, "session_id": sid, "event_type": "enemy_killed"})
        s_deaths = game_telemetry.count_documents({"user_id": pid, "session_id": sid, "event_type": "player_death"})
        s_ana = game_events.find_one({"session_id": sid, "analysis_type": "game_session"}) or {}
        recent_five.append({
            "session_id": sid,
            "game": s.get("game", "CyberStrike 3D"),
            "started_at": format_iso(s.get("started_at")),
            "kills": s_kills,
            "deaths": s_deaths,
            "kdr": round(s_kills / max(s_deaths, 1), 2),
            "result": s.get("winner", "Completed"),
            "risk_score": s_ana.get("risk_score"),
            "status": s.get("status")
        })

    return jsonify({
        "account_info": {
            "id": str(player["_id"]),
            "name": player.get("name", "Unknown"),
            "email": player.get("email", ""),
            "role": player.get("role", "player"),
            "account_status": player.get("account_status") or ("suspended" if player.get("revoked") else "active"),
            "email_verified": player.get("email_verified", False),
            "mfa_enabled": player.get("mfa_enabled", False),
            "honour_score": player.get("honour_score", 100),
            "created_at": format_iso(player.get("created_at")),
        },
        "stats": {
            "total_matches": total_matches,
            "kills": kills,
            "deaths": deaths,
            "kdr": kdr,
            "risk_score": risk_score,
            "risk_category": risk_category,
        },
        "recent_matches": recent_five,
        "honour_history": [
            {
                "session_id": h.get("session_id"),
                "previous_score": h.get("previous_score"),
                "new_score": h.get("new_score"),
                "points_delta": h.get("points_delta"),
                "reason": h.get("reason"),
                "timestamp": format_iso(h.get("timestamp")),
                "is_automatic": h.get("is_automatic", True)
            }
            for h in honour_logs
        ],
        "reward_history": [
            {
                "type": r.get("type"),
                "description": r.get("description"),
                "coins": r.get("coins", 0),
                "xp": r.get("xp", 0),
                "timestamp": format_iso(r.get("created_at"))
            }
            for r in reward_logs
        ],
        "login_history": [
            {
                "type": l.get("type"),
                "ip_address": l.get("ip_address") or l.get("ip"),
                "device": l.get("device"),
                "status": l.get("status"),
                "timestamp": format_iso(l.get("created_at"))
            }
            for l in logins
        ],
        "active_sessions": [
            {
                "ip_address": s.get("ip_address") or s.get("ip"),
                "device": s.get("device"),
                "last_activity": format_iso(s.get("last_activity"))
            }
            for s in active_devices
        ],
        "security_events": [
            {
                "type": e.get("type"),
                "severity": e.get("severity"),
                "description": e.get("description"),
                "timestamp": format_iso(e.get("created_at"))
            }
            for e in sec_events
        ],
        "ml_analyses": [
            {
                "session_id": a.get("session_id"),
                "risk_score": a.get("risk_score"),
                "risk_category": a.get("risk_category"),
                "status": a.get("status"),
                "timestamp": format_iso(a.get("created_at"))
            }
            for a in ml_analyses
        ],
        "audit_records": [
            {
                "action": ar.get("action"),
                "admin_email": ar.get("admin_email"),
                "timestamp": format_iso(ar.get("timestamp")),
                "details": ar.get("details")
            }
            for ar in audit_records
        ]
    })


# =========================================================================
# ADMINISTRATIVE ENFORCEMENT ACTIONS (Audited)
# =========================================================================

@admin_bp.post("/players/<player_id>/suspend")
def suspend_player(player_id):
    try:
        pid = ObjectId(player_id)
    except Exception:
        return jsonify({"message": "Invalid player ID format."}), 400

    admin = current_admin()
    res = users.update_one(
        {"_id": pid, "role": {"$ne": "admin"}},
        {"$set": {"account_status": "suspended", "revoked": True, "suspended_at": datetime.now(timezone.utc)}}
    )
    if res.matched_count == 0:
        return jsonify({"message": "Player not found or cannot suspend admin."}), 404

    # Revoke all active sessions immediately
    sessions_db.update_many({"user_id": pid}, {"$set": {"is_active": False, "revoked_at": datetime.now(timezone.utc)}})

    # Record security event and admin audit log
    now = datetime.now(timezone.utc)
    security_events.insert_one({
        "type": "account_suspended",
        "user_id": pid,
        "severity": "high",
        "description": f"Account suspended by admin ({admin['email']})",
        "created_at": now
    })
    log_admin_action(admin["_id"], admin["email"], pid, "suspend_player")

    return jsonify({"success": True, "message": f"Player {player_id} has been suspended."})


@admin_bp.post("/players/<player_id>/unsuspend")
def unsuspend_player(player_id):
    try:
        pid = ObjectId(player_id)
    except Exception:
        return jsonify({"message": "Invalid player ID format."}), 400

    admin = current_admin()
    res = users.update_one(
        {"_id": pid, "role": {"$ne": "admin"}},
        {"$set": {"account_status": "active", "revoked": False, "unsuspended_at": datetime.now(timezone.utc)},
         "$unset": {"ban_until": ""}}
    )
    if res.matched_count == 0:
        return jsonify({"message": "Player not found."}), 404

    log_admin_action(admin["_id"], admin["email"], pid, "unsuspend_player")
    return jsonify({"success": True, "message": f"Player {player_id} has been unsuspended."})


@admin_bp.post("/players/<player_id>/ban")
def ban_player(player_id):
    try:
        pid = ObjectId(player_id)
    except Exception:
        return jsonify({"message": "Invalid player ID format."}), 400

    admin = current_admin()
    res = users.update_one(
        {"_id": pid, "role": {"$ne": "admin"}},
        {"$set": {"account_status": "banned", "revoked": True, "banned_at": datetime.now(timezone.utc)}}
    )
    if res.matched_count == 0:
        return jsonify({"message": "Player not found or cannot ban admin."}), 404

    sessions_db.update_many({"user_id": pid}, {"$set": {"is_active": False, "revoked_at": datetime.now(timezone.utc)}})
    log_admin_action(admin["_id"], admin["email"], pid, "ban_player")
    return jsonify({"success": True, "message": f"Player {player_id} has been permanently banned."})


@admin_bp.post("/players/<player_id>/unban")
def unban_player(player_id):
    try:
        pid = ObjectId(player_id)
    except Exception:
        return jsonify({"message": "Invalid player ID format."}), 400

    admin = current_admin()
    res = users.update_one(
        {"_id": pid, "role": {"$ne": "admin"}},
        {"$set": {"account_status": "active", "revoked": False, "unbanned_at": datetime.now(timezone.utc)},
         "$unset": {"ban_until": ""}}
    )
    if res.matched_count == 0:
        return jsonify({"message": "Player not found."}), 404

    log_admin_action(admin["_id"], admin["email"], pid, "unban_player")
    return jsonify({"success": True, "message": f"Player {player_id} has been unbanned."})


@admin_bp.post("/players/<player_id>/delete")
def delete_player(player_id):
    try:
        pid = ObjectId(player_id)
    except Exception:
        return jsonify({"message": "Invalid player ID format."}), 400

    admin = current_admin()
    res = users.delete_one({"_id": pid, "role": {"$ne": "admin"}})
    if res.deleted_count == 0:
        return jsonify({"message": "Player not found or cannot delete admin."}), 404

    sessions_db.delete_many({"user_id": pid})
    log_admin_action(admin["_id"], admin["email"], pid, "delete_player")
    return jsonify({"success": True, "message": f"Player {player_id} deleted."})


# =========================================================================
# ADMIN AUDIT LOG & REWARDS MANAGEMENT
# =========================================================================

@admin_bp.get("/audit-log")
def get_audit_log():
    limit = max(1, min(request.args.get("limit", 50, type=int), 100))
    logs = list(admin_audit_log.find().sort("timestamp", -1).limit(limit))
    return jsonify({
        "audit_logs": [
            {
                "id": str(l["_id"]),
                "admin_email": l.get("admin_email"),
                "target_user_id": str(l.get("target_user_id", "")),
                "action": l.get("action"),
                "details": l.get("details"),
                "timestamp": format_iso(l.get("timestamp")),
            }
            for l in logs
        ]
    })


@admin_bp.get("/rewards/balances")
def get_reward_balances():
    search = (request.args.get("q") or "").strip().lower()
    query = {"role": {"$ne": "admin"}}
    if search:
        query["$or"] = [
            {"name": {"$regex": search, "$options": "i"}},
            {"email": {"$regex": search, "$options": "i"}}
        ]
    all_players = list(users.find(query, {"name": 1, "email": 1, "rewards": 1, "honour_score": 1}).limit(100))
    return jsonify({
        "balances": [
            {
                "id": str(p["_id"]),
                "name": p.get("name", "Unknown"),
                "email": p.get("email", ""),
                "coins": p.get("rewards", {}).get("coins", 0),
                "xp": p.get("rewards", {}).get("xp", 0),
                "honour_score": p.get("honour_score", 100),
                "daily_streak": p.get("rewards", {}).get("daily_streak", 0),
            }
            for p in all_players
        ]
    })
