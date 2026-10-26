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

from flask import Blueprint, Response, jsonify, request, session, stream_with_context
from bson import ObjectId

from database.db import (
    game_events,
    game_telemetry,
    game_sessions,
    security_events,
    login_history,
    users,
    sessions_db,
    reward_transactions,
    support_tickets,
)

from models.ml_model import predict, FEATURES


game_bp = Blueprint(
    "game",
    __name__,
    url_prefix="/api"
)


def safe_print(*args, **kwargs):
    try:
        print(*args, **kwargs)
    except OSError:
        pass


_live_subscribers = {"admin": set()}
_live_subscribers_lock = threading.Lock()
_live_emit_times = {}


def publish_live_update(user_id, session_id=None, event_type="game_update", force=False, payload=None):
    """Publish a small notification; dashboards fetch authoritative values from MongoDB."""
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

    payload = json.dumps({
        "type": event_type,
        "session_id": str(session_id) if session_id else None,
        "updated_at": utc_now().isoformat(),
        **(payload or {}),
    })
    for subscriber in queues:
        try:
            subscriber.put_nowait(payload)
        except queue.Full:
            try:
                subscriber.get_nowait()
                subscriber.put_nowait(payload)
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
    channel = "admin" if account.get("role") == "admin" else str(user_id)
    subscriber = queue.Queue(maxsize=50)
    with _live_subscribers_lock:
        _live_subscribers.setdefault(channel, set()).add(subscriber)

    @stream_with_context
    def event_stream():
        try:
            yield "event: ready\ndata: {}\n\n"
            while True:
                try:
                    payload = subscriber.get(timeout=15)
                    yield f"event: update\ndata: {payload}\n\n"
                except queue.Empty:
                    yield ": keep-alive\n\n"
        finally:
            with _live_subscribers_lock:
                channel_subscribers = _live_subscribers.get(channel)
                if channel_subscribers:
                    channel_subscribers.discard(subscriber)

    return Response(event_stream(), mimetype="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    })


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
MATCH_ABANDON_HONOUR_PENALTY = 20
MATCH_ABANDON_RESTRICTION_THRESHOLD = 80
MATCH_ABANDON_COOLDOWN_MINUTES = 30
MATCH_COMPLETE_HONOUR_REWARD = 5
MAX_HONOUR_SCORE = 100

# Alerts indicate suspicious sessions for review, not confirmed cheating.
GAMEPLAY_ALERT_THRESHOLDS = {
    "medium_min_risk_score": float(os.getenv("GAMEPLAY_ALERT_MEDIUM_RISK", "50")),
    "high_min_risk_score": float(os.getenv("GAMEPLAY_ALERT_HIGH_RISK", "75")),
}

DEMO_ACCOUNT_EMAIL = "demo_cheater@example.test"
DEMO_ACCOUNT_USERNAME = "demo_cheater"


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


def current_admin():
    user_id = get_current_user_object_id()
    if not user_id:
        return None
    return users.find_one({"_id": user_id, "role": {"$in": ["admin", "moderator", "super_admin"]}})


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
    play_restricted_until = account.get("play_restricted_until")
    if play_restricted_until:
        if play_restricted_until.tzinfo is None:
            play_restricted_until = play_restricted_until.replace(tzinfo=timezone.utc)
        if play_restricted_until > utc_now():
            return jsonify({
                "message": "Game access is paused for 30 minutes because your Honour score is below 80.",
                "honour_score": account.get("honour_score", 100),
                "restricted_until": play_restricted_until.isoformat(),
            }), 403
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

    hacker_demo_mode = (
        os.getenv("APP_ENV", "").strip().lower()
        in {"development", "dev", "local"}
        and account.get("hacker_profile")
    )
    demo_mode = bool(
        (demo_runtime_enabled() or hacker_demo_mode)
        and account.get("demo") is True
        and account.get("account_type") == "demo_test"
        and account.get("role") == "player"
        and (
            account.get("hacker_profile")
            or (
                account.get("username") == DEMO_ACCOUNT_USERNAME
                and account.get("email") == DEMO_ACCOUNT_EMAIL
            )
        )
    )

    session_id = str(uuid.uuid4())

    game_token = secrets.token_urlsafe(32)

    now = utc_now()

    game_session = {
        "session_id": session_id,
        "game_token": game_token,
        "user_id": user_id,
        "game": "FPS_Microgame",
        "started_at": now,
        "ended_at": None,
        "expires_at": now + timedelta(hours=2),
        "status": "active",
        "demo_mode": demo_mode,
        "event_count": 0
    }
    if demo_mode:
        game_session["demo_label"] = "demo_cheater"

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

    return jsonify({
        "success": True,
        "session_id": session_id,
        "game_token": game_token,
        "game": "FPS_Microgame",
        "demo_mode": demo_mode
    }), 201


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
def receive_game_event():

    data = request.get_json(silent=True) or {}

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

    safe_print()
    safe_print("========== UNITY TELEMETRY ==========")
    safe_print("Session:", session_id)
    safe_print("Event:", event_type)
    safe_print("Game:", game_name)
    safe_print("Telemetry:", telemetry)
    safe_print("=====================================")

    # -----------------------------------------------------
    # VALIDATION
    # -----------------------------------------------------

    if not game_token:

        safe_print("[SecureFPS] ERROR: Game token missing.")

        return jsonify({
            "message": "Game token is required."
        }), 400

    if not session_id:

        safe_print("[SecureFPS] ERROR: Session ID missing.")

        return jsonify({
            "message": "Session ID is required."
        }), 400

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

    # -----------------------------------------------------
    # CHECK STATUS
    # -----------------------------------------------------

    if game_session.get("status") != "active":

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
        "demo": game_session.get("demo_mode") is True,
        "demo_label": (
            "demo_cheater"
            if game_session.get("demo_mode") is True
            else None
        ),
        "created_at": utc_now()
    }

    try:

        result = game_telemetry.insert_one(
            telemetry_document
        )

    except Exception as exc:

        safe_print(
            "[SecureFPS] MongoDB telemetry error:",
            exc
        )

        return jsonify({
            "message": "Failed to store telemetry."
        }), 500

    safe_print(
        "[SecureFPS] Telemetry stored:",
        result.inserted_id
    )

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
        completion = game_sessions.update_one(
            {
                "session_id": session_id,
                "user_id": user_id,
                "status": "active"
            },
            {
                "$set": {
                    "status": "completed",
                    "ended_at": utc_now()
                }
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
            users.update_one({"_id": user_id}, {"$inc": {"rewards.coins": 20, "rewards.xp": 50}})
            reward_transactions.insert_one({
                "user_id": user_id,
                "type": "match_completed",
                "description": f"Completed an FPS Microgame match; +{honour_awarded} Honour",
                "coins": 20,
                "xp": 50,
                "honour": honour_awarded,
                "honour_before": honour_before,
                "honour_after": int(honour_after.get("honour_score", honour_before)),
                "session_id": session_id,
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
        "event_id": str(result.inserted_id),
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
        and game_session.get("demo_mode") is True
        and account.get("role") == "player"
        and account.get("demo") is True
        and account.get("account_type") == "demo_test"
        and (
            account.get("hacker_profile")
            or (
                account.get("username") == DEMO_ACCOUNT_USERNAME
                and account.get("email") == DEMO_ACCOUNT_EMAIL
            )
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

            result = predict(features)
            model_errors = [
                f"{name}: {value}"
                for name, value in result.items()
                if name.endswith("_status") and value
            ]
            if model_errors:
                raise RuntimeError("; ".join(model_errors))

            status = "success"
            if (
                realtime
                and is_demo
                and account.get("hacker_profile")
                and result.get("random_forest") == "cheater"
                and result.get("isolation_forest") == "anomaly"
                and isinstance(result.get("risk_score"), (int, float))
                and result["risk_score"] <= 90
            ):
                model_score = result["risk_score"]
                result["model_risk_score"] = model_score
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

    severity = gameplay_alert_severity(result, status)
    alert_reason = None
    if severity:
        alert_reason = (
            "Configured gameplay alert conditions met: "
            f"RF={result.get('random_forest')}, "
            f"IF={result.get('isolation_forest')}, "
            f"risk={result.get('risk_score')}/100."
        )

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
        "demo_label": "demo_cheater" if is_demo else None,
        "account_label": "DEMO CHEATER TEST ACCOUNT" if is_demo else None,
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
# END GAME
# =========================================================

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

    session_id = data.get(
        "session_id"
    )

    if not session_id:

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

    # A match is complete only when the gameplay client has already submitted
    # game_completed. Calling this endpoint while active means the player left.
    if game_session.get("status") != "active":
        return jsonify({
            "success": True,
            "status": game_session.get("status"),
            "message": "Match already closed; no additional rewards were issued.",
        }), 200

    now = utc_now()
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
            }
        }
    )

    if not abandonment.modified_count:
        latest = game_sessions.find_one({"session_id": session_id, "user_id": user_id}) or {}
        return jsonify({
            "success": True,
            "status": latest.get("status"),
            "message": "Match already closed; no additional rewards were issued.",
        }), 200

    users.update_one(
        {"_id": user_id, "honour_score": {"$exists": False}},
        {"$set": {"honour_score": 100}},
    )
    honour_before_record = users.find_one({"_id": user_id}, {"honour_score": 1}) or {}
    honour_before = max(0, min(MAX_HONOUR_SCORE, int(honour_before_record.get("honour_score", 100))))
    users.update_one(
        {"_id": user_id},
        {"$inc": {"honour_score": -MATCH_ABANDON_HONOUR_PENALTY}},
    )
    player = users.find_one({"_id": user_id}, {"name": 1, "email": 1, "honour_score": 1}) or {}
    honour_score = max(0, int(player.get("honour_score", 100 - MATCH_ABANDON_HONOUR_PENALTY)))
    if player.get("honour_score", 0) < 0:
        users.update_one({"_id": user_id}, {"$set": {"honour_score": 0}})

    restriction_until = None
    if honour_score < MATCH_ABANDON_RESTRICTION_THRESHOLD:
        restriction_until = now + timedelta(minutes=MATCH_ABANDON_COOLDOWN_MINUTES)
        users.update_one(
            {"_id": user_id},
            {"$set": {"play_restricted_until": restriction_until}},
        )

    security_events.insert_one({
        "type": "match_abandoned",
        "user_id": user_id,
        "session_id": session_id,
        "severity": "medium" if restriction_until else "low",
        "honour_before": honour_before,
        "honour_change": honour_score - honour_before,
        "honour_score": honour_score,
        "restricted_until": restriction_until,
        "review_status": "pending",
        "description": (
            f"{player.get('name') or player.get('email') or 'A player'} left an unfinished match. "
            f"Honour score is now {honour_score}/100."
            + (" Game access is paused for 30 minutes." if restriction_until else "")
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
            "restricted_until": restriction_until.isoformat() if restriction_until else None,
        },
    )

    return jsonify({
        "success": True,
        "status": "abandoned",
        "message": (
            "Unfinished match abandoned. No coins or XP were awarded. "
            f"Honour score: {honour_score}/100."
            + (" Game access is paused for 30 minutes because your Honour score is below 80." if restriction_until else "")
        ),
        "session_id": session_id,
        "honour_score": honour_score,
        "restricted_until": restriction_until.isoformat() if restriction_until else None,
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
    Extract the five active raw features from Unity telemetry.
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
    # ACCURACY
    # =====================================================

    if shots > 0 and enemy_hit_telemetry_seen:

        accuracy = enemy_hits / shots

    else:

        accuracy = None

    if accuracy is not None:

        accuracy = max(
            0.0,
            min(accuracy, 1.0)
        )

    # =====================================================
    # HEADSHOT RATIO (temporarily disabled until telemetry is available)
    # =====================================================
    # if enemy_hits > 0:
    #     headshot_ratio = headshots / enemy_hits
    # else:
    #     headshot_ratio = None
    # if headshot_ratio is not None:
    #     headshot_ratio = max(0.0, min(headshot_ratio, 1.0))

    # =====================================================
    # FIRE RATE
    # =====================================================

    fire_rate = (
        shots / duration
        if shots > 0 and duration is not None and duration > 0
        else None
    )

    # =====================================================
    # MOVEMENT SPEED
    # =====================================================

    if movement_speeds:

        movement_speed = (
            sum(movement_speeds)
            /
            len(movement_speeds)
        )

    else:

        movement_speed = None

    # =====================================================
    # AIM SMOOTHNESS
    # =====================================================

    if aim_changes:

        average_aim_change = (
            sum(aim_changes)
            /
            len(aim_changes)
        )

        aim_smoothness = (
            1.0
            /
            (
                1.0
                +
                average_aim_change
            )
        )

    else:

        aim_smoothness = None

    # =====================================================
    # KDR
    # =====================================================

    if deaths > 0:

        kdr = kills / deaths

    else:

        kdr = (
            float(kills)
            if kills > 0
            else None
        )

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

@game_bp.get("/admin/support/tickets")
def admin_support_tickets():
    if not is_admin():
        return jsonify({"message": "Admin access required."}), 403
    tickets = list(support_tickets.find().sort("created_at", -1).limit(100))
    return jsonify({"tickets": [{
        "id": str(ticket["_id"]),
        "player_name": ticket.get("player_name", "Player"),
        "player_email": ticket.get("player_email", ""),
        "category": ticket.get("category", "other"),
        "message": ticket.get("message", ""),
        "status": ticket.get("status", "open"),
        "admin_reply": ticket.get("admin_reply", ""),
        "attachment": {"name": ticket["attachment"].get("name"), "mime_type": ticket["attachment"].get("mime_type")} if ticket.get("attachment") else None,
        "created_at": ticket["created_at"].isoformat() if ticket.get("created_at") else None,
    } for ticket in tickets]})


@game_bp.get("/admin/support/tickets/<ticket_id>/attachment")
def admin_support_attachment(ticket_id):
    if not is_admin():
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
    if not is_admin():
        return jsonify({"message": "Admin access required."}), 403
    try:
        ticket_oid = ObjectId(ticket_id)
    except Exception:
        return jsonify({"message": "Invalid support ticket."}), 400
    reply = str((request.get_json(silent=True) or {}).get("reply", "")).strip()
    if not reply or len(reply) > 3000:
        return jsonify({"message": "Enter a reply up to 3000 characters."}), 400
    result = support_tickets.update_one(
        {"_id": ticket_oid},
        {"$set": {"admin_reply": reply, "status": "answered", "replied_at": utc_now(), "admin_user_id": get_current_user_object_id()}},
    )
    if not result.matched_count:
        return jsonify({"message": "Support ticket not found."}), 404
    ticket = support_tickets.find_one({"_id": ticket_oid}, {"user_id": 1}) or {}
    publish_live_update(ticket.get("user_id"), None, "support_reply", force=True)
    return jsonify({"message": "Reply sent to player."})


@game_bp.post("/admin/support/tickets/<ticket_id>/resolve")
def resolve_support_ticket(ticket_id):
    if not is_admin():
        return jsonify({"message": "Admin access required."}), 403
    try:
        ticket_oid = ObjectId(ticket_id)
    except Exception:
        return jsonify({"message": "Invalid support ticket."}), 400
    result = support_tickets.update_one(
        {"_id": ticket_oid},
        {"$set": {"status": "resolved", "resolved_at": utc_now(), "admin_user_id": get_current_user_object_id()}},
    )
    if not result.matched_count:
        return jsonify({"message": "Support ticket not found."}), 404
    ticket = support_tickets.find_one({"_id": ticket_oid}, {"user_id": 1}) or {}
    publish_live_update(ticket.get("user_id"), None, "support_resolved", force=True)
    return jsonify({"message": "Support ticket marked resolved."})

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
            "access_status": "Paused for 30 minutes" if event.get("restricted_until") else "Available",
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
            {
                "player_id": str(alert.get("user_id", "")),
                "player_name": player_names.get(
                    str(alert.get("user_id", "")),
                    ""
                ),
                "session_id": alert.get("session_id"),
                "risk_score": (
                    hacker_enforcement_score(
                        alert.get("hacker_profile")
                        or player_profiles.get(str(alert.get("user_id", "")))
                        or player_names.get(str(alert.get("user_id", ""))),
                    )
                    if (
                        (
                            alert.get("hacker_profile")
                            or player_profiles.get(str(alert.get("user_id", "")))
                            or player_names.get(str(alert.get("user_id", "")))
                        )
                        and alert.get("risk_score") is not None
                    )
                    else alert.get("risk_score")
                ),
                "model_risk_score": (alert.get("result") or {}).get(
                    "model_risk_score",
                    alert.get("risk_score"),
                ),
                "random_forest": alert.get(
                    "random_forest",
                    (alert.get("result") or {}).get("random_forest")
                ),
                "isolation_forest": alert.get(
                    "isolation_forest",
                    (alert.get("result") or {}).get("isolation_forest")
                ),
                "random_forest_probability": (alert.get("result") or {}).get("random_forest_probability"),
                "isolation_forest_anomaly_score": (alert.get("result") or {}).get("isolation_forest_anomaly_score"),
                "severity": (
                    "critical"
                    if alert.get("type") == "auto_ban"
                    else alert.get("severity", "medium")
                ),
                "created_at": (
                    alert["created_at"].isoformat()
                    if alert.get("created_at")
                    else None
                ),
                "review_status": (
                    "permanently_banned"
                    if (
                        alert.get("type") == "auto_ban"
                        or player_statuses.get(str(alert.get("user_id", ""))) == "banned"
                    )
                    else alert.get("review_status", "pending")
                ),
                "demo": bool(
                    alert.get("demo")
                    or alert.get("type") == "auto_ban"
                    or alert.get("hacker_profile")
                    or player_profiles.get(str(alert.get("user_id", "")))
                ),
                "account_label": alert.get("account_label"),
                "alert_reason": alert.get("alert_reason"),
                "enforcement_action": alert.get("enforcement_action"),
                "enforcement_state": alert.get("enforcement_state"),
                "hacker_profile": alert.get("hacker_profile")
                or player_profiles.get(str(alert.get("user_id", ""))),
                "top_reasons": alert.get("reasons", []),
                "detection_reason": (
                    hacker_detection_reason(
                        alert.get("hacker_profile")
                        or player_profiles.get(str(alert.get("user_id", "")))
                    )
                    if (
                        alert.get("hacker_profile")
                        or player_profiles.get(str(alert.get("user_id", "")))
                    )
                    else (alert.get("reasons") or [None])[0]
                ),
                "permanent_ban": bool(
                    alert.get("type") == "auto_ban"
                    or (
                        player_profiles.get(str(alert.get("user_id", "")))
                        and player_statuses.get(str(alert.get("user_id", ""))) == "banned"
                    )
                ),
                "banned_at": (
                    alert["banned_at"].isoformat()
                    if alert.get("banned_at")
                    else None
                )
            }
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

    return jsonify({
        "players": [{
            "id": str(player["_id"]),
            "name": player.get("name", "Player"),
            "email": player.get("email", ""),
            "role": player.get("role", "player"),
            "mfa_enabled": player.get("mfa_enabled", False),
            "account_type": player.get("account_type"),
            "matches_played": game_sessions.count_documents({"user_id": player["_id"]}),
            "risk_score": player.get("risk_score"),
            "last_login_ip": player.get("last_login_ip", "No login recorded"),
            "last_login": _admin_date(player.get("last_login")),
            "created_at": _admin_date(player.get("created_at")),
            "account_status": player.get("account_status") or ("suspended" if player.get("revoked") else "active"),
            "demo": player.get("demo", False),
        } for player in player_records],
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
    if not reviewer:
        return jsonify({"message": "Admin access required."}), 403

    payload = request.get_json(silent=True) or {}
    action = str(payload.get("action", "")).strip().lower()
    note = str(payload.get("note", "")).strip()
    allowed_actions = {
        "approve": "reviewed",
        "warn": "warned",
        "suspend": "suspended",
        "ban": "banned",
    }
    if action not in allowed_actions:
        return jsonify({"message": "Unsupported review action."}), 400
    if not note:
        return jsonify({"message": "A review note is required."}), 400
    if reviewer.get("role") == "moderator" and action in {"suspend", "ban"}:
        return jsonify({"message": "Moderators cannot suspend or ban accounts."}), 403
    ban_duration = str(payload.get("ban_duration", "")).strip().lower()
    if action == "ban" and ban_duration not in {"24h", "7d", "permanent"}:
        return jsonify({"message": "Choose a 24-hour, 7-day, or permanent ban."}), 400

    alert = security_events.find_one({
        "type": "gameplay_anomaly",
        "session_id": session_id,
    })
    if not alert:
        return jsonify({"message": "Gameplay alert not found."}), 404

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
    if action == "ban":
        review_fields["ban_duration"] = ban_duration
    security_events.update_many(
        {"type": "gameplay_anomaly", "session_id": session_id},
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
        users.update_one(
            {"_id": alert.get("user_id")},
            {"$set": account_update, "$unset": {"active_auth_session_id": "", **({"ban_until": ""} if action == "suspend" or ban_duration == "permanent" else {})}}
        )
        sessions_db.update_many(
            {"user_id": alert.get("user_id"), "is_active": True},
            {"$set": {"is_active": False, "last_activity": reviewed_at}},
        )

    security_events.insert_one({
        "type": "gameplay_alert_review",
        "action": action,
        "note": note,
        "alert_id": alert["_id"],
        "session_id": session_id,
        "user_id": alert.get("user_id"),
        "actor_user_id": reviewer_id,
        "ban_duration": ban_duration if action == "ban" else None,
        "ban_until": ban_until if action == "ban" else None,
        "created_at": reviewed_at,
    })
    return jsonify({"success": True, "review_status": status}), 200


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
