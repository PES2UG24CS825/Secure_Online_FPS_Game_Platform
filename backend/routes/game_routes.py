from datetime import datetime, timezone, timedelta
import os
import secrets
import uuid
import math

from flask import Blueprint, jsonify, request, session
from bson import ObjectId

from database.db import (
    game_events,
    game_telemetry,
    game_sessions,
    security_events,
    users,
)

from models.ml_model import predict, FEATURES


game_bp = Blueprint(
    "game",
    __name__,
    url_prefix="/api"
)


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
    user_id = get_current_user_object_id()

    if not user_id:
        return False

    return bool(
        users.find_one({
            "_id": user_id,
            "role": "admin"
        })
    )


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

    demo_mode = bool(
        demo_runtime_enabled()
        and account.get("demo") is True
        and account.get("account_type") == "demo_test"
        and account.get("username") == DEMO_ACCOUNT_USERNAME
        and account.get("email") == DEMO_ACCOUNT_EMAIL
        and account.get("role") == "player"
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

        print(
            "[SecureFPS] Failed to create game session:",
            exc
        )

        return jsonify({
            "message": "Could not create game session."
        }), 500

    print()
    print("==========================================")
    print("[SecureFPS] GAME SESSION CREATED")
    print("User ID:", user_id)
    print("Session ID:", session_id)
    print("Game token received:", bool(game_token))
    print("==========================================")
    print()

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

    print()
    print("========== UNITY TELEMETRY ==========")
    print("Session:", session_id)
    print("Event:", event_type)
    print("Game:", game_name)
    print("Telemetry:", telemetry)
    print("=====================================")

    # -----------------------------------------------------
    # VALIDATION
    # -----------------------------------------------------

    if not game_token:

        print("[SecureFPS] ERROR: Game token missing.")

        return jsonify({
            "message": "Game token is required."
        }), 400

    if not session_id:

        print("[SecureFPS] ERROR: Session ID missing.")

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

        print(
            "[SecureFPS] ERROR: Invalid session/token."
        )

        return jsonify({
            "message": "Invalid game session."
        }), 403

    # -----------------------------------------------------
    # CHECK STATUS
    # -----------------------------------------------------

    if game_session.get("status") != "active":

        print(
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

        print(
            "[SecureFPS] MongoDB telemetry error:",
            exc
        )

        return jsonify({
            "message": "Failed to store telemetry."
        }), 500

    print(
        "[SecureFPS] Telemetry stored:",
        result.inserted_id
    )

    # -----------------------------------------------------
    # AUTOMATIC ML ANALYSIS
    # -----------------------------------------------------

    analysis = None
    realtime_detection = None

    if (
        event_type != "game_completed"
        and game_session.get("demo_mode") is True
        and demo_runtime_enabled()
    ):
        demo_account = users.find_one({
            "_id": user_id,
            "role": "player",
            "demo": True,
            "account_type": "demo_test",
            "username": DEMO_ACCOUNT_USERNAME,
            "email": DEMO_ACCOUNT_EMAIL
        })
        if demo_account:
            game_sessions.update_one(
                {
                    "session_id": session_id,
                    "user_id": user_id,
                    "status": "active",
                    "demo_mode": True
                },
                {"$inc": {"event_count": 1}}
            )
            current_game_session = game_sessions.find_one({
                "session_id": session_id,
                "user_id": user_id,
                "status": "active",
                "demo_mode": True
            })
            min_events = demo_int_setting("DEMO_REALTIME_MIN_EVENTS", 24)
            window_size = demo_int_setting("DEMO_REALTIME_WINDOW_EVENTS", 100)
            interval = demo_float_setting("DEMO_REALTIME_EVAL_INTERVAL_SECONDS", 0.25)

            if (
                current_game_session
                and current_game_session.get("event_count", 0) >= min_events
                and demo_window_has_stable_samples(user_id, session_id, window_size)
            ):
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
                last_evaluation = current_game_session.get("last_realtime_analysis_at")
                if last_evaluation and last_evaluation.tzinfo is None:
                    last_evaluation = last_evaluation.replace(tzinfo=timezone.utc)
                elapsed = (
                    (utc_now() - last_evaluation).total_seconds()
                    if last_evaluation
                    else interval
                )

                if not window_missing and elapsed >= interval:
                    claim_time = utc_now()
                    last_allowed = claim_time - timedelta(seconds=interval)
                    claim = game_sessions.update_one(
                        {
                            "session_id": session_id,
                            "user_id": user_id,
                            "status": "active",
                            "demo_mode": True,
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
                            "random_forest_status": (analysis.get("result") or {}).get("random_forest_status"),
                            "isolation_forest_status": (analysis.get("result") or {}).get("isolation_forest_status"),
                            "risk_score": analysis.get("risk_score"),
                            "alert_triggered": bool(analysis.get("alert_severity")),
                            "alert_severity": analysis.get("alert_severity"),
                            "enforcement_state": analysis.get("enforcement_state", "monitoring"),
                            "enforcement_action": analysis.get("enforcement_action", "none")
                        }

    if event_type == "game_completed":

        print()
        print(
            "[SecureFPS] Game completed."
        )

        print(
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
            and demo_runtime_enabled()
        )

    if analysis:

        response["analysis"] = analysis

    if realtime_detection:
        response["realtime_detection"] = realtime_detection

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

    print()
    print("==========================================")
    print("[SecureFPS] ANALYZING GAME SESSION")
    print("Session:", session_id)
    print("==========================================")

    raw_features = extract_features(
        user_id,
        session_id,
        max_events=max_events
    )

    game_session = game_sessions.find_one({
        "session_id": session_id,
        "user_id": user_id
    }) or {}
    is_demo = bool(
        demo_runtime_enabled()
        and game_session.get("demo_mode") is True
        and users.find_one({
            "_id": user_id,
            "role": "player",
            "demo": True,
            "account_type": "demo_test",
            "username": DEMO_ACCOUNT_USERNAME,
            "email": DEMO_ACCOUNT_EMAIL
        })
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
        print(
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

        except Exception as exc:
            print(
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
    if realtime and is_demo and severity == "high":
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

    print()
    print("========== RAW FEATURES ==========")

    for name, value in raw_features.items():

        print(
            f"  {name}: {value}"
        )

    print()
    print("========== NORMALIZED FEATURES ==========")

    for name, value in features.items():

        print(
            f"  {name}: {value}"
        )

    print()
    print("Random Forest:",
          result.get("random_forest"))

    print("Isolation Forest:",
          result.get("isolation_forest"))

    print("Risk Score:",
          result.get("risk_score"))

    print("===============================")
    print()

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

        print(
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

            print(
                "[SecureFPS] SECURITY ALERT CREATED:",
                severity
            )

        except Exception as exc:

            print(
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

    # -----------------------------------------------------
    # DON'T ANALYZE AN ALREADY COMPLETED SESSION AGAIN
    # -----------------------------------------------------

    already_completed = (
        game_session.get("status")
        == "completed"
    )

    if already_completed:

        return jsonify({
            "success": True,
            "message": "Game session already completed."
        }), 200

    # Claim completion atomically so this endpoint cannot compete with
    # game_completed to trigger the same session analysis.
    completion = game_sessions.update_one(
        {
            "session_id": session_id,
            "user_id": user_id,
            "status": "active"
        },
        {
            "$set": {
                "ended_at": utc_now(),
                "status": "completed"
            }
        }
    )

    if not completion.modified_count:
        return jsonify({
            "success": True,
            "message": "Game session already completed."
        }), 200

    analysis = analyze_game_session(
        user_id,
        session_id
    )

    return jsonify({
        "success": True,
        "session_id": session_id,
        "analysis": analysis
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

        print(
            "[SecureFPS] Missing ML feature definitions:",
            missing
        )

        return None

    print()
    print("========== EXTRACTED RAW FEATURES ==========")

    for name in FEATURES:

        print(
            f"{name}: {features[name]}"
        )

    print("============================================")
    print()

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

        print(
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

        print(
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

            print(
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

@game_bp.get("/admin/overview")
def admin_overview():

    if not is_admin():

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
            {"type": "gameplay_anomaly"},
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
                "demo": 1,
                "account_label": 1,
                "alert_reason": 1,
                "enforcement_action": 1,
                "enforcement_state": 1
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
                "demo": player.get("demo", False),
                "demo_label": player.get("demo_label"),
                "demo_restriction_status": player.get("demo_restriction_status"),

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
                    )
            }

            for event in events
        ],

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
                "risk_score": alert.get("risk_score"),
                "random_forest": alert.get(
                    "random_forest",
                    (alert.get("result") or {}).get("random_forest")
                ),
                "isolation_forest": alert.get(
                    "isolation_forest",
                    (alert.get("result") or {}).get("isolation_forest")
                ),
                "severity": alert.get("severity", "medium"),
                "created_at": (
                    alert["created_at"].isoformat()
                    if alert.get("created_at")
                    else None
                ),
                "review_status": alert.get("review_status", "pending"),
                "demo": alert.get("demo", False),
                "account_label": alert.get("account_label"),
                "alert_reason": alert.get("alert_reason"),
                "enforcement_action": alert.get("enforcement_action"),
                "enforcement_state": alert.get("enforcement_state")
            }
            for alert in gameplay_alerts
        ],

        "demo_account": demo_account_status,

        "login_count":
            0
    })


# =========================================================
# ADMIN PLAYER ACTION
# =========================================================

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
            "delete",
            "confirm-demo-alert",
            "clear-demo-restriction"
        }
    ):

        return jsonify({
            "message":
                "Admin access required."
        }), 403

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

        users.delete_one({
            "_id": oid,
            "role": {
                "$ne": "admin"
            }
        })

    else:

        users.update_one(
            {
                "_id": oid,
                "role": {
                    "$ne": "admin"
                }
            },
            {
                "$set": {
                    "revoked": True
                }
            }
        )

    return jsonify({
        "message":
            f"Player {action} complete."
    }), 200
