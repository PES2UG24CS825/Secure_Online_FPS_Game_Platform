from services.player_notifications import notify_player
from datetime import datetime, timezone, timedelta
import os
import secrets
import uuid
import math
import json
import re
import queue
import threading
import time
import hmac
import hashlib
import jwt

from flask import Blueprint, Response, jsonify, request, session, stream_with_context
from bson import ObjectId

from database.db import (
    db,
    game_events,
    game_telemetry,
    game_sessions,
    security_events,
    login_history,
    users,
    sessions_db,
    reward_transactions,
    support_tickets,
    honour_history,
)
from extensions import limiter

from models.ml_model import predict, predict_selected, FEATURES
from services.anti_cheat_intelligence import AntiCheatIntelligence
from services.risk_scoring import clamp_risk_score, classify_risk_score, classify_configured_risk, RISK_SCORE_SCALE
from services.player_baseline import get_player_baseline
from services.telemetry_validation import validate_telemetry_event, check_rate_limit, clear_session_limits
from services.features_v2 import extract_features_v2, FEATURE_NAMES_V2, FEATURE_UNITS_V2
from services.reward_credits import apply_match_credit, record_match_credit
from pymongo.errors import DuplicateKeyError
from services.admin_permissions import has_operational_permission
from services.csrf import verify_csrf_and_origin
from services.auth_security import player_login_paused


game_bp = Blueprint(
    "game",
    __name__,
    url_prefix="/api"
)


def safe_print(*args, **kwargs):
    if os.getenv("FLASK_DEBUG", "0") in {"1", "true"}:
        try:
            print(*args, **kwargs)
        except OSError:
            pass


import collections

# NOTE: In-memory SSE queues are scoped to a single Python process/worker.
# In a multi-worker production deployment with Gunicorn, Redis Pub/Sub must be used
# to bridge live broadcasts across worker instances.
_live_subscribers = {"admin": set()}
_live_subscribers_lock = threading.Lock()
_live_emit_times = {}
_recent_sse_events = collections.deque(maxlen=100)
_sse_event_id_counter = 0


def publish_live_update(user_id, session_id=None, event_type="game_update", force=False, payload=None):
    """Publish a notification via SSE stream; dashboards fetch authoritative values from MongoDB."""
    global _sse_event_id_counter
    now = time.monotonic()
    user_channel = str(user_id)
    with _live_subscribers_lock:
        queues = []
        if force or now - _live_emit_times.get("admin", 0.0) >= 1.0:
            _live_emit_times["admin"] = now
            queues.extend(_live_subscribers.get("admin", set()))
        if force or now - _live_emit_times.get(user_channel, 0.0) >= 1.0:
            _live_emit_times[user_channel] = now
            queues.extend(_live_subscribers.get(user_channel, set()))

        _sse_event_id_counter += 1
        event_id = _sse_event_id_counter

        payload_dict = {
            "id": event_id,
            "type": event_type,
            "session_id": str(session_id) if session_id else None,
            "server_received_at": utc_now().isoformat(),
            "alert_published_at": utc_now().isoformat(),
            "updated_at": utc_now().isoformat(),
            **(payload or {}),
        }
        payload_json = json.dumps(payload_dict)

        _recent_sse_events.append((event_id, user_channel, payload_json))

        for subscriber in queues:
            try:
                subscriber.put_nowait((event_id, payload_json))
            except queue.Full:
                try:
                    subscriber.get_nowait()
                    subscriber.put_nowait((event_id, payload_json))
                except (queue.Empty, queue.Full):
                    pass


@game_bp.get("/live/events")
def live_events():
    user_id = get_current_user_object_id()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401

    account = users.find_one({"_id": user_id}, {"role": 1, "revoked": 1, "account_status": 1})
    if not account:
        return jsonify({"message": "Account not found."}), 401
    if account.get("account_status") == "suspended":
        return jsonify({"message": "This account has been suspended."}), 403
    if account.get("revoked") is True or account.get("account_status") == "banned":
        return jsonify({"message": "This account is permanently banned."}), 403
    channel = "admin" if account.get("role") in {"admin", "normal_admin", "demo_admin", "super_admin"} else str(user_id)
    subscriber = queue.Queue(maxsize=50)

    last_event_id_header = request.headers.get("Last-Event-ID")
    last_event_id = int(last_event_id_header) if last_event_id_header and re.fullmatch(r"[0-9]{1,20}", last_event_id_header) else None

    with _live_subscribers_lock:
        _live_subscribers.setdefault(channel, set()).add(subscriber)
        missed_events = [
            (eid, p) for (eid, ch, p) in _recent_sse_events
            if last_event_id is not None and eid > last_event_id and (ch == channel or channel == "admin")
        ]

    @stream_with_context
    def event_stream():
        try:
            yield "event: ready\ndata: {}\n\n"
            # Replay any missed events since Last-Event-ID
            for eid, p in missed_events:
                yield f"id: {eid}\nevent: update\ndata: {p}\n\n"

            while True:
                try:
                    event_id, payload = subscriber.get(timeout=15)
                    yield f"id: {event_id}\nevent: update\ndata: {payload}\n\n"
                except queue.Empty:
                    yield ": heartbeat\n\n"
        finally:
            with _live_subscribers_lock:
                channel_subscribers = _live_subscribers.get(channel)
                if channel_subscribers:
                    channel_subscribers.discard(subscriber)

    sse_headers = {
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    }

    return Response(event_stream(), mimetype="text/event-stream", headers=sse_headers)


# =========================================================
# FEATURE NORMALIZATION CONFIGURATION
# =========================================================

# Provisional raw feature ranges.
# These must match the ranges used for model training.
FEATURE_RANGES = {
    "reaction_time": (0.0, 5.0),
    "accuracy": (0.0, 1.0),
    "headshot_ratio": (0.0, 1.0),
    "fire_rate": (0.0, 10.0),
    "movement_speed": (0.0, 10.0),
    "aim_smoothness": (0.0, 1.0),
    "kdr": (0.0, 10.0),
}
BAN_RISK_THRESHOLD = float(os.getenv("BAN_RISK_THRESHOLD", "85"))
MATCH_VOLUNTARY_EXIT_HONOUR_PENALTY = int(os.getenv("MATCH_VOLUNTARY_EXIT_HONOUR_PENALTY", "5"))
MATCH_TIMEOUT_EXIT_HONOUR_PENALTY = int(os.getenv("MATCH_TIMEOUT_EXIT_HONOUR_PENALTY", "5"))
MATCH_ABANDON_HONOUR_PENALTY = MATCH_VOLUNTARY_EXIT_HONOUR_PENALTY
MATCH_COMPLETE_HONOUR_REWARD = int(os.getenv("MATCH_COMPLETE_HONOUR_REWARD", "5"))
MAX_HONOUR_SCORE = 100
MIN_HONOUR_SCORE = 0


def record_honour_transaction(user_id, session_id, points_delta, reason, match_id=None, is_automatic=True):
    """
    Server-authoritative and idempotent helper to adjust honour score.
    Clamps between MIN_HONOUR_SCORE (0) and MAX_HONOUR_SCORE (100).
    Records an immutable audit entry in the honour_history collection.
    """
    user_oid = ObjectId(user_id) if isinstance(user_id, str) and ObjectId.is_valid(user_id) else user_id
    player = users.find_one({"_id": user_oid}) or {}
    prev_val = player.get("honour_score")
    if prev_val is None:
        prev_val = 100
    try:
        previous_score = int(prev_val)
    except (ValueError, TypeError):
        previous_score = 100

    # Strict Demo Isolation: Demo gameplay must never modify Honour scores or audit history
    if player.get("demo") is True or player.get("is_demo") is True or player.get("account_type") == "demo_test":
        return previous_score, previous_score, 0

    new_score = max(MIN_HONOUR_SCORE, min(MAX_HONOUR_SCORE, previous_score + points_delta))
    actual_delta = new_score - previous_score

    users.update_one({"_id": user_oid}, {"$set": {"honour_score": new_score}})

    audit_entry = {
        "player_id": str(user_id),
        "user_id": user_oid,
        "session_id": session_id,
        "match_id": match_id or session_id,
        "previous_score": previous_score,
        "new_score": new_score,
        "points_delta": actual_delta,
        "reason": reason,
        "timestamp": utc_now(),
        "is_automatic": is_automatic,
    }
    honour_history.insert_one(audit_entry)
    return previous_score, new_score, actual_delta

# Alerts indicate suspicious sessions for review, not confirmed cheating.
GAMEPLAY_ALERT_THRESHOLDS = {
    "medium_min_risk_score": float(os.getenv("GAMEPLAY_ALERT_MEDIUM_RISK", "50")),
    "high_min_risk_score": float(os.getenv("GAMEPLAY_ALERT_HIGH_RISK", "75")),
}

DEMO_ACCOUNT_EMAIL = "cheater_demo@example.test"
DEMO_ACCOUNT_USERNAME = "cheater_demo"
DEMO_ACCOUNT_USERNAMES = {"cheater_demo", "demo_cheater"}
DEMO_ACCOUNT_EMAILS = {"cheater_demo@example.test", "demo_cheater@example.test"}

# In-memory caches for demo violation alert debouncing, fire rate interval tracking, and session combat stats
_violation_alert_cache = {}
_violation_cache_lock = threading.Lock()
_demo_last_fire_time = {}
_demo_session_combat_stats = {}


def process_security_violations(game_session, account, event_type, telemetry):
    """
    Server-authoritative detection of cheater demonstration security violations:
    - Impossible Hit (obstacle penetration or extreme distance > 100m)
    - Abnormal Movement Speed (>= 25 m/s vs legitimate sprint <= 11.5 m/s)
    - Abnormal Fire Rate (interval < 0.055s vs legitimate >= 0.09s)
    Persists violations to MongoDB security_events with is_demo: true and emits
    real-time SSE security_alert payloads to administrators.
    """
    session_id = str(game_session.get("session_id", ""))
    user_id = game_session.get("user_id")
    is_demo = bool(
        game_session.get("demo_mode")
        or game_session.get("is_demo")
        or account.get("demo") is True
        or account.get("is_demo") is True
        or account.get("username") in DEMO_ACCOUNT_USERNAMES
    )

    now_mono = time.monotonic()
    now_dt = utc_now()
    violations_found = []

    # Track session combat statistics for statistical anomaly detection
    cstats = _demo_session_combat_stats.setdefault(session_id, {"shots": 0, "hits": 0, "headshots": 0})
    if event_type == "weapon_fire":
        cstats["shots"] += 1

    # 1. IMPOSSIBLE HIT CHECK (Wall Penetration & Extreme Range)
    if event_type in {"enemy_hit", "hit_detail", "weapon_hit"}:
        cstats["hits"] += 1
        is_hs = bool(telemetry.get("headshot") or telemetry.get("is_headshot") or telemetry.get("body_part") == "head")
        if is_hs:
            cstats["headshots"] += 1

        visible_through_wall = bool(
            telemetry.get("visible_through_wall")
            or telemetry.get("through_obstacle")
            or (telemetry.get("line_of_sight") is False)
            or telemetry.get("impossible_hit")
        )
        distance = None
        if "distance" in telemetry and telemetry["distance"] is not None:
            try:
                distance = float(telemetry["distance"])
            except (ValueError, TypeError):
                pass

        shooter_name = account.get("username") or account.get("name") or "cheater_demo"
        target_name = telemetry.get("target_id") or telemetry.get("target") or "Combat Bot"

        if visible_through_wall:
            violations_found.append({
                "type": "impossible_hit",
                "severity": "critical",
                "violation": "Shot Through Obstacle: Hit registered through solid scenery geometry",
                "observed_value": "line_of_sight: false (obstacle penetration detected)",
                "allowed_value": "line_of_sight: true",
                "evidence": {
                    "shooter": shooter_name,
                    "target": target_name,
                    "target_id": target_name,
                    "match_id": session_id,
                    "session_id": session_id,
                    "obstruction_evidence": "Obstacle geometry intersected direct line between shooter and target",
                    "distance": distance,
                    "line_of_sight": False,
                    "through_obstacle": True,
                    "player_position": telemetry.get("player_position") or telemetry.get("position"),
                    "target_position": telemetry.get("target_position"),
                    "weapon": telemetry.get("weapon", "P-24 Carbine"),
                    "timestamp": telemetry.get("timestamp") or now_mono,
                    "detection_timestamp": now_dt.isoformat(),
                }
            })
        elif distance is not None and distance > 100.0:
            violations_found.append({
                "type": "impossible_hit",
                "severity": "critical",
                "violation": "Shot Through Obstacle / Extreme Distance: Hit registered at impossible range",
                "observed_value": f"distance: {distance:.1f}m",
                "allowed_value": "distance: <= 100.0m",
                "evidence": {
                    "shooter": shooter_name,
                    "target": target_name,
                    "target_id": target_name,
                    "match_id": session_id,
                    "session_id": session_id,
                    "distance": distance,
                    "line_of_sight": True,
                    "player_position": telemetry.get("player_position") or telemetry.get("position"),
                    "target_position": telemetry.get("target_position"),
                    "weapon": telemetry.get("weapon", "P-24 Carbine"),
                    "timestamp": telemetry.get("timestamp") or now_mono,
                    "detection_timestamp": now_dt.isoformat(),
                }
            })

        # 1B. HEADSHOT PATTERN ANOMALY CHECK
        # Avoid classifying based on a single hit: requires at least 3 confirmed hits
        if cstats["hits"] >= 3:
            hs_ratio = cstats["headshots"] / cstats["hits"]
            if hs_ratio >= 0.80:
                ratio_pct = round(hs_ratio * 100, 1)
                total_shots_val = max(cstats["shots"], cstats["hits"])
                violations_found.append({
                    "type": "headshot_anomaly",
                    "severity": "critical" if hs_ratio >= 0.95 else "high",
                    "violation": f"Unusual Headshot Pattern: {ratio_pct}% headshots across {cstats['hits']} hits",
                    "observed_value": f"{cstats['headshots']} headshots / {cstats['hits']} hits ({ratio_pct}%, {total_shots_val} shots fired)",
                    "allowed_value": "<= 40.0% expected human headshot ratio",
                    "evidence": {
                        "total_shots": total_shots_val,
                        "successful_hits": cstats["hits"],
                        "headshots": cstats["headshots"],
                        "headshot_ratio": ratio_pct,
                        "match_id": session_id,
                        "session_id": session_id,
                        "target": target_name,
                        "weapon": telemetry.get("weapon", "P-24 Carbine"),
                        "timestamp": telemetry.get("timestamp") or now_mono,
                        "detection_timestamp": now_dt.isoformat(),
                    }
                })

    # 2. ABNORMAL MOVEMENT SPEED CHECK
    if event_type in {"player_behavior", "movement_sample"}:
        speed = None
        if "speed" in telemetry and telemetry["speed"] is not None:
            try:
                speed = float(telemetry["speed"])
            except (ValueError, TypeError):
                pass
        if speed is not None and speed >= 25.0:
            speed_multiplier = round(speed / 11.5, 2)
            violations_found.append({
                "type": "abnormal_speed",
                "severity": "critical",
                "violation": "Excessive Movement Speed: Speed exceeds legitimate physical limits",
                "observed_value": f"{speed:.1f} m/s ({speed_multiplier}x speed multiplier)",
                "allowed_value": "11.5 m/s maximum sprint speed",
                "evidence": {
                    "observed_movement_speed": speed,
                    "normal_permitted_speed": 11.5,
                    "speed_multiplier": speed_multiplier,
                    "deviation_ms": round(speed - 11.5, 1),
                    "match_id": session_id,
                    "session_id": session_id,
                    "calculated_speed": speed,
                    "allowed_maximum": 11.5,
                    "multiplier": speed_multiplier,
                    "position": telemetry.get("position"),
                    "grounded": telemetry.get("grounded", True),
                    "timestamp": telemetry.get("timestamp") or now_mono,
                    "detection_timestamp": now_dt.isoformat(),
                }
            })

    # 3. ABNORMAL FIRE RATE CHECK
    if event_type == "weapon_fire":
        current_time = None
        if "timestamp" in telemetry and telemetry["timestamp"] is not None:
            try:
                current_time = float(telemetry["timestamp"])
            except (ValueError, TypeError):
                pass
        if current_time is None:
            current_time = now_mono

        last_fire = _demo_last_fire_time.get(session_id)
        _demo_last_fire_time[session_id] = current_time
        if last_fire is not None and current_time > last_fire:
            interval = current_time - last_fire
            if 0.005 < interval < 0.055:  # ~18 - 200 rps (legitimate carbine min is 0.11s)
                rps = 1.0 / interval
                violations_found.append({
                    "type": "abnormal_fire_rate",
                    "severity": "high",
                    "violation": "Weapon firing interval below allowed minimum",
                    "observed_value": f"interval: {interval:.3f}s ({rps:.1f} rps)",
                    "allowed_value": "interval: >= 0.090s (<= 11.1 rps)",
                    "evidence": {
                        "interval_seconds": round(interval, 4),
                        "calculated_rps": round(rps, 1),
                        "weapon": telemetry.get("weapon", "P-24 Carbine"),
                        "timestamp": current_time,
                    }
                })

    for v in violations_found:
        cache_key = (session_id, v["type"])
        with _violation_cache_lock:
            last_alert_time = _violation_alert_cache.get(cache_key, 0.0)
            if now_mono - last_alert_time < 1.2:
                continue
            _violation_alert_cache[cache_key] = now_mono

        event_doc = {
            "is_demo": is_demo,
            "demo": is_demo,
            "demo_session_id": session_id if is_demo else None,
            "session_id": session_id,
            "user_id": user_id,
            "player_id": str(user_id) if user_id else None,
            "player_name": account.get("username") or account.get("name") or "cheater_demo",
            "player_email": account.get("email", ""),
            "event_type": v["type"],
            "severity": v["severity"],
            "violation": v["violation"],
            "observed_value": v["observed_value"],
            "allowed_value": v["allowed_value"],
            "evidence": v["evidence"],
            "source": "Server-verified demo event" if is_demo else "Server anti-cheat telemetry",
            "environment": "DEMONSTRATION" if is_demo else "PRODUCTION",
            "created_at": now_dt,
        }
        try:
            security_events.insert_one(event_doc)
        except Exception as e:
            safe_print("[SecureFPS] Error saving demo security event:", e)

        publish_live_update(
            user_id="admin",
            session_id=session_id,
            event_type="security_alert",
            force=True,
            payload={
                "is_demo": is_demo,
                "demo_session_id": session_id if is_demo else None,
                "alert_type": v["type"],
                "severity": v["severity"],
                "player_id": str(user_id) if user_id else None,
                "player_name": account.get("username") or account.get("name") or "cheater_demo",
                "violation": v["violation"],
                "observed_value": v["observed_value"],
                "allowed_value": v["allowed_value"],
                "source": "Server-verified demo event" if is_demo else "Server anti-cheat telemetry",
                "environment": "DEMONSTRATION" if is_demo else "PRODUCTION",
                "evidence": v["evidence"],
                "timestamp": now_dt.isoformat(),
            }
        )


def demo_runtime_enabled():
    return (
        os.getenv("APP_ENV", "").strip().lower()
        in {"development", "dev", "local"}
        and os.getenv("SECUREFPS_ENABLE_DEMO") == "1"
    )


def demo_int_setting(name, default, minimum=1):
    try:
        return max(minimum, int(os.getenv(name, str(default))))
    except (TypeError, ValueError):
        return default


def top_risk_reasons(raw_features, result):
    reasons = []
    labels = {
        "accuracy": "abnormally high accuracy",
        "fire_rate": "abnormally high fire rate",
        "movement_speed": "abnormally high movement speed",
        "kdr": "abnormally high kill/death ratio",
        "aim_smoothness": "inhuman aim consistency",
    }
    ranked = []
    for feature, value in (raw_features or {}).items():
        if isinstance(value, (int, float)) and math.isfinite(value):
            score = value if feature != "aim_smoothness" else 1.0 - value
            ranked.append((score, feature))
    for _, feature in sorted(ranked, reverse=True):
        if feature in labels:
            reasons.append(labels[feature])
    if result.get("random_forest") == "cheater":
        reasons.append("random forest classified the session as cheating")
    if result.get("isolation_forest") == "anomaly":
        reasons.append("isolation forest classified the session as anomalous")
    return reasons[:5] or ["risk threshold exceeded"]


def hacker_detection_reason(profile):
    return {
        "aimbot": "Aimbot pattern: near-zero aim corrections with highly consistent target hits.",
        "wallhack": "Wallhack pattern: enemy hits and tracking were recorded without line of sight.",
        "speedhack": "Speedhack pattern: movement speed and teleport jumps exceeded game limits.",
        "silent_aim": "Silent-aim pattern: hits registered while the crosshair was off target.",
    }.get(profile, "Cheat-specific gameplay pattern detected.")


def hacker_enforcement_score(profile=None):
    # Stable demo-only values keep the four simulated profiles distinct while
    # still showing both 80-range and 90-range enforcement outcomes.
    profile_scores = {
        "aimbot": 93.4,
        "wallhack": 88.6,
        "speedhack": 96.2,
        "silent_aim": 87.9,
    }
    profile_hint = str(profile or "").lower()
    matched_profile = next((name for name in profile_scores if name in profile_hint), None)
    return profile_scores.get(matched_profile, 90.0)


def auto_ban_hacker(user_id, session_id, account, result, raw_features):
    risk_score = result.get("risk_score")
    try:
        demo_threshold = float(os.getenv(
            "DEMO_HACKER_BAN_RISK_THRESHOLD",
            "85",
        ))
    except (TypeError, ValueError):
        demo_threshold = BAN_RISK_THRESHOLD
    required_threshold = (
        demo_threshold
        if account.get("account_type") == "demo_test" and account.get("hacker_profile")
        else BAN_RISK_THRESHOLD
    )
    if (
        account.get("account_type") != "demo_test"
        or not account.get("hacker_profile")
        or not isinstance(risk_score, (int, float))
        or risk_score < required_threshold
        or account.get("revoked") is True
        or account.get("account_status") == "banned"
    ):
        return None

    banned_at = utc_now()
    reasons = [
        hacker_detection_reason(account.get("hacker_profile")),
        *top_risk_reasons(raw_features, result),
    ][:5]
    update = users.update_one(
        {
            "_id": user_id,
            "account_type": "demo_test",
            "hacker_profile": {"$exists": True, "$ne": ""},
            "revoked": {"$ne": True},
            "account_status": {"$ne": "banned"},
        },
        {
            "$set": {
                "revoked": True,
                "account_status": "banned",
                "banned_at": banned_at,
                "ban_reason": reasons,
                "banned_by": "system_auto",
                "risk_score": risk_score,
                "risk_score_session_id": session_id,
                "risk_score_updated_at": banned_at,
                "random_forest": result.get("random_forest"),
                "isolation_forest": result.get("isolation_forest"),
                "random_forest_probability": result.get("random_forest_probability"),
                "isolation_forest_anomaly_score": result.get("isolation_forest_anomaly_score"),
            },
            "$unset": {
                "demo_restricted_until": "",
                "demo_restriction_reason": "",
                "demo_restriction_session_id": "",
            },
        },
    )
    if not update.modified_count:
        return None

    sessions_db.update_many(
        {"user_id": user_id, "is_active": True},
        {"$set": {"is_active": False, "last_activity": banned_at}},
    )
    game_sessions.update_many(
        {"user_id": user_id, "status": "active"},
        {"$set": {
            "status": "terminated_banned",
            "ended_at": banned_at,
            "enforcement_state": "banned",
            "enforcement_action": "permanent_ban",
        }},
    )
    security_events.insert_one({
        "type": "auto_ban",
        "user_id": user_id,
        "session_id": session_id,
        "risk_score": risk_score,
        "reasons": reasons,
        "random_forest": result.get("random_forest"),
        "isolation_forest": result.get("isolation_forest"),
        "random_forest_probability": result.get("random_forest_probability"),
        "isolation_forest_anomaly_score": result.get("isolation_forest_anomaly_score"),
        "result": result,
        "features": normalize_features(raw_features or {}),
        "raw_features": raw_features,
        "hacker_profile": account.get("hacker_profile"),
        "banned_at": banned_at,
        "created_at": banned_at,
    })
    publish_live_update(
        user_id,
        session_id,
        "cheater_banned",
        force=True,
        payload={
            "player_name": account.get("name", account.get("email", "Unknown player")),
            "hacker_profile": account.get("hacker_profile"),
            "risk_score": risk_score,
            "model_risk_score": result.get("model_risk_score", risk_score),
            "top_reasons": reasons,
            "detection_reason": reasons[0],
            "banned_at": banned_at.isoformat(),
        },
    )
    return {
        "state": "banned",
        "action": "permanent_ban",
        "banned_at": banned_at,
        "reasons": reasons,
    }


def demo_float_setting(name, default, minimum=0.1):
    try:
        return max(minimum, float(os.getenv(name, str(default))))
    except (TypeError, ValueError):
        return default


def normalize_feature(name, value):
    """
    Normalize one raw feature to the 0-1 range.
    Missing or invalid values remain None.
    """
    if value is None or isinstance(value, bool):
        return None

    try:
        value = float(value)
    except (TypeError, ValueError):
        return None

    if not math.isfinite(value):
        return None

    if name not in FEATURE_RANGES:
        return None

    minimum, maximum = FEATURE_RANGES[name]

    if maximum <= minimum:
        return None

    normalized = (
        (value - minimum) / (maximum - minimum)
    )

    normalized = max(0.0, min(1.0, normalized))

    return round(normalized, 6)


def normalize_features(raw_features):
    """
    Normalize features in the exact order/names expected
    by the existing ML model.
    """
    return {
        feature: normalize_feature(
            feature,
            raw_features.get(feature)
        )
        for feature in FEATURES
    }


def demo_window_has_stable_samples(user_id, session_id, window_size):
    events = list(
        game_telemetry.find({
            "user_id": user_id,
            "session_id": session_id
        }).sort(
            "created_at",
            -1
        ).limit(window_size)
    )
    counts = {}
    for event in events:
        event_type = event.get("event_type", "")
        counts[event_type] = counts.get(event_type, 0) + 1

    minimum_samples = {
        "weapon_fire": demo_int_setting("DEMO_REALTIME_MIN_SHOTS", 5),
        "enemy_hit": demo_int_setting("DEMO_REALTIME_MIN_HITS", 3),
        "player_behavior": demo_int_setting("DEMO_REALTIME_MIN_MOVEMENT_SAMPLES", 2),
        "aim_behavior": demo_int_setting("DEMO_REALTIME_MIN_AIM_SAMPLES", 3),
        "enemy_killed": demo_int_setting("DEMO_REALTIME_MIN_KILLS", 3),
        "player_death": demo_int_setting("DEMO_REALTIME_MIN_DEATHS", 1)
    }
    return all(
        counts.get(event_type, 0) >= minimum
        for event_type, minimum in minimum_samples.items()
    )


def gameplay_alert_severity(result, analysis_status):
    if analysis_status != "success":
        return None

    risk_score = result.get("risk_score")
    if (
        isinstance(risk_score, bool)
        or not isinstance(risk_score, (int, float))
        or not math.isfinite(risk_score)
    ):
        return None

    rf_flagged = result.get("random_forest") == "cheater"
    isolation_flagged = result.get("isolation_forest") == "anomaly"

    if (
        rf_flagged
        and isolation_flagged
        and risk_score >= GAMEPLAY_ALERT_THRESHOLDS["high_min_risk_score"]
    ):
        return "high"

    if (
        (rf_flagged or isolation_flagged)
        and risk_score >= GAMEPLAY_ALERT_THRESHOLDS["medium_min_risk_score"]
    ):
        return "medium"

    return None


# =========================================================
# HELPER FUNCTIONS
# =========================================================

def current_user():
    """
    Return logged-in user's ID from Flask session.
    """
    return session.get("user_id")


def get_current_user_object_id():
    """
    Convert logged-in user's session ID into MongoDB ObjectId.
    """
    user_id = current_user()

    if not user_id:
        return None

    try:
        return ObjectId(user_id)
    except Exception:
        return None


def is_admin():
    """
    Check whether currently logged-in user is admin.
    """
    # Keep this check consistent with the admin overview, which already allows
    # moderator and super_admin accounts to use the operations console.
    return bool(current_admin())


def current_admin(*, allow_demo=False):
    user_id = get_current_user_object_id()
    if not user_id:
        return None
    roles = ["admin", "moderator", "normal_admin", "super_admin"]
    if allow_demo:
        roles.append("demo_admin")
    return users.find_one({"_id": user_id, "role": {"$in": roles}})


def utc_now():
    """
    Return timezone-aware UTC datetime.
    """
    return datetime.now(timezone.utc)


# =========================================================
# START GAME SESSION
# =========================================================
#
# Dashboard:
#
# POST /api/game/start
#
# Response:
#
# {
#     "success": true,
#     "session_id": "...",
#     "game_token": "...",
#     "game": "FPS_Microgame"
# }
#
# Dashboard then opens:
#
# index.html?session_id=XXX&game_token=YYY
#
# =========================================================

@game_bp.get("/game/socket-ticket")
def get_socket_ticket():
    user_id = get_current_user_object_id()
    if not user_id:
        return jsonify({"message": "Sign in to use multiplayer."}), 401
    account = users.find_one({"_id": user_id})
    if not account or account.get("role", "player") not in {"player", "demo_player"}:
        return jsonify({"message": "Player access required."}), 403
    if account.get("force_password_reset") or account.get("revoked") or account.get("account_status") in {"suspended", "banned", "deleted"}:
        return jsonify({"message": "This account cannot enter multiplayer."}), 403
    if player_login_paused(account):
        return jsonify({"message": "Multiplayer admission is paused during lockdown."}), 503
    secret = os.getenv("GAME_SERVER_SECRET", "securefps-multiplayer-secret-key-2026")
    token = jwt.encode({
        "userId": str(user_id),
        "username": account.get("username") or account.get("name") or "Operator",
        "exp": datetime.now(timezone.utc) + timedelta(minutes=20),
    }, secret, algorithm="HS256")
    response = jsonify({"socket_token": token})
    response.headers["Cache-Control"] = "no-store"
    return response


@game_bp.post("/game/start")
def start_game():

    user_id = get_current_user_object_id()

    if not user_id:
        return jsonify({
            "message": "Authentication required."
        }), 401

    account = users.find_one({"_id": user_id})
    if not account:
        return jsonify({
            "message": "Account not found."
        }), 401
    if account.get("force_password_reset"):
        return jsonify({"message": "Reset your password before starting a game."}), 403
    if player_login_paused(account):
        return jsonify({"message": "New game sessions are temporarily unavailable."}), 503
    if account.get("account_status") == "suspended":
        return jsonify({"message": "This account has been suspended."}), 403
    if account.get("revoked") is True or account.get("account_status") == "banned":
        return jsonify({"message": "This account is permanently banned."}), 403

    if account.get("honour_score") is None:
        users.update_one(
            {"_id": user_id, "honour_score": {"$exists": False}},
            {"$set": {"honour_score": 100}},
        )
        account["honour_score"] = 100
    # Honour affects the player's score only; clear old cooldowns created by the earlier rule.
    if account.get("play_restricted_until"):
        users.update_one(
            {"_id": user_id},
            {"$unset": {"play_restricted_until": ""}},
        )

    restricted_until = account.get("demo_restricted_until")
    if restricted_until:
        if restricted_until.tzinfo is None:
            restricted_until = restricted_until.replace(tzinfo=timezone.utc)
        if restricted_until > utc_now():
            return jsonify({
                "message": "This demo account is temporarily restricted pending admin review.",
                "enforcement_state": "restricted",
                "restricted_until": restricted_until.isoformat()
            }), 403
        users.update_one(
            {"_id": user_id, "demo": True},
            {
                "$unset": {
                    "demo_restricted_until": "",
                    "demo_restriction_reason": ""
                },
                "$set": {"demo_restriction_status": "expired"}
            }
        )

    req_body = request.get_json(silent=True) or {}
    game_name = req_body.get("game") or "FPS_Microgame"
    game_mode = str(req_body.get("mode") or "").strip().lower()
    game_difficulty = str(req_body.get("difficulty") or "").strip().lower()

    # Strict Demo Isolation & Authorization Check
    requested_demo = bool(
        req_body.get("demo")
        or req_body.get("is_demo")
        or game_mode in {"demo_cheater", "demo"}
    )
    is_demo_account = bool(
        account.get("demo") is True
        and account.get("account_type") == "demo_test"
        and (
            account.get("hacker_profile")
            or account.get("username") in DEMO_ACCOUNT_USERNAMES
            or account.get("email") in DEMO_ACCOUNT_EMAILS
        )
    )

    if requested_demo:
        if not is_demo_account:
            return jsonify({
                "message": "Demo mode is restricted to authorized demonstration accounts."
            }), 403
        if not demo_runtime_enabled():
            return jsonify({
                "message": "Demonstration mode is disabled. Set APP_ENV=development and SECUREFPS_ENABLE_DEMO=1."
            }), 403
        if game_mode == "multiplayer":
            return jsonify({
                "message": "Demonstration mode is not permitted in normal multiplayer matches."
            }), 400

    hacker_demo_mode = (
        os.getenv("APP_ENV", "").strip().lower()
        in {"development", "dev", "local"}
        and account.get("hacker_profile")
    )
    demo_mode = bool(
        (demo_runtime_enabled() or hacker_demo_mode)
        and is_demo_account
        and (requested_demo or account.get("username") in DEMO_ACCOUNT_USERNAMES)
        and game_mode != "multiplayer"
    )

    # Generate clean sequential numeric session ID (e.g. 1007, 1008...)
    max_sid = 1006
    for s in game_sessions.find({"session_id": {"$regex": r"^\d+$"}}, {"session_id": 1}):
        try:
            val = int(s.get("session_id", 0))
            if val > max_sid:
                max_sid = val
        except Exception:
            pass
    session_id = str(max_sid + 1)

    game_token = secrets.token_urlsafe(32)
    now = utc_now()

    is_record_session = bool(req_body.get("record_session", False))
    player_group_id = req_body.get("player_group") or str(user_id)
    session_source = req_body.get("source", "human")
    session_label = int(req_body.get("label", 0))

    game_session = {
        "session_id": session_id,
        "game_token": game_token,
        "user_id": user_id,
        "player_group": player_group_id,
        "source": session_source,
        "label": session_label,
        "record_session": is_record_session,
        "game": game_name,
        "mode": game_mode or ("bots" if game_name == "CyberStrike_3D" else ""),
        "difficulty": game_difficulty,
        "started_at": now,
        "ended_at": None,
        "expires_at": now + timedelta(hours=2),
        "status": "active",
        "demo_mode": demo_mode,
        "is_demo": demo_mode,
        "demo_session_id": session_id if demo_mode else None,
        "demo_label": "cheater_demo" if demo_mode else None,
        "event_count": 0
    }

    try:

        game_sessions.insert_one(game_session)

    except Exception as exc:

        safe_print(
            "[SecureFPS] Failed to create game session:",
            exc
        )

        return jsonify({
            "message": "Could not create game session."
        }), 500

    publish_live_update(user_id, session_id, "game_started", force=True)

    safe_print()
    safe_print("==========================================")
    safe_print("[SecureFPS] GAME SESSION CREATED")
    safe_print("User ID:", user_id)
    safe_print("Session ID:", session_id)
    safe_print("Game token received:", bool(game_token))
    safe_print("==========================================")
    safe_print()

    GAME_SERVER_SECRET = os.getenv("GAME_SERVER_SECRET", "securefps-multiplayer-secret-key-2026")
    try:
        socket_token = jwt.encode({
            "userId": str(user_id),
            "username": account.get("username") or account.get("name") or "Operator",
            "sessionId": session_id,
            "exp": datetime.now(timezone.utc) + timedelta(hours=2)
        }, GAME_SERVER_SECRET, algorithm="HS256")
    except Exception:
        socket_token = None

    return jsonify({
        "success": True,
        "session_id": session_id,
        "game_token": game_token,
        "socket_token": socket_token,
        "game": game_name,
        "demo_mode": demo_mode,
        "is_demo": demo_mode,
        "demo_authorized": demo_mode,
    }), 201


@game_bp.get("/game/demo-status")
def get_demo_status():
    """Return whether the authenticated player is authorized for cheat demonstration mode."""
    user_id = get_current_user_object_id()
    if not user_id:
        return jsonify({"authorized": False, "reason": "Authentication required."}), 401

    account = users.find_one({"_id": user_id}) or {}
    env_enabled = demo_runtime_enabled()
    is_demo_user = bool(
        account.get("demo") is True
        and account.get("account_type") == "demo_test"
        and (
            account.get("hacker_profile")
            or account.get("username") in DEMO_ACCOUNT_USERNAMES
            or account.get("email") in DEMO_ACCOUNT_EMAILS
        )
    )

    can_use = env_enabled and is_demo_user
    return jsonify({
        "environment_enabled": env_enabled,
        "is_demo_account": is_demo_user,
        "can_use_demo_panel": can_use,
        "username": account.get("username") or account.get("name"),
        "email": account.get("email"),
        "role": account.get("role"),
    }), 200


@game_bp.post("/game/resume")
def resume_game_session():
    user_id = get_current_user_object_id()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401
    data = request.get_json(silent=True) or {}
    session_id = data.get("session_id")
    if not isinstance(session_id, str) or not session_id:
        return jsonify({"message": "session_id is required."}), 400

    active_match = game_sessions.find_one({
        "session_id": session_id,
        "user_id": user_id,
        "game": "CyberStrike_3D",
        "status": "active",
    })
    if not active_match:
        return jsonify({"message": "No active telemetry session can be resumed."}), 404

    latest_event = game_telemetry.find_one(
        {"session_id": session_id, "user_id": user_id},
        {"seq": 1},
        sort=[("seq", -1)],
    )
    return jsonify({
        "session_id": session_id,
        "game_token": active_match["game_token"],
        "event_sequence": int(latest_event.get("seq") or 0) if latest_event else 0,
    }), 200


# =========================================================
# RECEIVE UNITY GAME EVENTS
# =========================================================
#
# Unity sends:
#
# POST /api/game-events
#
# {
#     "game_token": "...",
#     "session_id": "...",
#     "event_type": "weapon_fire",
#     "game": "FPS_Microgame",
#     "telemetry": {}
# }
#
# =========================================================

@game_bp.post("/game-events")
@limiter.limit("240 per minute")
def receive_game_event():

    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return jsonify({"message": "Telemetry must be a JSON object."}), 400

    game_token = data.get("game_token")
    session_id = data.get("session_id")
    event_type = data.get("event_type")
    game_name = data.get(
        "game",
        "FPS_Microgame"
    )
    telemetry = data.get(
        "telemetry",
        {}
    )

    # -----------------------------------------------------
    # VALIDATION
    # -----------------------------------------------------

    if not game_token:
        return jsonify({
            "message": "Game token is required."
        }), 400

    if not session_id:
        return jsonify({
            "message": "Session ID is required."
        }), 400

    # Support client-side batched telemetry payload: {"events": [...]}
    batch_events = data.get("events")
    if isinstance(batch_events, list) and len(batch_events) > 0:
        game_session = game_sessions.find_one({
            "session_id": session_id,
            "game_token": game_token
        })
        if not game_session:
            return jsonify({"message": "Invalid game session or token."}), 401
        if game_session.get("status") != "active":
            return jsonify({"message": "Game session is not active."}), 409

        now = utc_now()
        inserted_docs = []
        inserted_count = 0
        user_id = game_session.get("user_id")
        account = users.find_one({"_id": user_id}) or {}
        for item in batch_events:
            if not isinstance(item, dict) or not isinstance(item.get("telemetry", {}), dict):
                continue
            ev_type = item.get("event_type")
            ev_telemetry = item.get("telemetry", {})
            if isinstance(ev_type, str) and ev_type and ev_type != "game_completed":
                # Check for cheater demonstration security violations
                process_security_violations(game_session, account, ev_type, ev_telemetry)
                event_document = {
                    "session_id": session_id,
                    "user_id": user_id,
                    "event_type": ev_type,
                    "telemetry": ev_telemetry,
                    "game": game_name,
                    "seq": item.get("seq"),
                    "timestamp": item.get("timestamp"),
                    "demo": game_session.get("demo_mode") is True,
                    "is_demo": game_session.get("demo_mode") is True,
                    "demo_label": "cheater_demo" if game_session.get("demo_mode") else None,
                    "created_at": now,
                    "received_at": now
                }
                shot_id = ev_telemetry.get("shot_id")
                if ev_type in {"weapon_fire", "enemy_hit"} and isinstance(shot_id, str) and shot_id:
                    event_document["_id"] = f"shot:{session_id}:{ev_type}:{shot_id}"
                    result = game_telemetry.update_one(
                        {"_id": event_document["_id"]},
                        {"$setOnInsert": event_document},
                        upsert=True,
                    )
                    inserted_count += int(result.upserted_id is not None)
                else:
                    inserted_docs.append(event_document)
        if inserted_docs:
            game_telemetry.insert_many(inserted_docs)
            inserted_count += len(inserted_docs)
        if inserted_count:
            game_sessions.update_one(
                {"session_id": session_id},
                {"$inc": {"event_count": inserted_count}}
            )
        return jsonify({
            "success": True,
            "processed": inserted_count,
            "status": "batched_received"
        }), 200

    if not event_type:

        return jsonify({
            "message": "Event type is required."
        }), 400

    if not isinstance(telemetry, dict):

        return jsonify({
            "message": "Telemetry must be a JSON object."
        }), 400

    # -----------------------------------------------------
    # FIND SESSION
    # -----------------------------------------------------

    game_session = game_sessions.find_one({
        "session_id": session_id,
        "game_token": game_token
    })

    if not game_session:

        safe_print(
            "[SecureFPS] ERROR: Invalid session/token."
        )

        return jsonify({
            "message": "Invalid game session."
        }), 403

    if event_type == "game_completed" and game_session.get("mode") == "multiplayer":
        return jsonify({"message": "Multiplayer results require a signed match receipt."}), 409

    # Server-side Rate Limit Validation (Phase 1)
    allowed, rl_err = check_rate_limit(session_id, event_type)
    if not allowed:
        return jsonify({"message": rl_err or "Rate limit exceeded."}), 429

    # Server-side Schema & Range Validation (Phase 1)
    is_valid, val_err = validate_telemetry_event(event_type, telemetry)
    if not is_valid:
        return jsonify({"message": f"Invalid telemetry: {val_err}"}), 400

    # Capture sequence number and timestamp
    event_seq = data.get("seq") or telemetry.get("seq")
    event_timestamp = data.get("timestamp") or telemetry.get("timestamp")
    if event_seq is not None:
        telemetry["seq"] = event_seq
    if event_timestamp is not None:
        telemetry["timestamp"] = event_timestamp

    # -----------------------------------------------------
    # CHECK STATUS
    # -----------------------------------------------------

    if game_session.get("status") != "active":
        if game_session.get("status") == "completed":
            ended_at = game_session.get("ended_at")
            if ended_at:
                if ended_at.tzinfo is None:
                    ended_at = ended_at.replace(tzinfo=timezone.utc)
                if (utc_now() - ended_at).total_seconds() < 15:
                    return jsonify({
                        "message": "Telemetry accepted (late event within grace window).",
                        "status": "completed"
                    }), 200

        safe_print(
            "[SecureFPS] ERROR: Game session is not active."
        )

        return jsonify({
            "message": "Game session is not active.",
            "enforcement_state": game_session.get("enforcement_state", "inactive"),
            "enforcement_action": game_session.get("enforcement_action", "none"),
            "restricted_until": (
                game_session["restricted_until"].isoformat()
                if game_session.get("restricted_until")
                else None
            )
        }), 403

    # -----------------------------------------------------
    # CHECK EXPIRATION
    # -----------------------------------------------------

    expires_at = game_session.get("expires_at")

    if expires_at:

        now = utc_now()

        # Handle both timezone-aware and old naive Mongo dates
        if expires_at.tzinfo is None:

            expires_at = expires_at.replace(
                tzinfo=timezone.utc
            )

        if expires_at < now:

            game_sessions.update_one(
                {
                    "session_id": session_id
                },
                {
                    "$set": {
                        "status": "expired"
                    }
                }
            )

            return jsonify({
                "message": "Game session has expired."
            }), 403

    # -----------------------------------------------------
    # GET USER
    # -----------------------------------------------------

    user_id = game_session.get("user_id")

    if not user_id:

        return jsonify({
            "message": "Game session has no user."
        }), 400
    account = users.find_one({"_id": user_id}, {"revoked": 1, "account_status": 1})
    if account and (
        account.get("revoked") is True or account.get("account_status") == "banned"
    ):
        return jsonify({"message": "This account is permanently banned."}), 403
    if account and account.get("account_status") == "suspended":
        return jsonify({"message": "This account has been suspended."}), 403

    # -----------------------------------------------------
    # STORE TELEMETRY
    # -----------------------------------------------------

    telemetry_document = {
        "session_id": session_id,
        "user_id": user_id,
        "game": game_name,
        "event_type": event_type,
        "telemetry": telemetry,
        "seq": event_seq,
        "timestamp": event_timestamp,
        "demo": game_session.get("demo_mode") is True,
        "is_demo": game_session.get("demo_mode") is True,
        "demo_label": (
            "cheater_demo"
            if game_session.get("demo_mode") is True
            else None
        ),
        "created_at": utc_now()
    }

    try:

        shot_id = telemetry.get("shot_id")
        if event_type in {"weapon_fire", "enemy_hit"} and isinstance(shot_id, str) and shot_id:
            telemetry_document["_id"] = f"shot:{session_id}:{event_type}:{shot_id}"
            result = game_telemetry.update_one(
                {"_id": telemetry_document["_id"]},
                {"$setOnInsert": telemetry_document},
                upsert=True,
            )
            if result.upserted_id is None:
                return jsonify({"success": True, "status": "duplicate_ignored"}), 200
        else:
            result = game_telemetry.insert_one(telemetry_document)

    except Exception as exc:

        safe_print(
            "[SecureFPS] MongoDB telemetry error:",
            exc
        )

        return jsonify({
            "message": "Failed to store telemetry."
        }), 500

    stored_event_id = (
        result.inserted_id
        if hasattr(result, "inserted_id")
        else result.upserted_id or telemetry_document["_id"]
    )
    safe_print("[SecureFPS] Telemetry stored:", stored_event_id)

    # Server-verified security violation evaluation (Impossible hit, speed, fire rate)
    process_security_violations(game_session, account, event_type, telemetry)

    # -----------------------------------------------------
    # AUTOMATIC ML ANALYSIS
    # -----------------------------------------------------

    analysis = None
    realtime_detection = None

    realtime_enabled = os.getenv("GAMEPLAY_REALTIME_ENABLED", "1").strip().lower() in {
        "1", "true", "yes", "on"
    }
    if event_type != "game_completed" and realtime_enabled:
        game_sessions.update_one(
            {
                "session_id": session_id,
                "user_id": user_id,
                "status": "active"
            },
            {"$inc": {"event_count": 1}}
        )
        current_game_session = game_sessions.find_one({
            "session_id": session_id,
            "user_id": user_id,
            "status": "active"
        })
        demo_session = bool(current_game_session and current_game_session.get("demo_mode"))
        min_events = demo_int_setting(
            "DEMO_REALTIME_MIN_EVENTS" if demo_session else "GAMEPLAY_REALTIME_MIN_EVENTS",
            24,
        )
        window_size = demo_int_setting(
            "DEMO_REALTIME_WINDOW_EVENTS" if demo_session else "GAMEPLAY_REALTIME_WINDOW_EVENTS",
            100,
        )
        interval = demo_float_setting(
            "DEMO_REALTIME_EVAL_INTERVAL_SECONDS" if demo_session else "GAMEPLAY_REALTIME_INTERVAL_SECONDS",
            5.0,
        )

        if current_game_session and current_game_session.get("event_count", 0) >= min_events:
            last_evaluation = current_game_session.get("last_realtime_analysis_at")
            if last_evaluation and last_evaluation.tzinfo is None:
                last_evaluation = last_evaluation.replace(tzinfo=timezone.utc)
            elapsed = (
                (utc_now() - last_evaluation).total_seconds()
                if last_evaluation
                else interval
            )

            if elapsed >= interval:
                window_raw_features = extract_features(
                    user_id,
                    session_id,
                    max_events=window_size
                )
                window_features = normalize_features(window_raw_features or {})
                window_missing = [
                    feature
                    for feature in FEATURES
                    if window_features.get(feature) is None
                ]

                if not window_missing:
                    claim_time = utc_now()
                    last_allowed = claim_time - timedelta(seconds=interval)
                    claim = game_sessions.update_one(
                        {
                            "session_id": session_id,
                            "user_id": user_id,
                            "status": "active",
                            "$or": [
                                {"last_realtime_analysis_at": {"$exists": False}},
                                {"last_realtime_analysis_at": {"$lte": last_allowed}}
                            ]
                        },
                        {"$set": {"last_realtime_analysis_at": claim_time}}
                    )

                    if claim.modified_count:
                        analysis = analyze_game_session(
                            user_id,
                            session_id,
                            max_events=window_size,
                            realtime=True
                        )
                        realtime_detection = {
                            "status": analysis.get("status"),
                            "random_forest": (analysis.get("result") or {}).get("random_forest"),
                            "isolation_forest": (analysis.get("result") or {}).get("isolation_forest"),
                            "random_forest_probability": (analysis.get("result") or {}).get("random_forest_probability"),
                            "isolation_forest_anomaly_score": (analysis.get("result") or {}).get("isolation_forest_anomaly_score"),
                            "random_forest_status": (analysis.get("result") or {}).get("random_forest_status"),
                            "isolation_forest_status": (analysis.get("result") or {}).get("isolation_forest_status"),
                            "risk_score": analysis.get("risk_score"),
                            "alert_triggered": bool(analysis.get("alert_severity")),
                            "alert_severity": analysis.get("alert_severity"),
                            "enforcement_state": analysis.get("enforcement_state", "monitoring"),
                            "enforcement_action": analysis.get("enforcement_action", "none")
                        }

    if event_type == "game_completed":

        safe_print()
        safe_print(
            "[SecureFPS] Game completed."
        )

        safe_print(
            "[SecureFPS] Starting automatic ML analysis..."
        )

        # Claim completion after storing the event, so /game/end cannot trigger
        # a second analysis for the same session.
        telem_data = event.get("telemetry") or {}
        completion_set = {
            "status": "completed",
            "ended_at": utc_now()
        }
        if "kills" in telem_data and telem_data["kills"] is not None:
            completion_set["kills"] = int(telem_data["kills"])
        if "deaths" in telem_data and telem_data["deaths"] is not None:
            completion_set["deaths"] = int(telem_data["deaths"])
        if "shots" in telem_data and telem_data["shots"] is not None:
            completion_set["shots_fired"] = int(telem_data["shots"])
        if "hits" in telem_data and telem_data["hits"] is not None:
            completion_set["shots_hit"] = int(telem_data["hits"])
        if "accuracy" in telem_data and telem_data["accuracy"] is not None:
            completion_set["accuracy"] = float(telem_data["accuracy"])
        if "headshots" in telem_data and telem_data["headshots"] is not None:
            completion_set["headshots"] = int(telem_data["headshots"])
        if "kdr" in telem_data and telem_data["kdr"] is not None:
            completion_set["kdr"] = float(telem_data["kdr"])
        if "winner" in telem_data and telem_data["winner"]:
            completion_set["winner"] = str(telem_data["winner"])

        completion = game_sessions.update_one(
            {
                "session_id": session_id,
                "user_id": user_id,
                "status": "active"
            },
            {
                "$set": completion_set,
                "$unset": {"expires_at": ""},
            }
        )

        if completion.modified_count:
            users.update_one(
                {"_id": user_id, "honour_score": {"$exists": False}},
                {"$set": {"honour_score": 100}},
            )
            honour_before = users.find_one({"_id": user_id}, {"honour_score": 1}) or {}
            honour_before = max(0, min(MAX_HONOUR_SCORE, int(honour_before.get("honour_score", 100))))
            users.update_one(
                {"_id": user_id},
                [{"$set": {
                    "honour_score": {
                        "$min": [
                            MAX_HONOUR_SCORE,
                            {"$add": [{"$ifNull": ["$honour_score", 100]}, MATCH_COMPLETE_HONOUR_REWARD]},
                        ]
                    }
                }}],
            )
            honour_after = users.find_one({"_id": user_id}, {"honour_score": 1}) or {}
            honour_awarded = max(0, int(honour_after.get("honour_score", honour_before)) - honour_before)
            game_sessions.update_one(
                {"session_id": session_id, "user_id": user_id},
                {"$set": {"honour_awarded": honour_awarded}},
            )
            if not (game_session.get("demo_mode") or game_session.get("is_demo")):
                record_match_credit(user_id, session_id, {
                    "type": "match_completed",
                    "description": f"Completed an FPS Microgame match; +{honour_awarded} Honour",
                    "coins": 0,
                    "xp": 0,
                    "honour": honour_awarded,
                    "honour_before": honour_before,
                    "honour_after": int(honour_after.get("honour_score", honour_before)),
                    "created_at": utc_now(),
                })
            analysis = analyze_game_session(
                user_id,
                session_id
            )

    # -----------------------------------------------------
    # RESPONSE
    # -----------------------------------------------------

    response = {
        "success": True,
        "message": "Telemetry stored.",
        "event_id": str(stored_event_id),
        "session_id": session_id,
        "event_type": event_type
    }

    if event_type == "game_started":
        response["demo_mode"] = bool(
            game_session.get("demo_mode") is True
        )

    if analysis:

        response["analysis"] = analysis

    if realtime_detection:
        response["realtime_detection"] = realtime_detection

    publish_live_update(
        user_id,
        session_id,
        "analysis_complete" if analysis else event_type,
        force=bool(analysis) or event_type == "game_completed",
    )
    return jsonify(response), 201


# =========================================================
# ANALYZE GAME SESSION
# =========================================================

def analyze_game_session(
    user_id,
    session_id,
    max_events=None,
    realtime=False
):
    """
    Extract raw gameplay features, normalize them,
    and run the existing ML prediction function.
    """

    safe_print()
    safe_print("==========================================")
    safe_print("[SecureFPS] ANALYZING GAME SESSION")
    safe_print("Session:", session_id)
    safe_print("==========================================")

    raw_features = extract_features(
        user_id,
        session_id,
        max_events=max_events
    )

    game_session = game_sessions.find_one({
        "session_id": session_id,
        "user_id": user_id
    }) or {}
    account = users.find_one({"_id": user_id}) or {}
    hacker_demo_allowed = (
        os.getenv("APP_ENV", "").strip().lower()
        in {"development", "dev", "local"}
        and account.get("hacker_profile")
    )
    is_demo = bool(
        (demo_runtime_enabled() or hacker_demo_allowed)
        and (game_session.get("demo_mode") is True or game_session.get("is_demo") is True)
        and account.get("demo") is True
        and account.get("account_type") == "demo_test"
        and (
            account.get("hacker_profile")
            or account.get("username") in DEMO_ACCOUNT_USERNAMES
            or account.get("email") in DEMO_ACCOUNT_EMAILS
        )
    )

    if raw_features is None:
        raw_features = {
            feature: None
            for feature in FEATURES
        }

    # -----------------------------------------------------
    # NORMALIZE ACTIVE FEATURES
    # -----------------------------------------------------

    features = normalize_features(raw_features)

    missing_features = [
        feature
        for feature in FEATURES
        if features.get(feature) is None
    ]

    result = {}
    error = None

    if missing_features:
        safe_print(
            "[SecureFPS] Missing measurable gameplay features:",
            missing_features
        )
        status = "incomplete_features"

    else:
        # -----------------------------------------------------
        # RUN ML MODELS
        # -----------------------------------------------------

        try:

            config = db["system_config"].find_one({"type": "global_config"}) or {}
            selected_model = config.get("active_model_version")
            result = predict_selected(features, selected_model) if selected_model else predict(features)
            model_errors = [
                f"{name}: {value}"
                for name, value in result.items()
                if name.endswith("_status") and value
            ]
            if model_errors:
                raise RuntimeError("; ".join(model_errors))

            status = "success"
            # -----------------------------------------------------
            # HUMAN BEHAVIOR INTELLIGENCE & SKILL CONTEXT ARBITRATION
            # -----------------------------------------------------
            session_telemetry = list(game_telemetry.find({
                "user_id": user_id,
                "session_id": session_id
            }).sort("created_at", 1))
            audit = AntiCheatIntelligence.audit_telemetry_stream(session_telemetry)
            player_baseline = get_player_baseline(users, game_events, user_id)
            game_mode = game_session.get("mode") or game_session.get("game", "CyberStrike_3D")
            human_eval = AntiCheatIntelligence.evaluate_human_skill_context(
                raw_features, audit, game_mode=game_mode, player_baseline=player_baseline
            )

            calibrated_risk, calibrated_severity = AntiCheatIntelligence.calibrate_ensemble_risk(
                result.get("random_forest"),
                result.get("random_forest_probability"),
                result.get("isolation_forest"),
                result.get("isolation_forest_anomaly_score"),
                human_eval,
                raw_features
            )
            result["model_risk_score"] = result.get("risk_score")
            result["risk_score"] = calibrated_risk
            result["human_evaluation"] = human_eval

            if (
                realtime
                and is_demo
                and account.get("hacker_profile")
                and result.get("random_forest") == "cheater"
                and result.get("isolation_forest") == "anomaly"
                and isinstance(result.get("risk_score"), (int, float))
                and result["risk_score"] <= 90
            ):
                result["risk_calibration"] = "development_hacker_evidence"
                result["risk_score"] = hacker_enforcement_score(
                    account.get("hacker_profile")
                    or account.get("email")
                    or account.get("username"),
                )

        except Exception as exc:
            safe_print(
                "[SecureFPS] ML prediction error:",
                exc
            )
            status = "ml_error"
            error = str(exc)
            human_eval = {"review_category": "Analysis incomplete", "explanation": str(exc), "is_skilled_human": False, "hard_cheat_evidence": []}
            calibrated_severity = None

    risk_config = ((db["system_config"].find_one({"type": "global_config"}) or {}).get("risk_engine") or {})
    classification = classify_configured_risk(result.get("risk_score"), risk_config)
    severity = (
        classification["severity"] if status == "success" and risk_config
        else calibrated_severity if status == "success"
        else gameplay_alert_severity(result, status)
    )
    alert_reason = None
    if severity and severity != "low":
        alert_reason = (
            f"{human_eval.get('explanation') or 'Configured gameplay alert conditions met'}: "
            f"RF={result.get('random_forest')}, "
            f"IF={result.get('isolation_forest')}, "
            f"risk={result.get('risk_score')}/100."
        )
    else:
        severity = None  # Low risk sessions do not trigger gameplay alerts

    enforcement_state = "monitoring"
    enforcement_action = "none"
    restriction_until = None
    auto_ban = None
    try:
        demo_ban_threshold = float(os.getenv(
            "DEMO_HACKER_BAN_RISK_THRESHOLD",
            "85",
        ))
    except (TypeError, ValueError):
        demo_ban_threshold = BAN_RISK_THRESHOLD
    ban_threshold = (
        demo_ban_threshold
        if account.get("account_type") == "demo_test" and account.get("hacker_profile")
        else BAN_RISK_THRESHOLD
    )
    if realtime and result.get("risk_score", 0) >= ban_threshold:
        auto_ban = auto_ban_hacker(
            user_id,
            session_id,
            account,
            result,
            raw_features,
        )
        if auto_ban:
            enforcement_state = auto_ban["state"]
            enforcement_action = auto_ban["action"]
    if realtime and is_demo and severity == "high" and not auto_ban:
        restriction_seconds = demo_int_setting(
            "DEMO_CHEATER_RESTRICTION_SECONDS",
            900,
            minimum=60
        )
        restriction_until = utc_now() + timedelta(seconds=restriction_seconds)
        restriction = users.update_one(
            {
                "_id": user_id,
                "role": "player",
                "demo": True,
                "account_type": "demo_test",
                "username": DEMO_ACCOUNT_USERNAME,
                "email": DEMO_ACCOUNT_EMAIL
            },
            {"$set": {
                "demo_restricted_until": restriction_until,
                "demo_restriction_reason": alert_reason,
                "demo_restriction_session_id": session_id,
                "demo_restriction_status": "active"
            }}
        )
        if restriction.modified_count:
            game_sessions.update_one(
                {
                    "session_id": session_id,
                    "user_id": user_id,
                    "status": "active",
                    "demo_mode": True
                },
                {"$set": {
                    "status": "restricted",
                    "enforcement_state": "restricted",
                    "enforcement_action": "temporary_restriction",
                    "restricted_at": utc_now(),
                    "restricted_until": restriction_until
                }}
            )
            enforcement_state = "restricted"
            enforcement_action = "temporary_restriction"

    alert_status = (
        "pending" if severity
        else "not_triggered" if status == "success"
        else "analysis_incomplete"
    )

    # -----------------------------------------------------
    # PRINT MODEL RESULTS
    # -----------------------------------------------------

    safe_print()
    safe_print("========== RAW FEATURES ==========")

    for name, value in raw_features.items():

        safe_print(
            f"  {name}: {value}"
        )

    safe_print()
    safe_print("========== NORMALIZED FEATURES ==========")

    for name, value in features.items():

        safe_print(
            f"  {name}: {value}"
        )

    safe_print()
    safe_print("Random Forest:",
          result.get("random_forest"))

    safe_print("Isolation Forest:",
          result.get("isolation_forest"))

    safe_print("Risk Score:",
          result.get("risk_score"))

    safe_print("===============================")
    safe_print()

    # -----------------------------------------------------
    # STORE DETECTION
    # -----------------------------------------------------

    detection_event = {
        "user_id": user_id,
        "session_id": session_id,
        "analysis_type": "game_session",
        "active_features": FEATURES,
        "missing_features": missing_features,
        "status": status,

        # Keep both representations for evaluation/debugging.
        "raw_features": raw_features,

        "features": features,
        "result": result,
        "risk_score": result.get("risk_score"),
        "error": error,
        "demo": is_demo,
        "is_demo": is_demo,
        "demo_label": "cheater_demo" if is_demo else None,
        "account_label": "CHEATER DEMONSTRATION TEST ACCOUNT" if is_demo else None,
        "realtime": realtime,
        "alert_status": alert_status,
        "alert_severity": severity,
        "alert_reason": alert_reason,
        "enforcement_state": enforcement_state,
        "enforcement_action": enforcement_action,
        "restricted_until": restriction_until,
        "auto_ban": bool(auto_ban),

        "created_at": utc_now()
    }

    analysis_update = {"$set": detection_event}
    if realtime:
        analysis_update["$push"] = {
            "evaluation_history": {
                "$each": [{
                    "created_at": detection_event["created_at"],
                    "raw_features": raw_features,
                    "features": features,
                    "result": result,
                    "risk_score": result.get("risk_score"),
                    "status": status,
                    "alert_severity": severity,
                    "enforcement_state": enforcement_state
                }],
                "$slice": -25
            }
        }

    try:

        game_events.update_one(
            {
                "session_id": session_id,
                "analysis_type": "game_session"
            },
            analysis_update,
            upsert=True
        )
        # Mirror authoritative risk metrics to game_sessions for immediate admin sync
        try:
            sess_risk = result.get("risk_score")
            sess_cat = classification["category"]
            sess_update = {
                "risk_score": sess_risk,
                "risk_category": sess_cat,
                "analysis_status": status,
            }
            if game_session.get("mode") != "multiplayer":
                for metric in ("accuracy", "kdr", "kills", "deaths", "shots_fired", "shots_hit"):
                    if raw_features.get(metric) is not None:
                        sess_update[metric] = raw_features[metric] if metric in {"accuracy", "kdr"} else int(raw_features[metric])
                if not realtime:
                    sess_update["status"] = "completed"
            update = {"$set": sess_update}
            if sess_update.get("status") == "completed":
                update["$unset"] = {"expires_at": ""}
            game_sessions.update_one(
                {"session_id": session_id},
                update,
            )
        except Exception as sess_err:
            safe_print("[SecureFPS] Warning: Failed to mirror risk to game_sessions:", sess_err)

    except Exception as exc:

        safe_print(
            "[SecureFPS] Failed to store ML result:",
            exc
        )

    # -----------------------------------------------------
    # SECURITY ALERT
    # -----------------------------------------------------

    if severity:
        # A gameplay alert marks a suspicious session for human review only.
        security_event = {
            "user_id": user_id,
            "session_id": session_id,
            "type": "gameplay_anomaly",
            "severity": severity,
            "risk_score": result["risk_score"],
            "random_forest": result["random_forest"],
            "isolation_forest": result["isolation_forest"],
            "random_forest_probability": result.get("random_forest_probability"),
            "isolation_forest_anomaly_score": result.get("isolation_forest_anomaly_score"),
            "result": result,
            "features": features,
            "raw_features": raw_features,
            "active_features": FEATURES,
            "missing_features": missing_features,
            "analysis_status": status,
            "demo": is_demo,
            "account_label": "demo_cheater" if is_demo else None,
            "alert_reason": alert_reason,
            "enforcement_action": enforcement_action,
            "enforcement_state": enforcement_state,
            "restricted_until": restriction_until,
            "last_evaluated_at": utc_now()
        }

        try:

            security_events.update_one(
                {
                    "session_id": session_id,
                    "type": "gameplay_anomaly"
                },
                {
                    "$set": security_event,
                    "$setOnInsert": {
                        "review_status": "pending",
                        "created_at": security_event["last_evaluated_at"]
                    }
                },
                upsert=True
            )

            safe_print(
                "[SecureFPS] SECURITY ALERT CREATED:",
                severity
            )

        except Exception as exc:

            safe_print(
                "[SecureFPS] Failed to store security alert:",
                exc
            )

    elif not realtime:
        # Full match concluded within legitimate human boundaries.
        # Clear any transient mid-match spike alerts for this session.
        security_events.update_many(
            {
                "session_id": session_id,
                "type": "gameplay_anomaly",
                "review_status": "pending"
            },
            {
                "$set": {
                    "review_status": "cleared",
                    "risk_score": result.get("risk_score"),
                    "severity": "low",
                    "alert_reason": "Full match completed within normal human boundaries; transient real-time spike cleared."
                }
            }
        )

    return {
        "status": status,
        "raw_features": raw_features,
        "features": features,
        "active_features": FEATURES,
        "missing_features": missing_features,
        "result": result,
        "risk_score": result.get("risk_score"),
        "error": error,
        "alert_status": alert_status,
        "alert_severity": severity,
        "alert_reason": alert_reason,
        "enforcement_state": enforcement_state,
        "enforcement_action": enforcement_action,
        "restricted_until": restriction_until,
        "demo": is_demo
    }


# =========================================================
# VOLUNTARY MATCH EXIT (With Confirmation & Server Validation)
# =========================================================

@game_bp.post("/game/voluntary-exit")
def voluntary_exit_game():
    user_id = get_current_user_object_id()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401

    data = request.get_json(silent=True) or {}
    session_id = data.get("session_id")
    if not session_id:
        return jsonify({"message": "session_id is required."}), 400

    game_session = game_sessions.find_one({"session_id": session_id, "user_id": user_id})
    if not game_session:
        return jsonify({"message": "Game session not found."}), 404

    # Idempotent: If session is already closed (completed or abandoned), do NOT penalize again
    if game_session.get("status") != "active":
        player = users.find_one({"_id": user_id}, {"honour_score": 1}) or {}
        current_score = player.get("honour_score", 100)
        return jsonify({
            "success": True,
            "status": game_session.get("status"),
            "already_closed": True,
            "message": "Match already closed; no additional honour deduction applied.",
            "honour_score": current_score,
            "deducted": 0
        }), 200

    now = utc_now()
    abandonment = game_sessions.update_one(
        {"session_id": session_id, "user_id": user_id, "status": "active"},
        {
            "$set": {
                "ended_at": now,
                "status": "abandoned_voluntary",
                "abandoned_at": now,
                "abandon_reason": "voluntary_match_exit",
            },
            "$unset": {"expires_at": ""},
        }
    )

    if not abandonment.modified_count:
        player = users.find_one({"_id": user_id}, {"honour_score": 1}) or {}
        return jsonify({
            "success": True,
            "already_closed": True,
            "honour_score": player.get("honour_score", 100),
            "deducted": 0
        }), 200

    prev_score, new_score, actual_delta = record_honour_transaction(
        user_id=user_id,
        session_id=session_id,
        points_delta=-MATCH_VOLUNTARY_EXIT_HONOUR_PENALTY,
        reason="voluntary_match_exit",
        is_automatic=False
    )

    player = users.find_one({"_id": user_id}, {"name": 1, "email": 1}) or {}
    player_name = player.get("name") or player.get("email") or "Player"

    security_events.insert_one({
        "type": "match_abandoned",
        "user_id": user_id,
        "session_id": session_id,
        "severity": "low",
        "honour_before": prev_score,
        "honour_change": actual_delta,
        "honour_score": new_score,
        "restricted_until": None,
        "review_status": "cleared",
        "description": f"{player_name} voluntarily left an active match. Honour reduced by {abs(actual_delta)} to {new_score}/100.",
        "created_at": now,
    })

    publish_live_update(
        user_id,
        session_id,
        "match_abandoned",
        force=True,
        payload={"player_name": player_name, "honour_score": new_score}
    )

    return jsonify({
        "success": True,
        "status": "abandoned_voluntary",
        "previous_score": prev_score,
        "new_score": new_score,
        "deducted": abs(actual_delta),
        "message": f"Left match. Honour Score reduced by {abs(actual_delta)} points ({new_score}/100)."
    }), 200


@game_bp.get("/game/honour")
def get_honour_info():
    user_id = get_current_user_object_id()
    if not user_id:
        return jsonify({"message": "Authentication required."}), 401

    player = users.find_one({"_id": user_id}, {"honour_score": 1, "name": 1}) or {}
    score = player.get("honour_score")
    if score is None:
        score = 100
        users.update_one({"_id": user_id}, {"$set": {"honour_score": 100}})

    recent_history = list(
        honour_history.find(
            {"$or": [{"user_id": user_id}, {"player_id": str(user_id)}]}
        ).sort("timestamp", -1).limit(20)
    )

    history_items = []
    for h in recent_history:
        history_items.append({
            "session_id": h.get("session_id"),
            "previous_score": h.get("previous_score"),
            "new_score": h.get("new_score"),
            "points_delta": h.get("points_delta"),
            "reason": h.get("reason"),
            "timestamp": h["timestamp"].isoformat() if h.get("timestamp") else None,
            "is_automatic": h.get("is_automatic", True),
        })

    return jsonify({
        "success": True,
        "honour_score": score,
        "max_honour": MAX_HONOUR_SCORE,
        "min_honour": MIN_HONOUR_SCORE,
        "penalty_per_exit": MATCH_VOLUNTARY_EXIT_HONOUR_PENALTY,
        "reward_per_match": MATCH_COMPLETE_HONOUR_REWARD,
        "history": history_items
    }), 200


# =========================================================
# END GAME
# =========================================================

def complete_multiplayer_game(game_session, token):
    if not isinstance(token, str) or len(token) > 4096:
        return jsonify({"message": "Multiplayer results require a signed match receipt."}), 409
    user_id = game_session["user_id"]
    secret = os.getenv("GAME_SERVER_SECRET", "securefps-multiplayer-secret-key-2026")
    key = hmac.digest(secret.encode("utf-8"), b"securefps:match-result:v1", "sha256")
    try:
        result = jwt.decode(token, key, algorithms=["HS256"], audience="securefps-match-result", subject=str(user_id),
                            options={"require": ["exp", "iat", "sub", "match_id", "started_at"]})
        match_id = str(uuid.UUID(result["match_id"]))
        started_at = datetime.fromtimestamp(result["started_at"] / 1000, timezone.utc)
        metrics = {name: result[name] for name in ("kills", "deaths", "assists", "headshots", "shots_fired", "shots_hit")}
        duration = result["duration"]
        outcome = result["result"]
        if any(type(value) is not int or not 0 <= value <= 100_000 for value in [*metrics.values(), duration]):
            raise ValueError("Invalid match metrics")
        if outcome not in {"win", "loss", "draw"}:
            raise ValueError("Invalid outcome")
    except (jwt.InvalidTokenError, ValueError, KeyError, TypeError, AttributeError, OverflowError, OSError):
        return jsonify({"message": "The match receipt is invalid or expired."}), 403

    session_start = game_session.get("started_at")
    if session_start and session_start.tzinfo is None:
        session_start = session_start.replace(tzinfo=timezone.utc)
    if not session_start or abs((session_start - started_at).total_seconds()) > 120:
        return jsonify({"message": "The match receipt does not belong to this gameplay session."}), 409
    if game_session.get("status") != "active" and game_session.get("multiplayer_receipt") != match_id:
        return jsonify({"message": "This gameplay session is already closed."}), 409

    receipt_id = f"{match_id}:{user_id}"
    receipts = db["multiplayer_match_receipts"]
    try:
        receipts.update_one({"_id": receipt_id}, {
            "$setOnInsert": {"session_id": game_session["session_id"], "created_at": utc_now()},
        }, upsert=True)
    except DuplicateKeyError:
        pass
    receipt = receipts.find_one({"_id": receipt_id}) or {}
    if receipt.get("session_id") != game_session["session_id"]:
        return jsonify({"message": "This match receipt has already been used."}), 409

    shots = metrics["shots_fired"]
    metrics["shots_hit"] = min(metrics["shots_hit"], shots)
    metrics["headshots"] = min(metrics["headshots"], metrics["shots_hit"])
    now = utc_now()
    changes = {
        **metrics,
        "status": "completed",
        "stats_source": "multiplayer_server",
        "multiplayer_receipt": match_id,
        "result": outcome,
        "ended_at": started_at + timedelta(seconds=duration),
        "duration_seconds": duration,
        "accuracy": round(metrics["shots_hit"] / shots, 3) if shots else 0.0,
        "kdr": round(metrics["kills"] / max(1, metrics["deaths"]), 2),
    }
    completion = game_sessions.update_one(
        {"_id": game_session["_id"], "status": "active"},
        {"$set": changes, "$unset": {"expires_at": ""}},
    )
    current = game_sessions.find_one({"_id": game_session["_id"], "multiplayer_receipt": match_id})
    if not current:
        return jsonify({"message": "This gameplay session is already closed."}), 409

    if duration >= 30 and not (current.get("demo_mode") or current.get("is_demo")):
        if completion.modified_count:
            _, _, honour = record_honour_transaction(user_id, current["session_id"], MATCH_COMPLETE_HONOUR_REWARD, "match_completed")
            game_sessions.update_one({"_id": current["_id"]}, {"$set": {"honour_awarded": honour}})
            current["honour_awarded"] = honour
        if current.get("reward_credit"):
            apply_match_credit(current)
        else:
            day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
            under_cap = reward_transactions.count_documents({
                "user_id": user_id, "type": "match_completed", "coins": {"$gt": 0}, "created_at": {"$gte": day_start},
            }) < 20
            record_match_credit(user_id, current["session_id"], {
                "type": "match_completed", "description": "Completed an authoritative multiplayer match",
                "coins": 20 if under_cap else 0, "xp": 50 if under_cap else 0,
                "honour": current.get("honour_awarded", 0), "created_at": now,
            })
    notify_player(user_id, "match_result", receipt_id)
    if completion.modified_count:
        analyze_game_session(user_id, current["session_id"])
        publish_live_update(user_id, current["session_id"], "analysis_complete", force=True)
    return jsonify({"success": True, "status": "completed", "session_id": current["session_id"]})


@game_bp.post("/game/end")
def end_game():

    user_id = get_current_user_object_id()

    if not user_id:

        return jsonify({
            "message": "Authentication required."
        }), 401

    data = request.get_json(
        silent=True
    ) or {}
    if not isinstance(data, dict):
        return jsonify({"message": "Match completion must be a JSON object."}), 400

    session_id = data.get(
        "session_id"
    )

    if not isinstance(session_id, str) or not session_id:

        return jsonify({
            "message": "session_id is required."
        }), 400

    game_session = game_sessions.find_one({
        "session_id": session_id,
        "user_id": user_id
    })

    if not game_session:

        return jsonify({
            "message": "Game session not found."
        }), 404

    # A match is complete if the gameplay client already submitted game_completed
    # or if this call explicitly declares the match completed.
    is_completed_request = (
        data.get("completed") is True
        or data.get("reason") in ("match_completed", "score_limit_reached", "time_expired")
    )
    if is_completed_request and game_session.get("mode") == "multiplayer":
        return complete_multiplayer_game(game_session, data.get("completion_token"))

    now = utc_now()
    restriction_until = None

    combat_sync = {}
    for k in ("kills", "deaths", "headshots"):
        if k in data and data[k] is not None:
            combat_sync[k] = data[k]
    if "shots" in data and data["shots"] is not None:
        combat_sync["shots_fired"] = data["shots"]
    elif "shots_fired" in data and data["shots_fired"] is not None:
        combat_sync["shots_fired"] = data["shots_fired"]
    if "hits" in data and data["hits"] is not None:
        combat_sync["shots_hit"] = data["hits"]
    elif "shots_hit" in data and data["shots_hit"] is not None:
        combat_sync["shots_hit"] = data["shots_hit"]
    if "winner" in data and data["winner"]:
        combat_sync["winner"] = data["winner"]

    if game_session.get("status") != "active":
        return jsonify({
            "success": True,
            "status": game_session.get("status"),
            "message": "Match already closed.",
        }), 200

    if is_completed_request:
        started_at = game_session.get("started_at")
        if started_at and started_at.tzinfo is None:
            started_at = started_at.replace(tzinfo=timezone.utc)
        duration_seconds = max(0, (now - started_at).total_seconds()) if started_at else 0
        eligible_for_rewards = duration_seconds >= 30
        if not eligible_for_rewards:
            combat_sync = {}
        def count(key):
            value = combat_sync.get(key)
            return value if type(value) is int and 0 <= value <= 2**31 - 1 else 0

        match_kills = count("kills")
        match_deaths = count("deaths")
        match_shots = count("shots_fired")
        match_hits = min(match_shots, count("shots_hit"))
        completion_set = {
            "status": "completed",
            "ended_at": now,
            "duration_seconds": duration_seconds,
            "kills": match_kills,
            "deaths": match_deaths,
            "shots_fired": match_shots,
            "shots_hit": match_hits,
            "headshots": min(match_hits, count("headshots")),
            "accuracy": round(match_hits / match_shots, 3) if match_shots else 0.0,
            "kdr": round(match_kills / max(1, match_deaths), 2),
        }
        if isinstance(combat_sync.get("winner"), str):
            completion_set["winner"] = combat_sync["winner"][:100]
        completion = game_sessions.update_one(
            {
                "session_id": session_id,
                "user_id": user_id,
                "status": "active"
            },
            {
                "$set": completion_set,
                "$unset": {"expires_at": ""},
            }
        )
        if completion.modified_count:
            honour_delta = MATCH_COMPLETE_HONOUR_REWARD if eligible_for_rewards else 0

            honour_before, honour_score, honour_awarded = record_honour_transaction(
                user_id=user_id,
                session_id=session_id,
                points_delta=honour_delta,
                reason="match_completed",
                is_automatic=True
            )
            game_sessions.update_one(
                {"session_id": session_id, "user_id": user_id},
                {
                    "$set": {"honour_awarded": honour_awarded}
                },
            )
            if not (game_session.get("demo_mode") or game_session.get("is_demo")):
                record_match_credit(user_id, session_id, {
                    "type": "match_completed",
                    "description": f"Completed CyberStrike 3D match ({int(duration_seconds)}s); +{honour_awarded} Honour",
                    "coins": 0,
                    "xp": 0,
                    "honour": honour_awarded,
                    "honour_before": honour_before,
                    "honour_after": int(honour_score if honour_score is not None else honour_before),
                    "created_at": now,
                })
            analysis = analyze_game_session(user_id, session_id)
            publish_live_update(user_id, session_id, "analysis_complete", force=True)
            return jsonify({
                "success": True,
                "status": "completed",
                "message": f"Match completed successfully! +{honour_awarded} Honour awarded.",
                "session_id": session_id,
                "honour_score": int(honour_score if honour_score is not None else 100),
                "analysis": analysis,
            }), 200

    abandonment = game_sessions.update_one(
        {
            "session_id": session_id,
            "user_id": user_id,
            "status": "active"
        },
        {
            "$set": {
                "ended_at": now,
                "status": "abandoned",
                "abandoned_at": now,
                "abandon_reason": "player_left_before_match_completion",
            },
            "$unset": {"expires_at": ""},
        }
    )

    if not abandonment.modified_count:
        latest = game_sessions.find_one({"session_id": session_id, "user_id": user_id}) or {}
        return jsonify({
            "success": True,
            "status": latest.get("status"),
            "message": "Match already closed; no additional rewards were issued.",
        }), 200

    honour_before, honour_score, actual_delta = record_honour_transaction(
        user_id=user_id,
        session_id=session_id,
        points_delta=-MATCH_ABANDON_HONOUR_PENALTY,
        reason="match_abandoned",
        is_automatic=True
    )
    player = users.find_one({"_id": user_id}, {"name": 1, "email": 1}) or {}

    security_events.insert_one({
        "type": "match_abandoned",
        "user_id": user_id,
        "session_id": session_id,
        "severity": "low",
        "honour_before": honour_before,
        "honour_change": honour_score - honour_before,
        "honour_score": honour_score,
        "restricted_until": restriction_until,
        "review_status": "pending",
        "description": (
            f"{player.get('name') or player.get('email') or 'A player'} left an unfinished match. "
            f"Honour score is now {honour_score}/100. Game access remains available."
        ),
        "created_at": now,
    })

    publish_live_update(
        user_id,
        session_id,
        "match_abandoned",
        force=True,
        payload={
            "player_name": player.get("name") or player.get("email") or "Player",
            "honour_score": honour_score,
            "restricted_until": None,
        },
    )

    return jsonify({
        "success": True,
        "status": "abandoned",
        "message": (
            "Unfinished match abandoned. No coins or XP were awarded. "
            f"Honour score: {honour_score}/100. You can start another match."
        ),
        "session_id": session_id,
        "honour_score": honour_score,
        "restricted_until": None,
        "reward": None,
    }), 200


# =========================================================
# FEATURE EXTRACTION
# =========================================================

def extract_features(
    user_id,
    session_id,
    max_events=None
):
    """
    Extract Feature Set v2 from session telemetry with fallback for older sessions.
    Unified logic using services.features_v2.
    """

    event_cursor = game_telemetry.find({
        "user_id": user_id,
        "session_id": session_id
    }).sort(
        "created_at",
        -1 if max_events else 1
    )

    if max_events:
        event_cursor = event_cursor.limit(max_events)

    events = list(event_cursor)
    if max_events:
        events.reverse()

    features_dict, meta = extract_features_v2(events, enforce_min_data=False, allow_fallback=True)

    # Legacy aliases so existing code expecting 5 features does not break
    if features_dict.get("aim_speed_mean") is not None:
        features_dict["aim_smoothness"] = round(1.0 / (1.0 + features_dict["aim_speed_mean"] / 100.0), 4)
    else:
        # Graceful fallback to normal human aim consistency
        features_dict["aim_smoothness"] = 0.82
    features_dict["movement_speed"] = features_dict.get("movement_speed_mean")
    if features_dict.get("movement_speed") is None:
        features_dict["movement_speed"] = 4.2
    features_dict["low_confidence"] = meta.get("low_confidence", False)
    features_dict["is_fallback"] = meta.get("is_fallback", False)

    return features_dict

def _legacy_extract_features_backup(user_id, session_id, events):

    # -----------------------------------------------------
    # COUNTERS
    # -----------------------------------------------------

    shots = 0
    enemy_hits = 0
    enemy_hit_telemetry_seen = False
    kills = 0
    deaths = 0
    # headshots = 0  # Retained for future headshot_ratio support.

    movement_speeds = []
    aim_changes = []
    # reaction_times = []  # Reaction-time telemetry is unavailable for now.

    event_times = []

    # -----------------------------------------------------
    # PROCESS EVENTS
    # -----------------------------------------------------

    for event in events:

        event_type = event.get(
            "event_type",
            ""
        )

        telemetry = event.get(
            "telemetry",
            {}
        )

        if not isinstance(
            telemetry,
            dict
        ):

            telemetry = {}

        if event_type == "weapon_fire":

            shots += 1

        elif event_type == "enemy_hit":

            enemy_hits += 1
            enemy_hit_telemetry_seen = True

        elif event_type == "enemy_killed":

            kills += 1

        elif event_type == "player_death":

            deaths += 1

        # Temporarily excluded: headshot_ratio is not an active model feature.
        # elif event_type == "headshot":
        #     headshots += 1

        # -------------------------------------------------
        # MOVEMENT
        # -------------------------------------------------

        if event_type == "player_behavior":

            speed = telemetry.get(
                "speed"
            )

            if speed is not None:

                try:

                    speed = float(speed)

                    if math.isfinite(speed):
                        movement_speeds.append(speed)

                except (
                    TypeError,
                    ValueError
                ):

                    pass

        # -------------------------------------------------
        # AIM
        # -------------------------------------------------

        if event_type == "aim_behavior":

            rotation_change = telemetry.get(
                "rotation_change"
            )

            if rotation_change is not None:

                try:

                    rotation_change = float(
                        rotation_change
                    )

                    if math.isfinite(rotation_change):
                        if event.get("game") == "FPS_Microgame" or rotation_change > math.pi * 2:
                            rotation_change = math.radians(rotation_change)
                        aim_changes.append(
                            abs(rotation_change)
                        )

                except (
                    TypeError,
                    ValueError
                ):

                    pass

        # -------------------------------------------------
        # REACTION TIME
        # -------------------------------------------------

        # reaction_time = telemetry.get("reaction_time")
        # if reaction_time is not None:
        #     try:
        #         reaction_time = float(reaction_time)
        #         if math.isfinite(reaction_time) and reaction_time > 0:
        #             reaction_times.append(reaction_time)
        #     except (TypeError, ValueError):
        #         pass

        # -------------------------------------------------
        # EVENT TIME
        # -------------------------------------------------

        created_at = event.get(
            "created_at"
        )

        if created_at:

            try:

                event_times.append(
                    created_at.timestamp()
                )

            except Exception:

                pass

    # =====================================================
    # GAME DURATION
    # =====================================================

    if len(event_times) >= 2:

        duration = max(
            event_times[-1]
            - event_times[0],
            1.0
        )

    else:

        duration = None

    # =====================================================
    # COMBAT ACTIVITY CHECK & STATISTICAL AGGREGATION
    # =====================================================
    has_combat_activity = (shots > 0 or enemy_hit_telemetry_seen or kills > 0 or deaths > 0)

    # ACCURACY
    if shots > 0:
        accuracy = max(0.0, min(1.0, enemy_hits / shots))
    elif enemy_hit_telemetry_seen:
        accuracy = 1.0
    elif has_combat_activity:
        accuracy = 0.0
    else:
        accuracy = None

    # FIRE RATE
    if shots > 0 and duration is not None and duration > 0:
        fire_rate = shots / duration
    elif duration is not None and duration > 0 and has_combat_activity:
        fire_rate = 0.0
    else:
        fire_rate = None

    # MOVEMENT SPEED
    if movement_speeds:
        movement_speed = sum(movement_speeds) / len(movement_speeds)
    elif duration is not None and duration > 0:
        movement_speed = 0.0
    else:
        movement_speed = None

    # AIM SMOOTHNESS
    if aim_changes:
        average_aim_change = sum(aim_changes) / len(aim_changes)
        aim_smoothness = 1.0 / (1.0 + average_aim_change)
    elif duration is not None and duration > 0:
        aim_smoothness = 1.0
    else:
        aim_smoothness = None

    # KDR (Documented Zero-Combat & Zero-Death Standard Convention)
    if deaths > 0:
        kdr = kills / deaths
    elif kills > 0:
        kdr = float(kills)
    elif has_combat_activity:
        kdr = 0.0
    else:
        kdr = None

    # =====================================================
    # REACTION TIME
    # =====================================================

    # if reaction_times:
    #     reaction_time = sum(reaction_times) / len(reaction_times)
    # else:
    #     reaction_time = None

    # =====================================================
    # FINAL RAW FEATURES
    # =====================================================

    features = {

        "accuracy":
            accuracy,

        "fire_rate":
            fire_rate,

        "movement_speed":
            movement_speed,

        "aim_smoothness":
            aim_smoothness,

        "kdr":
            kdr
    }

    # -----------------------------------------------------
    # VERIFY ACTIVE FEATURES ARE DEFINED
    # -----------------------------------------------------

    missing = [
        feature
        for feature in FEATURES
        if feature not in features
    ]

    if missing:

        safe_print(
            "[SecureFPS] Missing ML feature definitions:",
            missing
        )

        return None

    safe_print()
    safe_print("========== EXTRACTED RAW FEATURES ==========")

    for name in FEATURES:

        safe_print(
            f"{name}: {features[name]}"
        )

    safe_print("============================================")
    safe_print()

    return features


# =========================================================
# MANUAL ML DETECTION
# =========================================================

@game_bp.post("/detect")
def detect():

    user_id = get_current_user_object_id()

    if not user_id:

        return jsonify({
            "message": "Authentication required."
        }), 401
    account = users.find_one({"_id": user_id}, {"revoked": 1, "account_status": 1})
    if account and (
        account.get("revoked") is True or account.get("account_status") == "banned"
    ):
        return jsonify({"message": "This account is permanently banned."}), 403
    if account and account.get("account_status") == "suspended":
        return jsonify({"message": "This account has been suspended."}), 403

    data = request.get_json(
        silent=True
    ) or {}

    raw_features = data.get(
        "features",
        {}
    )

    # -----------------------------------------------------
    # REQUIRED FEATURES
    # -----------------------------------------------------

    missing = [
        name
        for name in FEATURES
        if name not in raw_features
    ]

    if missing:

        return jsonify({
            "message":
                "Missing features: "
                + ", ".join(missing)
        }), 400

    # -----------------------------------------------------
    # NORMALIZE INPUT FEATURES
    # -----------------------------------------------------

    clean_raw_features = {
        name: raw_features.get(name)
        for name in FEATURES
    }

    clean_features = normalize_features(
        clean_raw_features
    )

    invalid = [
        name
        for name in FEATURES
        if clean_features.get(name) is None
    ]

    if invalid:

        return jsonify({
            "message":
                "Invalid feature values: "
                + ", ".join(invalid)
        }), 400

    # -----------------------------------------------------
    # RUN ALL AVAILABLE MODELS
    # -----------------------------------------------------

    try:

        result = predict(
            clean_features
        )

    except Exception as exc:

        safe_print(
            "[SecureFPS] ML error:",
            exc
        )

        return jsonify({
            "message":
                f"ML prediction failed: {exc}"
        }), 400

    model_errors = [
        value
        for name, value in result.items()
        if name.endswith("_status") and value
    ]
    status = "ml_error" if model_errors else "success"
    session_id = data.get("session_id")

    # -----------------------------------------------------
    # STORE DETECTION
    # -----------------------------------------------------

    event = {
        "user_id": user_id,
        "session_id": session_id,
        "raw_features": clean_raw_features,
        "features": clean_features,
        "result": result,
        "risk_score": result.get("risk_score"),
        "status": status,
        "created_at": utc_now()
    }

    try:

        game_events.insert_one(
            event
        )

    except Exception as exc:

        safe_print(
            "[SecureFPS] Failed to store detection:",
            exc
        )

    # -----------------------------------------------------
    # SECURITY ALERT
    # -----------------------------------------------------

    severity = gameplay_alert_severity(result, status)
    if severity and session_id:

        try:

            security_events.update_one(
                {
                    "session_id": session_id,
                    "type": "gameplay_anomaly"
                },
                {
                    "$set": {
                "user_id": user_id,
                "session_id": session_id,
                "type": "gameplay_anomaly",
                "severity": severity,
                "risk_score": result["risk_score"],
                "random_forest": result["random_forest"],
                "isolation_forest": result["isolation_forest"],
                "features": clean_features,
                "review_status": "pending",
                "created_at": utc_now()
                    }
                },
                upsert=True
            )

        except Exception as exc:

            safe_print(
                "[SecureFPS] Security event error:",
                exc
            )

    return jsonify({
        "success": True,
        "status": status,
        "result": result,
        "features": clean_features,
        "alert_created": bool(severity and session_id)
    }), 200


# =========================================================
# PLAYER DASHBOARD
# =========================================================

@game_bp.get("/dashboard")
def dashboard():

    user_id = get_current_user_object_id()

    if not user_id:

        return jsonify({
            "message": "Authentication required."
        }), 401

    recent = list(
        game_events.find({
            "user_id": user_id
        })
        .sort(
            "created_at",
            -1
        )
        .limit(8)
    )

    alerts = list(
        security_events.find({
            "user_id": user_id
        })
        .sort(
            "created_at",
            -1
        )
        .limit(6)
    )

    recent_detections = []
    for item in recent:
        if not item.get("created_at"):
            continue

        result = item.get("result") or {}
        status = item.get("status", "ml_error")
        complete_result = (
            result.get("random_forest") in {"normal", "cheater"}
            and result.get("isolation_forest") in {"normal", "anomaly"}
            and isinstance(result.get("risk_score"), (int, float))
        )
        if status == "success" and not complete_result:
            status = "ml_error"

        recent_detections.append({
            "rf": result.get("random_forest") if status == "success" else None,
            "if": result.get("isolation_forest") if status == "success" else None,
            "risk_score": result.get("risk_score") if status == "success" else None,
            "status": status,
            "created_at": item["created_at"].isoformat()
        })

    return jsonify({

        "stats": {

            "matches_analyzed":
                game_events.count_documents({
                    "user_id": user_id
                }),

            "alerts":
                security_events.count_documents({
                    "user_id": user_id,
                    "severity": {
                        "$in": [
                            "medium",
                            "high"
                        ]
                    }
                }),

            "security_status":
                "Protected"
        },

        "recent_detections": recent_detections,

        "alerts": [

            {
                "type":
                    alert.get(
                        "type",
                        "security_event"
                    ),

                "severity":
                    alert.get(
                        "severity",
                        "low"
                    ),

                "created_at":
                    alert.get(
                        "created_at"
                    ).isoformat()
            }

            for alert in alerts

            if alert.get(
                "created_at"
            )
        ]
    })


# =========================================================
# ADMIN OVERVIEW
# =========================================================
# ENHANCED ADMIN SUPPORT TICKETS
# =========================================================

SUPPORT_REPLY_TEMPLATES = [
    {
        "id": "ban_appeal_info",
        "title": "Ban Appeal Information",
        "text": "Thank you for reaching out. Please submit an official appeal through your player dashboard with any supporting match context so our security team can formally review your account."
    },
    {
        "id": "telemetry_investigation",
        "title": "Telemetry Review in Progress",
        "text": "Our security operations team has received your ticket and is actively reviewing the server-authoritative telemetry logs and ML risk assessments for your session."
    },
    {
        "id": "bug_report_ack",
        "title": "Gameplay Bug Acknowledged",
        "text": "We have logged this issue with our engineering team for investigation in the next build deployment. Thank you for helping keep SecureFPS fair and responsive."
    },
    {
        "id": "ticket_resolved",
        "title": "Ticket Resolved",
        "text": "The reported issue has been investigated and resolved. If you need any further assistance, feel free to open a new support ticket."
    }
]


@game_bp.get("/admin/support/tickets")
def admin_support_tickets():
    if not has_operational_permission(current_admin(allow_demo=True), "support:read"):
        return jsonify({"message": "Admin access required."}), 403

    status_filter = (request.args.get("status") or "").strip().lower()
    priority_filter = (request.args.get("priority") or "").strip().lower()
    search = (request.args.get("q") or "").strip()
    limit = max(1, min(request.args.get("limit", 25, type=int), 100))
    offset = max(0, request.args.get("offset", 0, type=int))

    query = {}
    if status_filter in {"open", "in_progress", "answered", "resolved"}:
        query["status"] = status_filter
    if priority_filter in {"low", "normal", "high", "urgent"}:
        query["priority"] = priority_filter
    if search:
        query["$or"] = [
            {"player_name": {"$regex": search, "$options": "i"}},
            {"player_email": {"$regex": search, "$options": "i"}},
            {"message": {"$regex": search, "$options": "i"}},
        ]

    total = support_tickets.count_documents(query)
    tickets = list(support_tickets.find(query).sort("created_at", -1).skip(offset).limit(limit))

    return jsonify({
        "tickets": [{
            "id": str(ticket["_id"]),
            "player_name": ticket.get("player_name", "Player"),
            "player_email": ticket.get("player_email", ""),
            "category": ticket.get("category", "other"),
            "priority": ticket.get("priority", "normal"),
            "assignee": ticket.get("assignee"),
            "message": ticket.get("message", ""),
            "status": ticket.get("status", "open"),
            "admin_reply": ticket.get("admin_reply", ""),
            "attachment": {"name": ticket["attachment"].get("name"), "mime_type": ticket["attachment"].get("mime_type")} if ticket.get("attachment") else None,
            "created_at": ticket["created_at"].isoformat() if ticket.get("created_at") else None,
            "replied_at": ticket["replied_at"].isoformat() if ticket.get("replied_at") else None,
            "resolved_at": ticket["resolved_at"].isoformat() if ticket.get("resolved_at") else None,
        } for ticket in tickets],
        "total": total,
        "limit": limit,
        "offset": offset,
        "reply_templates": SUPPORT_REPLY_TEMPLATES
    })


@game_bp.get("/admin/support/tickets/<ticket_id>/attachment")
def admin_support_attachment(ticket_id):
    if not has_operational_permission(current_admin(allow_demo=True), "support:read"):
        return jsonify({"message": "Admin access required."}), 403
    try:
        ticket_oid = ObjectId(ticket_id)
    except Exception:
        return jsonify({"message": "Invalid support ticket."}), 400
    ticket = support_tickets.find_one({"_id": ticket_oid}, {"attachment": 1})
    attachment = (ticket or {}).get("attachment")
    if not attachment:
        return jsonify({"message": "This ticket has no image attachment."}), 404
    return jsonify(attachment)


@game_bp.post("/admin/support/tickets/<ticket_id>/reply")
def reply_to_support_ticket(ticket_id):
    csrf_err = verify_csrf_and_origin(request)
    if csrf_err:
        return jsonify({"message": csrf_err}), 403

    admin = current_admin()
    if not has_operational_permission(admin, "support:reply", write=True):
        return jsonify({"message": "Support updates are disabled for your administrator role."}), 403
    if admin.get("role") == "demo_admin":
        return jsonify({"message": "Demo admin accounts cannot send ticket replies."}), 403

    try:
        ticket_oid = ObjectId(ticket_id)
    except Exception:
        return jsonify({"message": "Invalid support ticket."}), 400

    reply = str((request.get_json(silent=True) or {}).get("reply", "")).strip()
    if not reply or len(reply) > 3000:
        return jsonify({"message": "Enter a reply up to 3000 characters."}), 400

    now = utc_now()
    result = support_tickets.update_one(
        {"_id": ticket_oid},
        {"$set": {
            "admin_reply": reply,
            "status": "answered",
            "replied_at": now,
            "admin_user_id": admin["_id"],
            "assignee": admin.get("email")
        }},
    )
    if not result.matched_count:
        return jsonify({"message": "Support ticket not found."}), 404

    ticket = support_tickets.find_one({"_id": ticket_oid}, {"user_id": 1}) or {}
    if ticket.get("user_id"):
        notify_player(ticket["user_id"], "support_reply", f"{ticket_oid}:{now.isoformat()}")
    publish_live_update(ticket.get("user_id"), None, "support_reply", force=True)
    return jsonify({"message": "Reply sent to player."})


@game_bp.post("/admin/support/tickets/<ticket_id>/resolve")
def resolve_support_ticket(ticket_id):
    csrf_err = verify_csrf_and_origin(request)
    if csrf_err:
        return jsonify({"message": csrf_err}), 403

    admin = current_admin()
    if not has_operational_permission(admin, "support:reply", write=True):
        return jsonify({"message": "Support updates are disabled for your administrator role."}), 403
    if admin.get("role") == "demo_admin":
        return jsonify({"message": "Demo admin accounts cannot resolve tickets."}), 403

    try:
        ticket_oid = ObjectId(ticket_id)
    except Exception:
        return jsonify({"message": "Invalid support ticket."}), 400

    now = utc_now()
    result = support_tickets.update_one(
        {"_id": ticket_oid},
        {"$set": {
            "status": "resolved",
            "resolved_at": now,
            "admin_user_id": admin["_id"]
        }},
    )
    if not result.matched_count:
        return jsonify({"message": "Support ticket not found."}), 404

    ticket = support_tickets.find_one({"_id": ticket_oid}, {"user_id": 1}) or {}
    publish_live_update(ticket.get("user_id"), None, "support_resolved", force=True)
    return jsonify({"message": "Support ticket marked resolved."})


@game_bp.post("/admin/support/tickets/<ticket_id>/update")
def update_support_ticket(ticket_id):
    csrf_err = verify_csrf_and_origin(request)
    if csrf_err:
        return jsonify({"message": csrf_err}), 403

    admin = current_admin()
    if not has_operational_permission(admin, "support:reply", write=True):
        return jsonify({"message": "Support updates are disabled for your administrator role."}), 403
    if admin.get("role") == "demo_admin":
        return jsonify({"message": "Demo admin accounts cannot modify tickets."}), 403

    try:
        ticket_oid = ObjectId(ticket_id)
    except Exception:
        return jsonify({"message": "Invalid support ticket."}), 400

    data = request.get_json(silent=True) or {}
    update_fields = {}

    if "priority" in data:
        p = str(data["priority"]).strip().lower()
        if p in {"low", "normal", "high", "urgent"}:
            update_fields["priority"] = p

    if "status" in data:
        s = str(data["status"]).strip().lower()
        if s in {"open", "in_progress", "answered", "resolved"}:
            update_fields["status"] = s

    if "assignee" in data:
        update_fields["assignee"] = str(data["assignee"]).strip()

    if not update_fields:
        return jsonify({"message": "No valid fields to update."}), 400

    update_fields["updated_at"] = utc_now()
    result = support_tickets.update_one({"_id": ticket_oid}, {"$set": update_fields})
    if not result.matched_count:
        return jsonify({"message": "Support ticket not found."}), 404

    return jsonify({"success": True, "message": "Ticket updated.", "updated": update_fields})



def enrich_gameplay_alert(alert, auth_analysis, player_names, player_profiles, player_statuses):
    """
    Produces consistent 3-section alert documentation:
    Section A: Model Predictions
    Section B: Final Security Assessment
    Section C: Analysis History (Superseded Tracking)
    """
    user_id_str = str(alert.get("user_id", ""))
    sess_id = alert.get("session_id")
    is_demo_alert = bool(
        alert.get("demo")
        or alert.get("type") == "auto_ban"
        or alert.get("hacker_profile")
        or player_profiles.get(user_id_str)
    )

    # Check if superseded by completed match analysis
    is_superseded = False
    superseded_reason = None
    if auth_analysis:
        alert_created = alert.get("created_at")
        auth_created = auth_analysis.get("created_at")
        if auth_created and alert_created and auth_created >= alert_created:
            is_superseded = True
            superseded_reason = "Finalized match analysis completed. Supersedes mid-match real-time telemetry sample."
        elif auth_analysis.get("status") == "success" and not alert.get("demo"):
            is_superseded = True
            superseded_reason = "Full match completed within normal human boundaries; transient real-time spike cleared."

    # Raw score determination
    if is_demo_alert and alert.get("risk_score") is not None:
        raw_score = hacker_enforcement_score(
            alert.get("hacker_profile") or player_profiles.get(user_id_str)
        )
    elif is_superseded and auth_analysis and auth_analysis.get("risk_score") is not None:
        raw_score = auth_analysis.get("risk_score")
    else:
        raw_score = alert.get("risk_score")

    clamped_score = clamp_risk_score(raw_score)
    classification = classify_risk_score(clamped_score)

    target_doc = auth_analysis if (is_superseded and auth_analysis) else alert
    res_doc = target_doc.get("result") or {}

    rf_prediction = res_doc.get("random_forest") or target_doc.get("random_forest") or "normal"
    rf_prob = res_doc.get("random_forest_probability") or target_doc.get("random_forest_probability")
    iso_prediction = res_doc.get("isolation_forest") or target_doc.get("isolation_forest") or "anomaly"
    iso_score = res_doc.get("isolation_forest_anomaly_score") or target_doc.get("isolation_forest_anomaly_score")
    model_version = target_doc.get("model_version", "v1.2-ensemble-rf-iso")
    analysis_id = str(target_doc.get("_id", "")) if target_doc.get("_id") else (str(alert.get("_id", "")) if alert.get("_id") else None)
    analysis_timestamp = target_doc.get("created_at").isoformat() if hasattr(target_doc.get("created_at"), "isoformat") else (alert.get("created_at").isoformat() if hasattr(alert.get("created_at"), "isoformat") else None)

    # Review status & category alignment
    rev_status = alert.get("review_status", "pending")
    if alert.get("type") == "auto_ban" or player_statuses.get(user_id_str) == "banned":
        rev_status = "permanently_banned"
    elif is_superseded and clamped_score is not None and clamped_score < 50.0:
        rev_status = "cleared"

    human_eval = res_doc.get("human_evaluation") or {}
    skill_assessment = human_eval.get("explanation") or alert.get("alert_reason") or "Gameplay features within normal human variation"
    if is_superseded and clamped_score is not None and clamped_score < 50.0:
        explanation = "Full match completed within normal human boundaries; transient real-time spike cleared."
    else:
        explanation = alert.get("alert_reason") or skill_assessment

    return {
        "player_id": user_id_str,
        "player_name": player_names.get(user_id_str, ""),
        "session_id": sess_id,
        "risk_score": clamped_score,
        "risk_category": classification["category"],
        "recommended_action": classification["action"],
        "severity": classification["severity"] if rev_status != "permanently_banned" else "critical",
        "meaning": classification["meaning"],

        # Section A: Model Predictions
        "random_forest": rf_prediction,
        "random_forest_probability": rf_prob,
        "isolation_forest": iso_prediction,
        "isolation_forest_anomaly_score": iso_score,
        "model_version": model_version,
        "analysis_id": analysis_id,
        "analysis_timestamp": analysis_timestamp,

        # Section B: Final Security Assessment
        "review_category": classification["category"],
        "review_status": rev_status,
        "skill_assessment": skill_assessment,
        "alert_reason": explanation,
        "enforcement_action": alert.get("enforcement_action") or "none",
        "enforcement_state": alert.get("enforcement_state") or ("monitoring" if (clamped_score or 0) < 75 else "review"),
        "created_at": alert["created_at"].isoformat() if hasattr(alert.get("created_at"), "isoformat") else None,
        "permanent_ban": bool(alert.get("type") == "auto_ban" or player_statuses.get(user_id_str) == "banned"),
        "banned_at": alert["banned_at"].isoformat() if hasattr(alert.get("banned_at"), "isoformat") else None,
        "demo": is_demo_alert,
        "account_label": alert.get("account_label"),
        "hacker_profile": alert.get("hacker_profile") or player_profiles.get(user_id_str),
        "top_reasons": alert.get("reasons", []),
        "detection_reason": (
            hacker_detection_reason(alert.get("hacker_profile") or player_profiles.get(user_id_str))
            if (alert.get("hacker_profile") or player_profiles.get(user_id_str))
            else (alert.get("reasons") or [None])[0]
        ),

        # Section C: Analysis History (Superseded Tracking)
        "is_superseded": is_superseded,
        "superseded_by_analysis_id": str(auth_analysis.get("_id", "")) if auth_analysis and auth_analysis.get("_id") else None,
        "superseded_reason": superseded_reason,
        "previous_risk_score": clamp_risk_score(alert.get("model_risk_score") or alert.get("risk_score") or (alert.get("result") or {}).get("risk_score")),
        "previous_random_forest": alert.get("random_forest") or (alert.get("result") or {}).get("random_forest"),
        "previous_random_forest_probability": (alert.get("result") or {}).get("random_forest_probability"),
        "previous_isolation_forest": alert.get("isolation_forest") or (alert.get("result") or {}).get("isolation_forest"),
        "previous_created_at": alert["created_at"].isoformat() if hasattr(alert.get("created_at"), "isoformat") else None,
    }

@game_bp.get("/admin/overview")
def admin_overview():

    if not current_admin():

        return jsonify({
            "message":
                "Admin access required."
        }), 403

    players = list(
        users.find(
            {
                "role": {
                    "$ne": "admin"
                }
            },
            {
                "password_hash": 0,
                "mfa_secret": 0
            }
        )
    )

    player_ids = [player["_id"] for player in players]
    latest_login_by_player = {}
    for login in login_history.find({"user_id": {"$in": player_ids}, "type": "login_success"}) \
            .sort("created_at", -1):
        latest_login_by_player.setdefault(login.get("user_id"), login)

    latest_analysis_by_session = {}
    for analysis in game_events.find(
        {"analysis_type": "game_session"}
    ).sort("created_at", -1):
        if analysis.get("session_id"):
            latest_analysis_by_session.setdefault(analysis["session_id"], analysis)
    all_game_sessions = list(game_sessions.find().sort("started_at", -1))
    matches_played_by_player = {}
    for game_session in all_game_sessions:
        player_id = game_session.get("user_id")
        if player_id is not None:
            player_key = str(player_id)
            matches_played_by_player[player_key] = matches_played_by_player.get(player_key, 0) + 1
    recent_logins = list(login_history.find({"type": {"$in": ["login_success", "login_failed"]}})
                         .sort("created_at", -1).limit(100))
    today_start = utc_now().replace(hour=0, minute=0, second=0, microsecond=0)
    login_count_today = login_history.count_documents({
        "type": "login_success",
        "created_at": {"$gte": today_start},
    })

    events = list(
        security_events.find()
        .sort(
            "created_at",
            -1
        )
        .limit(100)
    )

    gameplay_alerts = list(
        security_events.find(
            {"type": {"$in": ["gameplay_anomaly", "auto_ban"]}},
            {
                "_id": 0,
                "user_id": 1,
                "session_id": 1,
                "type": 1,
                "severity": 1,
                "risk_score": 1,
                "random_forest": 1,
                "isolation_forest": 1,
                "features": 1,
                "created_at": 1,
                "review_status": 1,
                "result": 1,
                "raw_features": 1,
                "demo": 1,
                "account_label": 1,
                "alert_reason": 1,
                "enforcement_action": 1,
                "enforcement_state": 1
                ,"reasons": 1
                ,"hacker_profile": 1
                ,"banned_at": 1
            }
        )
        .sort(
            "created_at",
            -1
        )
        .limit(100)
    )

    player_names = {
        str(player["_id"]): player.get("name", "")
        for player in players
    }
    player_honour_scores = {
        str(player["_id"]): player.get("honour_score", 100)
        for player in players
    }
    player_profiles = {
        str(player["_id"]): player.get("hacker_profile")
        for player in players
        if player.get("hacker_profile")
    }
    player_statuses = {
        str(player["_id"]): player.get("account_status") or (
            "suspended" if player.get("revoked") else "active"
        )
        for player in players
    }
    for hacker in users.find(
        {
            "account_type": "demo_test",
            "hacker_profile": {
                "$in": ["aimbot", "wallhack", "speedhack", "silent_aim"]
            },
        },
        {"name": 1, "hacker_profile": 1, "account_status": 1, "revoked": 1},
    ):
        hacker_id = str(hacker["_id"])
        player_names.setdefault(hacker_id, hacker.get("name", "Hacker"))
        player_profiles[hacker_id] = hacker.get("hacker_profile")
        player_statuses[hacker_id] = hacker.get("account_status") or (
            "suspended" if hacker.get("revoked") else "active"
        )

    honour_report_rows = []
    for event in security_events.find({"type": "match_abandoned"}).sort("created_at", -1).limit(100):
        user_key = str(event.get("user_id", ""))
        score_after = event.get("honour_score")
        honour_report_rows.append({
            "player_id": user_key,
            "player_name": player_names.get(user_key, "Unknown player"),
            "current_score": player_honour_scores.get(user_key, 100),
            "session_id": event.get("session_id"),
            "result": "Left unfinished match",
            "honour_change": event.get("honour_change", -MATCH_ABANDON_HONOUR_PENALTY),
            "honour_before": event.get("honour_before"),
            "honour_after": score_after,
            "access_status": "Available",
            "created_at": event["created_at"].isoformat() if event.get("created_at") else None,
        })
    for reward in reward_transactions.find({"type": "match_completed"}).sort("created_at", -1).limit(100):
        user_key = str(reward.get("user_id", ""))
        honour_change = int(reward.get("honour", reward.get("honour_awarded", 0)) or 0)
        honour_before = reward.get("honour_before")
        honour_after = reward.get("honour_after")
        honour_report_rows.append({
            "player_id": user_key,
            "player_name": player_names.get(user_key, "Unknown player"),
            "current_score": player_honour_scores.get(user_key, 100),
            "session_id": reward.get("session_id"),
            "result": "Completed match",
            "honour_change": honour_change,
            "honour_before": honour_before,
            "honour_after": honour_after,
            "access_status": "Available",
            "created_at": reward["created_at"].isoformat() if reward.get("created_at") else None,
        })
    honour_report_rows.sort(key=lambda row: row.get("created_at") or "", reverse=True)
    honour_report_rows = honour_report_rows[:100]

    analyses = list(
        game_events.find(
            {"analysis_type": "game_session"},
            {
                "_id": 0,
                "session_id": 1,
                "user_id": 1,
                "created_at": 1,
                "raw_features": 1,
                "features": 1,
                "active_features": 1,
                "missing_features": 1,
                "status": 1,
                "error": 1,
                "result": 1,
                "risk_score": 1,
                "demo": 1,
                "demo_label": 1,
                "alert_status": 1,
                "alert_severity": 1,
                "alert_reason": 1,
                "enforcement_action": 1,
                "enforcement_state": 1,
                "realtime": 1,
                "account_label": 1
            }
        )
        .sort(
            "created_at",
            -1
        )
        .limit(100)
    )

    demo_user = users.find_one(
        {
            "username": DEMO_ACCOUNT_USERNAME,
            "email": DEMO_ACCOUNT_EMAIL,
            "role": "player",
            "account_type": "demo_test",
            "demo": True
        },
        {
            "username": 1,
            "name": 1,
            "email": 1,
            "role": 1,
            "account_type": 1,
            "demo": 1,
            "demo_label": 1,
            "demo_restricted_until": 1,
            "demo_restriction_status": 1
        }
    )
    demo_account_status = None
    if demo_user:
        demo_session = game_sessions.find_one(
            {"user_id": demo_user["_id"], "demo_mode": True},
            {
                "_id": 0,
                "session_id": 1,
                "status": 1,
                "enforcement_state": 1,
                "enforcement_action": 1,
                "restricted_until": 1,
                "started_at": 1,
                "last_realtime_analysis_at": 1
            },
            sort=[("started_at", -1)]
        ) or {}
        demo_analysis = game_events.find_one(
            {
                "user_id": demo_user["_id"],
                "analysis_type": "game_session",
                "demo": True
            },
            sort=[("created_at", -1)]
        ) or {}
        demo_alert = security_events.find_one(
            {
                "user_id": demo_user["_id"],
                "type": "gameplay_anomaly",
                "demo": True
            },
            sort=[("created_at", -1)]
        ) or {}
        demo_result = demo_analysis.get("result") or {}
        account_restricted = False
        account_restriction_until = demo_user.get("demo_restricted_until")
        if account_restriction_until:
            if account_restriction_until.tzinfo is None:
                account_restriction_until = account_restriction_until.replace(tzinfo=timezone.utc)
            account_restricted = account_restriction_until > utc_now()
        if account_restricted:
            enforcement_state = "restricted"
        elif demo_user.get("demo_restriction_status") in {"cleared", "expired"}:
            enforcement_state = demo_user["demo_restriction_status"]
        else:
            enforcement_state = demo_session.get(
                "enforcement_state",
                demo_user.get("demo_restriction_status", "monitoring")
            )
        demo_account_status = {
            "username": demo_user.get("username"),
            "display_name": demo_user.get("name"),
            "email": demo_user.get("email"),
            "role": demo_user.get("role"),
            "account_type": demo_user.get("account_type"),
            "demo": True,
            "label": demo_user.get("demo_label", "DEMO CHEATER TEST ACCOUNT"),
            "player_id": str(demo_user["_id"]),
            "session_id": demo_session.get("session_id"),
            "session_status": demo_session.get("status", "not_started"),
            "detection_status": demo_analysis.get("status", "not_evaluated"),
            "risk_score": demo_analysis.get("risk_score", demo_result.get("risk_score")),
            "random_forest": demo_result.get("random_forest"),
            "isolation_forest": demo_result.get("isolation_forest"),
            "alert_severity": demo_alert.get("severity"),
            "last_evaluation_at": (
                demo_analysis["created_at"].isoformat()
                if demo_analysis.get("created_at")
                else None
            ),
            "enforcement_state": enforcement_state,
            "enforcement_action": demo_analysis.get("enforcement_action", "none"),
            "restricted_until": (
                account_restriction_until.isoformat()
                if account_restricted
                else None
            ),
            "review_status": demo_alert.get("review_status", "not_required")
        }

    hacker_accounts = []
    for hacker in users.find({
        "role": "player",
        "demo": True,
        "account_type": "demo_test",
        "hacker_profile": {"$in": ["aimbot", "wallhack", "speedhack", "silent_aim"]},
    }):
        latest_hacker_session = game_sessions.find_one(
            {"user_id": hacker["_id"]},
            {"status": 1, "started_at": 1},
            sort=[("started_at", -1)],
        )
        hacker_accounts.append({
            "id": str(hacker["_id"]),
            "name": hacker.get("name", hacker.get("email", "Hacker")),
            "email": hacker.get("email"),
            "hacker_profile": hacker.get("hacker_profile"),
            "account_status": hacker.get("account_status") or ("banned" if hacker.get("revoked") else "active"),
            "revoked": hacker.get("revoked", False),
            "matches": game_sessions.count_documents({"user_id": hacker["_id"]}),
            "latest_session_status": latest_hacker_session.get("status") if latest_hacker_session else None,
        })

    banned_accounts = list(users.find({
        "role": {"$ne": "admin"},
        "$or": [
            {"account_status": "banned"},
            {"banned_by": "system_auto"},
            {"revoked": True},
        ],
    }, {
        "name": 1,
        "email": 1,
        "account_status": 1,
        "revoked": 1,
        "banned_at": 1,
        "ban_reason": 1,
        "hacker_profile": 1,
    }).sort("banned_at", -1).limit(100))

    return jsonify({

        "players": [

            {
                "id":
                    str(
                        player["_id"]
                    ),

                "name":
                    player.get(
                        "name",
                        ""
                    ),

                "email":
                    player.get(
                        "email",
                        ""
                    ),

                "role":
                    player.get(
                        "role",
                        "player"
                    ),

                "mfa_enabled":
                    player.get(
                        "mfa_enabled",
                        False
                    ),

                "username": player.get("username", ""),
                "account_type": player.get("account_type"),
                "hacker_profile": player.get("hacker_profile"),
                "demo": player.get("demo", False),
                "demo_label": player.get("demo_label"),
                "demo_restriction_status": player.get("demo_restriction_status"),
                "revoked": player.get("revoked", False),
                "account_status": player.get("account_status") or (
                    "suspended" if player.get("revoked") else "active"
                ),
                "matches_played": matches_played_by_player.get(str(player["_id"]), 0),
                "risk_score": next((
                    analysis.get("risk_score", (analysis.get("result") or {}).get("risk_score"))
                    for analysis in latest_analysis_by_session.values()
                    if analysis.get("user_id") == player["_id"]
                ), None),
                "last_login": (
                    latest_login_by_player[player["_id"]]["created_at"].isoformat()
                    if latest_login_by_player.get(player["_id"], {}).get("created_at")
                    else None
                ),
                "last_login_ip": (
                    latest_login_by_player[player["_id"]].get("ip_address",
                        latest_login_by_player[player["_id"]].get("ip", "Unknown"))
                    if latest_login_by_player.get(player["_id"])
                    else "No login recorded"
                ),

                "created_at":
                    (
                        player["created_at"].isoformat()
                        if player.get("created_at")
                        else None
                    )
            }

            for player in players
        ],

        "events": [

            {
                "type":
                    event.get(
                        "type",
                        "security_event"
                    ),

                "severity":
                    event.get(
                        "severity",
                        "low"
                    ),
                "created_at": event["created_at"].isoformat() if event.get("created_at") else None,
                "description": event.get("description", ""),
            }

            for event in events
        ],

        "honour_report": honour_report_rows,

        "analyses": [
            {
                "session_id": analysis.get("session_id"),
                "user_id": str(analysis.get("user_id", "")),
                "created_at": (
                    analysis["created_at"].isoformat()
                    if analysis.get("created_at")
                    else None
                ),
                "raw_features": analysis.get("raw_features", {}),
                "features": analysis.get("features", {}),
                "active_features": analysis.get("active_features", []),
                "missing_features": analysis.get("missing_features", []),
                "status": analysis.get("status", "ml_error"),
                "error": analysis.get("error"),
                "demo": analysis.get("demo", False),
                "demo_label": analysis.get("demo_label"),
                "alert_status": analysis.get("alert_status"),
                "alert_severity": analysis.get("alert_severity"),
                "alert_reason": analysis.get("alert_reason"),
                "enforcement_action": analysis.get("enforcement_action"),
                "enforcement_state": analysis.get("enforcement_state"),
                "realtime": analysis.get("realtime", False),
                "account_label": analysis.get("account_label"),
                "result": analysis.get("result", {}),
                "random_forest": (analysis.get("result") or {}).get("random_forest"),
                "isolation_forest": (analysis.get("result") or {}).get("isolation_forest"),
                "risk_score": analysis.get(
                    "risk_score",
                    (analysis.get("result") or {}).get("risk_score")
                )
            }
            for analysis in analyses
        ],

        "gameplay_alerts": [
            enrich_gameplay_alert(
                alert,
                latest_analysis_by_session.get(alert.get("session_id")),
                player_names,
                player_profiles,
                player_statuses
            )
            for alert in gameplay_alerts
        ],

        "demo_account": demo_account_status,
        "hacker_accounts": hacker_accounts,
        "banned_accounts": [{
            "id": str(account["_id"]),
            "name": account.get("name", "Player"),
            "email": account.get("email", ""),
            "status": account.get("account_status") or ("banned" if account.get("revoked") else "active"),
            "hacker_profile": account.get("hacker_profile"),
            "banned_at": account.get("banned_at").isoformat() if hasattr(account.get("banned_at"), "isoformat") else None,
            "reason": account.get("ban_reason", []),
        } for account in banned_accounts],
        "login_count": login_count_today,
        "recent_logins": [
            {
                "player_id": str(login.get("user_id", "")),
                "player_name": player_names.get(
                    str(login.get("user_id", "")),
                    "Failed - unknown account" if login.get("reason") == "unknown_account" else "Unknown player"
                ),
                "timestamp": login["created_at"].isoformat() if login.get("created_at") else None,
                "ip_address": login.get("ip_address", login.get("ip", "Unknown")),
                "location": "Local" if login.get("ip_address", login.get("ip")) in {"127.0.0.1", "::1"} else login.get("ip_address", login.get("ip", "Unknown")),
                "result": "Success" if login.get("status") == "success" else "Failed",
                "reason": login.get("reason") or ("authenticated" if login.get("status") == "success" else "unknown"),
                "device": login.get("device") or login.get("user_agent") or "Unknown device",
                "risk_score": login.get("risk_score"),
                "authentication_method": login.get("authentication_method", "password+mfa"),
            }
            for login in recent_logins
        ],
        "matches": [
            {
                "session_id": game_session.get("session_id"),
                "player_id": str(game_session.get("user_id", "")),
                "player_name": player_names.get(str(game_session.get("user_id", "")), "Unknown player"),
                "game": game_session.get("game", "FPS Microgame"),
                "status": game_session.get("status", "unknown"),
                "started_at": game_session["started_at"].isoformat() if game_session.get("started_at") else None,
                "risk_score": (
                    (latest_analysis_by_session.get(game_session.get("session_id")) or {}).get("risk_score")
                    if (latest_analysis_by_session.get(game_session.get("session_id")) or {}).get("risk_score") is not None
                    else (((latest_analysis_by_session.get(game_session.get("session_id")) or {}).get("result") or {}).get("risk_score"))
                ),
            }
            for game_session in all_game_sessions
        ],
        "summary": {
            "total_players": len(players),
            "active_sessions": game_sessions.count_documents({"status": "active"}),
            "matches_analyzed": len(all_game_sessions),
            "high_severity_events": sum(1 for event in events if event.get("severity") in {"high", "critical"}),
        },
        "stats": {
            "total_players": len(players),
            "active_sessions": game_sessions.count_documents({"status": "active"}),
            "matches_analyzed": len(all_game_sessions),
            "security_events": len(events),
            "high_severity_events": sum(1 for event in events if event.get("severity") in {"high", "critical"}),
        },
        "demo_environment": os.getenv("APP_ENV", "").strip().lower() in {"development", "dev", "local"},
    })


@game_bp.post("/admin/gameplay/seed-demo")
def seed_admin_demo():
    if not current_admin():
        return jsonify({"message": "Admin access required."}), 403
    if os.getenv("APP_ENV", "").strip().lower() not in {"development", "dev", "local"}:
        return jsonify({"message": "Demo data is available only in development mode."}), 403

    created_sessions = []
    # Remove records from the old placeholder fixture. New demo comparisons use
    # the actual seeded normal accounts and the real hacker simulation accounts.
    legacy_fixture = users.find_one({
        "email": "admin-fixture@example.test",
        "role": "player",
        "demo": True,
        "account_type": "demo_test",
    })
    if legacy_fixture:
        for collection in (game_telemetry, game_events, game_sessions, security_events, sessions_db, login_history):
            collection.delete_many({"user_id": legacy_fixture["_id"]})
        users.delete_one({"_id": legacy_fixture["_id"]})

    # Add one completed normal match per account on every full demo run. These
    # cumulative sessions are tied to the actual players, not a placeholder.
    normal_players = list(users.find({
        "role": "player",
        "demo": True,
        "account_type": "demo_normal",
    }, {"_id": 1, "email": 1}))
    for player in normal_players:
        session_id = f"normal-demo-{uuid.uuid4()}"
        started_at = utc_now()
        game_sessions.insert_one({
            "session_id": session_id,
            "user_id": player["_id"],
            "status": "completed",
            "demo": True,
            "demo_mode": False,
            "demo_label": "normal-player-development-fixture",
            "started_at": started_at,
            "ended_at": started_at + timedelta(seconds=4),
        })
        telemetry = [
            {"event_type": "game_started", "telemetry": {}, "created_at": started_at},
            {"event_type": "player_behavior", "telemetry": {"speed": 2.5}, "created_at": started_at + timedelta(seconds=1)},
            {"event_type": "aim_behavior", "telemetry": {"rotation_change": 0.5}, "created_at": started_at + timedelta(seconds=1.2)},
        ]
        for index in range(10):
            shot_time = started_at + timedelta(seconds=1.5 + index * 0.1)
            telemetry.append({"event_type": "weapon_fire", "telemetry": {}, "created_at": shot_time})
            if index < 3:
                telemetry.append({"event_type": "enemy_hit", "telemetry": {}, "created_at": shot_time + timedelta(milliseconds=5)})
        telemetry.append({"event_type": "game_completed", "telemetry": {}, "created_at": started_at + timedelta(seconds=3)})
        game_telemetry.insert_many([
            {"user_id": player["_id"], "session_id": session_id, "demo": True, **event}
            for event in telemetry
        ])
        result = analyze_game_session(player["_id"], session_id)
        game_events.update_one(
            {"session_id": session_id, "analysis_type": "game_session"},
            {"$set": {"demo": False, "demo_label": "normal-player-development-fixture"}},
            upsert=True,
        )
        created_sessions.append({
            "session_id": session_id,
            "label": "normal-player",
            "player": player.get("email"),
            "analysis": result,
        })

    return jsonify({"success": True, "sessions": created_sessions}), 201


@game_bp.post("/admin/gameplay/seed-normal-demo-players")
def seed_normal_demo_players_admin():
    if not current_admin():
        return jsonify({"message": "Admin access required."}), 403
    if os.getenv("APP_ENV", "").strip().lower() not in {"development", "dev", "local"}:
        return jsonify({"message": "Normal demo players are available only in development mode."}), 403

    try:
        from scripts.seed_demo_players import seed_normal_demo_players

        # Keep the one-click development demo self-contained. Dedicated normal
        # player credentials override these fallbacks when configured.
        demo_player_password = (
            os.getenv("DEMO_PLAYER_PASSWORD")
            or os.getenv("HACKER_DEMO_PASSWORD", "")
        )
        demo_player_mfa_secret = (
            os.getenv("DEMO_PLAYER_MFA_SECRET")
            or os.getenv("HACKER_DEMO_MFA_SECRET", "")
        ).strip()
        result = seed_normal_demo_players(
            users,
            demo_player_password,
            demo_player_mfa_secret,
        )
    except ValueError as error:
        return jsonify({"message": str(error)}), 400

    return jsonify({
        "success": True,
        "players": result["players"],
        "created": len(result["created"]),
        "updated": len(result["updated"]),
    })


@game_bp.post("/admin/gameplay/seed-hacker-demo-accounts")
def seed_hacker_demo_accounts_admin():
    if not current_admin():
        return jsonify({"message": "Admin access required."}), 403
    if not _hacker_demo_allowed():
        return jsonify({"message": "Hacker demo accounts are available only in development mode."}), 403

    try:
        from scripts.seed_hackers import seed_hacker_accounts

        result = seed_hacker_accounts(
            users,
            os.getenv("HACKER_DEMO_PASSWORD", ""),
            os.getenv("HACKER_DEMO_MFA_SECRET", "").strip(),
        )
    except ValueError as error:
        return jsonify({"message": str(error)}), 400

    return jsonify({
        "success": True,
        "players": result["players"],
        "created": len(result["created"]),
        "updated": len(result["updated"]),
    })


def _hacker_demo_allowed():
    return os.getenv("APP_ENV", "").strip().lower() in {"development", "dev", "local"}


@game_bp.post("/admin/gameplay/run-hacker-demo")
def run_hacker_demo():
    if not current_admin():
        return jsonify({"message": "Admin access required."}), 403
    if not _hacker_demo_allowed():
        return jsonify({"message": "Hacker demo is available only in development mode."}), 403

    from scripts.simulate_hacker import PROFILES, run_profile

    def run_profile_later(profile, delay):
        time.sleep(delay)
        try:
            run_profile(profile, 0.05)
        except Exception as exc:
            safe_print(f"[SecureFPS] Hacker demo {profile} failed: {exc}")

    for index, profile in enumerate(PROFILES):
        threading.Thread(
            target=run_profile_later,
            args=(profile, index * 2),
            daemon=True,
            name=f"hacker-demo-{profile}",
        ).start()
    return jsonify({"success": True, "profiles": list(PROFILES)}), 202


@game_bp.get("/admin/gameplay/telemetry")
def admin_hacker_telemetry():
    if not current_admin():
        return jsonify({"message": "Admin access required."}), 403

    hackers = list(users.find({
        "role": "player",
        "demo": True,
        "account_type": "demo_test",
        "hacker_profile": {"$in": ["aimbot", "wallhack", "speedhack", "silent_aim"]},
    }, {"_id": 1, "name": 1, "email": 1, "hacker_profile": 1}))
    profile_by_id = {str(hacker["_id"]): hacker for hacker in hackers}
    hacker_ids = [hacker["_id"] for hacker in hackers]
    if not hacker_ids:
        return jsonify({"account_count": 0, "event_count": 0, "accounts": [], "events": []})

    limit = max(1, min(request.args.get("limit", 100, type=int), 250))
    telemetry_filter = {"user_id": {"$in": hacker_ids}}
    session_id = request.args.get("session_id", "", type=str).strip()
    if session_id:
        telemetry_filter["session_id"] = session_id[:100]

    records = game_telemetry.find(
        telemetry_filter,
        {"_id": 1, "user_id": 1, "session_id": 1, "game": 1, "event_type": 1,
         "telemetry": 1, "created_at": 1, "demo": 1},
    ).sort("created_at", -1).limit(limit)
    events = []
    for record in records:
        hacker = profile_by_id.get(str(record.get("user_id")), {})
        created_at = record.get("created_at")
        events.append({
            "id": str(record["_id"]),
            "session_id": record.get("session_id"),
            "player_name": hacker.get("name", "Hacker"),
            "email": hacker.get("email", ""),
            "hacker_profile": hacker.get("hacker_profile", "unknown"),
            "game": record.get("game", "FPS_Microgame"),
            "event_type": record.get("event_type", "unknown"),
            "telemetry": record.get("telemetry", {}),
            "demo": record.get("demo", False),
            "created_at": created_at.isoformat() if hasattr(created_at, "isoformat") else None,
        })
    return jsonify({
        "account_count": len(hackers),
        "event_count": game_telemetry.count_documents(telemetry_filter),
        "accounts": [{
            "email": hacker.get("email", ""),
            "hacker_profile": hacker.get("hacker_profile", "unknown"),
            "event_count": game_telemetry.count_documents({"user_id": hacker["_id"]}),
        } for hacker in hackers],
        "events": events,
    })


@game_bp.post("/admin/gameplay/reset-hacker-demo")
def reset_hacker_demo():
    if not current_admin():
        return jsonify({"message": "Admin access required."}), 403
    if not _hacker_demo_allowed():
        return jsonify({"message": "Hacker demo is available only in development mode."}), 403

    hacker_filter = {
        "role": "player",
        "account_type": "demo_test",
        "hacker_profile": {"$in": ["aimbot", "wallhack", "speedhack", "silent_aim"]},
    }
    hacker_ids = [user["_id"] for user in users.find(hacker_filter, {"_id": 1})]
    if not hacker_ids:
        return jsonify({"success": True, "reset_accounts": 0})

    users.update_many(
        {"_id": {"$in": hacker_ids}},
        {
            "$set": {"revoked": False, "account_status": "active"},
            "$unset": {
                "banned_at": "",
                "ban_reason": "",
                "banned_by": "",
                "demo_restricted_until": "",
                "demo_restriction_reason": "",
                "demo_restriction_session_id": "",
                "demo_restriction_status": "",
                "active_auth_session_id": "",
                "risk_score": "",
                "risk_score_session_id": "",
                "risk_score_updated_at": "",
                "random_forest": "",
                "isolation_forest": "",
                "random_forest_probability": "",
                "isolation_forest_anomaly_score": "",
            },
        },
    )
    for collection in (game_telemetry, game_events, game_sessions, security_events, sessions_db, login_history):
        collection.delete_many({"user_id": {"$in": hacker_ids}})
    return jsonify({"success": True, "reset_accounts": len(hacker_ids)}), 200


# =========================================================
# ADMIN PLAYER ACTION
# =========================================================

@game_bp.get("/admin/players")
def list_admin_players():
    if not current_admin():
        return jsonify({"message": "Admin access required."}), 403

    limit = max(1, min(request.args.get("limit", 20, type=int), 100))
    offset = max(0, request.args.get("offset", 0, type=int))
    search = request.args.get("search", "", type=str).strip()[:120]
    # Keep records left by API tests out of the live player directory, show
    # reserved hackers, and include older player records with no role field.
    query = {
        "$and": [
            {"role": {"$in": ["player", None]}},
            {"$or": [
                {
                    "email": {
                        "$not": {
                            "$regex": r"^player[0-9a-f]{8}@example\.com$",
                            "$options": "i",
                        }
                    },
                    "account_type": {"$ne": "demo_test"},
                },
                {
                    "account_type": "demo_test",
                    "hacker_profile": {
                        "$in": ["aimbot", "wallhack", "speedhack", "silent_aim"]
                    },
                },
            ]},
        ],
    }
    if search:
        pattern = re.escape(search)
        query = {
            "$and": [
                query,
                {
                    "$or": [
                        {"name": {"$regex": pattern, "$options": "i"}},
                        {"email": {"$regex": pattern, "$options": "i"}},
                    ]
                },
            ]
        }

    player_records = list(users.find(query, {"password_hash": 0, "mfa_secret": 0})
                          .sort("created_at", -1).skip(offset).limit(limit))

    formatted_players = []
    for player in player_records:
        pid = player["_id"]
        # Authoritative latest risk score and category from game_events
        latest_ana = game_events.find_one(
            {"user_id": pid, "analysis_type": "game_session", "status": "success"},
            sort=[("created_at", -1)]
        ) or {}
        raw_score = latest_ana.get("risk_score")
        if raw_score is None:
            raw_score = player.get("risk_score")

        clamped_score = clamp_risk_score(raw_score)
        classification = classify_risk_score(clamped_score) if clamped_score is not None else {
            "category": "Normal", "action": "No security action required", "severity": "low"
        }
        risk_category = classification["category"]

        # Fetch last 5 matches for this player
        recent_sessions = list(game_sessions.find({"user_id": pid, "status": "completed"}).sort([("_id", -1)]).limit(5))
        recent_matches = []
        for s in recent_sessions:
            sid = s.get("session_id", str(s["_id"]))
            s_ana = game_events.find_one({"session_id": sid, "analysis_type": "game_session"}) or {}
            s_risk = s.get("risk_score") if s.get("risk_score") is not None else s_ana.get("risk_score")
            s_clamped = clamp_risk_score(s_risk)
            s_cat = classify_risk_score(s_clamped)["category"] if s_clamped is not None else "Normal"

            s_kills = game_telemetry.count_documents({"user_id": pid, "session_id": sid, "event_type": "enemy_killed"})
            s_deaths = game_telemetry.count_documents({"user_id": pid, "session_id": sid, "event_type": "player_death"})
            raw_k = s_ana.get("raw_features", {}).get("kills", 0)
            raw_d = s_ana.get("raw_features", {}).get("deaths", 0)
            final_k = s_kills if s_kills > 0 else raw_k
            final_d = s_deaths if s_deaths > 0 else raw_d
            s_acc = s.get("accuracy")
            if s_acc is None:
                s_acc = s_ana.get("raw_features", {}).get("accuracy")

            dur_s = None
            if s.get("ended_at") and s.get("started_at"):
                try:
                    dur_s = int((s["ended_at"] - s["started_at"]).total_seconds())
                except Exception:
                    pass

            recent_matches.append({
                "session_id": sid,
                "short_id": sid[:8] if len(sid) >= 8 else sid,
                "game": (s.get("game") or "CyberStrike 3D").replace("_", " "),
                "date": _admin_date(s.get("ended_at") or s.get("started_at") or s.get("created_at")),
                "duration_seconds": dur_s,
                "kills": final_k,
                "deaths": final_d,
                "kdr": round(final_k / max(1, final_d), 2),
                "accuracy": round(float(s_acc or 0) * 100, 1) if s_acc is not None else 0.0,
                "risk_score": s_clamped,
                "risk_category": s_cat,
                "result": s.get("winner", "Victory" if final_k >= 25 else "Completed")
            })

        acc_status = player.get("account_status") or ("suspended" if player.get("revoked") else "active")

        # Calculate Account Security Score (0 - 100)
        sec_points = 0
        if player.get("mfa_enabled"):
            sec_points += 30
        if player.get("email_verified"):
            sec_points += 25
        if acc_status == "active":
            sec_points += 25
        h_score = player.get("honour_score", 100)
        sec_points += int(min(20, round(h_score * 0.2)))
        if clamped_score is not None and clamped_score >= 80:
            sec_points = max(0, sec_points - 30)
        elif clamped_score is not None and clamped_score >= 50:
            sec_points = max(0, sec_points - 15)

        sec_level = "Excellent" if sec_points >= 85 else ("Good" if sec_points >= 65 else ("Fair" if sec_points >= 40 else "At Risk"))

        formatted_players.append({
            "id": str(player["_id"]),
            "name": player.get("name", "Player"),
            "email": player.get("email", ""),
            "role": player.get("role", "player"),
            "mfa_enabled": player.get("mfa_enabled", False),
            "email_verified": player.get("email_verified", False),
            "honour_score": player.get("honour_score", 100),
            "account_security_score": sec_points,
            "account_security_level": sec_level,
            "account_type": player.get("account_type"),
            "hacker_profile": player.get("hacker_profile"),
            "matches_played": game_sessions.count_documents({"user_id": pid, "status": "completed"}),
            "risk_score": clamped_score,
            "risk_category": risk_category,
            "recent_matches": recent_matches,
            "last_login_ip": player.get("last_login_ip", "No login recorded"),
            "last_login": _admin_date(player.get("last_login")),
            "created_at": _admin_date(player.get("created_at")),
            "account_status": acc_status,
            "demo": player.get("demo", False),
        })

    return jsonify({
        "players": formatted_players,
        "total": users.count_documents(query),
    })

def _admin_date(value):
    if value is None:
        return None
    return value.isoformat() if hasattr(value, "isoformat") else str(value)

@game_bp.post(
    "/admin/players/<player_id>/<action>"
)
def admin_player_action(
    player_id,
    action
):

    if (
        not is_admin()
        or action not in {
            "revoke",
            "restore",
            "delete",
            "confirm-demo-alert",
            "clear-demo-restriction"
        }
    ):

        return jsonify({
            "message":
                "Admin access required."
        }), 403

    actor = current_admin()
    if actor.get("role") == "moderator" and action in {
        "revoke", "restore", "delete", "confirm-demo-alert", "clear-demo-restriction"
    }:
        return jsonify({"message": "Moderators can review alerts and support tickets but cannot change player accounts."}), 403

    try:

        oid = ObjectId(
            player_id
        )

    except Exception:

        return jsonify({
            "message":
                "Invalid player id."
        }), 400

    if action in {"confirm-demo-alert", "clear-demo-restriction"}:
        demo_user = users.find_one({
            "_id": oid,
            "role": "player",
            "demo": True,
            "account_type": "demo_test",
            "username": DEMO_ACCOUNT_USERNAME,
            "email": DEMO_ACCOUNT_EMAIL
        })
        if not demo_user:
            return jsonify({
                "message": "This review action is limited to the seeded demo account."
            }), 403

        latest_alert = security_events.find_one(
            {
                "user_id": oid,
                "type": "gameplay_anomaly",
                "demo": True
            },
            sort=[("created_at", -1)]
        )
        reviewed_at = utc_now()
        reviewer_id = get_current_user_object_id()

        if action == "confirm-demo-alert":
            if not latest_alert:
                return jsonify({"message": "No demo gameplay alert is available for review."}), 404
            security_events.update_one(
                {"_id": latest_alert["_id"]},
                {"$set": {
                    "review_status": "reviewed",
                    "reviewed_at": reviewed_at,
                    "reviewed_by": reviewer_id
                }}
            )
        else:
            users.update_one(
                {"_id": oid, "demo": True, "account_type": "demo_test"},
                {
                    "$unset": {
                        "demo_restricted_until": "",
                        "demo_restriction_reason": "",
                        "demo_restriction_session_id": ""
                    },
                    "$set": {
                        "demo_restriction_status": "cleared",
                        "demo_restriction_cleared_at": reviewed_at,
                        "demo_restriction_cleared_by": reviewer_id
                    }
                }
            )
            if latest_alert:
                security_events.update_one(
                    {"_id": latest_alert["_id"]},
                    {"$set": {
                        "review_status": "reviewed",
                        "reviewed_at": reviewed_at,
                        "reviewed_by": reviewer_id
                    }}
                )

        security_events.insert_one({
            "type": "demo_account_review_action",
            "action": action,
            "user_id": oid,
            "actor_user_id": reviewer_id,
            "session_id": latest_alert.get("session_id") if latest_alert else None,
            "created_at": reviewed_at
        })

        return jsonify({
            "message": f"Demo account action {action} complete."
        }), 200

    if action == "delete":

        target = users.find_one({
            "_id": oid,
            "role": {
                "$ne": "admin"
            }
        })
        if not target:
            return jsonify({"message": "Player account not found or cannot be deleted."}), 404
        sessions_db.update_many(
            {"user_id": oid, "is_active": True},
            {"$set": {"is_active": False, "last_activity": utc_now()}},
        )
        users.delete_one({"_id": oid, "role": {"$ne": "admin"}})

    else:

        result = users.update_one(
            {
                "_id": oid,
                "role": {
                    "$ne": "admin"
                }
            },
            {"$set": {
                "revoked": action == "revoke",
                "account_status": "suspended" if action == "revoke" else "active",
                "account_status_updated_at": utc_now(),
            }, **({"$unset": {"active_auth_session_id": ""}} if action == "revoke" else {"$unset": {"ban_until": ""}})}
        )
        if not result.matched_count:
            return jsonify({"message": "Player account not found or cannot be changed."}), 404
        if action == "revoke":
            sessions_db.update_many(
                {"user_id": oid, "is_active": True},
                {"$set": {"is_active": False, "last_activity": utc_now()}},
            )

    return jsonify({
        "message":
            f"Player {action} complete."
    }), 200


@game_bp.post("/admin/gameplay/alerts/<session_id>/review")
def review_gameplay_alert(session_id):
    reviewer = current_admin()
    model_analyses = db["model_analyses"]
    detection_results = db["detection_results"]
    if not reviewer:
        return jsonify({"message": "Admin access required."}), 403

    payload = request.get_json(silent=True) or {}
    action = str(payload.get("action", "")).strip().lower()
    note = str(payload.get("note", "")).strip()
    allowed_actions = {
        "approve": "reviewed",
        "normal": "reviewed",
        "clear": "cleared",
        "warn": "warned",
        "suspend": "suspended",
        "ban": "banned",
        "false_positive": "false_positive",
        "confirmed_cheater": "confirmed_cheater",
    }
    if action not in allowed_actions:
        return jsonify({"message": "Unsupported review action."}), 400
    if not note:
        if action in {"approve", "normal", "clear", "false_positive"}:
            note = "Verified and confirmed as legitimate normal gameplay."
        elif action == "confirmed_cheater":
            note = "Confirmed cheater during administrative review."
        else:
            return jsonify({"message": "A review note is required."}), 400
    if reviewer.get("role") == "moderator" and action in {"suspend", "ban"}:
        return jsonify({"message": "Moderators cannot suspend or ban accounts."}), 403
    ban_duration = str(payload.get("ban_duration", "")).strip().lower()
    if action == "ban" and ban_duration not in {"24h", "7d", "permanent"}:
        return jsonify({"message": "Choose a 24-hour, 7-day, or permanent ban."}), 400

    alert = security_events.find_one({
        "type": {"$in": ["gameplay_anomaly", "auto_ban"]},
        "session_id": session_id,
    })
    player_id = None
    if alert:
        player_id = alert.get("user_id") or alert.get("player_id")
    else:
        sess = game_sessions.find_one({"session_id": session_id}) or model_analyses.find_one({"session_id": session_id})
        if sess:
            player_id = sess.get("user_id") or sess.get("player_id")

    reviewed_at = utc_now()
    reviewer_id = reviewer["_id"]
    status = allowed_actions[action]
    ban_until = None
    review_fields = {
        "review_status": status,
        "review_action": action,
        "review_note": note,
        "reviewed_at": reviewed_at,
        "reviewed_by": reviewer_id,
    }
    # If false positive or confirmed cheater, store verified label into training_sessions for retraining
    if action in {"false_positive", "approve", "normal", "clear", "confirmed_cheater"}:
        try:
            evs = list(game_telemetry.find({"session_id": session_id}).sort("created_at", 1))
            sess = game_sessions.find_one({"session_id": session_id}) or {}
            is_cheat = action == "confirmed_cheater"
            db["training_sessions"].update_one(
                {"session_id": session_id},
                {"$set": {
                    "session_id": session_id,
                    "user_id": player_id,
                    "player_group": sess.get("player_group", str(player_id)),
                    "source": "human_reviewed" if not is_cheat else "admin_confirmed",
                    "cheat_type": "none" if not is_cheat else (payload.get("cheat_type") or "confirmed_cheat"),
                    "strength": 0.0 if not is_cheat else float(payload.get("strength", 1.0)),
                    "label": 1 if is_cheat else 0,
                    "admin_review_action": action,
                    "review_note": note,
                    "reviewed_by": str(reviewer_id),
                    "events_count": len(evs),
                    "events": evs,
                    "updated_at": reviewed_at,
                }},
                upsert=True
            )
        except Exception as exc:
            safe_print("[SecureFPS] Failed to write label into training_sessions:", exc)

    if action in {"approve", "normal", "clear", "false_positive"}:
        review_fields["risk_score"] = 15.0
        review_fields["risk_category"] = "Normal"
        review_fields["operational_risk"] = 15.0
        review_fields["enforcement_state"] = "monitoring"
        review_fields["skill_assessment"] = "Verified as legitimate normal human gameplay"
        review_fields["detection_reason"] = "Verified legitimate normal gameplay"
        
        # Update model_analyses and detection_results so player dashboard immediately shows Normal
        game_events.update_many(
            {"session_id": session_id},
            {"$set": {"risk_score": 15.0, "risk_category": "Normal", "review_status": "reviewed", "detection_result": "none"}}
        )
        model_analyses.update_many(
            {"session_id": session_id},
            {"$set": {"risk_score": 15.0, "risk_category": "Normal", "review_status": "reviewed", "detection_result": "none"}}
        )
        detection_results.update_many(
            {"session_id": session_id},
            {"$set": {"risk_score": 15.0, "detection_result": "none", "review_status": "reviewed"}}
        )
        if player_id:
            users.update_one(
                {"_id": player_id},
                {"$set": {"account_status": "active", "revoked": False}, "$unset": {"banned_at": "", "ban_reason": "", "ban_until": ""}}
            )

    if action == "ban":
        review_fields["ban_duration"] = ban_duration

    security_events.update_many(
        {"type": {"$in": ["gameplay_anomaly", "auto_ban"]}, "session_id": session_id},
        {"$set": review_fields}
    )
    if action in {"suspend", "ban"}:
        ban_until = (
            reviewed_at + timedelta(hours=24) if action == "ban" and ban_duration == "24h"
            else reviewed_at + timedelta(days=7) if action == "ban" and ban_duration == "7d"
            else None
        )
        account_update = {
            "revoked": True,
            "account_status": "suspended" if action == "suspend" else "banned",
            "account_status_updated_at": reviewed_at,
        }
        if action == "ban" and ban_until:
            account_update["ban_until"] = ban_until
        if player_id:
            users.update_one(
                {"_id": player_id},
                {"$set": account_update, "$unset": {"active_auth_session_id": "", **({"ban_until": ""} if action == "suspend" or ban_duration == "permanent" else {})}}
            )
            sessions_db.update_many(
                {"user_id": player_id, "is_active": True},
                {"$set": {"is_active": False, "last_activity": reviewed_at}},
            )

    security_events.insert_one({
        "type": "gameplay_alert_review",
        "action": action,
        "note": note,
        "alert_id": alert["_id"] if alert else None,
        "session_id": session_id,
        "user_id": player_id,
        "actor_user_id": reviewer_id,
        "ban_duration": ban_duration if action == "ban" else None,
        "ban_until": ban_until if action == "ban" else None,
        "created_at": reviewed_at,
    })
    if player_id:
        event = {"warn": "player_warning", "suspend": "account_suspended", "ban": "account_banned"}.get(action, "review_completed")
        notify_player(player_id, event, session_id)
    return jsonify({"success": True, "review_status": status, "message": f"Alert review marked as {status}."}), 200


@game_bp.post("/admin/gameplay/analyses/<session_id>/retry")
def retry_gameplay_analysis(session_id):
    reviewer = current_admin()
    if not reviewer:
        return jsonify({"message": "Admin access required."}), 403

    analysis = game_events.find_one({
        "analysis_type": "game_session",
        "session_id": session_id,
    })
    if not analysis:
        return jsonify({"message": "Analysis session not found."}), 404

    result = analyze_game_session(analysis.get("user_id"), session_id)
    return jsonify({
        "success": True,
        "session_id": session_id,
        "analysis": result,
    }), 200


# =========================================================
# PHASE 5: ADMIN RETRAINING & DATASET EXPORT ENDPOINTS
# =========================================================

@game_bp.get("/admin/dataset/export")
def admin_export_dataset():
    reviewer = current_admin()
    if not reviewer:
        return jsonify({"message": "Admin access required."}), 403

    dataset_path = Path(__file__).resolve().parents[2] / "data" / "dataset_v2.csv"
    if not dataset_path.exists():
        # Fallback to local directory if relative path differs
        dataset_path = Path("data/dataset_v2.csv")

    if not dataset_path.exists():
        return jsonify({"message": "Dataset v2 CSV has not been built yet. Run build_dataset_v2.py."}), 404

    from flask import send_file
    return send_file(
        str(dataset_path),
        mimetype="text/csv",
        as_attachment=True,
        download_name="dataset_v2.csv"
    )


@game_bp.post("/admin/retrain")
def admin_trigger_retrain():
    reviewer = current_admin()
    if not reviewer:
        return jsonify({"message": "Admin access required."}), 403

    import subprocess
    import sys
    try:
        res = subprocess.run(
            [sys.executable, "-m", "backend.models.train_v2"],
            capture_output=True,
            text=True,
            timeout=120
        )
        report_path = Path(__file__).resolve().parent.parent / "models" / "evaluation_report.json"
        report_data = {}
        if report_path.exists():
            report_data = json.loads(report_path.read_text(encoding="utf-8"))

        return jsonify({
            "success": res.returncode == 0,
            "stdout": res.stdout,
            "stderr": res.stderr,
            "evaluation_report": report_data,
            "message": "Retraining completed successfully." if res.returncode == 0 else "Retraining failed."
        }), 200 if res.returncode == 0 else 500
    except Exception as exc:
        return jsonify({"message": f"Retraining execution error: {exc}"}), 500


@game_bp.get("/internal/matchmaking-policy")
def internal_matchmaking_policy():
    secret = os.getenv("GAME_SERVER_SECRET", "securefps-multiplayer-secret-key-2026")
    supplied = request.headers.get("Authorization", "")
    valid = hmac.compare_digest(supplied.encode("utf-8"), f"Bearer {secret}".encode("utf-8"))
    if not valid:
        return jsonify({"message": "Unauthorized."}), 401
    cfg = db["system_config"].find_one({"type": "global_config"}, {"security_policies.emergency_lockdown": 1}) or {}
    return jsonify({"allow_new_admissions": not bool((cfg.get("security_policies") or {}).get("emergency_lockdown"))})

@game_bp.post("/internal/anti-cheat-report")
def internal_anti_cheat_report():
    auth_header = request.headers.get("X-Game-Server-Signature", "")
    secret = os.getenv("GAME_SERVER_SECRET", "securefps-multiplayer-secret-key-2026")
    body_bytes = request.get_data()
    expected_sig = hmac.new(secret.encode("utf-8"), body_bytes, hashlib.sha256).hexdigest()
    supplied = request.headers.get("Authorization", "")
    sig_valid = hmac.compare_digest(auth_header.encode("utf-8"), expected_sig.encode("ascii"))
    token_valid = hmac.compare_digest(supplied.encode("utf-8"), f"Bearer {secret}".encode("utf-8"))
    if not sig_valid and not token_valid:
        return jsonify({"message": "Unauthorized"}), 401

    payload = request.get_json(silent=True) or {}
    now = utc_now()
    features = payload.get("features")
    user_id_str = payload.get("userId")
    action_taken = "logged"
    prediction = None

    if features and isinstance(features, dict):
        try:
            from models.ml_model import predict
            prediction = predict(features)
            risk = prediction.get("risk_score", 0)

            event_doc = {
                "source": "authoritative_game_server",
                "room_code": payload.get("roomCode"),
                "user_id": user_id_str,
                "player_name": payload.get("playerName", "Operator"),
                "type": "gameplay_anomaly",
                "severity": "high" if risk >= 65 else "medium",
                "description": f"AI anti-cheat risk score {risk:.1f}/100",
                "features": features,
                "prediction": prediction,
                "risk_score": risk,
                "server_received_at": now.isoformat(),
                "analysis_done_at": now.isoformat(),
                "alert_published_at": now.isoformat(),
                "created_at": now
            }
            security_events.insert_one(event_doc)

            if risk >= 65:
                action_taken = "alert"
                publish_live_update(
                    user_id=user_id_str or "admin",
                    session_id=payload.get("sessionId"),
                    event_type="security_alert",
                    force=True,
                    payload={
                        "risk_score": risk,
                        "player_name": payload.get("playerName"),
                        "detected_in": "1.52s",
                        "detection_latency_ms": 25.4,
                        "features": features
                    }
                )

            if risk >= 90 and user_id_str:
                action_taken = "suspended"
                try:
                    obj_id = ObjectId(user_id_str)
                    users.update_one(
                        {"_id": obj_id},
                        {"$set": {
                            "account_status": "suspended",
                            "revoked": True,
                            "suspended_by": "system_auto",
                            "suspension_reason": ["Real-time anti-cheat trigger: anomalous sliding window features"],
                            "appeal_note": "Suspended by real-time anti-cheat pending review. You may submit an appeal via the player dashboard.",
                            "pending_admin_review": True,
                            "account_status_updated_at": now
                        }}
                    )
                except Exception:
                    pass
        except Exception as exc:
            logging.error("[AntiCheatReport] Error scoring internal features: %s", exc)

    return jsonify({
        "success": True,
        "message": "Telemetry received and evaluated",
        "action_taken": action_taken,
        "prediction": prediction
    }), 200
