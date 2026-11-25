"""
SecureFPS — Advanced AI Anti-Cheat Intelligence & Human Behavior Analysis Service
Provides evidence-based physical cheat detection, player skill baselining,
context-aware false positive elimination, and explainable AI metrics.
"""

import math
from datetime import datetime, timezone
from typing import Dict, List, Optional, Any, Tuple

# Physical constants for CyberStrike 3D
MAX_HUMAN_SPRINT_SPEED = 12.0      # m/s (tactical sprint in Controller.js is 11.5 m/s)
MAX_PERMISSIBLE_SPEED = 20.0       # m/s (includes sprinting + bunny hopping / momentum impulses)
MAX_CARBINE_FIRE_RATE = 11.5       # rounds per second (cyclic rate + tolerance)
MAX_SNIPER_FIRE_RATE = 1.8         # rounds per second
MIN_HUMAN_REACTION_MS = 100.0      # ms (fastest elite esports reaction)
NORMAL_HUMAN_REACTION_MS = 180.0   # ms (average human visual reaction time)


class AntiCheatIntelligence:
    """
    Evidence-based anti-cheat intelligence engine.
    Ensures skilled human players are never falsely classified as cheaters.
    """

    @staticmethod
    def calculate_kdr(kills: int, deaths: int, has_combat: bool = True) -> Optional[float]:
        """
        Documented Zero-Death & Zero-Kill KDR Convention:
        - deaths > 0: kills / deaths
        - deaths == 0 and kills > 0: float(kills) (clean zero-death performance)
        - deaths == 0 and kills == 0:
            - if has_combat (shots fired/hits): 0.0 (active combat with zero eliminations)
            - if not has_combat (no shots/hits): None (session lacks combat data)
        """
        if deaths > 0:
            return round(float(kills) / float(deaths), 4)
        if kills > 0:
            return float(kills)
        if has_combat:
            return 0.0
        return None

    @staticmethod
    def audit_telemetry_stream(events: List[Dict[str, Any]]) -> Dict[str, Any]:
        """
        Audits raw telemetry events for physical cheat indicators:
        - Speedhack / Teleportation
        - Inhuman Fire Rate
        - Unnatural Snap Aiming
        - Impossible Damage
        """
        speed_violations = []
        aim_snap_violations = []
        fire_rate_violations = []

        last_pos = None
        last_pos_time = None

        shots = 0
        hits = 0
        kills = 0
        deaths = 0
        headshots = 0

        movement_speeds = []
        aim_rotations = []
        shot_timestamps = []

        for ev in events:
            etype = ev.get("event_type", "")
            tdata = ev.get("telemetry", {}) or {}
            created_at = ev.get("created_at")
            ts = created_at.timestamp() if isinstance(created_at, datetime) else None

            if etype == "weapon_fire":
                shots += 1
                if ts:
                    shot_timestamps.append(ts)
            elif etype == "enemy_hit":
                hits += 1
                if tdata.get("headshot"):
                    headshots += 1
            elif etype == "enemy_killed":
                kills += 1
            elif etype in ("player_death", "player_respawn"):
                deaths += 1
                # Respawn teleports player across the map — reset kinematics baseline
                last_pos = None
                last_pos_time = None
            elif etype == "player_behavior":
                spd = tdata.get("speed")
                pos = tdata.get("position")
                if spd is not None:
                    try:
                        spd_f = float(spd)
                        if math.isfinite(spd_f):
                            movement_speeds.append(spd_f)
                            if spd_f > MAX_PERMISSIBLE_SPEED:
                                speed_violations.append({
                                    "speed": spd_f,
                                    "max_allowed": MAX_PERMISSIBLE_SPEED,
                                    "timestamp": ts
                                })
                    except (TypeError, ValueError):
                        pass

                # Check kinematics if position vector exists
                if pos and isinstance(pos, dict) and ts and last_pos and last_pos_time:
                    dt = max(0.001, ts - last_pos_time)
                    if dt < 5.0: # within reasonable sample gap
                        dx = pos.get("x", 0) - last_pos.get("x", 0)
                        dy = pos.get("y", 0) - last_pos.get("y", 0)
                        dz = pos.get("z", 0) - last_pos.get("z", 0)
                        disp = math.sqrt(dx*dx + dy*dy + dz*dz)
                        # Displacements > 25m in sample interval are respawns or teleport resets
                        if disp <= 25.0:
                            calculated_speed = disp / dt
                            if calculated_speed > MAX_PERMISSIBLE_SPEED:
                                speed_violations.append({
                                    "calculated_speed": round(calculated_speed, 2),
                                    "displacement": round(disp, 2),
                                    "dt": round(dt, 3),
                                    "timestamp": ts
                                })
                if pos and isinstance(pos, dict) and ts:
                    last_pos = pos
                    last_pos_time = ts

            elif etype == "aim_behavior":
                rot = tdata.get("rotation_change")
                if rot is not None:
                    try:
                        rot_f = float(rot)
                        if math.isfinite(rot_f):
                            # Unity FPS_Microgame sends Vector3.Angle in degrees (0 to 180).
                            # If game is FPS_Microgame or rot_f is in degrees (> 2*pi), convert to radians
                            # so aim_smoothness and aim_snap_violations are evaluated consistently in radians.
                            if ev.get("game") == "FPS_Microgame" or rot_f > math.pi * 2:
                                rot_rad = math.radians(rot_f)
                            else:
                                rot_rad = rot_f
                            aim_rotations.append(abs(rot_rad))
                            # Instant snap check: rotation change > 3.0 rad (~172 deg) in single sample
                            if abs(rot_rad) > 3.0:
                                aim_snap_violations.append({
                                    "rotation_delta": round(rot_f, 4),
                                    "rotation_rad": round(rot_rad, 4),
                                    "timestamp": ts
                                })
                    except (TypeError, ValueError):
                        pass

        # Check fire rate intervals
        if len(shot_timestamps) >= 4:
            shot_timestamps.sort()
            for i in range(len(shot_timestamps) - 3):
                window_dt = shot_timestamps[i+3] - shot_timestamps[i]
                if window_dt > 0.0001:
                    instant_rate = 3.0 / window_dt
                    if instant_rate > MAX_CARBINE_FIRE_RATE:
                        fire_rate_violations.append({
                            "rate": round(instant_rate, 2),
                            "max_allowed": MAX_CARBINE_FIRE_RATE
                        })
                        break

        has_combat = (shots > 0 or hits > 0 or kills > 0)
        kdr = AntiCheatIntelligence.calculate_kdr(kills, deaths, has_combat=has_combat)
        accuracy = (hits / shots) if shots > 0 else (0.0 if not has_combat else None)
        if accuracy is not None:
            accuracy = max(0.0, min(accuracy, 1.0))

        avg_speed = (sum(movement_speeds) / len(movement_speeds)) if movement_speeds else None
        avg_aim = (sum(aim_rotations) / len(aim_rotations)) if aim_rotations else None
        smoothness = (1.0 / (1.0 + avg_aim)) if avg_aim is not None else None

        return {
            "counts": {
                "shots": shots,
                "hits": hits,
                "kills": kills,
                "deaths": deaths,
                "headshots": headshots
            },
            "features": {
                "accuracy": round(accuracy, 6) if accuracy is not None else None,
                "movement_speed": round(avg_speed, 6) if avg_speed is not None else None,
                "aim_smoothness": round(smoothness, 6) if smoothness is not None else None,
                "kdr": round(kdr, 4) if kdr is not None else None
            },
            "physical_violations": {
                "speed_violations": speed_violations,
                "aim_snap_violations": aim_snap_violations,
                "fire_rate_violations": fire_rate_violations
            },
            "has_combat": has_combat
        }

    @staticmethod
    def evaluate_human_skill_context(
        raw_features: Dict[str, Any],
        audit: Dict[str, Any],
        game_mode: str = "solo",
        player_baseline: Optional[Dict[str, Any]] = None,
        session_security_events: Optional[List[Dict[str, Any]]] = None,
        session_stats: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Differentiates skilled human performance from artificial cheat signatures.
        Evaluates whether high performance is consistent with legitimate gameplay.
        """
        accuracy = raw_features.get("accuracy") or 0.0
        kdr = raw_features.get("kdr") or 0.0
        smoothness = raw_features.get("aim_smoothness") or 0.0
        shots = audit["counts"]["shots"]
        hits = audit["counts"]["hits"]
        kills = audit["counts"]["kills"]

        if session_stats:
            shots = max(shots, int(session_stats.get("shots_fired") or 0))
            hits = max(hits, int(session_stats.get("shots_hit") or 0))
            headshots = int(session_stats.get("headshots") or 0)
        else:
            headshots = 0

        mode = str(game_mode or "").lower()
        is_bot_mode = mode in ("solo", "play_with_bots", "training", "bots", "fps_microgame") or mode.startswith("bot")

        violations = audit["physical_violations"]
        has_speed_hack = len(violations["speed_violations"]) >= 5
        has_fire_rate_hack = len(violations["fire_rate_violations"]) >= 3
        has_aim_snap_hack = len(violations["aim_snap_violations"]) >= 12

        # Physical impossibility check
        hard_cheat_evidence = []
        if has_speed_hack:
            hard_cheat_evidence.append(f"Unusually fast movement detected ({len(violations['speed_violations'])} samples > {MAX_PERMISSIBLE_SPEED} m/s)")
        if has_fire_rate_hack:
            hard_cheat_evidence.append(f"Weapon fire rate exceeded physical limits (> {MAX_CARBINE_FIRE_RATE} rounds/s)")
        if has_aim_snap_hack and not is_bot_mode:
            hard_cheat_evidence.append(f"Unusual sudden aiming detected ({len(violations['aim_snap_violations'])} instances)")

        # Incorporate verified server-rule / telemetry security_events for this session
        cleared_statuses = {"false_positive", "cleared", "dismissed", "confirmed_clean"}
        rule_counts = {}
        first_sev_by_type = {}
        for sev in (session_security_events or []):
            r_status = str(sev.get("review_status") or sev.get("status") or "").lower()
            if r_status in cleared_statuses:
                continue
            etype = str(sev.get("event_type") or sev.get("type") or "")
            if etype in {"impossible_hit", "headshot_anomaly", "abnormal_fire_rate", "abnormal_speed", "hard_rule_violation"}:
                rule_counts[etype] = rule_counts.get(etype, 0) + 1
                first_sev_by_type.setdefault(etype, sev)

        seen_rule_types = set()
        for etype, sev in first_sev_by_type.items():
            # For abnormal_fire_rate on non-demo accounts, require >= 5 events or explicit 5+ streak evidence
            if etype == "abnormal_fire_rate" and not sev.get("is_demo") and rule_counts[etype] < 5:
                ev_data = sev.get("evidence") or {}
                if int(ev_data.get("consecutive_rapid_shots") or 0) < 5:
                    continue
            seen_rule_types.add(etype)
            desc = sev.get("violation") or etype
            obs = sev.get("observed_value")
            hard_cheat_evidence.append(f"{desc} ({obs})" if obs else str(desc))

        # Statistical headshot impossibility check (only with sufficient sample size >= 10 hits)
        if "headshot_anomaly" not in seen_rule_types and hits >= 10 and (headshots / max(1, hits)) >= 0.90:
            hs_pct = round((headshots / hits) * 100.0, 1)
            hard_cheat_evidence.append(f"Impossible headshot consistency: {headshots}/{hits} hits ({hs_pct}%)")

        # Skill assessment
        is_skilled_human = False
        skill_reasons = []

        if is_bot_mode:
            # In bot modes, 60-90% accuracy and high KDR are expected for skilled human players
            if accuracy >= 0.60:
                skill_reasons.append("High accuracy achieved against predictable AI bot movement patterns")
            if kdr >= 3.0:
                skill_reasons.append(f"High K/D ({kdr}) is normal for skilled humans in bot modes")
            if smoothness >= 0.65:
                skill_reasons.append("Smooth tracking consistent with gaming mouse DPI and mouse smoothing")
            if accuracy >= 0.60 or kdr >= 3.0:
                is_skilled_human = True

        # Check historical baseline if available
        is_within_baseline = True
        baseline_delta = None
        if player_baseline and player_baseline.get("sample_count", 0) >= 3:
            base_acc = player_baseline.get("avg_accuracy", 0.5)
            base_kdr = player_baseline.get("avg_kdr", 1.5)
            # Check if this match is within 2.5 standard deviations of player's historical skill
            acc_diff = accuracy - base_acc
            kdr_diff = kdr - base_kdr
            baseline_delta = {"acc_diff": round(acc_diff, 3), "kdr_diff": round(kdr_diff, 2)}
            if acc_diff < 0.25 and kdr_diff < 5.0:
                skill_reasons.append(f"Performance matches player's historical skill baseline (avg acc: {base_acc:.1%})")
                is_skilled_human = True

        # Determine review category
        if hard_cheat_evidence:
            category = "Confirmed violation"
            state = "restricted"
            explanation = "Server-validated physical impossibility detected: " + "; ".join(hard_cheat_evidence)
        elif not audit["has_combat"]:
            category = "Analysis incomplete"
            state = "monitoring"
            explanation = "Session contains zero combat engagement (no weapon fire or damage recorded)"
        elif is_skilled_human and not hard_cheat_evidence:
            category = "Normal"
            state = "monitoring"
            explanation = "Performance consistent with skilled human player: " + "; ".join(skill_reasons)
        elif accuracy > 0.95 and shots >= 25 and not is_bot_mode:
            category = "Under review"
            state = "monitoring"
            explanation = "Extremely high accuracy (>95%) in competitive PvP requires manual review"
        elif accuracy > 0.85 and shots >= 30 and kdr >= 8.0 and not is_bot_mode:
            category = "Suspicious"
            state = "monitoring"
            explanation = "Statistically atypical performance in competitive PvP flagged for monitoring"
        else:
            category = "Normal"
            state = "monitoring"
            explanation = "Gameplay features within normal human variation"

        return {
            "review_category": category,
            "enforcement_state": state,
            "is_skilled_human": is_skilled_human,
            "hard_cheat_evidence": hard_cheat_evidence,
            "skill_reasons": skill_reasons,
            "explanation": explanation,
            "game_mode_context": "AI Bots / Casual" if is_bot_mode else "Competitive PvP",
            "baseline_comparison": baseline_delta
        }

    @staticmethod
    def calibrate_ensemble_risk(
        rf_result: Optional[str],
        rf_prob: Optional[float],
        iso_result: Optional[str],
        iso_score: Optional[float],
        human_eval: Dict[str, Any],
        raw_features: Dict[str, Any]
    ) -> Tuple[float, str]:
        """
        Intelligent Risk Score Arbiter:
        - Prevents false-positives for skilled human players.
        - NEVER flags a player as a cheater based on Isolation Forest anomaly alone.
        - Respects server-validated physical violations.
        """
        # 1. If physical or server-rule violations exist (speedhack, impossible_hit, headshot_anomaly, etc.), risk is high
        if human_eval["hard_cheat_evidence"]:
            evidence_count = len(human_eval["hard_cheat_evidence"])
            if evidence_count >= 3:
                risk = 92.5
            elif evidence_count == 2:
                risk = 88.0
            else:
                risk = 82.5
            return risk, "high"

        # 2. If session has incomplete combat
        if human_eval["review_category"] == "Analysis incomplete":
            return 0.0, "low"

        # 3. Base ML calculation
        rf_p = rf_prob if (rf_prob is not None and math.isfinite(rf_prob)) else (0.75 if rf_result == "cheater" else 0.1)
        iso_s = iso_score if (iso_score is not None and math.isfinite(iso_score)) else (0.55 if iso_result == "anomaly" else 0.2)

        # Standard 60/40 weighted formula
        raw_risk = round(100.0 * (0.60 * rf_p + 0.40 * iso_s), 2)

        # 4. No positive server-validated physical evidence means no high/critical risk.
        # RF/IF alone, accuracy, or historical model skew cannot exceed the monitoring band.
        calibrated_risk = min(raw_risk, 39.0)
        return calibrated_risk, "low"
