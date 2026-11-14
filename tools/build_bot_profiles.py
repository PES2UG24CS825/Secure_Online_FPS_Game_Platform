#!/usr/bin/env python3
"""
SecureFPS: Dataset-Driven Humanlike Bot Profile Generator
=========================================================
Reads backend/data Preprocessing/cheating_detection_dataset (1).csv,
extracts solely legitimate human player distributions (Label == 0),
and computes empirical distributions and 64 human-calibrated bot personas
across 3 skill bands: Easy (~p10-p35), Normal (~p35-p70), and Hard (~p70-p95).

UNIT ASSUMPTIONS & CONTRACT:
-----------------------------
- Reaction_Time:   Milliseconds (ms). Empirical range ~180ms - 320ms. Lower is faster.
- Accuracy:        Percentage (%). Empirical range ~40% - 68%. Range falloff applied in-game.
- Headshot_Ratio:  Percentage (%). Empirical range ~10% - 30% of landed hits.
- Fire_Rate:       Shots per second. Empirical range ~4.5 - 7.5 shots/s.
- Movement_Speed:  Meters per second (m/s). Empirical range ~4.0 - 5.0 m/s.
- Aim_Smoothness:  Normalized scalar (0.0 to 1.0). Higher = smoother tracking, lower = more jitter.
- KDR:             Kill-to-death ratio. Empirical range ~0.8 - 2.2.

OUTPUT:
-------
frontend/public/games/three-fps/data/bot_profiles.json
"""

import os
import json
import numpy as np
import pandas as pd
from pathlib import Path

# Tactical callsigns for bots
CALLSIGNS = [
    "Specter", "Viper", "Phantom", "Reaper", "Cobalt", "Ghost", "Apex", "Havoc",
    "Ranger", "Saber", "Nomad", "Echo", "Striker", "Onyx", "Rogue", "Hawk",
    "Titan", "Sentinel", "Ronin", "Banshee", "Wraith", "Paladin", "Shade", "Bishop",
    "Raven", "Talon", "Blitz", "Gargoyle", "Shadow", "Vector", "Outlaw", "Corsair",
    "Jaguar", "Phoenix", "Cobra", "Frost", "Grizzly", "Hydra", "Lynx", "Mantis",
    "Nebula", "Orion", "Panther", "Quaser", "Raptor", "Scorpion", "Tornado", "Ursa",
    "Valkyrie", "Wolf", "Xenon", "Yeti", "Zephyr", "Aegis", "Blizzard", "Centurion",
    "Drift", "Enforcer", "Falcon", "Goliath", "Hunter", "Ironclad", "Kodiak", "Legion"
]

ROLES = ["pointman", "flanker", "marksman", "scout"]


def build_bot_profiles():
    repo_root = Path(__file__).resolve().parent.parent
    csv_path = repo_root / "backend" / "data Preprocessing" / "cheating_detection_dataset (1).csv"
    output_path = repo_root / "frontend" / "public" / "games" / "three-fps" / "data" / "bot_profiles.json"

    if not csv_path.exists():
        raise FileNotFoundError(f"Source dataset not found at {csv_path}")

    df = pd.read_csv(csv_path)
    # STRICT FILTER: Keep ONLY legitimate players (Label == 0)
    legit_df = df[df["Label"] == 0].copy()

    features = [
        "Reaction_Time",
        "Accuracy",
        "Headshot_Ratio",
        "Fire_Rate",
        "Movement_Speed",
        "Aim_Smoothness",
        "KDR"
    ]

    # Compute per-column summary statistics
    distribution_stats = {}
    for feat in features:
        col = legit_df[feat].dropna()
        distribution_stats[feat] = {
            "mean": float(col.mean()),
            "std": float(col.std()),
            "min": float(col.min()),
            "max": float(col.max()),
            "p10": float(col.quantile(0.10)),
            "p25": float(col.quantile(0.25)),
            "p50": float(col.quantile(0.50)),
            "p75": float(col.quantile(0.75)),
            "p90": float(col.quantile(0.90)),
        }

    # Compute a normalized skill index for composite stratification
    # Faster reaction time (lower) increases skill; higher accuracy, headshots, and KDR increase skill
    z_acc = (legit_df["Accuracy"] - distribution_stats["Accuracy"]["mean"]) / distribution_stats["Accuracy"]["std"]
    z_hs = (legit_df["Headshot_Ratio"] - distribution_stats["Headshot_Ratio"]["mean"]) / distribution_stats["Headshot_Ratio"]["std"]
    z_rt = -(legit_df["Reaction_Time"] - distribution_stats["Reaction_Time"]["mean"]) / distribution_stats["Reaction_Time"]["std"]
    z_kdr = (legit_df["KDR"] - distribution_stats["KDR"]["mean"]) / distribution_stats["KDR"]["std"]

    legit_df["skill_index"] = 0.35 * z_acc + 0.20 * z_hs + 0.25 * z_rt + 0.20 * z_kdr

    p10_skill = legit_df["skill_index"].quantile(0.10)
    p35_skill = legit_df["skill_index"].quantile(0.35)
    p70_skill = legit_df["skill_index"].quantile(0.70)
    p95_skill = legit_df["skill_index"].quantile(0.95)

    easy_pool = legit_df[(legit_df["skill_index"] >= p10_skill) & (legit_df["skill_index"] < p35_skill)]
    normal_pool = legit_df[(legit_df["skill_index"] >= p35_skill) & (legit_df["skill_index"] < p70_skill)]
    hard_pool = legit_df[(legit_df["skill_index"] >= p70_skill) & (legit_df["skill_index"] <= p95_skill)]

    # Deterministic sampling seed for reproducibility
    np.random.seed(42)

    sampled_easy = easy_pool.sample(n=21, replace=len(easy_pool) < 21, random_state=42)
    sampled_normal = normal_pool.sample(n=22, replace=len(normal_pool) < 22, random_state=42)
    sampled_hard = hard_pool.sample(n=21, replace=len(hard_pool) < 21, random_state=42)

    personas = []
    callsign_idx = 0

    def make_personas(sample_df, difficulty):
        nonlocal callsign_idx
        result = []
        for idx, (_, row) in enumerate(sample_df.iterrows()):
            role = ROLES[idx % len(ROLES)]
            callsign = CALLSIGNS[callsign_idx % len(CALLSIGNS)]
            callsign_idx += 1

            rt_ms = float(row["Reaction_Time"])
            # In-game human motor reaction floor: clamp >= 150ms
            clamped_rt_ms = max(150.0, rt_ms)

            acc_pct = float(row["Accuracy"])
            hs_pct = float(row["Headshot_Ratio"])
            fr = float(row["Fire_Rate"])
            spd = float(row["Movement_Speed"])
            smooth = float(row["Aim_Smoothness"])
            kdr = float(row["KDR"])

            # Derived combat cadence
            burst_count = 2 if difficulty == "easy" else (4 if role == "pointman" else 3)
            burst_interval = max(0.12, min(0.35, 1.0 / fr if fr > 0 else 0.22))
            burst_cooldown = 2.2 if difficulty == "easy" else (1.2 if difficulty == "hard" else 1.6)

            persona = {
                "id": f"persona_{difficulty}_{idx+1:02d}",
                "name": f"{callsign}_{idx+1:02d}",
                "callsign": callsign,
                "difficulty": difficulty,
                "role": role,
                "reaction_time_ms": round(clamped_rt_ms, 1),
                "accuracy_pct": round(acc_pct, 1),
                "headshot_ratio_pct": round(hs_pct, 1),
                "fire_rate_s": round(fr, 2),
                "movement_speed_ms": round(spd, 2),
                "aim_smoothness": round(smooth, 3),
                "kdr": round(kdr, 2),
                "burst_count": burst_count,
                "burst_interval_s": round(burst_interval, 3),
                "burst_cooldown_s": round(burst_cooldown, 2),
            }
            result.append(persona)
        return result

    personas.extend(make_personas(sampled_easy, "easy"))
    personas.extend(make_personas(sampled_normal, "normal"))
    personas.extend(make_personas(sampled_hard, "hard"))

    payload = {
        "_metadata": {
            "version": "2.0.0",
            "source_dataset": "cheating_detection_dataset (1).csv",
            "source_filter": "Label == 0 (Legitimate Humans Only)",
            "sample_count": len(personas),
            "units": {
                "reaction_time_ms": "Milliseconds (ms)",
                "accuracy_pct": "Percentage (%)",
                "headshot_ratio_pct": "Percentage (%)",
                "fire_rate_s": "Shots per second",
                "movement_speed_ms": "Meters per second (m/s)",
                "aim_smoothness": "Normalized scalar (0.0 - 1.0)",
                "kdr": "Kill-to-death ratio"
            }
        },
        "distributions": distribution_stats,
        "personas": personas,
        "difficulty_bands": {
            "easy": [p for p in personas if p["difficulty"] == "easy"],
            "normal": [p for p in personas if p["difficulty"] == "normal"],
            "hard": [p for p in personas if p["difficulty"] == "hard"]
        }
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)

    print(f"[build_bot_profiles] Successfully exported {len(personas)} dataset-grounded bot personas to {output_path}")


if __name__ == "__main__":
    build_bot_profiles()
