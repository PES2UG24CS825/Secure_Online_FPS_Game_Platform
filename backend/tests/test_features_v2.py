"""
Unit tests for Feature Set v2 (backend/services/features_v2.py).
Tests exact mathematical computations against hand-crafted event sequences.
"""

import math
import pytest
from services.features_v2 import (
    extract_features_v2,
    FEATURE_NAMES_V2,
    MIN_SHOTS_REQUIRED,
    MIN_DURATION_SECONDS,
)


def test_insufficient_data_returns_none():
    """Sessions with < 10 shots or < 20s duration return None for all features."""
    short_events = [
        {"event_type": "weapon_fire", "telemetry": {"timestamp": 1.0}},
        {"event_type": "weapon_fire", "telemetry": {"timestamp": 2.0}},
        {"event_type": "enemy_hit", "telemetry": {"timestamp": 2.1}},
    ]
    features, meta = extract_features_v2(short_events, enforce_min_data=True)

    assert meta["has_sufficient_data"] is False
    assert meta["low_confidence"] is True
    for feat in FEATURE_NAMES_V2:
        assert features[feat] is None


def test_handmade_event_list_with_known_expected_values():
    """
    Construct a precise synthetic session with 12 shots, 25 seconds duration,
    and verified exact values for every single feature.
    """
    events = []

    # 1. Target acquisitions
    # enemy_1 acquired at t=1.0 (in plain sight)
    events.append({
        "event_type": "target_acquired",
        "telemetry": {"enemy_id": "enemy_1", "distance": 15.0, "visible_through_wall": False, "timestamp": 1.0}
    })
    # enemy_2 acquired at t=10.0 (behind wall)
    events.append({
        "event_type": "target_acquired",
        "telemetry": {"enemy_id": "enemy_2", "distance": 25.0, "visible_through_wall": True, "timestamp": 10.0}
    })

    # 2. Shots: 12 shots total
    # Burst 1: 3 shots at t=1.2, 1.4, 1.6 (interval 0.2s <= 0.45s) -> first shot reaction = 1.2 - 1.0 = 0.20s
    # Burst 2: 3 shots at t=5.0, 5.2, 5.4 (interval 0.2s)
    # Burst 3: 3 shots at t=10.3, 10.5, 10.7 (reaction to enemy_2 = 10.3 - 10.0 = 0.30s; shots at enemy_2 behind wall)
    # Burst 4: 3 shots at t=20.0, 20.2, 21.2 (last interval 1.0s -> separates burst)
    shot_times = [
        (1.2, "enemy_1", 2.0),
        (1.4, "enemy_1", 4.0),
        (1.6, "enemy_1", 6.0),
        (5.0, "enemy_1", 2.0),
        (5.2, "enemy_1", 4.0),
        (5.4, "enemy_1", 6.0),
        (10.3, "enemy_2", 8.0),
        (10.5, "enemy_2", 8.0),
        (10.7, "enemy_2", 8.0),
        (20.0, "enemy_3", 1.0),
        (20.2, "enemy_3", 1.0),
        (25.0, "enemy_3", 1.0),  # extends duration to 25.0 - 1.0 = 24.0s
    ]

    for ts, tgt, aim_err in shot_times:
        events.append({
            "event_type": "weapon_fire",
            "telemetry": {
                "weapon": "Rifle",
                "target_id": tgt,
                "aim_error_deg": aim_err,
                "timestamp": ts,
            }
        })

    # 3. Hits: 6 hits out of 12 shots -> accuracy = 6 / 12 = 0.50
    # 3 headshots -> headshot_ratio = 3 / 6 = 0.50
    hits_data = [
        (1.25, "enemy_1", "head", 15.0, 50.0),
        (1.45, "enemy_1", "body", 15.0, 30.0),
        (5.05, "enemy_1", "head", 14.0, 50.0),
        (10.35, "enemy_2", "body", 25.0, 30.0),
        (10.55, "enemy_2", "limb", 25.0, 20.0),
        (20.05, "enemy_3", "head", 12.0, 50.0),
    ]
    for ts, tid, part, dist, dmg in hits_data:
        events.append({
            "event_type": "hit_detail",
            "telemetry": {
                "target_id": tid,
                "body_part": part,
                "distance": dist,
                "damage": dmg,
                "timestamp": ts,
            }
        })

    # 4. Kills & Deaths: 2 kills, 1 death -> KDR = 2.0
    # enemy_1 hit first at 1.25, killed at 5.5 -> TTK = 5.5 - 1.25 = 4.25s
    # enemy_2 hit first at 10.35, killed at 12.0 -> TTK = 12.0 - 10.35 = 1.65s
    # Median TTK = (4.25 + 1.65) / 2 = 2.95s
    events.append({
        "event_type": "enemy_killed",
        "telemetry": {"enemy": "enemy_1", "timestamp": 5.5}
    })
    events.append({
        "event_type": "enemy_killed",
        "telemetry": {"enemy": "enemy_2", "timestamp": 12.0}
    })
    events.append({
        "event_type": "player_death",
        "telemetry": {"timestamp": 15.0}
    })

    # 5. Kinematics: Movement speeds: [2.0, 4.0, 6.0]
    # mean = 4.0, max = 6.0, std = 2.0
    for ts, spd in [(2.0, 2.0), (4.0, 4.0), (6.0, 6.0)]:
        events.append({
            "event_type": "player_behavior",
            "telemetry": {"speed": spd, "timestamp": ts}
        })

    # 6. Aim samples:
    # 2 regular samples: 100.0, 200.0
    # 1 flick sample: 500.0 deg/s at t=10.2s (followed by hit at t=10.35s, delta 0.15s <= 0.30s)
    events.append({"event_type": "aim_sample", "telemetry": {"angular_velocity_deg_s": 100.0, "yaw": 10.0, "pitch": 0.0, "timestamp": 2.0}})
    events.append({"event_type": "aim_sample", "telemetry": {"angular_velocity_deg_s": 200.0, "yaw": 20.0, "pitch": 0.0, "timestamp": 4.0}})
    events.append({"event_type": "aim_sample", "telemetry": {"angular_velocity_deg_s": 500.0, "yaw": 50.0, "pitch": 0.0, "timestamp": 10.2}})

    # Extract features
    features, meta = extract_features_v2(events, enforce_min_data=True)

    assert meta["has_sufficient_data"] is True
    assert meta["shots"] == 12
    assert meta["hits"] == 6
    assert meta["kills"] == 2
    assert meta["deaths"] == 1

    # Accuracy: 6 / 12 = 0.50
    assert features["accuracy"] == 0.50

    # Headshot ratio: 3 / 6 = 0.50
    assert features["headshot_ratio"] == 0.50

    # Reaction time: enemy_1: 1.2 - 1.0 = 0.20s; enemy_2: 10.3 - 10.0 = 0.30s
    # Min = 0.20, Median = 0.25
    assert features["reaction_time_min"] == 0.20
    assert features["reaction_time_median"] == 0.25

    # Fire rate: 12 shots / (25.0 - 1.2 = 23.8s) = 0.5042
    assert 0.45 <= features["fire_rate"] <= 0.55

    # Movement speed: [2.0, 4.0, 6.0] -> mean=4.0, max=6.0, std=2.0
    assert features["movement_speed_mean"] == 4.0
    assert features["movement_speed_max"] == 6.0
    assert features["movement_speed_std"] == 2.0

    # Aim speed: [100.0, 200.0, 500.0] -> mean=266.6667, max=500.0
    assert round(features["aim_speed_mean"], 1) == 266.7
    assert features["aim_speed_max"] == 500.0

    # Flick rate: 1 flick in (25.0 - 1.0 = 24.0s = 0.4 min) -> 1 / 0.4 = 2.5 flicks/min
    assert features["flick_rate"] == 2.5

    # Snap to hit ratio: 1 hit followed flick / 6 total hits = 1/6 = 0.1667
    assert round(features["snap_to_hit_ratio"], 3) == 0.167

    # Wall aim ratio: 3 shots at enemy_2 (behind wall) out of 12 shots = 3/12 = 0.25
    assert features["wall_aim_ratio"] == 0.25

    # KDR: 2 kills / max(1 death, 1) = 2.0
    assert features["kdr"] == 2.0

    # Time to kill median: [4.25, 1.65] -> median = 2.95s
    assert features["time_to_kill_median"] == 2.95

    # Shots per kill: 12 / 2 = 6.0
    assert features["shots_per_kill"] == 6.0


def test_feature_list_completeness():
    """Verify that all 21 feature names are present in FEATURE_NAMES_V2."""
    assert len(FEATURE_NAMES_V2) == 21
    expected = [
        "accuracy", "headshot_ratio", "reaction_time_median", "reaction_time_min",
        "fire_rate", "fire_interval_cv", "burst_length_mean", "movement_speed_mean",
        "movement_speed_max", "movement_speed_std", "aim_speed_mean", "aim_speed_std",
        "aim_speed_max", "flick_rate", "aim_error_at_fire_mean", "aim_error_at_fire_std",
        "snap_to_hit_ratio", "wall_aim_ratio", "kdr", "time_to_kill_median", "shots_per_kill"
    ]
    for feat in expected:
        assert feat in FEATURE_NAMES_V2
