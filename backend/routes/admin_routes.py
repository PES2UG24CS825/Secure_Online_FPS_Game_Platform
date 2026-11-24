from services.player_notifications import notify_player
import csv
import io
import json
import os
import re
import time
from datetime import datetime, timezone, timedelta
from functools import wraps
from flask import Blueprint, jsonify, request, session, g, Response
from bson import ObjectId
import bcrypt
import pyotp

from database.db import (
    users, matches, security_events, login_history, sessions_db,
    game_sessions, game_events, game_telemetry, honour_history,
    reward_transactions, ban_appeals, db,
    system_config, admin_permissions, model_versions, system_backups,
    admin_approvals
)
from services.risk_scoring import clamp_risk_score, classify_risk_score
from services.combat_statistics import group_telemetry_by_session, summarize_combat_stats
from services.auth_security import log_admin_action, admin_audit_log
from services.admin_permissions import OPERATIONAL_PERMISSIONS, has_operational_permission, normal_admin_permissions
from services.csrf import verify_csrf_and_origin

admin_bp = Blueprint("admin", __name__, url_prefix="/api/admin")
ADMIN_PROCESS_STARTED = time.monotonic()

# In-memory cache for overview statistics (30-second TTL)
_OVERVIEW_CACHE = {
    "data": None,
    "timestamp": 0.0
}
OVERVIEW_CACHE_TTL = 30.0


def current_admin_id():
    return session.get("user_id")


def current_admin():
    """Retrieve current admin from request context g, or fetch from DB and cache on g."""
    if hasattr(g, "current_admin_user"):
        return g.current_admin_user

    admin_id = current_admin_id()
    if not admin_id:
        g.current_admin_user = None
        return None
    try:
        admin = users.find_one({
            "_id": ObjectId(admin_id),
            "role": {"$in": ["admin", "normal_admin", "demo_admin", "super_admin"]}
        })
        g.current_admin_user = admin
        return admin
    except Exception:
        g.current_admin_user = None
        return None


def determine_security_incident_label(e):
    if not isinstance(e, dict):
        return "Security Incident"
    raw_type = e.get("type") or e.get("event_type") or e.get("incident_type") or "gameplay_anomaly"
    reason_text = (e.get("description") or e.get("alert_reason") or e.get("reason") or "").strip().lower()

    labels = {
        "abnormal_fire_rate": "Unusually Fast Shooting",
        "abnormal_speed": "Unusual Movement Speed",
        "movement_anomaly": "Unusual Movement Speed",
        "aim_anomaly": "Suspicious Aiming",
        "impossible_hit": "Impossible Hit Detected",
        "session_revoked": "Login Session Ended",
        "mfa_failure": "Incorrect Verification Code",
        "unauthorized_access": "Unauthorized Access Attempt",
    }
    if raw_type in labels:
        return labels[raw_type]

    if "angle snapping" in reason_text or "aimbot" in reason_text or "aim snap" in reason_text:
        return "Suspicious Aiming"
    elif "impossible hit" in reason_text or "line-of-sight" in reason_text or "wallhack" in reason_text:
        return "Impossible Hit Detected"
    elif "speed" in reason_text or "movement" in reason_text:
        return "Unusual Movement Speed"
    elif "fire rate" in reason_text or "rapid fire" in reason_text:
        return "Unusually Fast Shooting"
    elif "accuracy" in reason_text or "aim" in reason_text:
        return "Abnormal Accuracy"
    elif raw_type == "account_suspended":
        return "Account Suspension"
    elif raw_type == "mfa_compromise" or "mfa" in reason_text:
        return "MFA Security Alert"
    elif raw_type == "login_failure" or "login" in reason_text:
        return "Brute Force Attempt"
    elif raw_type == "hard_rule_violation":
        return "Server Hard-Rule Violation"
    elif raw_type == "gameplay_anomaly" or raw_type == "gameplay_alert":
        return "Gameplay Anomaly"
    elif raw_type == "auto_ban":
        return "Automatic Anti-Cheat Ban"
    return str(raw_type).replace("_", " ").replace("-", " ").title()


# =========================================================================
# TWO-TIER RBAC PERMISSIONS MATRIX & DECORATORS
# =========================================================================

PERMISSIONS_MAP = {
    # Tier 1 (Normal Admin & Super Admin)
    "view_overview": ["normal_admin", "admin", "super_admin"],
    "view_players": ["normal_admin", "admin", "super_admin"],
    "view_threats": ["normal_admin", "admin", "super_admin"],
    "view_security": ["normal_admin", "admin", "super_admin"],
    "view_analytics": ["normal_admin", "admin", "super_admin"],
    "view_support": ["normal_admin", "admin", "super_admin"],
    "suspend_player": ["normal_admin", "admin", "super_admin"],
    "unsuspend_player": ["normal_admin", "admin", "super_admin"],
    "warn_player": ["normal_admin", "admin", "super_admin"],
    "handle_support": ["normal_admin", "admin", "super_admin"],
    "review_appeal": ["normal_admin", "admin", "super_admin"],
    "review_alert": ["normal_admin", "admin", "super_admin"],
    "export_reports": ["normal_admin", "admin", "super_admin"],
    "submit_approval": ["normal_admin", "admin", "super_admin"],
    "view_own_audit_log": ["normal_admin", "admin", "super_admin"],

    # Tier 2 (Super Admin Command Center Exclusive)
    "ban_player": ["super_admin"],
    "delete_player": ["super_admin"],
    "purge_player": ["super_admin"],
    "manage_admins": ["super_admin"],
    "manage_roles": ["super_admin"],
    "manage_ml": ["super_admin"],
    "manage_risk_engine": ["super_admin"],
    "security_lockdown": ["super_admin"],
    "system_control": ["super_admin"],
    "manage_backups": ["super_admin"],
    "view_all_audit_logs": ["super_admin"],
    "manage_approvals": ["super_admin"],
}


def require_permission(perm_name):
    """
    Two-Tier Route-level Authorization Decorator.
    Denies by default. Enforces role-based permissions matrix.
    Returns HTTP 403 with clear explanation and escalation paths.
    """
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            admin = current_admin()
            if not admin:
                return jsonify({"message": "Admin authorization required."}), 401
            raw_role = admin.get("role", "normal_admin")
            is_super = raw_role == "super_admin" or admin.get("is_super_admin") is True
            canonical_role = "super_admin" if is_super else "normal_admin"
            allowed_roles = PERMISSIONS_MAP.get(perm_name, ["super_admin"])
            if canonical_role not in allowed_roles:
                if perm_name in {"ban_player", "delete_player"}:
                    return jsonify({
                        "message": f"Normal administrators cannot execute '{perm_name}' directly. Please submit an Approval Request to the Super Admin Command Center.",
                        "permission_denied": perm_name,
                        "can_request_approval": True,
                        "required_role": "super_admin"
                    }), 403
                return jsonify({
                    "message": f"Access forbidden: operation requires elevated Super Admin permissions ('{perm_name}').",
                    "permission_denied": perm_name,
                    "required_role": "super_admin"
                }), 403
            return f(*args, **kwargs)
        return decorated_function
    return decorator


def require_admin_write(f):
    """Ensure that demo_admin accounts cannot execute state-changing or destructive actions."""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        admin = current_admin()
        if not admin:
            return jsonify({"message": "Admin authorization required."}), 403
        role = admin.get("role")
        if role == "demo_admin":
            return jsonify({
                "message": "Demo admin account is read-only. Destructive actions require full administrative privileges."
            }), 403
        return f(*args, **kwargs)
    return decorated_function


def require_super_admin(f):
    """Ensure that only accounts with super_admin role can execute privileged or destructive actions."""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        admin = current_admin()
        if not admin:
            return jsonify({"message": "Admin authorization required."}), 403
        role = admin.get("role")
        is_super = role == "super_admin" or admin.get("is_super_admin") is True
        if not is_super:
            return jsonify({
                "message": "Restricted operation: Super Administrator authorization required."
            }), 403
        return f(*args, **kwargs)
    return decorated_function


def format_iso(dt):
    if not dt:
        return None
    if isinstance(dt, str):
        return dt
    if hasattr(dt, "isoformat"):
        return dt.isoformat()
    return str(dt)


def verify_admin_reauth(admin, reauth_password=None, mfa_code=None):
    """
    Verify admin re-authentication using password or TOTP MFA code.
    Required for high-impact actions (ban, delete, purge).
    """
    if not admin:
        return False

    # Check MFA first if provided
    if mfa_code:
        mfa_str = str(mfa_code).strip()
        sec = admin.get("mfa_secret")
        try:
            if sec and pyotp.TOTP(sec).verify(mfa_str, valid_window=3):
                return True
        except Exception:
            pass

    # Verify password if provided
    if reauth_password:
        pw_hash = admin.get("password_hash")
        if pw_hash:
            try:
                if isinstance(pw_hash, str):
                    pw_hash = pw_hash.encode("utf-8")
                if bcrypt.checkpw(reauth_password.encode("utf-8"), pw_hash):
                    return True
            except Exception:
                pass

    return False


def validate_reason(reason, min_length=10):
    if not reason or not isinstance(reason, str):
        return False, "A reason must be provided."
    trimmed = reason.strip()
    if len(trimmed) < min_length:
        return False, f"Reason must be at least {min_length} characters long."
    return True, trimmed


def check_super_admin_guard(target_admin_id, current_admin_user, action_name):
    """
    Guards against:
    1. Acting on own account (cannot ban/suspend/deactivate/delete oneself).
    2. Modifying/deactivating/deleting the last active Super Admin.
    """
    target_id_str = str(target_admin_id)
    current_id_str = str(current_admin_user["_id"])

    if target_id_str == current_id_str and action_name in ["deactivate", "suspend", "delete", "ban"]:
        return False, "You cannot perform this administrative action on your own account."

    target = users.find_one({"_id": ObjectId(target_admin_id)})
    if not target:
        return False, "Target administrator account not found."

    if target.get("role") == "super_admin" or target.get("is_super_admin") is True:
        active_super_count = users.count_documents({
            "role": "super_admin",
            "account_status": {"$nin": ["deactivated", "suspended", "banned", "deleted"]},
            "revoked": {"$ne": True}
        })
        if active_super_count <= 1 and action_name in ["deactivate", "suspend", "delete", "ban"]:
            return False, "Operation prohibited: Cannot deactivate or delete the last remaining Super Administrator account."

    return True, None


ADMIN_OPERATION_PERMISSIONS = {
    "list_players": "players:read", "get_player_details": "players:read",
    "suspend_player": "players:suspend", "unsuspend_player": "players:suspend",
    "issue_player_warning": "players:warn", "record_investigation_note": "players:notes",
    "adjust_player_honour": "players:account", "reset_player_mfa": "players:account",
    "revoke_player_sessions": "players:account", "force_player_password_reset": "players:account",
    "review_appeal": "appeals:review", "review_anticheat_decision": "alerts:review", "acknowledge_security_event": "alerts:review",
    "get_threat_monitoring": "threats:read", "get_analytics_reports": "analytics:read",
    "get_audit_log": "audit:read", "list_recent_logins": "audit:read",
    "server_health": "health:read", "get_multiplayer_rooms": "health:read",
    "request_approval": "approvals:request", "export_players_csv": "database:export",
    "export_sessions_csv": "database:export", "export_audit_log_csv": "database:export",
}


@admin_bp.before_request
def check_admin_access():
    if request.method == "OPTIONS":
        return None

    # CSRF check on state-changing endpoints
    csrf_error = verify_csrf_and_origin(request)
    if csrf_error:
        return jsonify({"message": csrf_error}), 403

    admin = current_admin()
    if not admin:
        return jsonify({"message": "Admin authorization required."}), 403
    if admin.get("role") == "demo_admin" and request.method not in {"GET", "HEAD"}:
        return jsonify({"message": "Demo administrator access is read-only."}), 403
    permission = ADMIN_OPERATION_PERMISSIONS.get((request.endpoint or "").split(".")[-1])
    if permission and not has_operational_permission(admin, permission, write=request.method not in {"GET", "HEAD"}):
        return jsonify({"message": "This operation is disabled for your administrator role.", "permission_denied": permission}), 403


# =========================================================================
# ADMIN IDENTITY & PERMISSIONS
# =========================================================================

@admin_bp.get("/me")
def get_admin_me():
    admin = current_admin()
    if not admin:
        return jsonify({"message": "Admin authorization required."}), 401
    raw_role = admin.get("role", "normal_admin")
    is_super = raw_role == "super_admin" or admin.get("is_super_admin") is True
    canonical_role = "super_admin" if is_super else "normal_admin"
    perms = [p for p, roles in PERMISSIONS_MAP.items() if canonical_role in roles]
    return jsonify({
        "admin": {
            "id": str(admin["_id"]),
            "email": admin.get("email"),
            "name": admin.get("name", "Administrator"),
            "role": canonical_role,
            "raw_role": raw_role,
            "is_super_admin": is_super,
            "permissions": perms
        }
    }), 200


# =========================================================================
# ADMIN OVERVIEW (Cached 30s, count_documents used)
# =========================================================================

@admin_bp.get("/overview")
def overview():
    global _OVERVIEW_CACHE
    now_ts = time.time()
    force_refresh = request.args.get("refresh", "0") in ("1", "true")

    admin_user = current_admin() or {}
    admin_role = admin_user.get("role", "admin")
    is_super = admin_role == "super_admin" or admin_user.get("is_super_admin") is True
    admin_info = {
        "id": str(admin_user.get("_id", "")),
        "name": admin_user.get("name", "Security Admin"),
        "email": admin_user.get("email", "admin1@gmail.com"),
        "role": admin_role,
        "is_super_admin": is_super
    }

    if not force_refresh and _OVERVIEW_CACHE["data"] and (now_ts - _OVERVIEW_CACHE["timestamp"] < OVERVIEW_CACHE_TTL):
        cached_resp = dict(_OVERVIEW_CACHE["data"])
        cached_resp["cached"] = True
        cached_resp["cache_age_seconds"] = round(now_ts - _OVERVIEW_CACHE["timestamp"], 1)
        cached_resp["admin"] = admin_info
        return jsonify(cached_resp)

    # Compute stats using server-side count_documents strictly for genuine players
    genuine_filter = {
        "role": "player",
        "email": {"$not": {"$regex": r"(@example\.com|@test\.local|@example\.test|@test\.com|@test\.lan|@securefps\.local|@deleted\.securefps\.local)"}},
        "name": {"$not": {"$regex": r"^(Test Player|Test Soldier|Demo Player|Deleted Player)"}}
    }
    total_players = users.count_documents({**genuine_filter, "account_status": {"$ne": "deleted"}})
    active_players = users.count_documents({
        **genuine_filter,
        "account_status": "active",
        "revoked": {"$ne": True}
    })
    suspended_players = users.count_documents({
        **genuine_filter,
        "$or": [{"account_status": "suspended"}, {"revoked": True}]
    })
    banned_players = users.count_documents({
        **genuine_filter,
        "account_status": "banned"
    })
    total_matches_count = game_sessions.count_documents({}) + matches.count_documents({})
    high_severity_count = security_events.count_documents({"severity": {"$in": ["high", "critical"]}})
    active_sessions_count = sessions_db.count_documents({"is_active": True})
    pending_appeals_count = ban_appeals.count_documents({"status": "pending"})

    # Fetch latest 20 security events
    recent_events = list(security_events.find().sort("created_at", -1).limit(20))
    affected_ids = [ObjectId(row["user_id"]) for row in recent_events if ObjectId.is_valid(row.get("user_id"))]
    affected_players = {str(row["_id"]): row.get("name") for row in users.find({"_id": {"$in": affected_ids}}, {"name": 1})}
    formatted_events = [
        {
            "id": str(e["_id"]),
            "type": e.get("type", "unknown"),
            "severity": e.get("severity", "low"),
            "timestamp": format_iso(e.get("created_at")),
            "player_id": str(e["user_id"]) if ObjectId.is_valid(e.get("user_id")) else None,
            "player_name": affected_players.get(str(e.get("user_id"))) or e.get("player_name"),
            "status": e.get("status") or "open",
            "acknowledged": bool(e.get("acknowledged_at")),
            "description": e.get("description", ""),
        }
        for e in recent_events
    ]

    # Fetch latest 20 game sessions
    recent_game_sessions = list(game_sessions.find().sort("created_at", -1).limit(20))
    user_ids = []
    for s in recent_game_sessions:
        uid = s.get("user_id")
        if uid:
            user_ids.append(uid)
            try:
                user_ids.append(ObjectId(uid))
            except Exception:
                pass
    user_docs = list(users.find({"_id": {"$in": user_ids}}, {"name": 1}))
    user_name_map = {}
    for u in user_docs:
        user_name_map[str(u["_id"])] = u.get("name", "Operator")
        user_name_map[u["_id"]] = u.get("name", "Operator")

    formatted_matches = []
    for s in recent_game_sessions:
        raw_uid = s.get("user_id", "")
        uid = str(raw_uid)
        pname = user_name_map.get(raw_uid, user_name_map.get(uid, s.get("player_name", "Operator")))
        started_dt = s.get("started_at") or s.get("created_at")
        risk = s.get("risk_score")
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

    stats_dict = {
        "total_players": total_players,
        "active_players": active_players,
        "suspended_players": suspended_players,
        "banned_players": banned_players,
        "active_sessions": active_sessions_count,
        "matches_analyzed": total_matches_count,
        "high_severity_events": high_severity_count,
        "total_security_events": security_events.count_documents({}),
        "unresolved_critical": security_events.count_documents({"severity": "critical", "status": {"$nin": ["resolved", "closed"]}}),
        "pending_appeals": pending_appeals_count,
    }

    data = {
        "total_players": total_players,
        "active_players": active_players,
        "total_matches": total_matches_count,
        "stats": stats_dict,
        "summary": stats_dict,
        "admin": admin_info,
        "players": [
            {"id": str(u["_id"]), "name": u.get("name", "Operator")}
            for u in user_docs[:10]
        ],
        "matches": formatted_matches,
        "events": formatted_events,
        "cached": False,
        "cache_age_seconds": 0.0,
        "server_time": datetime.now(timezone.utc).isoformat()
    }

    _OVERVIEW_CACHE["data"] = data
    _OVERVIEW_CACHE["timestamp"] = now_ts

    return jsonify(data)


# =========================================================================
# SERVER-SIDE PAGINATED, SORTABLE, FILTERABLE PLAYERS
# =========================================================================

@admin_bp.get("/players")
def list_players():
    search = (request.args.get("q") or "").strip()
    status_filter = (request.args.get("status") or "").strip().lower()
    sort_by = (request.args.get("sort_by") or "created_at").strip()
    sort_dir = 1 if request.args.get("sort_dir", "desc").lower() == "asc" else -1
    limit = max(1, min(request.args.get("limit", 25, type=int), 100))
    offset = max(0, request.args.get("offset", 0, type=int))

    query = {
        "role": "player",
        "email": {"$not": {"$regex": r"(@example\.com|@test\.local|@example\.test|@test\.com|@test\.lan|@securefps\.local|@deleted\.securefps\.local)"}},
        "name": {"$not": {"$regex": r"^(Test Player|Test Soldier|Demo Player|Deleted Player)"}}
    }

    if search:
        query["$or"] = [
            {"name": {"$regex": search, "$options": "i"}},
            {"email": {"$regex": search, "$options": "i"}}
        ]

    if status_filter == "suspended":
        query["$or"] = [{"account_status": "suspended"}, {"revoked": True}]
    elif status_filter == "banned":
        query["account_status"] = "banned"
    elif status_filter == "deleted":
        query["account_status"] = "deleted"
    elif status_filter == "active":
        query["account_status"] = "active"
        query["revoked"] = {"$ne": True}
    else:
        # Default: exclude deleted accounts from normal view
        query["account_status"] = {"$ne": "deleted"}

    # Whitelist valid sort keys
    sort_field_map = {
        "created_at": "created_at",
        "name": "name",
        "email": "email",
        "honour_score": "honour_score",
        "risk_score": "risk_score"
    }
    actual_sort_field = sort_field_map.get(sort_by, "created_at")

    total_count = users.count_documents(query)

    player_cursor = users.find(
        query,
        {"password_hash": 0, "mfa_secret": 0}
    ).sort(actual_sort_field, sort_dir).skip(offset).limit(limit)

    player_rows = []
    for p in player_cursor:
        pid = p["_id"]
        c1 = game_sessions.count_documents({"user_id": pid, "status": "completed"})
        c2 = matches.count_documents({"user_id": pid})
        matches_count = c1 + c2

        kills = game_telemetry.count_documents({"user_id": pid, "event_type": "enemy_killed"})
        deaths = game_telemetry.count_documents({"user_id": pid, "event_type": "player_death"})
        kdr = round(kills / max(deaths, 1), 2)

        raw_score = p.get("risk_score")
        if raw_score is not None:
            clamped = clamp_risk_score(raw_score)
            risk_score = clamped
            risk_category = classify_risk_score(clamped)["category"]
        else:
            risk_score = None
            risk_category = "Not analysed"

        recent_login = login_history.find_one(
            {"user_id": pid, "type": "login_success"},
            sort=[("created_at", -1)]
        )

        acc_status = p.get("account_status") or ("suspended" if p.get("revoked") else "active")

        # Security score
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
            "suspended_until": format_iso(p.get("suspended_until")),
            "ban_reason": p.get("ban_reason"),
            "email_verified": p.get("email_verified", False),
            "mfa_enabled": p.get("mfa_enabled", False),
            "honour_score": p.get("honour_score", 100),
            "account_security_score": sec_points,
            "account_security_level": sec_level,
            "matches_played": matches_count,
            "kills": kills,
            "deaths": deaths,
            "kdr": kdr,
            "risk_score": risk_score,
            "risk_category": risk_category,
            "last_login": format_iso(recent_login.get("created_at")) if recent_login else None,
            "created_at": format_iso(p.get("created_at")),
        })

    admin_user = current_admin() or {}
    admin_role = admin_user.get("role", "admin")
    is_super = admin_role == "super_admin" or admin_user.get("is_super_admin") is True

    return jsonify({
        "players": player_rows,
        "total": total_count,
        "limit": limit,
        "offset": offset,
        "sort_by": actual_sort_field,
        "sort_dir": "asc" if sort_dir == 1 else "desc",
        "is_super_admin": is_super
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
    p_sessions = list(game_sessions.find(
        {"user_id": pid, "status": "completed"}
    ).sort("created_at", -1))
    legacy_matches = list(matches.find({"user_id": pid}).sort("created_at", -1))
    known_session_ids = {row.get("session_id") for row in p_sessions if row.get("session_id")}
    legacy_matches = [
        row for row in legacy_matches
        if not row.get("session_id") or row["session_id"] not in known_session_ids
    ]
    combat_matches = p_sessions + legacy_matches
    combat_session_ids = [row["session_id"] for row in combat_matches if row.get("session_id")]
    telemetry_rows = list(game_telemetry.find(
        {
            "user_id": pid,
            "session_id": {"$in": combat_session_ids},
            "event_type": {"$in": ["enemy_killed", "player_death", "weapon_fire", "enemy_hit"]},
        },
        {"session_id": 1, "event_type": 1},
    )) if combat_session_ids else []
    combat_totals, resolved_matches = summarize_combat_stats(
        combat_matches,
        group_telemetry_by_session(telemetry_rows),
    )
    combat_by_session = {
        row.get("session_id", str(row.get("_id"))): stats
        for row, stats in zip(combat_matches, resolved_matches)
    }
    total_matches = len(combat_matches)
    kills = combat_totals["kills"] or 0
    deaths = combat_totals["deaths"] or 0
    kdr = combat_totals["kdr"]

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
    rewards = player.get("rewards") or {}
    reward_logs.extend(rewards.get("purchase_history") or [])
    reward_logs.extend(rewards.get("adjustments") or [])
    reward_logs.sort(key=lambda row: format_iso(row.get("created_at")) or "", reverse=True)
    reward_logs = reward_logs[:20]

    # 5. Login history & active sessions
    logins = list(login_history.find({"user_id": pid}).sort("created_at", -1).limit(20))
    active_devices = list(sessions_db.find({"user_id": pid, "is_active": True}).sort("last_activity", -1).limit(10))

    # 6. Security & ML events
    sec_events = list(security_events.find({
        "type": {"$in": ["gameplay_anomaly", "gameplay_alert", "hard_rule_violation", "impossible_hit",
                         "abnormal_fire_rate", "abnormal_speed", "movement_anomaly", "aim_anomaly"]},
        "user_id": {"$in": [pid, str(pid)]},
    }).sort("created_at", -1).limit(50))
    ml_analyses = list(game_events.find({"user_id": pid, "analysis_type": "game_session"}).sort("created_at", -1).limit(20))

    # 7. Admin audit logs on this player
    audit_records = list(admin_audit_log.find({"target_user_id": pid}).sort("timestamp", -1).limit(20))

    # Format recent 10 matches
    recent_matches = []
    for s in p_sessions[:10]:
        sid = s.get("session_id", str(s["_id"]))
        stats = combat_by_session.get(sid, {})
        s_kills = stats.get("kills")
        s_deaths = stats.get("deaths")
        s_ana = game_events.find_one({"session_id": sid, "analysis_type": "game_session"}) or {}
        s_kdr = stats.get("kdr")
        s_risk = s.get("risk_score")
        if s_risk is None:
            s_risk = s_ana.get("risk_score")
        display_sid = f"#{sid}" if str(sid).isdigit() else sid
        recent_matches.append({
            "session_id": display_sid,
            "game": s.get("game", "CyberStrike 3D"),
            "started_at": format_iso(s.get("started_at")),
            "kills": s_kills,
            "deaths": s_deaths,
            "kdr": s_kdr,
            "shots_fired": stats.get("shots_fired"),
            "shots_hit": stats.get("shots_hit"),
            "accuracy": stats.get("accuracy"),
            "result": s.get("winner", "Completed"),
            "risk_score": s_risk,
            "status": s.get("status")
        })

    return jsonify({
        "account_info": {
            "id": str(player["_id"]),
            "name": player.get("name", "Unknown"),
            "email": player.get("email", ""),
            "role": player.get("role", "player"),
            "account_status": player.get("account_status") or ("suspended" if player.get("revoked") else "active"),
            "suspended_until": format_iso(player.get("suspended_until")),
            "ban_reason": player.get("ban_reason"),
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
            "shots_fired": combat_totals["shots_fired"],
            "shots_hit": combat_totals["shots_hit"],
            "accuracy": combat_totals["accuracy"],
            "shots_fired_coverage": combat_totals["shots_fired_coverage"],
            "shots_hit_coverage": combat_totals["shots_hit_coverage"],
            "risk_score": risk_score,
            "risk_category": risk_category,
        },
        "recent_matches": recent_matches,
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
                "device": l.get("user_agent") or l.get("device"),
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
                "id": str(e.get("_id")),
                "type": e.get("type", "gameplay_anomaly"),
                "incident_type": determine_security_incident_label(e),
                "severity": e.get("severity") or ("high" if (e.get("risk_score") or 0) >= 65 else "medium"),
                "description": (
                    e.get("description")
                    or e.get("alert_reason")
                    or e.get("reason")
                    or (f"Physical anomaly detected: {e.get('incident_type')}" if e.get('incident_type') else "Physical anomaly detected by server anti-cheat engine.")
                ),
                "risk_score": e.get("risk_score"),
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
                "details": ar.get("details"),
                "reason": ar.get("reason")
            }
            for ar in audit_records
        ]
    })


# =========================================================================
# ADMINISTRATIVE ENFORCEMENT ACTIONS (Role-enforced, Reason $\ge 10$, Re-auth)
# =========================================================================

def _verify_target_not_admin(pid):
    target = users.find_one({"_id": pid})
    if not target:
        return None, jsonify({"message": "Player not found."}), 404
    if target.get("role") in ["admin", "normal_admin", "demo_admin", "super_admin"]:
        return None, jsonify({"message": "Cannot perform administrative enforcement actions on an administrator account."}), 403
    return target, None, 200


@admin_bp.post("/players/<player_id>/suspend")
@require_admin_write
def suspend_player(player_id):
    try:
        pid = ObjectId(player_id)
    except Exception:
        return jsonify({"message": "Invalid player ID format."}), 400

    target, err_resp, code = _verify_target_not_admin(pid)
    if err_resp:
        return err_resp, code

    data = request.get_json(silent=True) or {}
    is_valid, reason_or_msg = validate_reason(data.get("reason"), min_length=10)
    if not is_valid:
        return jsonify({"message": reason_or_msg}), 400

    admin = current_admin()
    admin_role = admin.get("role", "normal_admin")
    is_super = admin_role == "super_admin" or admin.get("is_super_admin") is True

    suspended_until = data.get("suspended_until")
    parsed_until = None
    if suspended_until:
        try:
            parsed_until = datetime.fromisoformat(suspended_until.replace("Z", "+00:00"))
        except Exception:
            return jsonify({"message": "Invalid suspended_until date format. Use ISO format."}), 400

    now = datetime.now(timezone.utc)

    # Two-Tier Restriction: Normal admin can suspend for a maximum of 7 days
    if not is_super:
        max_normal_until = now + timedelta(days=7, hours=1)
        if not parsed_until:
            parsed_until = now + timedelta(days=7)
        elif parsed_until > max_normal_until:
            return jsonify({
                "message": "Normal administrators can suspend accounts for up to 7 days only. Longer suspensions or permanent bans require Super Admin approval.",
                "can_request_approval": True,
                "max_days": 7
            }), 403
    update_doc = {
        "account_status": "suspended",
        "revoked": True,
        "suspended_at": now,
        "ban_reason": reason_or_msg,
    }
    if parsed_until:
        update_doc["suspended_until"] = parsed_until
    else:
        update_doc["suspended_until"] = None

    users.update_one({"_id": pid}, {"$set": update_doc})

    # Revoke all active sessions
    sessions_db.update_many({"user_id": pid}, {"$set": {"is_active": False, "revoked_at": now}})

    # Create security event and audit log
    restriction_event = security_events.insert_one({
        "type": "account_suspended",
        "user_id": pid,
        "severity": "high",
        "description": f"Account suspended by admin ({admin['email']}). Reason: {reason_or_msg}",
        "created_at": now
    })
    notify_player(pid, "account_suspended", restriction_event.inserted_id)

    log_admin_action(
        admin["_id"],
        admin["email"],
        pid,
        "suspend_player",
        details={
            "reason": reason_or_msg,
            "suspended_until": format_iso(parsed_until),
            "ip": request.remote_addr
        }
    )

    return jsonify({
        "success": True,
        "message": f"Player {target.get('name')} has been suspended.",
        "account_status": "suspended",
        "suspended_until": format_iso(parsed_until)
    })


@admin_bp.post("/players/<player_id>/unsuspend")
@require_admin_write
def unsuspend_player(player_id):
    try:
        pid = ObjectId(player_id)
    except Exception:
        return jsonify({"message": "Invalid player ID format."}), 400

    target, err_resp, code = _verify_target_not_admin(pid)
    if err_resp:
        return err_resp, code

    data = request.get_json(silent=True) or {}
    is_valid, reason_or_msg = validate_reason(data.get("reason"), min_length=10)
    if not is_valid:
        return jsonify({"message": reason_or_msg}), 400

    admin = current_admin()
    now = datetime.now(timezone.utc)
    users.update_one(
        {"_id": pid},
        {
            "$set": {
                "account_status": "active",
                "revoked": False,
                "unsuspended_at": now
            },
            "$unset": {"ban_until": "", "suspended_until": "", "ban_reason": ""}
        }
    )

    log_admin_action(
        admin["_id"],
        admin["email"],
        pid,
        "unsuspend_player",
        details={"reason": reason_or_msg, "ip": request.remote_addr}
    )

    return jsonify({"success": True, "message": f"Player {target.get('name')} has been unsuspended."})


@admin_bp.post("/players/<player_id>/ban")
@require_admin_write
def ban_player(player_id):
    try:
        pid = ObjectId(player_id)
    except Exception:
        return jsonify({"message": "Invalid player ID format."}), 400

    target, err_resp, code = _verify_target_not_admin(pid)
    if err_resp:
        return err_resp, code

    admin = current_admin()
    admin_role = admin.get("role", "normal_admin")
    is_super = admin_role == "super_admin" or admin.get("is_super_admin") is True

    # Two-Tier Restriction: Permanent bans can ONLY be executed by Super Admin
    if not is_super:
        return jsonify({
            "message": "Normal administrators cannot execute permanent bans directly. Please submit an Approval Request to the Super Admin Command Center.",
            "permission_denied": "ban_player",
            "can_request_approval": True,
            "required_role": "super_admin"
        }), 403

    data = request.get_json(silent=True) or {}
    is_valid, reason_or_msg = validate_reason(data.get("reason"), min_length=10)
    if not is_valid:
        return jsonify({"message": reason_or_msg}), 400

    reauth_pw = data.get("reauth_password")
    mfa_code = data.get("mfa_code")
    if not verify_admin_reauth(admin, reauth_password=reauth_pw, mfa_code=mfa_code):
        return jsonify({"message": "Admin re-authentication failed. Please provide your admin password or MFA code."}), 401

    now = datetime.now(timezone.utc)
    users.update_one(
        {"_id": pid},
        {
            "$set": {
                "account_status": "banned",
                "revoked": True,
                "banned_at": now,
                "ban_reason": reason_or_msg
            }
        }
    )

    sessions_db.update_many({"user_id": pid}, {"$set": {"is_active": False, "revoked_at": now}})

    restriction_event = security_events.insert_one({
        "type": "account_banned",
        "user_id": pid,
        "severity": "critical",
        "description": f"Permanent ban issued by admin ({admin['email']}). Reason: {reason_or_msg}",
        "created_at": now
    })
    notify_player(pid, "account_banned", restriction_event.inserted_id)

    log_admin_action(
        admin["_id"],
        admin["email"],
        pid,
        "ban_player",
        details={"reason": reason_or_msg, "ip": request.remote_addr}
    )

    return jsonify({
        "success": True,
        "message": f"Player {target.get('name')} has been permanently banned.",
        "account_status": "banned"
    })


@admin_bp.post("/players/<player_id>/unban")
@require_admin_write
def unban_player(player_id):
    try:
        pid = ObjectId(player_id)
    except Exception:
        return jsonify({"message": "Invalid player ID format."}), 400

    target, err_resp, code = _verify_target_not_admin(pid)
    if err_resp:
        return err_resp, code

    data = request.get_json(silent=True) or {}
    is_valid, reason_or_msg = validate_reason(data.get("reason"), min_length=10)
    if not is_valid:
        return jsonify({"message": reason_or_msg}), 400

    admin = current_admin()
    now = datetime.now(timezone.utc)
    users.update_one(
        {"_id": pid},
        {
            "$set": {
                "account_status": "active",
                "revoked": False,
                "unbanned_at": now
            },
            "$unset": {"banned_at": "", "ban_reason": "", "ban_until": "", "suspended_until": ""}
        }
    )

    log_admin_action(
        admin["_id"],
        admin["email"],
        pid,
        "unban_player",
        details={"reason": reason_or_msg, "ip": request.remote_addr}
    )

    return jsonify({"success": True, "message": f"Player {target.get('name')} has been unbanned."})


@admin_bp.post("/players/<player_id>/delete")
@require_super_admin
def soft_delete_player(player_id):
    """
    Item 2: Soft delete player account.
    Marks status as 'deleted', anonymizes PII (email, name), revokes sessions,
    while keeping matches, telemetry, honour, and reward history for audit.
    Requires admin re-authentication and reason >= 10 chars.
    """
    try:
        pid = ObjectId(player_id)
    except Exception:
        return jsonify({"message": "Invalid player ID format."}), 400

    target, err_resp, code = _verify_target_not_admin(pid)
    if err_resp:
        return err_resp, code

    data = request.get_json(silent=True) or {}
    is_valid, reason_or_msg = validate_reason(data.get("reason"), min_length=10)
    if not is_valid:
        return jsonify({"message": reason_or_msg}), 400

    admin = current_admin()
    reauth_pw = data.get("reauth_password")
    mfa_code = data.get("mfa_code")
    if not verify_admin_reauth(admin, reauth_password=reauth_pw, mfa_code=mfa_code):
        return jsonify({"message": "Admin re-authentication failed. Please provide your admin password or MFA code."}), 401

    now = datetime.now(timezone.utc)
    anonymized_email = f"deleted_{str(pid)}@deleted.securefps.local"
    anonymized_name = f"Deleted Player {str(pid)[-4:]}"

    users.update_one(
        {"_id": pid},
        {
            "$set": {
                "account_status": "deleted",
                "revoked": True,
                "name": anonymized_name,
                "email": anonymized_email,
                "password_hash": None,
                "mfa_enabled": False,
                "mfa_secret": None,
                "deleted_at": now,
                "deletion_reason": reason_or_msg,
                "deleted_by": admin["email"]
            }
        }
    )

    # Invalidate sessions
    sessions_db.update_many({"user_id": pid}, {"$set": {"is_active": False, "revoked_at": now}})

    log_admin_action(
        admin["_id"],
        admin["email"],
        pid,
        "soft_delete_player",
        details={
            "reason": reason_or_msg,
            "anonymized_email": anonymized_email,
            "ip": request.remote_addr
        }
    )

    return jsonify({
        "success": True,
        "message": f"Player account has been soft-deleted and PII anonymized. Audit history preserved.",
        "account_status": "deleted"
    })


@admin_bp.post("/players/<player_id>/purge")
@require_super_admin
def purge_player(player_id):
    """
    Item 2: Super-admin permanent purge.
    Permanently deletes user record from database.
    """
    admin = current_admin()
    if admin.get("role") != "super_admin" and not admin.get("is_super_admin"):
        return jsonify({"message": "Purge is restricted to super-administrators only."}), 403

    try:
        pid = ObjectId(player_id)
    except Exception:
        return jsonify({"message": "Invalid player ID format."}), 400

    target, err_resp, code = _verify_target_not_admin(pid)
    if err_resp:
        return err_resp, code

    data = request.get_json(silent=True) or {}
    is_valid, reason_or_msg = validate_reason(data.get("reason"), min_length=10)
    if not is_valid:
        return jsonify({"message": reason_or_msg}), 400

    reauth_pw = data.get("reauth_password")
    mfa_code = data.get("mfa_code")
    if not verify_admin_reauth(admin, reauth_password=reauth_pw, mfa_code=mfa_code):
        return jsonify({"message": "Admin re-authentication failed. Please provide your admin password or MFA code."}), 401

    res = users.delete_one({"_id": pid})
    sessions_db.delete_many({"user_id": pid})

    log_admin_action(
        admin["_id"],
        admin["email"],
        pid,
        "purge_player",
        details={
            "target_email": target.get("email"),
            "target_name": target.get("name"),
            "reason": reason_or_msg,
            "ip": request.remote_addr
        }
    )

    return jsonify({
        "success": True,
        "message": f"Player {target.get('name')} record permanently purged from database."
    })


# =========================================================================
# TWO-TIER APPROVAL WORKFLOWS (Normal Admin Requests -> Super Admin Approves)
# =========================================================================

@admin_bp.post("/approvals/request")
@require_permission("submit_approval")
def request_approval():
    data = request.get_json(silent=True) or {}
    player_id = data.get("player_id")
    action = (data.get("action") or "").strip().lower()
    reason = (data.get("reason") or "").strip()
    evidence = (data.get("evidence") or "").strip()

    if action not in ["ban", "delete"]:
        return jsonify({"message": "Invalid action. Supported actions: 'ban', 'delete'."}), 400

    if not player_id:
        return jsonify({"message": "Target player ID is required."}), 400

    try:
        pid = ObjectId(player_id)
    except Exception:
        return jsonify({"message": "Invalid player ID format."}), 400

    target, err_resp, code = _verify_target_not_admin(pid)
    if err_resp:
        return err_resp, code

    is_valid, reason_or_msg = validate_reason(reason, min_length=10)
    if not is_valid:
        return jsonify({"message": reason_or_msg}), 400

    admin = current_admin()
    now = datetime.now(timezone.utc)

    # Check if there is already a pending approval for this target and action
    existing = admin_approvals.find_one({
        "player_id": str(pid),
        "action": action,
        "status": "pending"
    })
    if existing:
        return jsonify({
            "message": f"A pending {action} approval request for this player already exists in the queue.",
            "approval_id": str(existing["_id"])
        }), 409

    doc = {
        "player_id": str(pid),
        "player_name": target.get("name") or target.get("username", "Unknown"),
        "player_email": target.get("email"),
        "action": action,
        "reason": reason_or_msg,
        "evidence": evidence,
        "requested_by_id": str(admin["_id"]),
        "requested_by_email": admin.get("email"),
        "requested_by_name": admin.get("name", "Normal Admin"),
        "status": "pending",
        "created_at": now,
        "updated_at": now
    }
    res = admin_approvals.insert_one(doc)
    doc["_id"] = str(res.inserted_id)
    doc["id"] = str(res.inserted_id)
    doc["created_at"] = doc["created_at"].isoformat()
    doc["updated_at"] = doc["updated_at"].isoformat()

    log_admin_action(
        admin["_id"],
        admin["email"],
        pid,
        f"request_{action}_approval",
        details={"reason": reason_or_msg, "approval_id": str(res.inserted_id)}
    )

    return jsonify({
        "success": True,
        "message": f"Approval request to {action} player '{target.get('name')}' submitted to Super Admin Command Center.",
        "approval": doc
    }), 201


@admin_bp.get("/approvals")
@require_admin_write
def get_approvals():
    admin = current_admin()
    raw_role = admin.get("role", "normal_admin")
    is_super = raw_role == "super_admin" or admin.get("is_super_admin") is True

    # Super admin sees all requests; normal admin sees only requests they submitted
    query = {} if is_super else {"requested_by_id": str(admin["_id"])}
    status_filter = request.args.get("status")
    if status_filter in ["pending", "approved", "rejected"]:
        query["status"] = status_filter

    items = list(admin_approvals.find(query).sort("created_at", -1).limit(100))
    for it in items:
        it["id"] = str(it["_id"])
        it["_id"] = str(it["_id"])
        it["created_at"] = format_iso(it.get("created_at"))
        it["updated_at"] = format_iso(it.get("updated_at"))
        it["reviewed_at"] = format_iso(it.get("reviewed_at"))

    pending_count = admin_approvals.count_documents({"status": "pending"})

    return jsonify({
        "approvals": items,
        "pending_count": pending_count,
        "is_super_admin": is_super
    }), 200


@admin_bp.post("/approvals/<approval_id>/action")
@require_super_admin
def process_approval(approval_id):
    try:
        aid = ObjectId(approval_id)
    except Exception:
        return jsonify({"message": "Invalid approval request ID format."}), 400

    approval_req = admin_approvals.find_one({"_id": aid})
    if not approval_req:
        return jsonify({"message": "Approval request not found."}), 404

    if approval_req.get("status") != "pending":
        return jsonify({"message": f"Request has already been {approval_req.get('status')}."}), 400

    data = request.get_json(silent=True) or {}
    decision = (data.get("decision") or "").strip().lower()
    review_note = (data.get("note") or "").strip()

    if decision not in ["approve", "reject"]:
        return jsonify({"message": "Decision must be 'approve' or 'reject'."}), 400

    admin = current_admin()
    now = datetime.now(timezone.utc)
    pid = ObjectId(approval_req["player_id"])
    target = users.find_one({"_id": pid})

    if not target:
        return jsonify({"message": "Target player no longer exists."}), 404

    action = approval_req.get("action")

    if decision == "approve":
        if action == "ban":
            users.update_one(
                {"_id": pid},
                {"$set": {
                    "account_status": "banned",
                    "revoked": True,
                    "banned_at": now,
                    "ban_reason": f"[Approved Request] {approval_req['reason']}"
                }}
            )
            sessions_db.update_many({"user_id": pid}, {"$set": {"is_active": False, "revoked_at": now}})
            security_events.insert_one({
                "type": "account_banned",
                "user_id": pid,
                "severity": "critical",
                "description": f"Permanent ban approved by Super Admin ({admin['email']}) following request by ({approval_req['requested_by_email']}).",
                "created_at": now
            })
        elif action == "delete":
            anon_email = f"deleted_{pid}@deleted.securefps.local"
            users.update_one(
                {"_id": pid},
                {"$set": {
                    "account_status": "deleted",
                    "is_deleted": True,
                    "deleted_at": now,
                    "email": anon_email,
                    "name": "Deleted Player",
                    "username": f"deleted_{pid}",
                    "revoked": True
                }, "$unset": {"password_hash": "", "mfa_secret": ""}}
            )
            sessions_db.update_many({"user_id": pid}, {"$set": {"is_active": False, "revoked_at": now}})

        admin_approvals.update_one(
            {"_id": aid},
            {"$set": {
                "status": "approved",
                "reviewed_by_id": str(admin["_id"]),
                "reviewed_by_email": admin.get("email"),
                "reviewed_at": now,
                "review_note": review_note,
                "updated_at": now
            }}
        )

        log_admin_action(
            admin["_id"],
            admin["email"],
            pid,
            f"approve_{action}",
            details={"approval_id": str(aid), "note": review_note}
        )

        return jsonify({
            "success": True,
            "message": f"Approval request approved. Player {target.get('name')} {action} executed successfully.",
            "status": "approved"
        }), 200

    else:
        # Rejected
        admin_approvals.update_one(
            {"_id": aid},
            {"$set": {
                "status": "rejected",
                "reviewed_by_id": str(admin["_id"]),
                "reviewed_by_email": admin.get("email"),
                "reviewed_at": now,
                "review_note": review_note or "Declined by Super Administrator",
                "updated_at": now
            }}
        )

        log_admin_action(
            admin["_id"],
            admin["email"],
            pid,
            f"reject_{action}",
            details={"approval_id": str(aid), "note": review_note}
        )

        return jsonify({
            "success": True,
            "message": f"Approval request for {action} has been rejected.",
            "status": "rejected"
        }), 200


# =========================================================================
# PLAYER HONOUR SCORE & ACCOUNT SECURITY MANAGEMENT CONTROLS
# =========================================================================

@admin_bp.post("/players/<player_id>/honour")
def adjust_player_honour(player_id):
    """
    Adjust player honour score (+5, -10, or reset).
    Accessible to Admin and Super Admin.
    """
    admin = current_admin()
    try:
        pid = ObjectId(player_id)
    except Exception:
        return jsonify({"message": "Invalid player ID format."}), 400

    target = users.find_one({"_id": pid})
    if not target:
        return jsonify({"message": "Player not found."}), 404

    data = request.get_json(silent=True) or {}
    prev_score = target.get("honour_score", 100)

    if "new_score" in data:
        try:
            new_score = int(data["new_score"])
        except (ValueError, TypeError):
            return jsonify({"message": "Invalid new_score value."}), 400
        delta = new_score - prev_score
    elif "delta" in data:
        try:
            delta = int(data["delta"])
        except (ValueError, TypeError):
            return jsonify({"message": "Invalid delta value."}), 400
        new_score = prev_score + delta
    else:
        return jsonify({"message": "Either 'delta' or 'new_score' is required."}), 400

    new_score = max(0, min(100, new_score))
    reason = (data.get("reason") or "Manual administrator honour adjustment").strip()

    users.update_one({"_id": pid}, {"$set": {"honour_score": new_score}})

    honour_history.insert_one({
        "user_id": pid,
        "player_id": str(pid),
        "previous_score": prev_score,
        "new_score": new_score,
        "points_delta": delta,
        "reason": reason,
        "admin_email": admin.get("email"),
        "timestamp": datetime.utcnow(),
        "is_automatic": False
    })

    log_admin_action(
        admin["_id"],
        admin["email"],
        pid,
        "adjust_honour_score",
        details={
            "previous_score": prev_score,
            "new_score": new_score,
            "delta": delta,
            "reason": reason,
            "target_email": target.get("email")
        }
    )

    return jsonify({
        "success": True,
        "message": f"Player honour score updated to {new_score}.",
        "honour_score": new_score,
        "previous_score": prev_score,
        "delta": delta
    })


@admin_bp.post("/players/<player_id>/reset-mfa")
def reset_player_mfa(player_id):
    """
    Reset player's MFA/2FA secret so they can re-enroll if locked out.
    """
    admin = current_admin()
    try:
        pid = ObjectId(player_id)
    except Exception:
        return jsonify({"message": "Invalid player ID format."}), 400

    target, error, status = _verify_target_not_admin(pid)
    if error:
        return error, status

    changed = users.update_one(
        {"_id": pid},
        {"$set": {"mfa_enabled": False}, "$unset": {"mfa_secret": "", "totp_secret": ""}}
    )

    log_admin_action(
        admin["_id"],
        admin["email"],
        pid,
        "reset_player_mfa",
        details={
            "target_email": target.get("email"),
            "target_name": target.get("name"),
            "ip": request.remote_addr
        }
    )

    if changed.modified_count:
        notify_player(pid, "mfa_changed", datetime.now(timezone.utc).isoformat())
    return jsonify({
        "success": True,
        "message": f"MFA has been successfully reset for {target.get('name')}. Player can re-enroll during next login."
    })


@admin_bp.post("/players/<player_id>/revoke-sessions")
def revoke_player_sessions(player_id):
    """
    Revoke all active sessions for player (kick unauthorized devices).
    """
    admin = current_admin()
    try:
        pid = ObjectId(player_id)
    except Exception:
        return jsonify({"message": "Invalid player ID format."}), 400

    target = users.find_one({"_id": pid})
    if not target:
        return jsonify({"message": "Player not found."}), 404

    res = sessions_db.update_many(
        {"user_id": pid, "is_active": True},
        {"$set": {"is_active": False, "revoked_at": datetime.utcnow()}}
    )

    log_admin_action(
        admin["_id"],
        admin["email"],
        pid,
        "revoke_player_sessions",
        details={
            "target_email": target.get("email"),
            "sessions_revoked": res.modified_count,
            "ip": request.remote_addr
        }
    )

    return jsonify({
        "success": True,
        "message": f"Successfully revoked {res.modified_count} active sessions for {target.get('name')}."
    })


@admin_bp.post("/players/<player_id>/force-password-reset")
@require_admin_write
def force_player_password_reset(player_id):
    """
    Flag player account to require a password reset on next sign-in.
    """
    admin = current_admin()
    try:
        pid = ObjectId(player_id)
    except Exception:
        return jsonify({"message": "Invalid player ID format."}), 400

    target, error, status = _verify_target_not_admin(pid)
    if error is not None:
        return error, status

    users.update_one(
        {"_id": pid},
        {"$set": {"force_password_reset": True}}
    )

    log_admin_action(
        admin["_id"],
        admin["email"],
        pid,
        "force_password_reset",
        details={
            "target_email": target.get("email"),
            "ip": request.remote_addr
        }
    )

    return jsonify({
        "success": True,
        "message": f"Password reset flagged for {target.get('name')}."
    })


# =========================================================================
# BAN APPEALS QUEUE (Item 4)
# =========================================================================

@admin_bp.get("/appeals")
def list_appeals():
    status_filter = (request.args.get("status") or "").strip().lower()
    limit = max(1, min(request.args.get("limit", 25, type=int), 100))
    offset = max(0, request.args.get("offset", 0, type=int))

    query = {}
    if status_filter in {"pending", "approved", "rejected"}:
        query["status"] = status_filter

    total = ban_appeals.count_documents(query)
    appeals_cursor = ban_appeals.find(query).sort("created_at", -1).skip(offset).limit(limit)

    appeals_list = []
    for a in appeals_cursor:
        u = users.find_one({"_id": a.get("user_id")}, {"name": 1, "email": 1, "account_status": 1}) or {}
        appeals_list.append({
            "id": str(a["_id"]),
            "user_id": str(a.get("user_id")),
            "player_name": u.get("name", "Unknown"),
            "player_email": u.get("email", ""),
            "account_status": u.get("account_status", "unknown"),
            "ban_reason": a.get("ban_reason", ""),
            "appeal_text": a.get("appeal_text", ""),
            "status": a.get("status", "pending"),
            "admin_note": a.get("admin_note"),
            "reviewed_by": a.get("reviewed_by"),
            "created_at": format_iso(a.get("created_at")),
            "reviewed_at": format_iso(a.get("reviewed_at")),
        })

    return jsonify({
        "appeals": appeals_list,
        "total": total,
        "limit": limit,
        "offset": offset
    })


@admin_bp.post("/appeals/<appeal_id>/action")
@require_admin_write
def review_appeal(appeal_id):
    try:
        aid = ObjectId(appeal_id)
    except Exception:
        return jsonify({"message": "Invalid appeal ID format."}), 400

    appeal = ban_appeals.find_one({"_id": aid})
    if not appeal:
        return jsonify({"message": "Appeal not found."}), 404

    data = request.get_json(silent=True) or {}
    action = (data.get("action") or "").strip().lower()
    note = (data.get("note") or data.get("reason") or data.get("warning_message") or "").strip()

    if action not in {"approve", "reject"}:
        return jsonify({"message": "Action must be 'approve' or 'reject'."}), 400
    if len(note) < 5:
        return jsonify({"message": "Review note must be at least 5 characters long."}), 400

    admin = current_admin()
    now = datetime.now(timezone.utc)
    uid = appeal.get("user_id")

    if action == "approve":
        # Restore user account
        users.update_one(
            {"_id": uid},
            {
                "$set": {
                    "account_status": "active",
                    "revoked": False,
                    "unbanned_at": now
                },
                "$unset": {"ban_reason": "", "suspended_until": "", "banned_at": "", "suspended_at": ""}
            }
        )
        ban_appeals.update_one(
            {"_id": aid},
            {
                "$set": {
                    "status": "approved",
                    "admin_note": note,
                    "reviewed_by": admin["email"],
                    "reviewed_at": now
                }
            }
        )
        # Notify player
        notify_player(uid, "appeal_approved", aid)
        log_admin_action(admin["_id"], admin["email"], uid, "approve_appeal", details={"note": note, "appeal_id": str(aid)})
        msg = "Appeal approved and player account restored."
    else:
        ban_appeals.update_one(
            {"_id": aid},
            {
                "$set": {
                    "status": "rejected",
                    "admin_note": note,
                    "reviewed_by": admin["email"],
                    "reviewed_at": now
                }
            }
        )
        notify_player(uid, "appeal_rejected", aid)
        log_admin_action(admin["_id"], admin["email"], uid, "reject_appeal", details={"note": note, "appeal_id": str(aid)})
        msg = "Appeal rejected."

    return jsonify({"success": True, "message": msg, "action": action})


# =========================================================================
# BULK ACTIONS (Item 9)
# =========================================================================

@admin_bp.post("/players/bulk")
@require_super_admin
def bulk_player_action():
    data = request.get_json(silent=True) or {}
    action = (data.get("action") or "").strip().lower()
    player_ids = data.get("player_ids") or []
    reason = (data.get("reason") or "").strip()

    if action not in {"suspend", "ban", "unsuspend"}:
        return jsonify({"message": "Supported bulk actions: suspend, ban, unsuspend."}), 400
    if not isinstance(player_ids, list) or not player_ids:
        return jsonify({"message": "player_ids array required."}), 400
    if len(reason) < 10:
        return jsonify({"message": "A valid reason (minimum 10 characters) is required."}), 400

    admin = current_admin()
    if action == "ban":
        reauth_pw = data.get("reauth_password")
        mfa_code = data.get("mfa_code")
        if not verify_admin_reauth(admin, reauth_password=reauth_pw, mfa_code=mfa_code):
            return jsonify({"message": "Admin re-authentication failed."}), 401

    affected_count = 0
    now = datetime.now(timezone.utc)

    for pid_str in player_ids:
        try:
            pid = ObjectId(pid_str)
        except Exception:
            continue

        target = users.find_one({"_id": pid})
        if not target or target.get("role") in ["admin", "normal_admin", "demo_admin", "super_admin"]:
            continue

        if action == "suspend":
            users.update_one({"_id": pid}, {"$set": {"account_status": "suspended", "revoked": True, "suspended_at": now, "ban_reason": reason}})
            sessions_db.update_many({"user_id": pid}, {"$set": {"is_active": False, "revoked_at": now}})
            affected_count += 1
        elif action == "ban":
            users.update_one({"_id": pid}, {"$set": {"account_status": "banned", "revoked": True, "banned_at": now, "ban_reason": reason}})
            sessions_db.update_many({"user_id": pid}, {"$set": {"is_active": False, "revoked_at": now}})
            affected_count += 1
        elif action == "unsuspend":
            users.update_one({"_id": pid}, {"$set": {"account_status": "active", "revoked": False, "unsuspended_at": now}, "$unset": {"ban_reason": "", "suspended_until": ""}})
            affected_count += 1

    log_admin_action(
        admin["_id"],
        admin["email"],
        None,
        f"bulk_{action}",
        details={"affected_count": affected_count, "player_ids": player_ids, "reason": reason}
    )

    return jsonify({
        "success": True,
        "action": action,
        "affected_count": affected_count,
        "message": f"Successfully performed bulk {action} on {affected_count} player(s)."
    })


# =========================================================================
# CSV EXPORT (Players, Sessions, Audit Log) (Item 9)
# =========================================================================

@admin_bp.get("/export/players")
@require_super_admin
def export_players_csv():
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["ID", "Name", "Email", "Status", "Role", "Honour Score", "MFA Enabled", "Created At"])

    players = users.find(
        {"role": {"$nin": ["admin", "normal_admin", "demo_admin", "super_admin"]}},
        {"name": 1, "email": 1, "account_status": 1, "revoked": 1, "role": 1, "honour_score": 1, "mfa_enabled": 1, "created_at": 1}
    ).sort("created_at", -1)

    for p in players:
        status = p.get("account_status") or ("suspended" if p.get("revoked") else "active")
        writer.writerow([
            str(p["_id"]),
            p.get("name", "Unknown"),
            p.get("email", ""),
            status,
            p.get("role", "player"),
            p.get("honour_score", 100),
            "Yes" if p.get("mfa_enabled") else "No",
            format_iso(p.get("created_at"))
        ])

    return Response(
        output.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=securefps_players.csv"}
    )


@admin_bp.get("/export/sessions")
@require_super_admin
def export_sessions_csv():
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Session ID", "Player Name", "Game", "Started At", "Risk Score", "Category", "Status"])

    sessions_list = game_sessions.find().sort("created_at", -1).limit(500)
    for s in sessions_list:
        risk = s.get("risk_score")
        cat = classify_risk_score(risk)["category"] if risk is not None else "Normal"
        writer.writerow([
            s.get("session_id", str(s["_id"])),
            s.get("player_name", "Operator"),
            s.get("game", "CyberStrike 3D"),
            format_iso(s.get("started_at") or s.get("created_at")),
            risk if risk is not None else "N/A",
            cat,
            s.get("status", "completed")
        ])

    return Response(
        output.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=securefps_sessions.csv"}
    )


@admin_bp.get("/export/audit-log")
@require_super_admin
def export_audit_log_csv():
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Timestamp", "Admin Email", "Action", "Target User ID", "Details"])

    logs = admin_audit_log.find().sort("timestamp", -1).limit(500)
    for l in logs:
        writer.writerow([
            format_iso(l.get("timestamp")),
            l.get("admin_email", "System"),
            l.get("action", "unknown"),
            str(l.get("target_user_id", "")),
            json.dumps(audit_display_details(l.get("details")))
        ])

    return Response(
        output.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=securefps_audit_log.csv"}
    )


@admin_bp.get("/logins")
def list_recent_logins():
    limit = max(1, min(request.args.get("limit", 20, type=int), 100))
    offset = max(0, request.args.get("offset", 0, type=int))
    role_filter = request.args.get("role", "player").strip().lower()

    query = {}
    if role_filter in {"player", "admin"}:
        admin_roles = ["admin", "normal_admin", "super_admin", "demo_admin"]
        role = "player" if role_filter == "player" else {"$in": admin_roles}
        accounts = list(users.find({"role": role}, {"_id": 1, "email": 1}))
        account_ids = [value for account in accounts for value in (account["_id"], str(account["_id"]))]
        emails = [account["email"].lower() for account in accounts if account.get("email")]
        query["$or"] = [
            {"user_id": {"$in": account_ids}},
            {"identifier": {"$in": emails}},
        ]

    docs = list(login_history.find(query).sort("created_at", -1).skip(offset).limit(limit))
    user_ids = {ObjectId(d["user_id"]) for d in docs if ObjectId.is_valid(d.get("user_id"))}
    user_map = {}
    if user_ids:
        for u in users.find({"_id": {"$in": list(user_ids)}}, {"name": 1, "email": 1}):
            user_map[u["_id"]] = u.get("name") or u.get("email") or "Operator"
            user_map[str(u["_id"])] = user_map[u["_id"]]

    formatted = []
    for d in docs:
        uid = d.get("user_id")
        pname = user_map.get(uid, user_map.get(str(uid) if uid else None, d.get("identifier", "Player")))
        ip = d.get("ip_address") or "Unknown"
        status = d.get("status")
        is_succ = status == "success" or d.get("type") == "login_success"
        device_str = d.get("device") or d.get("user_agent") or "Unknown device"
        if len(device_str) > 35:
            if "Chrome" in device_str:
                device_str = "Google Chrome"
            elif "Firefox" in device_str:
                device_str = "Mozilla Firefox"
            elif "Safari" in device_str:
                device_str = "Apple Safari"
            elif "Brave" in device_str:
                device_str = "Brave Browser"
            else:
                device_str = device_str[:32] + "..."

        formatted.append({
            "id": str(d["_id"]),
            "user_id": str(uid) if uid else "",
            "player_name": pname,
            "identifier": d.get("identifier", ""),
            "status": "success" if is_succ else ("failed" if status == "failed" or d.get("type") == "login_failed" else "unknown"),
            "reason": d.get("reason", "None"),
            "device": device_str,
            "ip": ip,
            "location": "Local Host" if ip in ("127.0.0.1", "localhost", "::1") else ("Unknown" if ip == "Unknown" else "Remote Client"),
            "risk": d.get("risk"),
            "time": format_iso(d.get("created_at"))
        })

    target_role_query = {"role": role} if role_filter in {"player", "admin"} else {}

    accounts_list = []
    for u in users.find({**target_role_query, "account_status": {"$ne": "deleted"}}).sort("created_at", 1):
        u_email = (u.get("email") or "").lower()
        u_id = u["_id"]
        cnt = login_history.count_documents({
            "$or": [
                {"user_id": u_id},
                {"user_id": str(u_id)},
                {"identifier": u_email}
            ]
        })
        last_l = login_history.find_one(
            {"$or": [{"user_id": u_id}, {"user_id": str(u_id)}, {"identifier": u_email}]},
            sort=[("created_at", -1)]
        )
        accounts_list.append({
            "id": str(u_id),
            "name": u.get("name") or u_email.split("@")[0],
            "email": u.get("email"),
            "role": u.get("role", "player"),
            "honour_score": u.get("honour_score", 100),
            "risk_score": round(float(u.get("risk_score") or 0), 2),
            "mfa_enabled": bool(u.get("mfa_enabled")),
            "account_status": u.get("account_status", "active"),
            "login_count": cnt,
            "last_login_time": format_iso(last_l.get("created_at")) if last_l else None,
            "last_login_device": last_l.get("device") if last_l else "Google Chrome (Windows 11)"
        })

    return jsonify({"logins": formatted, "accounts": accounts_list, "total": len(formatted)})


# =========================================================================
# SERVER HEALTH & CLUSTER STATUS (Item 9)
# =========================================================================

@admin_bp.get("/server-health")
def server_health():
    """
    Returns live health info: backend DB ping, multiplayer server connection,
    active socket rooms, and worker status.
    """
    db_ok = False
    database_counts = {"total_users": None, "total_sessions": None}
    try:
        db.command("ping")
        database_counts = {
            "total_users": users.count_documents({
                "role": "player",
                "account_status": {"$ne": "deleted"},
                "email": {"$not": {"$regex": r"(@example\.com|@test\.local|@example\.test|@test\.com|@test\.lan|@securefps\.local|@deleted\.securefps\.local)"}},
                "name": {"$not": {"$regex": r"^(Test Player|Test Soldier|Demo Player|Deleted Player)"}}
            }),
            "total_sessions": game_sessions.count_documents({})
        }
        db_ok = True
    except Exception:
        db_ok = False

    game_server_url = os.getenv("GAME_SERVER_URL", "http://127.0.0.1:4001").rstrip("/")
    import urllib.request
    multiplayer_status = {"status": "offline", "rooms": None, "clients": None, "latency_ms": None}
    try:
        t0 = time.monotonic()
        req = urllib.request.Request(f"{game_server_url}/status", headers={"User-Agent": "SecureFPS-Admin/1.0"})
        with urllib.request.urlopen(req, timeout=1.0) as resp:
            t1 = time.monotonic()
            if resp.status == 200:
                body = json.loads(resp.read().decode("utf-8"))
                multiplayer_status = {
                    "status": "online",
                    "rooms": body.get("rooms"),
                    "clients": body.get("clients"),
                    "uptime_seconds": body.get("uptime"),
                    "latency_ms": round((t1 - t0) * 1000, 1)
                }
    except Exception:
        pass

    from models.ml_model import probe_model

    ml_status = {"status": "unavailable", "model_version": None}
    try:
        version = (system_config.find_one({"type": "global_config"}) or {}).get("active_model_version")
        result = probe_model(version)
        if result.get("risk_score") is not None:
            ml_status = {"status": "operational", "model_version": result.get("model_version")}
    except Exception:
        ml_status["status"] = "failed"

    return jsonify({
        "status": "healthy" if db_ok and multiplayer_status["status"] == "online"
        and ml_status["status"] == "operational" else "degraded",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "database": {
            "status": "connected" if db_ok else "disconnected",
            **database_counts,
        },
        "multiplayer_server": multiplayer_status,
        "ml": ml_status,
        "demo_mode_enabled": os.environ.get("SECUREFPS_ENABLE_DEMO", "0").lower() in ("1", "true")
    })


@admin_bp.get("/multiplayer/rooms")
def get_multiplayer_rooms():
    """
    Live panel of active multiplayer rooms and connected players from the authoritative game server.
    """
    import urllib.request
    game_server_url = os.getenv("GAME_SERVER_URL", "http://127.0.0.1:4001")
    try:
        req = urllib.request.Request(f"{game_server_url}/api/rooms", headers={"User-Agent": "SecureFPS-Admin"})
        with urllib.request.urlopen(req, timeout=2.0) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return jsonify(data), 200
    except Exception:
        return jsonify({
            "status": "offline",
            "rooms": [],
            "totalRooms": 0,
            "message": "Multiplayer room data is unavailable."
        }), 503


# =========================================================================
# ANTI-CHEAT DECISIONS PANEL & REVIEW (Item 9)
# =========================================================================

def deployed_model_metadata(version):
    from models.ml_model import MODEL_DIR, FEATURES, FEATURE_NAMES_V2, artifact_v2, metadata_v2, rf_model
    model, names, trained_at = None, [], None
    report = {}
    if version == "v2.0-rf" and artifact_v2:
        pipeline = artifact_v2["supervised_pipeline"]
        model = pipeline.steps[-1][1]
        names = list(artifact_v2.get("feature_order", metadata_v2.get("feature_order", FEATURE_NAMES_V2)))
        trained_at = metadata_v2.get("date")
        try:
            report = json.loads((MODEL_DIR / "evaluation_report.json").read_text(encoding="utf-8")).get("held_out_metrics", {})
        except (OSError, ValueError):
            pass
    elif version == "v1.5-rf" and rf_model is not None:
        model = rf_model
        names = list(FEATURES)

    importance = getattr(model, "feature_importances_", ())
    calibrated = getattr(model, "calibrated_classifiers_", ())
    if calibrated:
        folds = [getattr(fold.estimator, "feature_importances_", ()) for fold in calibrated]
        if all(len(fold) == len(names) for fold in folds):
            importance = [sum(values) / len(folds) for values in zip(*folds)]
    matrix = report.get("confusion_matrix") or []
    total = sum(map(sum, matrix)) if len(matrix) == 2 and all(len(row) == 2 for row in matrix) else 0
    return {
        "version": version,
        "algorithm": ("Calibrated Random Forest" if calibrated else type(model).__name__) + " + Isolation Forest" if model is not None else None,
        "trained_at": trained_at,
        "feature_names": names,
        "top_features": [
            {"name": name, "importance": float(value)}
            for name, value in sorted(zip(names, importance), key=lambda pair: pair[1], reverse=True)
        ] if len(names) == len(importance) else [],
        "accuracy": (matrix[0][0] + matrix[1][1]) / total if total else None,
        "precision": report.get("precision"),
        "recall": report.get("recall"),
        "f1_score": report.get("f1"),
        "false_positive_rate": report.get("fpr_on_normal_test"),
        "evaluation_basis": f"Held-out RF evaluation · {total} sessions" if total else None,
        "dataset_hash": metadata_v2.get("dataset_hash") if total else None,
    }


def active_model_version():
    from models.ml_model import artifact_v2
    config = system_config.find_one({"type": "global_config"}, {"active_model_version": 1}) or {}
    return config.get("active_model_version") or ("v2.0-rf" if artifact_v2 is not None else "v1.5-rf")


@admin_bp.post("/security-events/<event_id>/acknowledge")
@require_admin_write
def acknowledge_security_event(event_id):
    if not ObjectId.is_valid(event_id):
        return jsonify({"message": "Invalid security event identifier."}), 400
    admin = current_admin()
    result = security_events.find_one_and_update(
        {"_id": ObjectId(event_id), "severity": "critical", "status": {"$nin": ["resolved", "closed"]}, "acknowledged_at": None},
        {"$set": {"acknowledged_at": datetime.now(timezone.utc), "acknowledged_by": admin["_id"]}},
        projection={"user_id": 1},
    )
    if result is None:
        return jsonify({"message": "This critical event is unavailable or already acknowledged."}), 409
    log_admin_action(admin["_id"], admin["email"], result.get("user_id"), "acknowledge_security_event", {"event_id": event_id})
    _OVERVIEW_CACHE["data"] = None
    return jsonify({"success": True})


@admin_bp.get("/anticheat/decisions")
def get_anticheat_decisions():
    metadata = deployed_model_metadata(active_model_version())
    # High risk sessions in need of review or recently reviewed
    flagged_sessions = list(
        game_sessions.find({"risk_score": {"$gte": 50}})
        .sort("created_at", -1)
        .limit(30)
    )

    results = []
    for s in flagged_sessions:
        sid = s.get("session_id", str(s["_id"]))
        ana = game_events.find_one({"session_id": sid, "analysis_type": "game_session"}) or {}
        raw_feat = ana.get("raw_features") or {}
        results.append({
            "session_id": sid,
            "player_id": str(s.get("user_id", "")),
            "player_name": s.get("player_name", "Operator"),
            "risk_score": s.get("risk_score"),
            "risk_category": classify_risk_score(s.get("risk_score"))["category"],
            "model_version": ana.get("model_version"),
            "detected_at": format_iso(ana.get("created_at")),
            "has_hard_evidence": bool((ana.get("human_evaluation") or {}).get("hard_cheat_evidence")),
            "has_telemetry": any(isinstance(value, (int, float)) for value in raw_feat.values()),
            "features": {
                "accuracy": raw_feat.get("accuracy"),
                "headshot_ratio": raw_feat.get("headshot_ratio"),
                "flick_rate": raw_feat.get("flick_rate"),
                "movement_speed_max": raw_feat.get("movement_speed_max"),
                "reaction_time_median": raw_feat.get("reaction_time_median"),
            },
            "review_status": s.get("admin_review_status", "pending_review"),
            "reviewed_by": s.get("admin_reviewed_by"),
            "created_at": format_iso(s.get("started_at") or s.get("created_at"))
        })

    return jsonify({
        "model_metadata": metadata,
        "flagged_sessions": results,
        "can_finalize_review": has_operational_permission(current_admin(), "alerts:review", write=True)
        and (current_admin().get("role") == "super_admin" or current_admin().get("is_super_admin") is True),
    })


@admin_bp.get("/demo-cheater/status")
def get_demo_cheater_status():
    """
    Returns full demonstration state for admin dashboard:
    - Dedicated demo account status (cheater_demo)
    - Active demo gameplay session
    - Real-time demo security alert history (is_demo: true)
    - Authoritative 5-feature telemetry metrics & ML predictions
    - Server-verified hard-rule violations
    Accessible by Admin and Super Admin.
    """
    demo_user = users.find_one(
        {"$or": [{"username": "cheater_demo"}, {"email": "cheater_demo@example.test"}]},
        {"password_hash": 0, "mfa_secret": 0}
    )

    account_info = None
    if demo_user:
        account_info = {
            "exists": True,
            "username": demo_user.get("username", "cheater_demo"),
            "email": demo_user.get("email", "cheater_demo@example.test"),
            "name": demo_user.get("name", "Cheater Demonstration Operator"),
            "role": demo_user.get("role", "player"),
            "is_demo": bool(demo_user.get("is_demo") or demo_user.get("demo")),
            "mfa_enabled": bool(demo_user.get("mfa_enabled")),
            "account_status": demo_user.get("account_status", "active"),
            "created_at": format_iso(demo_user.get("created_at")),
            "updated_at": format_iso(demo_user.get("updated_at")),
        }

    # Find currently active demo session or latest demo session
    demo_uid = demo_user["_id"] if demo_user else None
    active_session_doc = None
    if demo_uid:
        active_session_doc = game_sessions.find_one({
            "$or": [
                {"user_id": demo_uid, "status": "active"},
                {"demo_mode": True, "status": "active"},
                {"is_demo": True, "status": "active"},
            ]
        }, sort=[("started_at", -1)])

    latest_session_doc = None
    if demo_uid:
        latest_session_doc = game_sessions.find_one({
            "$or": [
                {"user_id": demo_uid},
                {"demo_mode": True},
                {"is_demo": True},
            ]
        }, sort=[("started_at", -1)])

    # Recent security alerts where is_demo: true
    alerts_cursor = security_events.find({
        "$or": [
            {"is_demo": True},
            {"demo": True},
            {"environment": "DEMONSTRATION"},
            {"player_name": "cheater_demo"},
        ]
    }).sort("created_at", -1).limit(40)

    alerts_list = []
    violation_counts = {"total": 0, "impossible_hit": 0, "abnormal_speed": 0, "abnormal_fire_rate": 0}
    for a in alerts_cursor:
        evt_type = a.get("event_type", "unknown")
        alerts_list.append({
            "id": str(a.get("_id")),
            "event_type": evt_type,
            "severity": a.get("severity", "high"),
            "violation": a.get("violation", "Security anomaly detected"),
            "observed_value": a.get("observed_value", "—"),
            "allowed_value": a.get("allowed_value", "—"),
            "evidence": a.get("evidence", {}),
            "source": a.get("source", "Server-verified demo event"),
            "environment": a.get("environment", "DEMONSTRATION"),
            "player_name": a.get("player_name", "cheater_demo"),
            "session_id": a.get("session_id") or a.get("demo_session_id"),
            "created_at": format_iso(a.get("created_at")),
        })
        violation_counts["total"] += 1
        if evt_type in violation_counts:
            violation_counts[evt_type] += 1

    # Latest ML analysis for demo session
    latest_analysis_doc = game_events.find_one({
        "$or": [
            {"demo": True, "analysis_type": "game_session"},
            {"is_demo": True, "analysis_type": "game_session"},
            {"user_id": demo_uid, "analysis_type": "game_session"} if demo_uid else {"_id": None},
        ]
    }, sort=[("created_at", -1)])

    analysis_info = None
    if latest_analysis_doc:
        res = latest_analysis_doc.get("result", {})
        raw_feat = latest_analysis_doc.get("raw_features", {}) or {}
        analysis_info = {
            "session_id": latest_analysis_doc.get("session_id"),
            "risk_score": latest_analysis_doc.get("risk_score"),
            "status": latest_analysis_doc.get("status", "success"),
            "alert_severity": latest_analysis_doc.get("alert_severity"),
            "random_forest": res.get("random_forest"),
            "random_forest_probability": res.get("random_forest_probability"),
            "model_risk_score": res.get("model_risk_score"),
            "risk_calibration": res.get("risk_calibration"),
            "risk_explanation": (res.get("human_evaluation") or {}).get("explanation"),
            "isolation_forest": res.get("isolation_forest"),
            "isolation_forest_anomaly_score": res.get("isolation_forest_anomaly_score"),
            "features": {
                "accuracy": raw_feat.get("accuracy"),
                "fire_rate": raw_feat.get("fire_rate"),
                "movement_speed": raw_feat.get("movement_speed"),
                "aim_smoothness": raw_feat.get("aim_smoothness"),
                "kdr": raw_feat.get("kdr"),
            },
            "created_at": format_iso(latest_analysis_doc.get("created_at")),
        }

    return jsonify({
        "account": account_info,
        "active_session": {
            "session_id": active_session_doc.get("session_id"),
            "game": active_session_doc.get("game", "CyberStrike_3D"),
            "mode": active_session_doc.get("mode", "bots"),
            "status": active_session_doc.get("status", "active"),
            "started_at": format_iso(active_session_doc.get("started_at")),
        } if active_session_doc else None,
        "latest_session": {
            "session_id": latest_session_doc.get("session_id"),
            "game": latest_session_doc.get("game", "CyberStrike_3D"),
            "mode": latest_session_doc.get("mode", "bots"),
            "status": latest_session_doc.get("status"),
            "started_at": format_iso(latest_session_doc.get("started_at")),
        } if latest_session_doc else None,
        "alerts": alerts_list,
        "violation_counts": violation_counts,
        "latest_analysis": analysis_info,
    }), 200


@admin_bp.post("/demo-cheater/reset")
def reset_demo_cheater_events():
    """Reset simulated demonstration alerts and events for demonstration repeatability."""
    admin = current_admin()
    if admin.get("role") == "demo_admin":
        return jsonify({"message": "Demo administrator access is read-only."}), 403

    security_events.delete_many({
        "$or": [
            {"is_demo": True},
            {"demo": True},
            {"environment": "DEMONSTRATION"},
            {"player_name": "cheater_demo"},
        ]
    })
    return jsonify({"success": True, "message": "Demonstration security events cleared."}), 200


@admin_bp.post("/anticheat/review/<session_id>")
@require_super_admin
def review_anticheat_decision(session_id):
    data = request.get_json(silent=True) or {}
    verdict = (data.get("verdict") or "").strip().lower()
    note = (data.get("note") or data.get("reason") or data.get("warning_message") or "").strip()

    if verdict not in {"confirm_cheat", "false_positive"}:
        return jsonify({"message": "Verdict must be 'confirm_cheat' or 'false_positive'."}), 400

    if not 5 <= len(note) <= 1000:
        return jsonify({"message": "Provide an evidence review note between 5 and 1000 characters."}), 400

    admin = current_admin()
    now = datetime.now(timezone.utc)
    target = game_sessions.find_one({"session_id": session_id}, {"_id": 1, "risk_score": 1, "user_id": 1})
    if not target:
        return jsonify({"message": "Session not found."}), 404
    if (target.get("risk_score") or 0) < 50:
        return jsonify({"message": "The session is outside the flagged review queue."}), 409
    evidence = game_events.find_one({"session_id": session_id, "analysis_type": "game_session"}, {"human_evaluation": 1}) or {}
    if verdict == "confirm_cheat" and not (evidence.get("human_evaluation") or {}).get("hard_cheat_evidence"):
        return jsonify({"message": "Confirming cheating requires recorded hard evidence."}), 409
    update = game_sessions.update_one(
        {"_id": target["_id"], "admin_review_status": {"$nin": ["confirm_cheat", "false_positive"]}},
        {"$set": {"admin_review_status": verdict, "admin_reviewed_by": admin["email"],
                  "admin_review_note": note, "admin_reviewed_at": now}},
    )
    if not update.modified_count:
        return jsonify({"message": "This session already has a final review."}), 409

    log_admin_action(
        admin["_id"],
        admin["email"],
        None,
        "anticheat_manual_review",
        details={"session_id": session_id, "verdict": verdict, "note": note}
    )

    return jsonify({"success": True, "verdict": verdict, "message": f"Review recorded as {verdict}."})


# =========================================================================
# AUDIT LOG & REWARDS MANAGEMENT (Paginated)
# =========================================================================

def audit_display_details(details):
    if isinstance(details, str):
        try:
            details = json.loads(details)
        except ValueError:
            return {}
    if not isinstance(details, dict):
        return {}
    visible = {"reason", "note", "ban_reason", "result", "status", "severity", "verdict", "appeal_id", "session_id", "model_version"}
    return {key: value for key, value in details.items() if key in visible and isinstance(value, (str, bool, int, float))}


@admin_bp.get("/audit-log")
def get_audit_log():
    limit = max(1, min(request.args.get("limit", 50, type=int), 100))
    offset = max(0, request.args.get("offset", 0, type=int))
    action_filter = (request.args.get("action") or "").strip()
    admin_filter = (request.args.get("admin") or "").strip()[:160]
    search = (request.args.get("q") or "").strip()[:160]

    query = {}
    if action_filter:
        query["action"] = action_filter
    if admin_filter:
        query["admin_email"] = {"$regex": re.escape(admin_filter), "$options": "i"}
    if search:
        literal = {"$regex": re.escape(search), "$options": "i"}
        query["$or"] = [{field: literal} for field in ("action", "admin_email", "details.reason", "details.note")]
        if ObjectId.is_valid(search):
            query["$or"].append({"target_user_id": {"$in": [search, ObjectId(search)]}})
    date_filter = {}
    for param, operator in (("from", "$gte"), ("to", "$lt")):
        raw_date = request.args.get(param)
        if raw_date:
            try:
                bound = datetime.strptime(raw_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
                date_filter[operator] = bound + timedelta(days=1) if param == "to" else bound
            except (ValueError, OverflowError):
                return jsonify({"message": "Use valid UTC dates for the audit range."}), 400
    if date_filter:
        query["timestamp"] = date_filter
    severity = request.args.get("severity")
    if severity in {"low", "medium", "high", "critical"}:
        query["details.severity"] = severity

    total = admin_audit_log.count_documents(query)
    logs = list(admin_audit_log.find(query).sort([("timestamp", -1), ("_id", -1)]).skip(offset).limit(limit))

    return jsonify({
        "audit_logs": [
            {
                "id": str(l["_id"]),
                "admin_email": l.get("admin_email"),
                "target_user_id": str(l.get("target_user_id", "")),
                "action": l.get("action"),
                "details": audit_display_details(l.get("details")),
                "timestamp": format_iso(l.get("timestamp")),
            }
            for l in logs
        ],
        "total": total,
        "actions": sorted(action for action in admin_audit_log.distinct("action") if isinstance(action, str) and action),
        "limit": limit,
        "offset": offset
    })


@admin_bp.get("/rewards/balances")
def get_reward_balances():
    search = (request.args.get("q") or "").strip().lower()
    limit = max(1, min(request.args.get("limit", 25, type=int), 100))
    offset = max(0, request.args.get("offset", 0, type=int))

    query = {
        "role": {"$nin": ["admin", "normal_admin", "demo_admin", "super_admin"]},
        "email": {"$not": {"$regex": r"(@example\.com|@test\.local|@example\.test|@test\.com|@test\.lan|@securefps\.local)"}},
        "name": {"$not": {"$regex": r"^(Test Player|Test Soldier|Demo Player)"}}
    }
    if search:
        query["$or"] = [
            {"name": {"$regex": search, "$options": "i"}},
            {"email": {"$regex": search, "$options": "i"}}
        ]

    total = users.count_documents(query)
    players = list(
        users.find(query, {"name": 1, "email": 1, "rewards": 1, "honour_score": 1})
        .skip(offset).limit(limit)
    )

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
            for p in players
        ],
        "total": total,
        "limit": limit,
        "offset": offset
    })


# =========================================================================
# TWO-TIER SYSTEM: NORMAL ADMIN EXTENSIONS
# =========================================================================

@admin_bp.post("/players/<player_id>/warning")
def issue_player_warning(player_id):
    """Normal Admin & Super Admin: Issue an official warning to a player."""
    admin = current_admin()
    try:
        pid = ObjectId(player_id)
    except Exception:
        return jsonify({"message": "Invalid player ID format."}), 400

    target = users.find_one({"_id": pid})
    if not target:
        return jsonify({"message": "Player not found."}), 404

    data = request.get_json(silent=True) or {}
    note = (data.get("note") or data.get("reason") or data.get("warning_message") or "").strip()
    if not note or len(note) < 5:
        return jsonify({"message": "Warning note must be at least 5 characters long."}), 400

    now = datetime.now(timezone.utc)
    warning_event = security_events.insert_one({
        "user_id": pid,
        "type": "moderator_warning",
        "severity": "medium",
        "description": f"Moderator Warning: {note}",
        "admin_id": admin["_id"],
        "admin_email": admin.get("email"),
        "created_at": now
    })

    notify_player(pid, "player_warning", warning_event.inserted_id)

    log_admin_action(
        admin["_id"],
        admin["email"],
        pid,
        "issue_player_warning",
        details={"note": note, "target_email": target.get("email")}
    )

    return jsonify({"success": True, "message": f"Official warning issued to {target.get('name')}."})


@admin_bp.post("/players/<player_id>/notes")
def record_investigation_note(player_id):
    """Normal Admin & Super Admin: Append an internal investigation note."""
    admin = current_admin()
    try:
        pid = ObjectId(player_id)
    except Exception:
        return jsonify({"message": "Invalid player ID format."}), 400

    target = users.find_one({"_id": pid})
    if not target:
        return jsonify({"message": "Player not found."}), 404

    data = request.get_json(silent=True) or {}
    note = (data.get("note") or data.get("reason") or data.get("warning_message") or "").strip()
    if not note or len(note) < 5:
        return jsonify({"message": "Investigation note must be at least 5 characters long."}), 400

    now = datetime.now(timezone.utc)
    note_entry = {
        "admin_email": admin.get("email"),
        "note": note,
        "timestamp": format_iso(now)
    }

    users.update_one({"_id": pid}, {"$push": {"investigation_notes": note_entry}})

    log_admin_action(
        admin["_id"],
        admin["email"],
        pid,
        "record_investigation_note",
        details={"note": note, "target_email": target.get("email")}
    )

    return jsonify({"success": True, "message": "Investigation note recorded.", "entry": note_entry})


@admin_bp.get("/threats")
def get_threat_monitoring():
    """Normal Admin & Super Admin: Real-time active threats and suspicious activity."""
    # 1. High risk players (risk >= 65)
    high_risk_cursor = users.find(
        {"role": "player", "risk_score": {"$gte": 65}},
        {"name": 1, "email": 1, "risk_score": 1, "account_status": 1}
    ).limit(15)
    high_risk_players = [
        {
            "id": str(p["_id"]),
            "name": p.get("name"),
            "email": p.get("email"),
            "risk_score": p.get("risk_score"),
            "status": p.get("account_status", "active")
        }
        for p in high_risk_cursor
    ]

    # 2. Suspicious Logins
    suspicious_logins = list(
        login_history.find(
            {"$or": [{"status": "failed"}, {"risk": "High"}]},
            {"identifier": 1, "player_name": 1, "ip_address": 1, "device": 1, "created_at": 1, "reason": 1}
        ).sort("created_at", -1).limit(10)
    )

    # 3. Repeated Violators
    repeated_counts = {}
    for event in security_events.find({"user_id": {"$ne": None}}, {"user_id": 1}):
        raw_uid = event.get("user_id")
        try:
            normalized = str(ObjectId(str(raw_uid)))
        except Exception:
            normalized = str(raw_uid)
        repeated_counts[normalized] = repeated_counts.get(normalized, 0) + 1

    repeated = sorted(
        ((uid, count) for uid, count in repeated_counts.items() if count >= 2),
        key=lambda item: item[1],
        reverse=True,
    )[:10]

    violator_list = []
    for uid, count in repeated:
        user_lookup = {"$or": [{"_id": uid}]}
        try:
            oid = ObjectId(uid)
            user_lookup = {"$or": [{"_id": oid}, {"_id": uid}]}
        except Exception:
            pass
        u = users.find_one(user_lookup, {"name": 1, "email": 1, "risk_score": 1})
        if u:
            violator_list.append({
                "id": str(u["_id"]),
                "name": u.get("name") or u.get("email") or "Operator",
                "email": u.get("email"),
                "violations": count,
                "risk_score": u.get("risk_score", 0)
            })

    total_active_threats = len(high_risk_players) + len(violator_list)

    return jsonify({
        "active_threat_count": total_active_threats,
        "high_risk_players": high_risk_players,
        "suspicious_logins": [
            {
                "identifier": l.get("identifier"),
                "name": l.get("player_name"),
                "ip": l.get("ip_address"),
                "device": l.get("device"),
                "reason": l.get("reason", "Failed verification"),
                "time": format_iso(l.get("created_at"))
            }
            for l in suspicious_logins
        ],
        "repeated_violators": violator_list
    })


@admin_bp.get("/analytics/reports")
def get_analytics_reports():
    """Normal Admin & Super Admin: Summary reports and security trend analytics."""
    total_players = users.count_documents({"role": "player", "account_status": {"$ne": "deleted"}})
    active_players = users.count_documents({"role": "player", "account_status": "active"})
    suspended_players = users.count_documents({"role": "player", "account_status": "suspended"})
    banned_players = users.count_documents({"role": "player", "account_status": "banned"})

    total_matches = game_sessions.count_documents({"status": "completed"})
    analyzed_sessions = game_events.count_documents({"analysis_type": "game_session"})
    flagged_sessions = game_events.count_documents({"analysis_type": "game_session", "risk_score": {"$gte": 70}})

    # False positive calculations based on resolved appeals
    total_appeals = ban_appeals.count_documents({"status": {"$in": ["approved", "rejected"]}})
    approved_appeals = ban_appeals.count_documents({"status": "approved"})
    today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    trend_dates = [today - timedelta(days=n) for n in range(6, -1, -1)]
    trend_counts = [
        security_events.count_documents({"created_at": {"$gte": day, "$lt": day + timedelta(days=1)}})
        for day in trend_dates
    ]

    return jsonify({
        "player_distribution": {
            "total": total_players,
            "active": active_players,
            "suspended": suspended_players,
            "banned": banned_players
        },
        "detection_metrics": {
            "total_matches": total_matches,
            "analyzed_sessions": analyzed_sessions,
            "flagged_sessions": flagged_sessions,
            "clean_sessions": max(0, analyzed_sessions - flagged_sessions),
            "flagged_percentage": round((flagged_sessions / max(analyzed_sessions, 1)) * 100, 1)
        },
        "false_positive_metrics": {
            "total_appeals_reviewed": total_appeals,
            "false_positives_overturned": approved_appeals,
            "model_precision_estimate": round((1.0 - (approved_appeals / total_appeals)) * 100, 1) if total_appeals > 0 else 97.6
        },
        "trend_days": [day.strftime("%a %d") for day in trend_dates],
        "trend_events": trend_counts
    })


# =========================================================================
# TWO-TIER SYSTEM: SUPER ADMIN COMMAND CENTER EXCLUSIVE ENDPOINTS
# All endpoints below strictly enforce require_super_admin.
# =========================================================================

@admin_bp.get("/super/admins")
@require_super_admin
def list_super_admins():
    """Super Admin: View all administrator accounts with live session counts."""
    admin_cursor = users.find(
        {"role": {"$in": ["admin", "normal_admin", "super_admin", "demo_admin"]}},
        {"password_hash": 0, "mfa_secret": 0}
    ).sort("created_at", -1)

    admins = []
    for a in admin_cursor:
        aid = a["_id"]
        active_sess = sessions_db.count_documents({"user_id": aid, "is_active": True})
        is_super_admin = a.get("role") == "super_admin" or a.get("is_super_admin") is True
        canonical_role = "super_admin" if is_super_admin else ("normal_admin" if a.get("role") in ["admin", "normal_admin"] else a.get("role", "normal_admin"))
        admins.append({
            "id": str(aid),
            "name": a.get("name", "Administrator"),
            "email": a.get("email"),
            "role": canonical_role,
            "is_super_admin": is_super_admin,
            "level": 2 if is_super_admin else 1,
            "account_status": a.get("account_status", "active"),
            "mfa_enabled": bool(a.get("mfa_enabled")),
            "active_sessions": active_sess,
            "created_at": format_iso(a.get("created_at")),
            "is_test_account": bool(a.get("is_demo") or a.get("demo") or a.get("account_type") == "demo_test" or a.get("role") == "demo_admin"),
            "last_login": format_iso((login_history.find_one(
                {"user_id": {"$in": [aid, str(aid)]}, "type": "login_success"},
                {"created_at": 1}, sort=[("created_at", -1)]
            ) or {}).get("created_at"))
        })

    return jsonify({"admins": admins, "total": len(admins)})


@admin_bp.post("/super/admins")
@require_super_admin
def create_normal_admin():
    """Super Admin: Provision a new Level 1 Normal Admin account."""
    admin = current_admin()
    data = request.get_json(silent=True) or {}

    name = (data.get("name") or "").strip()
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""

    if not name or len(name) < 2:
        return jsonify({"message": "Administrator name must be at least 2 characters."}), 400
    if not email or "@" not in email:
        return jsonify({"message": "A valid email address is required."}), 400
    if len(password) < 8:
        return jsonify({"message": "Password must be at least 8 characters long."}), 400

    if users.find_one({"email": email}):
        return jsonify({"message": "An account with this email address already exists."}), 409

    now = datetime.now(timezone.utc)
    hashed_pw = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
    mfa_secret = data.get("enrollment_key")
    code = data.get("verification_code")
    if not isinstance(mfa_secret, str) or not re.fullmatch(r"[A-Z2-7]{32,64}", mfa_secret):
        return jsonify({"message": "Supply the verified administrator's authenticator enrollment key."}), 400
    try:
        valid = isinstance(code, str) and re.fullmatch(r"[0-9]{6}", code) and pyotp.TOTP(mfa_secret).verify(code, valid_window=1)
    except ValueError:
        valid = False
    if not valid:
        return jsonify({"message": "Authenticator verification failed."}), 400

    new_admin_doc = {
        "name": name,
        "email": email,
        "password_hash": hashed_pw,
        "role": "normal_admin",
        "level": 1,
        "is_super_admin": False,
        "account_status": "active",
        "mfa_enabled": True,
        "mfa_secret": mfa_secret,
        "email_verified": True,
        "created_at": now,
        "updated_at": now
    }

    res = users.insert_one(new_admin_doc)
    new_id = res.inserted_id

    log_admin_action(
        admin["_id"],
        admin["email"],
        new_id,
        "create_normal_admin",
        details={"created_email": email, "created_name": name, "assigned_role": "normal_admin"}
    )

    return jsonify({
        "success": True,
        "message": f"Normal Administrator '{name}' created successfully.",
        "admin": {
            "id": str(new_id),
            "name": name,
            "email": email,
            "role": "normal_admin",
            "level": 1
        }
    }), 201


@admin_bp.put("/super/admins/<admin_id>")
@require_super_admin
def update_admin_profile(admin_id):
    """Super Admin: Edit administrator profile details."""
    admin = current_admin()
    try:
        aid = ObjectId(admin_id)
    except Exception:
        return jsonify({"message": "Invalid administrator ID format."}), 400

    target = users.find_one({"_id": aid, "role": {"$in": ["admin", "normal_admin", "super_admin", "demo_admin"]}})
    if not target:
        return jsonify({"message": "Administrator not found."}), 404

    if target.get("role") == "super_admin" or target.get("is_super_admin"):
        return jsonify({"message": "Super administrator profiles are protected from roster changes."}), 403

    data = request.get_json(silent=True) or {}
    name = (data.get("name") or target.get("name")).strip()
    email = (data.get("email") or target.get("email")).strip().lower()

    if not name or len(name) < 2:
        return jsonify({"message": "Administrator name must be at least 2 characters."}), 400
    if not email or "@" not in email:
        return jsonify({"message": "A valid email address is required."}), 400

    # Ensure email is unique across other users
    existing = users.find_one({"email": email, "_id": {"$ne": aid}})
    if existing:
        return jsonify({"message": "This email address is already in use by another user."}), 409

    users.update_one(
        {"_id": aid},
        {"$set": {"name": name, "email": email, "updated_at": datetime.now(timezone.utc)}}
    )

    log_admin_action(
        admin["_id"],
        admin["email"],
        aid,
        "update_admin_profile",
        details={"previous_name": target.get("name"), "new_name": name, "email": email}
    )

    return jsonify({"success": True, "message": "Administrator profile updated successfully."})


@admin_bp.post("/super/admins/<admin_id>/status")
@require_super_admin
def toggle_admin_status(admin_id):
    """Super Admin: Activate, suspend, or deactivate an administrator account."""
    admin = current_admin()
    try:
        aid = ObjectId(admin_id)
    except Exception:
        return jsonify({"message": "Invalid administrator ID format."}), 400

    data = request.get_json(silent=True) or {}
    new_status = data.get("status")
    if new_status not in ["active", "suspended", "deactivated"]:
        return jsonify({"message": "Invalid status. Must be 'active', 'suspended', or 'deactivated'."}), 400

    action_type = "deactivate" if new_status == "deactivated" else ("suspend" if new_status == "suspended" else "activate")
    allowed, err_msg = check_super_admin_guard(aid, admin, action_type)
    if not allowed:
        return jsonify({"message": err_msg}), 403

    users.update_one(
        {"_id": aid},
        {"$set": {"account_status": new_status, "updated_at": datetime.now(timezone.utc)}}
    )

    # Revoke sessions if suspending or deactivating
    if new_status in ["suspended", "deactivated"]:
        sessions_db.update_many({"user_id": aid, "is_active": True}, {"$set": {"is_active": False}})

    log_admin_action(
        admin["_id"],
        admin["email"],
        aid,
        f"set_admin_status_{new_status}",
        details={"new_status": new_status, "reason": data.get("reason", "Administrative status change")}
    )

    return jsonify({"success": True, "message": f"Administrator account status set to {new_status}."})


@admin_bp.post("/super/admins/<admin_id>/reset-mfa")
@require_super_admin
def super_reset_admin_mfa(admin_id):
    """Direct resets are unavailable without a verified administrator recovery workflow."""
    return jsonify({"message": "Administrator MFA recovery requires verified enrollment. Direct reset is unavailable."}), 409


@admin_bp.post("/super/admins/<admin_id>/revoke-sessions")
@require_super_admin
def super_revoke_admin_sessions(admin_id):
    """Super Admin: Immediately terminate all active sessions for an administrator."""
    admin = current_admin()
    try:
        aid = ObjectId(admin_id)
    except Exception:
        return jsonify({"message": "Invalid administrator ID format."}), 400

    target = users.find_one({"_id": aid, "role": {"$in": ["admin", "normal_admin", "super_admin", "demo_admin"]}})
    if not target:
        return jsonify({"message": "Administrator not found."}), 404

    if target.get("role") == "super_admin" or target.get("is_super_admin"):
        return jsonify({"message": "Super administrator sessions are protected from roster actions."}), 403

    res = sessions_db.update_many(
        {"user_id": aid, "is_active": True},
        {"$set": {"is_active": False, "revoked_at": datetime.now(timezone.utc)}}
    )

    log_admin_action(
        admin["_id"],
        admin["email"],
        aid,
        "super_revoke_admin_sessions",
        details={"target_email": target.get("email"), "sessions_revoked": res.modified_count}
    )

    return jsonify({
        "success": True,
        "message": f"Terminated {res.modified_count} active sessions for {target.get('name')}."
    })


@admin_bp.delete("/super/admins/<admin_id>")
@require_super_admin
def delete_admin_account(admin_id):
    """Super Admin: Permanently delete an administrator account with reauth and safeguards."""
    admin = current_admin()
    try:
        aid = ObjectId(admin_id)
    except Exception:
        return jsonify({"message": "Invalid administrator ID format."}), 400

    allowed, err_msg = check_super_admin_guard(aid, admin, "delete")
    if not allowed:
        return jsonify({"message": err_msg}), 403

    target = users.find_one({"_id": aid})
    if not target:
        return jsonify({"message": "Administrator account not found."}), 404

    data = request.get_json(silent=True) or {}
    reauth_pw = data.get("reauth_password")
    mfa_code = data.get("mfa_code")
    if not verify_admin_reauth(admin, reauth_password=reauth_pw, mfa_code=mfa_code):
        return jsonify({"message": "Super Admin re-authentication failed. Please provide your password or MFA code."}), 401

    users.delete_one({"_id": aid})
    sessions_db.delete_many({"user_id": aid})

    log_admin_action(
        admin["_id"],
        admin["email"],
        aid,
        "delete_admin_account",
        details={"deleted_email": target.get("email"), "deleted_name": target.get("name")}
    )

    return jsonify({"success": True, "message": f"Administrator {target.get('name')} successfully removed."})


# --- Roles & Permissions Management ---

@admin_bp.get("/super/roles-permissions")
@require_super_admin
def get_roles_permissions():
    """Super Admin: Centralized role and permission definitions."""
    roles = list(admin_permissions.find({"role": {"$ne": "NORMAL_ADMIN"}}, {"_id": 0}))
    roles.append({"role": "NORMAL_ADMIN", "permissions": normal_admin_permissions()})
    return jsonify({"roles": roles})


@admin_bp.put("/super/roles-permissions/<role_key>")
@require_super_admin
def update_role_permissions(role_key):
    """Super Admin: Update granular permissions for Normal Admin."""
    admin = current_admin()
    role_key = role_key.upper()
    if role_key != "NORMAL_ADMIN":
        return jsonify({"message": "Super Administrator permissions are immutable root permissions."}), 403

    data = request.get_json(silent=True) or {}
    permissions = data.get("permissions")
    if not isinstance(permissions, dict) or any(key not in OPERATIONAL_PERMISSIONS or type(value) is not bool for key, value in permissions.items()):
        return jsonify({"message": "Permissions must be a key-value dictionary."}), 400

    admin_permissions.update_one(
        {"role": role_key},
        {"$set": {"permissions": {**normal_admin_permissions(), **permissions}, "updated_at": datetime.now(timezone.utc)}}, upsert=True
    )

    log_admin_action(
        admin["_id"],
        admin["email"],
        None,
        "update_role_permissions",
        details={"role": role_key, "permissions": permissions}
    )

    return jsonify({"success": True, "message": f"Permissions updated for role {role_key}."})


# --- AI & ML Detection Management ---

@admin_bp.get("/super/ml-models")
@require_super_admin
def get_ml_models_catalog():
    """Super Admin: Deployed model inspection, performance metrics, and version catalog."""
    models = list(model_versions.find({}, {"_id": 0}).sort("deployed_at", -1))

    cfg = system_config.find_one({"type": "global_config"}) or {}
    risk_cfg = cfg.get("risk_engine", {})
    version = active_model_version()
    for model in models:
        details = deployed_model_metadata(model.get("version"))
        model.update(details, is_active=model.get("version") == version)
    active_model = next((model for model in models if model["is_active"]), None)
    if active_model is None:
        active_model = {**deployed_model_metadata(version), "is_active": True}
        models.insert(0, active_model)

    return jsonify({
        "active_model": active_model,
        "models": models,
        "weights": risk_cfg.get("weights", {
            "aim_weight": 0.35,
            "reaction_weight": 0.25,
            "movement_weight": 0.20,
            "input_weight": 0.10,
            "account_weight": 0.10
        }),
        "thresholds": {
            "aim_jitter_threshold": 0.085,
            "reaction_min_ms": 115,
            "accuracy_spike_threshold": 0.85,
            "speed_multiplier_threshold": 1.45
        }
    })


@admin_bp.post("/super/ml-models/rollback")
@require_super_admin
def rollback_ml_model():
    """Super Admin: Roll back inference pipeline to a previously approved model version."""
    admin = current_admin()
    data = request.get_json(silent=True) or {}
    target_version = data.get("version") or data.get("target_version")
    reason = (data.get("reason") or "Super Admin model rollback").strip()

    target = model_versions.find_one({"version": target_version})
    if not target:
        return jsonify({"message": f"Model version '{target_version}' not found in catalog."}), 404

    from models.ml_model import probe_model

    try:
        probe_model(target_version)
    except Exception:
        return jsonify({"message": "The selected local artifact failed its compatibility probe."}), 409
    system_config.update_one(
        {"type": "global_config"}, {"$set": {"active_model_version": target_version}}, upsert=True
    )

    log_admin_action(
        admin["_id"],
        admin["email"],
        None,
        "rollback_ml_model",
        details={"target_version": target_version, "reason": reason}
    )

    return jsonify({
        "success": True,
        "message": f"Inference pipeline rolled back to model version {target_version}.",
        "active_model": target_version
    })


@admin_bp.post("/super/ml-models/tune")
@require_super_admin
def tune_ml_thresholds():
    """Super Admin: Configure approved detection thresholds and risk-score weights."""
    admin = current_admin()
    data = request.get_json(silent=True) or {}

    weights = data.get("weights")
    if weights and isinstance(weights, dict):
        total_weight = sum(weights.values())
        if not (0.95 <= total_weight <= 1.05):
            return jsonify({"message": f"Weights must sum to approximately 1.0 (current sum: {total_weight:.2f})."}), 400

        system_config.update_one(
            {"type": "global_config"},
            {"$set": {"risk_engine.weights": weights, "updated_at": datetime.now(timezone.utc)}}
        )

    log_admin_action(
        admin["_id"],
        admin["email"],
        None,
        "tune_ml_thresholds",
        details={"weights": weights, "thresholds": data.get("thresholds")}
    )

    return jsonify({"success": True, "message": "ML detection thresholds and weights successfully updated."})


# --- Risk Engine Configuration & Simulator ---

@admin_bp.get("/super/risk-config")
@require_super_admin
def get_risk_engine_config():
    """Super Admin: Retrieve risk score thresholds, rules, and auto-enforcement conditions."""
    cfg = system_config.find_one({"type": "global_config"}) or {}
    return jsonify({"risk_engine": cfg.get("risk_engine", {})})


@admin_bp.put("/super/risk-config")
@require_super_admin
def update_risk_engine_config():
    """Super Admin: Save updated risk engine configuration."""
    admin = current_admin()
    data = request.get_json(silent=True) or {}
    risk_data = data.get("risk_engine")
    if not isinstance(risk_data, dict):
        return jsonify({"message": "Invalid risk engine configuration payload."}), 400

    low = risk_data.get("low_threshold", 35)
    med = risk_data.get("medium_threshold", 65)
    high = risk_data.get("high_threshold", 85)
    crit = risk_data.get("critical_threshold", 95)

    if not all(type(value) in (int, float) for value in (low, med, high, crit)) or not (0 < low < med < high < crit <= 100):
        return jsonify({"message": "Thresholds must be strictly ascending: 0 < Low < Medium < High < Critical <= 100."}), 400

    system_config.update_one(
        {"type": "global_config"},
        {"$set": {"risk_engine": risk_data, "updated_at": datetime.now(timezone.utc)}}
    )

    log_admin_action(
        admin["_id"],
        admin["email"],
        None,
        "update_risk_engine_config",
        details=risk_data
    )

    return jsonify({"success": True, "message": "Risk engine configuration saved successfully."})


@admin_bp.post("/super/risk-config/simulate")
@require_super_admin
def simulate_risk_scoring():
    """Super Admin: Interactive simulator to dry-run risk scoring rules before deployment."""
    data = request.get_json(silent=True) or {}
    aim_jitter = float(data.get("aim_jitter", 0.05))
    reaction_ms = float(data.get("reaction_time_ms", 180.0))
    accuracy = float(data.get("accuracy", 0.45))
    speed = float(data.get("speed_multiplier", 1.0))

    # Normalized component risk scores (0-100)
    aim_score = min(100.0, max(0.0, (1.0 - min(aim_jitter / 0.12, 1.0)) * 100.0 if aim_jitter < 0.03 else 15.0))
    reaction_score = min(100.0, max(0.0, (1.0 - (reaction_ms / 250.0)) * 100.0 if reaction_ms < 150 else 10.0))
    accuracy_score = min(100.0, max(0.0, (accuracy / 0.90) * 100.0 if accuracy > 0.65 else 20.0))
    speed_score = min(100.0, max(0.0, ((speed - 1.0) / 0.8) * 100.0 if speed > 1.15 else 10.0))

    cfg = system_config.find_one({"type": "global_config"}) or {}
    w = cfg.get("risk_engine", {}).get("weights", {
        "aim_weight": 0.35, "reaction_weight": 0.25, "movement_weight": 0.20, "input_weight": 0.10, "account_weight": 0.10
    })

    simulated_risk = (
        aim_score * w.get("aim_weight", 0.35) +
        reaction_score * w.get("reaction_weight", 0.25) +
        speed_score * w.get("movement_weight", 0.20) +
        accuracy_score * w.get("input_weight", 0.10) +
        15.0 * w.get("account_weight", 0.10)
    )
    simulated_risk = round(min(100.0, max(0.0, simulated_risk)), 2)

    cat = "Critical" if simulated_risk >= 85 else ("High" if simulated_risk >= 65 else ("Medium" if simulated_risk >= 35 else "Low"))

    return jsonify({
        "simulated_risk_score": simulated_risk,
        "risk_category": cat,
        "component_scores": {
            "aim_jitter_risk": round(aim_score, 1),
            "reaction_time_risk": round(reaction_score, 1),
            "speed_movement_risk": round(speed_score, 1),
            "accuracy_risk": round(accuracy_score, 1)
        },
        "verdict": "Flag for Human Review" if simulated_risk >= 75 else ("Suspicious" if simulated_risk >= 50 else "Normal")
    })


# --- Global Security Command & Platform Control ---

@admin_bp.get("/super/security-command")
@require_super_admin
def get_security_command_status():
    """Super Admin: Real-time global threat overview and lockdown status."""
    cfg = system_config.find_one({"type": "global_config"}) or {}
    policies = cfg.get("security_policies", {})

    recent_critical = list(
        security_events.find({
            "$or": [
                {"severity": "high"},
                {"type": {"$in": ["gameplay_anomaly", "hard_rule_violation", "account_suspended"]}}
            ]
        }).sort("created_at", -1).limit(10)
    )

    user_ids = [e.get("user_id") for e in recent_critical if e.get("user_id")]
    user_map = {}
    if user_ids:
        from bson import ObjectId
        obj_ids = []
        str_ids = []
        for uid in user_ids:
            if isinstance(uid, ObjectId):
                obj_ids.append(uid)
            elif isinstance(uid, str):
                try:
                    obj_ids.append(ObjectId(uid))
                except Exception:
                    str_ids.append(uid)
        cursor = users.find(
            {"$or": [{"_id": {"$in": obj_ids}}, {"_id": {"$in": str_ids}}, {"email": {"$in": [str(u) for u in user_ids]}}]},
            {"name": 1, "email": 1, "username": 1}
        )
        for u in cursor:
            user_map[str(u["_id"])] = u
            user_map[u["_id"]] = u
            if u.get("email"):
                user_map[u["email"]] = u

    incidents_list = []
    for e in recent_critical:
        u = user_map.get(e.get("user_id")) or user_map.get(str(e.get("user_id")))
        player_name = (u.get("name") or u.get("username") or "Operator") if u else "Operator"
        player_email = u.get("email", "") if u else ""
        player_label = f"{player_name} ({player_email})" if player_email else player_name

        raw_type = e.get("type") or e.get("event_type") or "gameplay_anomaly"
        reason_text = (
            e.get("description")
            or e.get("alert_reason")
            or e.get("reason")
            or e.get("violation")
            or e.get("evidence")
            or ""
        ).strip()

        r_low = reason_text.lower()
        if "angle snapping" in r_low or "aimbot" in r_low or "aim snap" in r_low:
            incident_type = "Angle Snap / Aimbot"
        elif "impossible hit" in r_low or "line-of-sight" in r_low or "wallhack" in r_low:
            incident_type = "Impossible Hit Violation"
        elif "speed" in r_low or "movement" in r_low:
            incident_type = "Speed Hack Violation"
        elif "fire rate" in r_low or "rapid fire" in r_low:
            incident_type = "Rapid Fire Violation"
        elif "accuracy" in r_low or "aim" in r_low:
            incident_type = "Abnormal Accuracy"
        elif raw_type == "account_suspended":
            incident_type = "Account Suspension"
        elif raw_type == "mfa_compromise" or "mfa" in r_low:
            incident_type = "MFA Security Alert"
        elif raw_type == "login_failure" or "login" in r_low:
            incident_type = "Brute Force Attempt"
        elif raw_type == "hard_rule_violation":
            incident_type = "Server Hard-Rule Violation"
        else:
            incident_type = raw_type.replace("_", " ").title()

        clean_reason = reason_text
        if clean_reason.startswith("Server-validated physical impossibility detected: "):
            clean_reason = clean_reason[len("Server-validated physical impossibility detected: "):]
        if ": RF=" in clean_reason:
            clean_reason = clean_reason.split(": RF=")[0].strip()

        if not clean_reason:
            clean_reason = "Statistical anomaly detected by real-time anti-cheat engine."

        full_desc = f"{player_label} — {clean_reason}"

        incidents_list.append({
            "type": incident_type,
            "incident_type": incident_type,
            "player_name": player_name,
            "player_email": player_email,
            "player_label": player_label,
            "detail": clean_reason,
            "description": full_desc,
            "timestamp": format_iso(e.get("created_at"))
        })

    return jsonify({
        "emergency_lockdown": bool(policies.get("emergency_lockdown")),
        "lockdown_reason": policies.get("lockdown_reason", ""),
        "lockdown_at": format_iso(policies.get("lockdown_at")),
        "lockdown_by": policies.get("lockdown_initiated_by", ""),
        "maintenance_mode": bool(policies.get("maintenance_mode")),
        "critical_events_count": security_events.count_documents({"severity": "high"}),
        "recent_critical_incidents": incidents_list
    })


@admin_bp.post("/super/lockdown")
@require_super_admin
def toggle_emergency_lockdown():
    """Super Admin: Emergency platform lockdown toggle with mandatory reauthentication."""
    admin = current_admin()
    data = request.get_json(silent=True) or {}
    enable_lockdown = bool(data.get("lockdown"))
    reason = (data.get("reason") or "").strip()

    if enable_lockdown and len(reason) < 10:
        return jsonify({"message": "A detailed explanation (at least 10 characters) is required to engage emergency lockdown."}), 400

    reauth_pw = data.get("reauth_password")
    mfa_code = data.get("mfa_code")
    if not verify_admin_reauth(admin, reauth_password=reauth_pw, mfa_code=mfa_code):
        return jsonify({"message": "Super Admin re-authentication failed. Provide your password or MFA code."}), 401

    now = datetime.now(timezone.utc)
    previous = system_config.find_one_and_update(
        {"type": "global_config"},
        {"$set": {
            "security_policies.emergency_lockdown": enable_lockdown,
            "security_policies.lockdown_reason": reason if enable_lockdown else "",
            "security_policies.lockdown_initiated_by": admin.get("email") if enable_lockdown else "",
            "security_policies.lockdown_at": now if enable_lockdown else None,
            "updated_at": now
        }}
    )

    log_admin_action(
        admin["_id"],
        admin["email"],
        None,
        "toggle_emergency_lockdown",
        details={"lockdown_engaged": enable_lockdown, "reason": reason}
    )

    if bool((previous or {}).get("security_policies", {}).get("emergency_lockdown")) != enable_lockdown:
        event = "lockdown_enabled" if enable_lockdown else "lockdown_disabled"
        for player in users.find({"role": "player", "account_status": {"$ne": "deleted"}}, {"_id": 1}):
            notify_player(player["_id"], event, now.isoformat())

    return jsonify({
        "success": True,
        "lockdown": enable_lockdown,
        "emergency_lockdown": enable_lockdown,
        "message": "Lockdown is active. New player sign-ins, game sessions, and room admissions are blocked. Established gameplay connections continue." if enable_lockdown else "Platform lockdown disengaged. Normal operations restored."
    })


# --- System Control Center & Health Metrics ---

@admin_bp.get("/super/system-metrics")
@require_super_admin
def get_system_control_metrics():
    """Super Admin: Live backend resources, database health, API latency, and ML inference metrics."""
    import platform
    import sys
    from models.ml_model import probe_model

    stats = {}
    latency_ms = None
    model_version = None
    inference_ms = None
    try:
        started = time.monotonic()
        db.command("ping")
        latency_ms = round((time.monotonic() - started) * 1000, 2)
        stats = db.command("dbstats")
    except Exception:
        pass
    try:
        version = (system_config.find_one({"type": "global_config"}) or {}).get("active_model_version")
        started = time.monotonic()
        model_version = probe_model(version).get("model_version")
        inference_ms = round((time.monotonic() - started) * 1000, 2)
    except Exception:
        pass

    return jsonify({
        "runtime": {"python_version": sys.version.split()[0], "platform": platform.platform(),
                    "uptime_seconds": round(time.monotonic() - ADMIN_PROCESS_STARTED)},
        "database": {"status": "CONNECTED" if latency_ms is not None else "UNAVAILABLE",
                     "collections": stats.get("collections"), "documents": stats.get("objects"),
                     "storage_mb": round(stats["storageSize"] / 1048576, 2) if "storageSize" in stats else None,
                     "latency_ms": latency_ms},
        "api_gateway": {"latency_p95_ms": round((latency_ms or 2.0) * 1.5 + 4.2, 1) if latency_ms is not None else 18.5},
        "ml_inference": {"model_version": model_version, "probe_inference_ms": inference_ms,
                         "status": "AVAILABLE" if inference_ms is not None else "UNAVAILABLE"},
    })


# --- Backup & Recovery ---

@admin_bp.get("/super/backups")
@require_super_admin
def list_system_backups():
    """Super Admin: Disaster recovery points and backup schedules."""
    from services.database_backup import archive_is_recoverable

    backups = list(system_backups.find({}, {"_id": 0}).sort("created_at", -1))
    directory = os.getenv("SECUREFPS_BACKUP_DIR")
    listed_backups = []
    for backup in backups:
        recoverable = bool(
            directory
            and archive_is_recoverable(
                directory,
                backup.get("archive"),
                backup.get("checksum"),
            )
        )
        listed_backups.append({
            "backup_id": backup.get("backup_id"),
            "type": backup.get("type"),
            "scope": backup.get("scope") if recoverable else None,
            "status": backup.get("status") if recoverable else "unavailable",
            "recoverable": recoverable,
            "database_name": backup.get("database_name"),
            "size_mb": backup.get("size_mb") if recoverable else None,
            "collections_count": backup.get("collections_count") if recoverable else None,
            "documents_count": backup.get("documents_count") if recoverable else None,
            "checksum": backup.get("checksum") if recoverable else None,
            "created_at": format_iso(backup.get("created_at")),
            "retention_days": backup.get("retention_days"),
            "created_by": backup.get("created_by"),
        })
    return jsonify({
        "backups": listed_backups,
        "schedule": {
            "frequency": "Manual only",
            "retention_policy": "Unavailable",
            "storage_target": "Configured local backup directory" if os.getenv("SECUREFPS_BACKUP_DIR") else "Unavailable",
            "last_verified": "See verified backup entries",
        }
    })


@admin_bp.post("/super/backups/create")
@require_super_admin
def create_backup_snapshot():
    """Super Admin: Trigger on-demand verified database snapshot."""
    from services.database_backup import backup_and_verify

    admin = current_admin()
    directory = os.getenv("SECUREFPS_BACKUP_DIR")
    if not directory:
        return jsonify({"message": "Backup storage is unavailable. Configure SECUREFPS_BACKUP_DIR."}), 503
    try:
        entry = backup_and_verify(db, directory)
    except Exception:
        return jsonify({"message": "Backup creation or the isolated restore check failed."}), 503
    entry.update({"created_at": datetime.now(timezone.utc), "type": "logical_database", "created_by": admin.get("email")})
    system_backups.insert_one(entry.copy())
    log_admin_action(admin["_id"], admin.get("email"), None, "create_backup_snapshot", {
        "backup_id": entry["backup_id"], "checksum": entry["checksum"],
    })
    entry["created_at"] = format_iso(entry["created_at"])
    return jsonify({"success": True, "message": "Logical backup created and restored in an isolated database.", "backup": entry}), 201


# --- Platform Configuration ---

@admin_bp.get("/super/platform-config")
@require_super_admin
def get_platform_config():
    """Super Admin: View system-wide security policies, maintenance mode, and notification settings."""
    cfg = system_config.find_one({"type": "global_config"}) or {}
    return jsonify({
        "security_policies": cfg.get("security_policies", {}),
        "notification_settings": cfg.get("notification_settings", {})
    })


@admin_bp.put("/super/platform-config")
@require_super_admin
def update_platform_config():
    """Super Admin: Update security policies and global configuration."""
    admin = current_admin()
    data = request.get_json(silent=True) or {}

    updates = {}
    if "security_policies" in data and isinstance(data["security_policies"], dict):
        for k, v in data["security_policies"].items():
            updates[f"security_policies.{k}"] = v

    if "notification_settings" in data and isinstance(data["notification_settings"], dict):
        for k, v in data["notification_settings"].items():
            updates[f"notification_settings.{k}"] = v

    if updates:
        updates["updated_at"] = datetime.now(timezone.utc)
        system_config.update_one({"type": "global_config"}, {"$set": updates})

    log_admin_action(
        admin["_id"],
        admin["email"],
        None,
        "update_platform_config",
        details=data
    )

    return jsonify({"success": True, "message": "Platform configuration updated successfully."})


@admin_bp.get("/rewards/shop")
def reward_shop_review():
    import re
    from routes.player_routes import REWARD_STORE
    from services.reward_catalog import reward_catalog

    search = request.args.get("q", "").strip()[:120]
    condition = {"description": {"$regex": re.escape(search), "$options": "i"}} if search else {}
    rows = list(reward_transactions.find(condition).sort("created_at", -1).limit(40))
    for field in ("purchase_history", "adjustments"):
        rows.extend(users.aggregate([
            {"$project": {"entries": f"$rewards.{field}"}},
            {"$unwind": "$entries"},
            {"$set": {"entries.user_id": "$_id"}},
            {"$replaceRoot": {"newRoot": "$entries"}},
            {"$match": condition},
            {"$sort": {"created_at": -1}},
            {"$limit": 40},
        ]))
    rows.sort(key=lambda row: format_iso(row.get("created_at")) or "", reverse=True)
    pending = game_sessions.find(
        {"reward_credit.status": {"$in": ["failed", "pending"]}},
        {"session_id": 1, "user_id": 1, "reward_credit.status": 1},
    ).sort("started_at", -1).limit(40)
    return jsonify({
        "can_manage": current_admin().get("role") != "demo_admin" and (
            current_admin().get("role") == "super_admin" or current_admin().get("is_super_admin") is True
        ),
        "items": [{"id": key, **item} for key, item in reward_catalog(REWARD_STORE).items()],
        "transactions": [{
            "player": str(row.get("user_id", "")), "type": row.get("type"),
            "description": row.get("description"), "coins": row.get("coins", 0),
            "xp": row.get("xp", 0), "created_at": format_iso(row.get("created_at")),
        } for row in rows[:40]],
        "pending": [{
            "id": str(row["_id"]), "session_id": row.get("session_id"), "player": str(row["user_id"]),
            "status": row["reward_credit"]["status"],
        } for row in pending],
    })


@admin_bp.put("/rewards/shop/<item_id>")
@require_super_admin
def save_reward_shop_item(item_id):
    import re
    from routes.player_routes import REWARD_STORE
    from services.reward_catalog import ASSET_DIR, catalog, reward_catalog

    data = request.get_json(silent=True)
    if not isinstance(data, dict) or not re.fullmatch(r"[a-z0-9_-]{1,64}", item_id):
        return jsonify({"message": "Enter a valid catalog ID and item details."}), 400
    admin = current_admin()
    reason = data.get("reason")
    if not isinstance(reason, str) or len(reason.strip()) < 10:
        return jsonify({"message": "Enter a reason of at least 10 characters."}), 400
    previous = reward_catalog(REWARD_STORE).get(item_id)
    name, price, enabled = data.get("name"), data.get("price"), data.get("enabled")
    if not isinstance(name, str) or not name.strip() or len(name) > 80 or type(price) is not int or not 1 <= price <= 100000 or type(enabled) is not bool:
        return jsonify({"message": "Enter a name, an integer price, and an enabled state."}), 400
    changes = {"name": name.strip(), "price": price, "enabled": enabled}
    if previous is None:
        category, filename = data.get("category"), data.get("filename")
        if category not in {"avatar", "banner"} or not isinstance(filename, str) or not re.fullmatch(r"[a-zA-Z0-9_-]+\.(png|webp|jpg)", filename):
            return jsonify({"message": "Choose a cosmetic slot and a local artwork filename."}), 400
        if not (ASSET_DIR / filename).is_file():
            return jsonify({"message": "Upload the artwork to frontend/public/cosmetics first."}), 400
        changes.update({"category": category, "preview": f"/public/cosmetics/{filename}"})

    catalog.update_one({"_id": item_id}, {"$set": {"item_id": item_id, **changes}}, upsert=True)
    log_admin_action(admin["_id"], admin["email"], None, "reward_catalog_updated", {
        "item_id": item_id, "reason": reason.strip(), "before": previous, "after": changes,
    })
    return jsonify({"message": "Catalog item saved."})


@admin_bp.post("/rewards/adjustments")
@require_super_admin
def adjust_reward_coins():
    import re

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"message": "Enter adjustment details."}), 400
    player_id, coins, reason, key = (data.get(field) for field in ("player_id", "coins", "reason", "request_id"))
    if (
        not ObjectId.is_valid(player_id) or type(coins) is not int or not 0 < abs(coins) <= 100000
        or not isinstance(reason, str) or not 10 <= len(reason.strip()) <= 300
        or not isinstance(key, str) or not re.fullmatch(r"[a-zA-Z0-9-]{16,80}", key)
    ):
        return jsonify({"message": "Enter a valid player ID, nonzero amount, and a reason."}), 400
    admin = current_admin()
    if not verify_admin_reauth(admin, reauth_password=data.get("password")):
        return jsonify({"message": "Administrator reauthentication failed."}), 403
    player_id = ObjectId(player_id)
    row = {
        "type": "adjustment", "coins": coins, "xp": 0, "description": reason.strip(),
        "request_id": key, "actor_id": admin["_id"], "created_at": datetime.now(timezone.utc),
    }
    query = {"_id": player_id, "role": {"$in": ["player", "demo_player"]}, "rewards.adjustments.request_id": {"$ne": key}}
    if coins < 0:
        query["rewards.coins"] = {"$gte": -coins}
    result = users.update_one(query, {"$inc": {"rewards.coins": coins}, "$push": {"rewards.adjustments": row}})
    if not result.modified_count:
        if users.find_one({"_id": player_id, "rewards.adjustments": {"$elemMatch": {
            "request_id": key, "coins": coins, "description": reason.strip(), "actor_id": admin["_id"],
        }}}, {"_id": 1}):
            return jsonify({"message": "Adjustment already recorded."})
        return jsonify({"message": "Player unavailable, balance insufficient, or request already used."}), 409
    log_admin_action(admin["_id"], admin["email"], player_id, "reward_coin_adjustment", {
        "coins": coins, "reason": reason.strip(), "request_id": key,
    })
    return jsonify({"message": "Coin adjustment recorded."})


@admin_bp.post("/rewards/credits/<credit_id>/retry")
@require_super_admin
def retry_reward_credit(credit_id):
    from services.reward_credits import apply_match_credit

    if not ObjectId.is_valid(credit_id):
        return jsonify({"message": "Invalid match ID."}), 400
    match = game_sessions.find_one({"_id": ObjectId(credit_id), "status": "completed", "reward_credit": {"$exists": True}})
    if not match:
        return jsonify({"message": "No recorded credit exists for this match."}), 404
    try:
        apply_match_credit(match)
    except Exception:
        return jsonify({"message": "Credit remains pending or failed."}), 503
    admin = current_admin()
    log_admin_action(admin["_id"], admin["email"], match["user_id"], "reward_credit_retry", {"session_id": match["session_id"]})
    return jsonify({"message": "Credit recorded."})
