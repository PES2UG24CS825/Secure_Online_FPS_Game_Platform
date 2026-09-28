from datetime import datetime, timezone, timedelta
import secrets
import uuid

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
        "status": "active"
    }

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
        "game": "FPS_Microgame"
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
            "message": "Game session is not active."
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
    #
    # When Unity sends game_completed,
    # automatically extract features and run:
    #
    # Random Forest
    # Isolation Forest
    #
    # -----------------------------------------------------

    analysis = None

    if event_type == "game_completed":

        print()
        print(
            "[SecureFPS] Game completed."
        )

        print(
            "[SecureFPS] Starting automatic ML analysis..."
        )

        analysis = analyze_game_session(
            user_id,
            session_id
        )

        # Mark session completed after analysis
        game_sessions.update_one(
            {
                "session_id": session_id
            },
            {
                "$set": {
                    "status": "completed",
                    "ended_at": utc_now()
                }
            }
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

    if analysis:

        response["analysis"] = analysis

    return jsonify(response), 201


# =========================================================
# ANALYZE GAME SESSION
# =========================================================

def analyze_game_session(
    user_id,
    session_id
):
    """
    Extract gameplay features and run all
    currently available ML models.
    """

    print()
    print("==========================================")
    print("[SecureFPS] ANALYZING GAME SESSION")
    print("Session:", session_id)
    print("==========================================")

    features = extract_features(
        user_id,
        session_id
    )

    if features is None:

        print(
            "[SecureFPS] Insufficient telemetry."
        )

        return {
            "status": "insufficient_data",
            "features": {},
            "result": {}
        }

    missing_features = [
        feature
        for feature in FEATURES
        if features.get(feature) is None
    ]

    if missing_features:

        print(
            "[SecureFPS] Missing measurable gameplay features:",
            missing_features
        )

        return {
            "status": "incomplete_features",
            "features": features,
            "missing_features": missing_features,
            "result": {}
        }

    # -----------------------------------------------------
    # RUN ML MODELS
    # -----------------------------------------------------

    try:

        result = predict(features)

    except Exception as exc:

        print(
            "[SecureFPS] ML prediction error:",
            exc
        )

        return {
            "status": "ml_error",
            "features": features,
            "result": {},
            "error": str(exc)
        }

    # -----------------------------------------------------
    # PRINT MODEL RESULTS
    # -----------------------------------------------------

    print()
    print("========== ML RESULT ==========")
    print("Features:")

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

        "features": {
            key: float(features[key])
            for key in FEATURES
        },

        "result": result,

        "created_at": utc_now()
    }

    try:

        game_events.insert_one(
            detection_event
        )

    except Exception as exc:

        print(
            "[SecureFPS] Failed to store ML result:",
            exc
        )

    # -----------------------------------------------------
    # SECURITY ALERT
    # -----------------------------------------------------

    rf_cheater = (
        result.get("random_forest")
        == "cheater"
    )

    isolation_anomaly = (
        result.get("isolation_forest")
        == "anomaly"
    )

    if rf_cheater or isolation_anomaly:

        severity = "high"

        if (
            not rf_cheater
            and isolation_anomaly
        ):

            severity = "medium"

        security_event = {
            "user_id": user_id,
            "session_id": session_id,
            "type": "gameplay_anomaly",
            "severity": severity,
            "result": result,
            "features": features,
            "created_at": utc_now()
        }

        try:

            security_events.insert_one(
                security_event
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
        "status": "success",
        "features": features,
        "result": result
    }


# =========================================================
# END GAME
# =========================================================
#
# This endpoint is useful if dashboard explicitly
# ends the game.
#
# POST /api/game/end
#
# {
#     "session_id": "..."
# }
#
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

    # -----------------------------------------------------
    # ANALYZE FIRST
    # -----------------------------------------------------

    analysis = analyze_game_session(
        user_id,
        session_id
    )

    # -----------------------------------------------------
    # MARK SESSION COMPLETE
    # -----------------------------------------------------

    game_sessions.update_one(
        {
            "session_id": session_id,
            "user_id": user_id
        },
        {
            "$set": {
                "ended_at": utc_now(),
                "status": "completed"
            }
        }
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
    session_id
):
    """
    Convert raw Unity telemetry into the same
    seven features expected by the ML models.
    """

    events = list(
        game_telemetry.find({
            "user_id": user_id,
            "session_id": session_id
        }).sort(
            "created_at",
            1
        )
    )

    if not events:

        return None

    # -----------------------------------------------------
    # COUNTERS
    # -----------------------------------------------------

    shots = 0
    enemy_hits = 0
    legacy_player_hits = 0
    has_enemy_hit_events = False
    kills = 0
    deaths = 0
    headshots = 0

    movement_speeds = []
    aim_changes = []
    reaction_times = []

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

        # -------------------------------------------------
        # WEAPON FIRE
        # -------------------------------------------------

        if event_type == "weapon_fire":

            shots += 1

        # -------------------------------------------------
        # CONFIRMED ENEMY HIT
        # -------------------------------------------------

        elif event_type == "enemy_hit":

            enemy_hits += 1
            has_enemy_hit_events = True

        # -------------------------------------------------
        # LEGACY HIT FALLBACK
        # -------------------------------------------------

        elif event_type == "player_hit":

            legacy_player_hits += 1

        # -------------------------------------------------
        # ENEMY KILLED
        # -------------------------------------------------

        elif event_type == "enemy_killed":

            kills += 1

        # -------------------------------------------------
        # PLAYER DEATH
        # -------------------------------------------------

        elif event_type == "player_death":

            deaths += 1

        # -------------------------------------------------
        # HEADSHOT
        # -------------------------------------------------

        elif event_type == "headshot":

            headshots += 1

        # -------------------------------------------------
        # MOVEMENT
        # -------------------------------------------------

        elif event_type == "player_behavior":

            speed = telemetry.get(
                "speed"
            )

            if speed is not None:

                try:

                    movement_speeds.append(
                        float(speed)
                    )

                except (
                    TypeError,
                    ValueError
                ):

                    pass

        # -------------------------------------------------
        # AIM
        # -------------------------------------------------

        elif event_type == "aim_behavior":

            rotation_change = telemetry.get(
                "rotation_change"
            )

            if rotation_change is not None:

                try:

                    aim_changes.append(
                        float(rotation_change)
                    )

                except (
                    TypeError,
                    ValueError
                ):

                    pass

        # -------------------------------------------------
        # REACTION TIME
        # -------------------------------------------------

        reaction_time = telemetry.get(
            "reaction_time"
        )

        if reaction_time is not None:

            try:

                value = float(
                    reaction_time
                )

                if value > 0:

                    reaction_times.append(
                        value
                    )

            except (
                TypeError,
                ValueError
            ):

                pass

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

        duration = 1.0

    # =====================================================
    # ACCURACY
    # =====================================================

    hits = (
        enemy_hits
        if has_enemy_hit_events
        else legacy_player_hits
    )

    if shots > 0:

        accuracy = hits / shots

    else:

        accuracy = None

    if accuracy is not None:
        accuracy = max(0.0, min(accuracy, 1.0))

    # =====================================================
    # HEADSHOT RATIO
    # =====================================================

    if hits > 0 and headshots > 0:

        headshot_ratio = (
            headshots / hits
        )

    else:

        headshot_ratio = None

    if headshot_ratio is not None:
        headshot_ratio = max(0.0, min(headshot_ratio, 1.0))

    # =====================================================
    # FIRE RATE
    # =====================================================

    fire_rate = (
        shots / duration
        if duration > 0
        else 0.0
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
                abs(
                    average_aim_change
                )
            )
        )

    else:

        # Neutral fallback when Unity
        # has not sent aim telemetry.
        aim_smoothness = None

    if aim_smoothness is not None:
        aim_smoothness = max(0.0, min(aim_smoothness, 1.0))

    # =====================================================
    # KDR
    # =====================================================

    if deaths > 0:

        kdr = kills / deaths

    else:

        kdr = float(kills)

    # =====================================================
    # REACTION TIME
    # =====================================================

    if reaction_times:

        reaction_time = (
            sum(reaction_times)
            /
            len(reaction_times)
        )

    else:

            reaction_time = None

    # =====================================================
    # FINAL FEATURES
    # =====================================================

    features = {

        "reaction_time":
            float(reaction_time) if reaction_time is not None else None,

        "accuracy":
            float(accuracy) if accuracy is not None else None,

        "headshot_ratio":
            float(headshot_ratio) if headshot_ratio is not None else None,

        "fire_rate":
            float(fire_rate),

        "movement_speed":
            float(movement_speed) if movement_speed is not None else None,

        "aim_smoothness":
            float(aim_smoothness) if aim_smoothness is not None else None,

        "kdr":
            float(kdr)
    }

    # -----------------------------------------------------
    # VERIFY FEATURES MATCH ML MODEL
    # -----------------------------------------------------

    missing = [
        feature
        for feature in FEATURES
        if feature not in features
    ]

    if missing:

        print(
            "[SecureFPS] Missing ML features:",
            missing
        )

        return None

    print()
    print("========== EXTRACTED FEATURES ==========")

    for name in FEATURES:

        print(
            f"{name}: {features[name]}"
        )

    print("=========================================")
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

    features = data.get(
        "features",
        {}
    )

    # -----------------------------------------------------
    # REQUIRED FEATURES
    # -----------------------------------------------------

    missing = [
        name
        for name in FEATURES
        if name not in features
    ]

    if missing:

        return jsonify({
            "message":
                "Missing features: "
                + ", ".join(missing)
        }), 400

    # -----------------------------------------------------
    # CONVERT FEATURES TO FLOAT
    # -----------------------------------------------------

    try:

        clean_features = {
            name: float(features[name])
            for name in FEATURES
        }

    except (
        TypeError,
        ValueError
    ) as exc:

        return jsonify({
            "message":
                f"Invalid feature values: {exc}"
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

    # -----------------------------------------------------
    # STORE DETECTION
    # -----------------------------------------------------

    event = {
        "user_id": user_id,
        "features": clean_features,
        "result": result,
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

    rf_cheater = (
        result.get("random_forest")
        == "cheater"
    )

    isolation_anomaly = (
        result.get("isolation_forest")
        == "anomaly"
    )

    if rf_cheater or isolation_anomaly:

        severity = "high"

        if (
            not rf_cheater
            and isolation_anomaly
        ):

            severity = "medium"

        try:

            security_events.insert_one({
                "user_id": user_id,
                "type": "gameplay_anomaly",
                "severity": severity,
                "result": result,
                "features": clean_features,
                "created_at": utc_now()
            })

        except Exception as exc:

            print(
                "[SecureFPS] Security event error:",
                exc
            )

    return jsonify({
        "success": True,
        "result": result,
        "features": clean_features
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

        "recent_detections": [

            {
                "rf":
                    item.get(
                        "result",
                        {}
                    ).get(
                        "random_forest"
                    ),

                "if":
                    item.get(
                        "result",
                        {}
                    ).get(
                        "isolation_forest"
                    ),

                "risk_score":
                    item.get(
                        "result",
                        {}
                    ).get(
                        "risk_score"
                    ),

                "created_at":
                    item.get(
                        "created_at"
                    ).isoformat()
            }

            for item in recent

            if item.get(
                "created_at"
            )
        ],

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
            "delete"
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