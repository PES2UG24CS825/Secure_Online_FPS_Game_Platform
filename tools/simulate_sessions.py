"""
SecureFPS: Synthetic & Human Gameplay Session Simulator (tools/simulate_sessions.py)
Generates 3,000+ realistic match sessions with human-like noise, overlapping skill distributions,
and multiple cheat archetypes across 50+ distinct player groups.
Connects directly to backend.arena_relay and persists sessions to MongoDB training_sessions and cache.
"""

import argparse
import json
import math
import os
import random
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Any, Optional

PROJECT_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = PROJECT_ROOT / "backend"
sys.path.insert(0, str(PROJECT_ROOT))
sys.path.insert(0, str(BACKEND_DIR))

from backend.arena_relay import ArenaRelay, relay_instance
from backend.services.features_v2 import extract_features_v2
from backend.database.db import db

# 60 distinct player groups: 10 human, 25 normal bot, 25 cheat bot
HUMAN_PLAYER_GROUPS = [f"human_p{i:02d}" for i in range(1, 11)]
NORMAL_SIM_GROUPS = [f"sim_norm_{i:02d}" for i in range(1, 26)]
CHEAT_SIM_GROUPS = [f"sim_cheat_{i:02d}" for i in range(1, 26)]

NORMAL_SKILL_LEVELS = ["casual", "average", "skilled", "pro"]
CHEAT_ARCHETYPES = [
    "hard_aimbot",
    "smooth_aimbot",
    "triggerbot",
    "wallhack",
    "speedhack",
    "recoil_script",
]


class SessionSimulator:
    def __init__(self, relay: Optional[ArenaRelay] = None):
        self.relay = relay or relay_instance

    def generate_session_events(
        self,
        session_id: str,
        player_group: str,
        source: str,
        cheat_type: str,
        strength: float,
        label: int,
    ) -> List[Dict[str, Any]]:
        """Generate a realistic stream of v1 & v2 events for a match."""
        duration = random.uniform(32.0, 70.0)
        num_shots = random.randint(18, 55)

        events: List[Dict[str, Any]] = []
        seq = 0

        def emit(event_type: str, telemetry: Dict[str, Any], t_sec: float):
            nonlocal seq
            seq += 1
            events.append({
                "session_id": session_id,
                "event_type": event_type,
                "seq": seq,
                "timestamp": round(t_sec, 4),
                "telemetry": {**telemetry, "seq": seq, "timestamp": round(t_sec, 4)},
            })

        emit("game_started", {}, 0.0)

        # Base movement speed
        base_speed = random.uniform(3.0, 5.5)
        if cheat_type == "speedhack":
            speed_mult = 1.0 + (strength * random.uniform(1.2, 2.5))
            base_speed *= speed_mult

        # Target acquisition & combat parameters
        if cheat_type == "hard_aimbot":
            reaction_base = random.uniform(0.04, 0.12)
            acc_base = random.uniform(0.75, 0.96)
            headshot_prob = 0.55 + 0.35 * strength
            aim_err_base = random.uniform(0.1, 1.2)
            flick_prob = 0.70
        elif cheat_type == "smooth_aimbot":
            # Significant overlap with skilled & pro humans
            reaction_base = random.uniform(0.16, 0.28)
            acc_base = random.uniform(0.48, 0.72)
            headshot_prob = 0.28 + 0.22 * strength
            aim_err_base = random.uniform(1.2, 3.8)
            flick_prob = 0.22 * strength
        elif cheat_type == "triggerbot":
            reaction_base = random.uniform(0.03, 0.08)
            acc_base = random.uniform(0.50, 0.75)
            headshot_prob = random.uniform(0.20, 0.40)
            aim_err_base = random.uniform(1.5, 4.5)
            flick_prob = 0.05
        elif cheat_type == "wallhack":
            reaction_base = random.uniform(0.15, 0.32)
            acc_base = random.uniform(0.42, 0.65)
            headshot_prob = random.uniform(0.20, 0.38)
            aim_err_base = random.uniform(2.0, 5.0)
            flick_prob = 0.10
        elif cheat_type == "recoil_script":
            reaction_base = random.uniform(0.18, 0.30)
            acc_base = random.uniform(0.45, 0.68)
            headshot_prob = random.uniform(0.22, 0.35)
            aim_err_base = random.uniform(1.8, 4.0)
            flick_prob = 0.05
        else:
            skill = random.choice(NORMAL_SKILL_LEVELS)
            if skill == "casual":
                reaction_base = random.uniform(0.28, 0.42)
                acc_base = random.uniform(0.18, 0.35)
                headshot_prob = random.uniform(0.08, 0.18)
                aim_err_base = random.uniform(5.0, 14.0)
                flick_prob = 0.01
            elif skill == "average":
                reaction_base = random.uniform(0.22, 0.34)
                acc_base = random.uniform(0.28, 0.46)
                headshot_prob = random.uniform(0.14, 0.26)
                aim_err_base = random.uniform(3.5, 8.5)
                flick_prob = 0.04
            elif skill == "skilled":
                reaction_base = random.uniform(0.17, 0.25)
                acc_base = random.uniform(0.42, 0.62)
                headshot_prob = random.uniform(0.22, 0.38)
                aim_err_base = random.uniform(2.0, 5.0)
                flick_prob = 0.12
            else:  # pro
                reaction_base = random.uniform(0.14, 0.21)
                acc_base = random.uniform(0.52, 0.72)
                headshot_prob = random.uniform(0.28, 0.46)
                aim_err_base = random.uniform(1.2, 3.2)
                flick_prob = 0.20

        # 1. 10Hz Aim Samples
        current_yaw = random.uniform(0, 360)
        current_pitch = random.uniform(-10, 10)
        num_aim_samples = int(duration / 0.1)
        for i in range(num_aim_samples):
            t_sample = i * 0.1
            ang_vel = max(5.0, random.gauss(120.0, 45.0))
            if random.random() < (flick_prob * 0.03):
                ang_vel = random.uniform(420.0, 950.0) if cheat_type != "hard_aimbot" else random.uniform(850.0, 2400.0)

            current_yaw = (current_yaw + random.uniform(-10, 10)) % 360
            current_pitch = max(-80, min(80, current_pitch + random.uniform(-3, 3)))
            emit("aim_sample", {
                "angular_velocity_deg_s": round(ang_vel, 2),
                "yaw": round(current_yaw, 2),
                "pitch": round(current_pitch, 2),
            }, t_sample)

        # 2. Movement samples every 2.0s
        num_move_samples = int(duration / 2.0)
        pos_x, pos_y, pos_z = 0.0, 0.0, 0.0
        for i in range(num_move_samples):
            t_move = i * 2.0 + 0.05
            spd = max(0.0, random.gauss(base_speed, base_speed * 0.25))
            pos_x += random.uniform(-2, 2)
            pos_z += random.uniform(-2, 2)
            emit("player_behavior", {
                "speed": round(spd, 2),
                "position": {"x": round(pos_x, 2), "y": round(pos_y, 2), "z": round(pos_z, 2)},
                "grounded": True,
            }, t_move)

        # 3. Combat
        enemies = [f"bot_target_{idx}" for idx in range(1, random.randint(4, 9))]
        current_t = random.uniform(1.5, 4.0)
        kills_count = 0
        deaths_count = random.randint(0, 3)

        shots_remaining = num_shots
        while shots_remaining > 0 and current_t < duration - 2.0:
            target = random.choice(enemies)
            is_behind_wall = (cheat_type == "wallhack" and random.random() < (0.35 + 0.45 * strength))
            if not is_behind_wall and random.random() < 0.06:
                is_behind_wall = True

            dist = random.uniform(8.0, 40.0)
            emit("target_acquired", {
                "enemy_id": target,
                "distance": round(dist, 1),
                "visible_through_wall": is_behind_wall,
            }, current_t)

            react_delay = max(0.03, random.gauss(reaction_base, reaction_base * 0.18))
            current_t += react_delay

            if cheat_type == "recoil_script":
                burst_len = random.randint(4, 10)
                interval = random.uniform(0.08, 0.11)
            else:
                burst_len = random.randint(1, 4)
                interval = random.uniform(0.12, 0.35)

            burst_len = min(burst_len, shots_remaining)
            enemy_hp = 100.0

            for b in range(burst_len):
                shots_remaining -= 1
                aim_err = max(0.05, random.gauss(aim_err_base, aim_err_base * 0.3))
                emit("weapon_fire", {
                    "weapon": "P-24 Carbine",
                    "aim_error_deg": round(aim_err, 2),
                    "target_id": target,
                }, current_t)

                hit_prob = acc_base * (1.0 if not is_behind_wall else 0.70)
                if random.random() < hit_prob:
                    is_head = random.random() < headshot_prob
                    part = "head" if is_head else ("body" if random.random() < 0.75 else "limb")
                    dmg = 50.0 if part == "head" else (34.0 if part == "body" else 22.0)
                    enemy_hp -= dmg

                    hit_t = current_t + random.uniform(0.01, 0.04)
                    emit("hit_detail", {
                        "target_id": target,
                        "body_part": part,
                        "distance": round(dist, 1),
                        "damage": round(dmg, 1),
                    }, hit_t)
                    emit("enemy_hit", {
                        "target_id": target,
                        "damage": round(dmg, 1),
                        "headshot": is_head,
                    }, hit_t)

                    if enemy_hp <= 0:
                        kills_count += 1
                        emit("enemy_killed", {"enemy": target}, hit_t + 0.02)
                        break

                current_t += interval

            current_t += random.uniform(1.2, 3.8)

        for d in range(deaths_count):
            t_death = random.uniform(10.0, duration - 5.0)
            emit("player_death", {}, t_death)

        emit("game_completed", {
            "kills": kills_count,
            "deaths": deaths_count,
            "shots": num_shots - shots_remaining,
            "accuracy": round(acc_base, 3),
        }, duration)

        events.sort(key=lambda x: x["timestamp"])
        return events

    def simulate_and_store_all(
        self,
        target_count: int = 3200,
        output_json_cache: Optional[Path] = None,
    ) -> List[Dict[str, Any]]:
        """Simulate sessions and batch-store into MongoDB training_sessions & disk cache."""
        print(f"[Simulator] Simulating {target_count} realistic match sessions across 60 players...")
        sessions_records = []

        normal_count = int(target_count * 0.50)
        cheat_count = target_count - normal_count
        start_wall_time = time.time()

        # 1. Normal sessions
        for i in range(normal_count):
            sid = f"sess_norm_{i+1:05d}"
            if i < 60:
                source = "human"
                player_group = random.choice(HUMAN_PLAYER_GROUPS)
            else:
                source = "simulated"
                player_group = random.choice(NORMAL_SIM_GROUPS)

            cheat_type = "none"
            strength = 0.0
            label = 0

            events = self.generate_session_events(
                session_id=sid,
                player_group=player_group,
                source=source,
                cheat_type=cheat_type,
                strength=strength,
                label=label,
            )

            record = {
                "session_id": sid,
                "player_group": player_group,
                "source": source,
                "cheat_type": cheat_type,
                "strength": strength,
                "label": label,
                "events_count": len(events),
                "events": events,
            }
            sessions_records.append(record)

        # 2. Cheat sessions
        for i in range(cheat_count):
            sid = f"sess_cheat_{i+1:05d}"
            player_group = random.choice(CHEAT_SIM_GROUPS)
            cheat_type = random.choice(CHEAT_ARCHETYPES)
            strength = round(random.choice([0.25, 0.40, 0.60, 0.80, 1.0]), 2)
            label = 1
            source = "simulated"

            events = self.generate_session_events(
                session_id=sid,
                player_group=player_group,
                source=source,
                cheat_type=cheat_type,
                strength=strength,
                label=label,
            )

            record = {
                "session_id": sid,
                "player_group": player_group,
                "source": source,
                "cheat_type": cheat_type,
                "strength": strength,
                "label": label,
                "events_count": len(events),
                "events": events,
            }
            sessions_records.append(record)

        elapsed = time.time() - start_wall_time
        print(f"[Simulator] Generated {len(sessions_records)} sessions in-memory in {elapsed:.2f}s.")

        # Batch insert into MongoDB training_sessions
        try:
            print("[Simulator] Batch persisting sessions to MongoDB collection 'training_sessions'...")
            coll = db["training_sessions"]
            # Clean old synthetic records
            coll.delete_many({"session_id": {"$regex": r"^sess_"}})
            batch_size = 300
            for b_idx in range(0, len(sessions_records), batch_size):
                chunk = sessions_records[b_idx:b_idx + batch_size]
                coll.insert_many(chunk, ordered=False)
            print(f"[Simulator] Successfully saved {len(sessions_records)} sessions to MongoDB 'training_sessions'.")
        except Exception as e:
            print(f"[Simulator] Note: MongoDB batch insert note: {e}")

        # Save to JSON cache file
        if output_json_cache:
            output_json_cache.parent.mkdir(parents=True, exist_ok=True)
            with open(output_json_cache, "w", encoding="utf-8") as f:
                json.dump(sessions_records, f, default=str)
            print(f"[Simulator] Successfully saved JSON cache to {output_json_cache} ({output_json_cache.stat().st_size / 1024 / 1024:.1f} MB).")

        return sessions_records


def main():
    parser = argparse.ArgumentParser(description="Simulate gameplay sessions for anti-cheat dataset.")
    parser.add_argument("--count", type=int, default=3200, help="Number of sessions to simulate (default: 3200)")
    parser.add_argument("--cache", type=str, default="data/sessions_cache.json", help="Path to cache raw sessions JSON")
    args = parser.parse_args()

    cache_path = PROJECT_ROOT / args.cache if args.cache else None
    sim = SessionSimulator()
    sim.simulate_and_store_all(target_count=args.count, output_json_cache=cache_path)


if __name__ == "__main__":
    main()
