"""
SecureFPS: Unified Feature Extraction v2 (backend/services/features_v2.py)
Shared module used by live analysis, retraining, and dataset generation.
Documented units and strict data sufficiency checks (min 10 shots, 20s duration).
"""

import math
from datetime import datetime
from typing import Dict, List, Any, Optional, Tuple

FEATURE_NAMES_V2 = [
    "accuracy",
    "headshot_ratio",
    "reaction_time_median",
    "reaction_time_min",
    "fire_rate",
    "fire_interval_cv",
    "burst_length_mean",
    "movement_speed_mean",
    "movement_speed_max",
    "movement_speed_std",
    "aim_speed_mean",
    "aim_speed_std",
    "aim_speed_max",
    "flick_rate",
    "aim_error_at_fire_mean",
    "aim_error_at_fire_std",
    "snap_to_hit_ratio",
    "wall_aim_ratio",
    "kdr",
    "time_to_kill_median",
    "shots_per_kill",
]

FEATURE_UNITS_V2: Dict[str, str] = {
    "accuracy": "ratio [0-1]",
    "headshot_ratio": "ratio [0-1]",
    "reaction_time_median": "seconds",
    "reaction_time_min": "seconds",
    "fire_rate": "shots/s",
    "fire_interval_cv": "unitless (std/mean)",
    "burst_length_mean": "shots",
    "movement_speed_mean": "m/s",
    "movement_speed_max": "m/s",
    "movement_speed_std": "m/s",
    "aim_speed_mean": "deg/s",
    "aim_speed_std": "deg/s",
    "aim_speed_max": "deg/s",
    "flick_rate": "flicks/min",
    "aim_error_at_fire_mean": "degrees",
    "aim_error_at_fire_std": "degrees",
    "snap_to_hit_ratio": "ratio [0-1]",
    "wall_aim_ratio": "ratio [0-1]",
    "kdr": "ratio",
    "time_to_kill_median": "seconds",
    "shots_per_kill": "shots/kill",
}

MIN_SHOTS_REQUIRED = 10
MIN_DURATION_SECONDS = 20.0
BURST_GAP_THRESHOLD_SECONDS = 0.45
FLICK_ANGULAR_VELOCITY_THRESHOLD = 400.0  # deg/s
FLICK_TO_HIT_WINDOW_SECONDS = 0.30  # seconds


def _safe_mean(values: List[float], default: Optional[float] = None) -> Optional[float]:
    if not values:
        return default
    return float(sum(values) / len(values))


def _safe_std(values: List[float], default: Optional[float] = 0.0) -> Optional[float]:
    if not values or len(values) < 2:
        return default
    mean = sum(values) / len(values)
    variance = sum((x - mean) ** 2 for x in values) / (len(values) - 1)
    return float(math.sqrt(max(0.0, variance)))


def _safe_median(values: List[float], default: Optional[float] = None) -> Optional[float]:
    if not values:
        return default
    sorted_vals = sorted(values)
    n = len(sorted_vals)
    mid = n // 2
    if n % 2 == 1:
        return float(sorted_vals[mid])
    return float((sorted_vals[mid - 1] + sorted_vals[mid]) / 2.0)


def _get_timestamp(event: Dict[str, Any], session_start_ts: Optional[float] = None) -> float:
    """Extract timestamp in seconds from event dict."""
    telemetry = event.get("telemetry", {})
    if isinstance(telemetry, dict) and "timestamp" in telemetry:
        ts = telemetry["timestamp"]
        if isinstance(ts, (int, float)) and math.isfinite(ts):
            return float(ts)

    if "timestamp" in event:
        ts = event["timestamp"]
        if isinstance(ts, (int, float)) and math.isfinite(ts):
            return float(ts)

    created_at = event.get("created_at")
    if isinstance(created_at, datetime):
        return created_at.timestamp()

    return 0.0


def extract_features_v2(
    events: List[Dict[str, Any]],
    enforce_min_data: bool = True,
    allow_fallback: bool = True,
) -> Tuple[Dict[str, Optional[float]], Dict[str, Any]]:
    """
    Extract Feature Set v2 from raw match events.
    Returns:
        (features_dict, metadata_dict)
    """
    if not events:
        empty_features = {k: None for k in FEATURE_NAMES_V2}
        return empty_features, {
            "has_sufficient_data": False,
            "low_confidence": True,
            "reason": "no_events",
            "is_fallback": False,
        }

    # Normalize events into sorted order
    parsed_events = []
    base_ts = None
    for ev in events:
        t = _get_timestamp(ev)
        if base_ts is None or (t > 0 and t < base_ts):
            base_ts = t
        parsed_events.append((t, ev))

    parsed_events.sort(key=lambda x: x[0])

    # Session duration
    start_time = parsed_events[0][0]
    end_time = parsed_events[-1][0]
    total_duration = max(0.0, end_time - start_time)

    # Accumulators
    shots_times: List[float] = []
    aim_errors_at_fire: List[float] = []
    shots_wall_aim: List[bool] = []
    hits_times: List[float] = []
    hits_body_parts: List[str] = []

    movement_speeds: List[float] = []
    aim_samples: List[Tuple[float, float]] = []  # (time, angular_velocity_deg_s)
    legacy_aim_rotations: List[float] = []

    target_acquisitions: Dict[str, List[Tuple[float, bool]]] = {}  # enemy_id -> list of (ts, visible_through_wall)
    target_hits: Dict[str, List[float]] = {}  # enemy_id -> list of hit timestamps
    kills_data: List[Tuple[float, str]] = []  # (ts, enemy_id)
    deaths_count = 0

    has_v2_aim_samples = False
    has_v2_hit_details = False

    # Process all events
    for ts, ev in parsed_events:
        event_type = ev.get("event_type", "")
        telem = ev.get("telemetry", {})
        if not isinstance(telem, dict):
            telem = {}

        if event_type == "weapon_fire":
            shots_times.append(ts)
            aim_err = telem.get("aim_error_deg")
            if aim_err is not None and isinstance(aim_err, (int, float)) and math.isfinite(aim_err):
                aim_errors_at_fire.append(float(aim_err))

            # Wall aim tracking: check target_id
            target_id = telem.get("target_id")
            is_wall_shot = False
            if target_id and target_id in target_acquisitions:
                # Check most recent acquisition of this target
                acq_list = target_acquisitions[target_id]
                if acq_list and acq_list[-1][1] is True:
                    is_wall_shot = True
            shots_wall_aim.append(is_wall_shot)

        elif event_type == "hit_detail":
            has_v2_hit_details = True
            hits_times.append(ts)
            bp = telem.get("body_part", "body")
            hits_body_parts.append(str(bp))
            tid = telem.get("target_id")
            if tid:
                target_hits.setdefault(str(tid), []).append(ts)

        elif event_type == "enemy_hit":
            # Only record if hit_detail not already logged at identical timestamp
            if not hits_times or abs(hits_times[-1] - ts) > 0.001:
                hits_times.append(ts)
                is_head = bool(telem.get("headshot", False))
                hits_body_parts.append("head" if is_head else "body")
            tid = telem.get("target_id")
            if tid:
                target_hits.setdefault(str(tid), []).append(ts)

        elif event_type == "target_acquired":
            eid = telem.get("enemy_id")
            if eid:
                vis_wall = bool(telem.get("visible_through_wall", False))
                target_acquisitions.setdefault(str(eid), []).append((ts, vis_wall))

        elif event_type == "aim_sample":
            has_v2_aim_samples = True
            ang_vel = telem.get("angular_velocity_deg_s")
            if ang_vel is not None and isinstance(ang_vel, (int, float)) and math.isfinite(ang_vel):
                aim_samples.append((ts, float(ang_vel)))

        elif event_type == "aim_behavior":
            rot = telem.get("rotation_change")
            if rot is not None and isinstance(rot, (int, float)) and math.isfinite(rot):
                legacy_aim_rotations.append(float(rot))

        elif event_type == "player_behavior":
            spd = telem.get("speed")
            if spd is not None and isinstance(spd, (int, float)) and math.isfinite(spd):
                movement_speeds.append(float(spd))

        elif event_type == "enemy_killed":
            enemy_name = telem.get("enemy", f"enemy_{len(kills_data)}")
            kills_data.append((ts, str(enemy_name)))

        elif event_type == "player_death":
            deaths_count += 1

        elif event_type == "headshot":
            if hits_body_parts:
                hits_body_parts[-1] = "head"

    total_shots = len(shots_times)
    total_hits = len(hits_times)
    total_kills = len(kills_data)

    # Data sufficiency check
    is_sufficient = (total_shots >= MIN_SHOTS_REQUIRED) and (total_duration >= MIN_DURATION_SECONDS)
    is_fallback = not (has_v2_aim_samples and (has_v2_hit_details or len(target_acquisitions) > 0))

    if enforce_min_data and not is_sufficient:
        empty_features = {k: None for k in FEATURE_NAMES_V2}
        return empty_features, {
            "has_sufficient_data": False,
            "low_confidence": True,
            "shots": total_shots,
            "duration": round(total_duration, 2),
            "reason": f"Insufficient data: shots={total_shots} (<{MIN_SHOTS_REQUIRED}) or duration={total_duration:.1f}s (<{MIN_DURATION_SECONDS}s)",
            "is_fallback": is_fallback,
        }

    # 1. Accuracy
    accuracy = min(1.0, float(total_hits / max(1, total_shots))) if total_shots > 0 else 0.0

    # 2. Headshot ratio
    headshot_count = sum(1 for bp in hits_body_parts if bp == "head")
    headshot_ratio = float(headshot_count / max(1, total_hits)) if total_hits > 0 else 0.0

    # 3 & 4. Reaction time (target_acquired -> first weapon_fire)
    reaction_times: List[float] = []
    for eid, acqs in target_acquisitions.items():
        for acq_ts, _ in acqs:
            # find first shot at or after acq_ts within 3.0s
            subsequent_shots = [st for st in shots_times if acq_ts <= st <= acq_ts + 3.0]
            if subsequent_shots:
                reaction_times.append(subsequent_shots[0] - acq_ts)

    reaction_time_median = _safe_median(reaction_times, default=None if is_fallback else 0.25)
    reaction_time_min = min(reaction_times) if reaction_times else (None if is_fallback else 0.15)

    # 5. Fire rate (shots per active combat second)
    if len(shots_times) >= 2:
        active_combat_duration = max(1.0, shots_times[-1] - shots_times[0])
        fire_rate = float(total_shots / active_combat_duration)
    elif total_shots == 1:
        fire_rate = 1.0
    else:
        fire_rate = 0.0

    # 6. Fire interval CV (std / mean)
    if len(shots_times) >= 2:
        intervals = [shots_times[i] - shots_times[i - 1] for i in range(1, len(shots_times))]
        mean_int = _safe_mean(intervals, 0.0)
        std_int = _safe_std(intervals, 0.0)
        fire_interval_cv = float(std_int / mean_int) if mean_int and mean_int > 0 else 0.0
    else:
        fire_interval_cv = 0.0

    # 7. Burst length mean
    if shots_times:
        bursts = []
        current_burst = 1
        for i in range(1, len(shots_times)):
            gap = shots_times[i] - shots_times[i - 1]
            if gap <= BURST_GAP_THRESHOLD_SECONDS:
                current_burst += 1
            else:
                bursts.append(current_burst)
                current_burst = 1
        bursts.append(current_burst)
        burst_length_mean = _safe_mean(bursts, 1.0)
    else:
        burst_length_mean = 0.0

    # 8, 9, 10. Movement speed mean, max, std
    movement_speed_mean = _safe_mean(movement_speeds, 0.0)
    movement_speed_max = max(movement_speeds) if movement_speeds else 0.0
    movement_speed_std = _safe_std(movement_speeds, 0.0)

    # 11, 12, 13. Aim speed mean, std, max
    if aim_samples:
        ang_velocities = [vel for _, vel in aim_samples]
        aim_speed_mean = _safe_mean(ang_velocities, 0.0)
        aim_speed_std = _safe_std(ang_velocities, 0.0)
        aim_speed_max = max(ang_velocities) if ang_velocities else 0.0
    elif legacy_aim_rotations:
        # Fallback from rotation change (assumed degrees or radians)
        deg_rotations = [r * (180.0 / math.pi) if r < 6.28 else r for r in legacy_aim_rotations]
        sim_ang_vels = [deg / 0.5 for deg in deg_rotations]
        aim_speed_mean = _safe_mean(sim_ang_vels, 0.0)
        aim_speed_std = _safe_std(sim_ang_vels, 0.0)
        aim_speed_max = max(sim_ang_vels) if sim_ang_vels else 0.0
    else:
        aim_speed_mean = None if is_fallback else 0.0
        aim_speed_std = None if is_fallback else 0.0
        aim_speed_max = None if is_fallback else 0.0

    # 14. Flick rate (flicks per minute: ang_vel > 400 deg/s followed by hit within 0.3s)
    # 17. Snap to hit ratio (hits following a flick / hits)
    flicks_count = 0
    flick_hits = 0
    duration_min = max(0.01, total_duration / 60.0)

    if aim_samples and hits_times:
        for t_aim, ang_vel in aim_samples:
            if ang_vel > FLICK_ANGULAR_VELOCITY_THRESHOLD:
                # check if followed by hit within 0.30s
                hits_in_window = [ht for ht in hits_times if t_aim <= ht <= t_aim + FLICK_TO_HIT_WINDOW_SECONDS]
                if hits_in_window:
                    flicks_count += 1
                    flick_hits += len(hits_in_window)
        flick_rate = float(flicks_count / duration_min)
        snap_to_hit_ratio = min(1.0, float(flick_hits / max(1, total_hits)))
    else:
        flick_rate = None if is_fallback else 0.0
        snap_to_hit_ratio = None if is_fallback else 0.0

    # 15, 16. Aim error at fire mean & std
    if aim_errors_at_fire:
        aim_error_at_fire_mean = _safe_mean(aim_errors_at_fire, 0.0)
        aim_error_at_fire_std = _safe_std(aim_errors_at_fire, 0.0)
    else:
        aim_error_at_fire_mean = None if is_fallback else 0.0
        aim_error_at_fire_std = None if is_fallback else 0.0

    # 18. Wall aim ratio (shots at targets behind wall / shots)
    if shots_wall_aim and total_shots > 0:
        wall_aim_ratio = float(sum(1 for w in shots_wall_aim if w) / total_shots)
    else:
        wall_aim_ratio = None if is_fallback else 0.0

    # 19. KDR = kills / max(deaths, 1)
    kdr = float(total_kills / max(1, deaths_count))

    # 20. Time to kill median (first hit on target to enemy kill)
    ttks: List[float] = []
    for tk_ts, eid in kills_data:
        if eid in target_hits and target_hits[eid]:
            prior_hits = [ht for ht in target_hits[eid] if ht <= tk_ts]
            if prior_hits:
                first_hit_ts = prior_hits[0]
                ttks.append(max(0.05, tk_ts - first_hit_ts))
    time_to_kill_median = _safe_median(ttks, default=None if is_fallback else 1.5)

    # 21. Shots per kill
    shots_per_kill = float(total_shots / max(1, total_kills))

    features: Dict[str, Optional[float]] = {
        "accuracy": round(accuracy, 4) if accuracy is not None else None,
        "headshot_ratio": round(headshot_ratio, 4) if headshot_ratio is not None else None,
        "reaction_time_median": round(reaction_time_median, 4) if reaction_time_median is not None else None,
        "reaction_time_min": round(reaction_time_min, 4) if reaction_time_min is not None else None,
        "fire_rate": round(fire_rate, 4) if fire_rate is not None else None,
        "fire_interval_cv": round(fire_interval_cv, 4) if fire_interval_cv is not None else None,
        "burst_length_mean": round(burst_length_mean, 4) if burst_length_mean is not None else None,
        "movement_speed_mean": round(movement_speed_mean, 4) if movement_speed_mean is not None else None,
        "movement_speed_max": round(movement_speed_max, 4) if movement_speed_max is not None else None,
        "movement_speed_std": round(movement_speed_std, 4) if movement_speed_std is not None else None,
        "aim_speed_mean": round(aim_speed_mean, 4) if aim_speed_mean is not None else None,
        "aim_speed_std": round(aim_speed_std, 4) if aim_speed_std is not None else None,
        "aim_speed_max": round(aim_speed_max, 4) if aim_speed_max is not None else None,
        "flick_rate": round(flick_rate, 4) if flick_rate is not None else None,
        "aim_error_at_fire_mean": round(aim_error_at_fire_mean, 4) if aim_error_at_fire_mean is not None else None,
        "aim_error_at_fire_std": round(aim_error_at_fire_std, 4) if aim_error_at_fire_std is not None else None,
        "snap_to_hit_ratio": round(snap_to_hit_ratio, 4) if snap_to_hit_ratio is not None else None,
        "wall_aim_ratio": round(wall_aim_ratio, 4) if wall_aim_ratio is not None else None,
        "kdr": round(kdr, 4) if kdr is not None else None,
        "time_to_kill_median": round(time_to_kill_median, 4) if time_to_kill_median is not None else None,
        "shots_per_kill": round(shots_per_kill, 4) if shots_per_kill is not None else None,
    }

    meta = {
        "has_sufficient_data": is_sufficient,
        "low_confidence": not is_sufficient or is_fallback,
        "is_fallback": is_fallback,
        "shots": total_shots,
        "hits": total_hits,
        "kills": total_kills,
        "deaths": deaths_count,
        "duration": round(total_duration, 2),
    }

    return features, meta
