"""
Telemetry Schema, Range, and Rate-Limit Validation for SecureFPS.
Validates all v1 and v2 telemetry events from Unity and WebGL Arena clients.
"""

import math
import time
from collections import defaultdict, deque
from typing import Tuple, Optional, Dict, Any

# Sliding window rate limiters: session_id -> deque of timestamps
_SESSION_EVENT_WINDOWS = defaultdict(deque)
_SESSION_AIM_WINDOWS = defaultdict(deque)
_WINDOW_SIZE_SECONDS = 1.0

MAX_EVENTS_PER_SECOND = 60
MAX_AIM_SAMPLES_PER_SECOND = 25

VALID_BODY_PARTS = {"head", "body", "limb"}
KNOWN_EVENT_TYPES = {
    "game_started",
    "player_behavior",
    "aim_behavior",
    "aim_sample",
    "target_acquired",
    "weapon_fire",
    "enemy_hit",
    "hit_detail",
    "enemy_killed",
    "player_death",
    "game_completed",
    "enemy_spawned",
    "player_hit",
    "headshot",
}


def check_rate_limit(session_id: str, event_type: str, now: Optional[float] = None) -> Tuple[bool, Optional[str]]:
    """
    Check if the event exceeds the rate limit for the session.
    Returns (allowed, error_message).
    """
    if now is None:
        now = time.monotonic()

    # Clean up old timestamps from event window
    ev_deque = _SESSION_EVENT_WINDOWS[session_id]
    cutoff = now - _WINDOW_SIZE_SECONDS
    while ev_deque and ev_deque[0] < cutoff:
        ev_deque.popleft()

    if len(ev_deque) >= MAX_EVENTS_PER_SECOND:
        return False, f"Total event rate limit exceeded ({MAX_EVENTS_PER_SECOND}/s)"
    ev_deque.append(now)

    # Aim sample specific rate limit
    if event_type == "aim_sample":
        aim_deque = _SESSION_AIM_WINDOWS[session_id]
        while aim_deque and aim_deque[0] < cutoff:
            aim_deque.popleft()
        if len(aim_deque) >= MAX_AIM_SAMPLES_PER_SECOND:
            return False, f"Aim sample rate limit exceeded ({MAX_AIM_SAMPLES_PER_SECOND}/s)"
        aim_deque.append(now)

    return True, None


def validate_telemetry_event(event_type: str, telemetry: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
    """
    Validate telemetry schema, types, and acceptable ranges.
    Returns (is_valid, error_reason).
    """
    if not isinstance(telemetry, dict):
        return False, "Telemetry payload must be a JSON dictionary"

    # Sequence number validation if present
    seq = telemetry.get("seq")
    if seq is not None:
        if not isinstance(seq, (int, float)) or int(seq) != seq or seq < 0:
            return False, "Field 'seq' must be a non-negative integer"

    # Timestamp validation if present
    ts = telemetry.get("timestamp")
    if ts is not None:
        if not isinstance(ts, (int, float)) or not math.isfinite(ts) or ts < 0:
            return False, "Field 'timestamp' must be a non-negative finite number"

    # Per-event schema and range validation
    if event_type == "aim_sample":
        ang_vel = telemetry.get("angular_velocity_deg_s")
        if ang_vel is None or not isinstance(ang_vel, (int, float)) or not math.isfinite(ang_vel):
            return False, "Field 'angular_velocity_deg_s' is required and must be a finite number"
        if ang_vel < 0 or ang_vel > 36000:
            return False, f"angular_velocity_deg_s {ang_vel} out of valid range [0, 36000]"

        yaw = telemetry.get("yaw")
        if yaw is None or not isinstance(yaw, (int, float)) or not math.isfinite(yaw):
            return False, "Field 'yaw' is required and must be a finite number (degrees)"

        pitch = telemetry.get("pitch")
        if pitch is None or not isinstance(pitch, (int, float)) or not math.isfinite(pitch):
            return False, "Field 'pitch' is required and must be a finite number (degrees)"
        if pitch < -180 or pitch > 180:
            return False, f"pitch {pitch} out of valid range [-180, 180]"

    elif event_type == "target_acquired":
        enemy_id = telemetry.get("enemy_id")
        if not enemy_id or not isinstance(enemy_id, str):
            return False, "Field 'enemy_id' is required and must be a non-empty string"

        distance = telemetry.get("distance")
        if distance is None or not isinstance(distance, (int, float)) or not math.isfinite(distance):
            return False, "Field 'distance' is required and must be a finite number"
        if distance < 0 or distance > 10000:
            return False, f"distance {distance} out of range [0, 10000]"

        visible = telemetry.get("visible_through_wall")
        if visible is None or not isinstance(visible, bool):
            return False, "Field 'visible_through_wall' is required and must be a boolean"

    elif event_type == "weapon_fire":
        aim_error = telemetry.get("aim_error_deg")
        if aim_error is not None:
            if not isinstance(aim_error, (int, float)) or not math.isfinite(aim_error):
                return False, "Field 'aim_error_deg' must be null or a finite number"
            if aim_error < 0 or aim_error > 180:
                return False, f"aim_error_deg {aim_error} out of valid angle range [0, 180]"

        target_id = telemetry.get("target_id")
        if target_id is not None and not isinstance(target_id, str):
            return False, "Field 'target_id' must be null or a string"

    elif event_type == "hit_detail":
        target_id = telemetry.get("target_id")
        if not target_id or not isinstance(target_id, str):
            return False, "Field 'target_id' is required and must be a string"

        body_part = telemetry.get("body_part")
        if not body_part or body_part not in VALID_BODY_PARTS:
            return False, f"Field 'body_part' must be one of {VALID_BODY_PARTS}"

        dist = telemetry.get("distance")
        if dist is None or not isinstance(dist, (int, float)) or not math.isfinite(dist) or dist < 0 or dist > 10000:
            return False, "Field 'distance' must be a valid non-negative number <= 10000"

        dmg = telemetry.get("damage")
        if dmg is None or not isinstance(dmg, (int, float)) or not math.isfinite(dmg) or dmg < 0 or dmg > 1000:
            return False, "Field 'damage' must be a non-negative number <= 1000"

    elif event_type == "player_behavior":
        speed = telemetry.get("speed")
        if speed is not None:
            if not isinstance(speed, (int, float)) or not math.isfinite(speed) or speed < 0 or speed > 1000:
                return False, f"player speed {speed} invalid or outside [0, 1000]"

    elif event_type == "aim_behavior":
        rot = telemetry.get("rotation_change")
        if rot is not None:
            if not isinstance(rot, (int, float)) or not math.isfinite(rot) or rot < 0:
                return False, f"rotation_change {rot} must be non-negative"

    elif event_type == "enemy_hit":
        dmg = telemetry.get("damage")
        if dmg is not None:
            if not isinstance(dmg, (int, float)) or not math.isfinite(dmg) or dmg < 0:
                return False, f"enemy_hit damage {dmg} must be non-negative"

    return True, None


def clear_session_limits(session_id: str):
    """Clean up memory when a session completes."""
    _SESSION_EVENT_WINDOWS.pop(session_id, None)
    _SESSION_AIM_WINDOWS.pop(session_id, None)
