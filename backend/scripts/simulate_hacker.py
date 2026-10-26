"""Send development-only hacker telemetry through the real HTTP API."""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pyotp
from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))
load_dotenv(BACKEND_DIR / ".env")

PROFILES = {
    "aimbot": "hacker_aimbot@example.test",
    "wallhack": "hacker_wallhack@example.test",
    "speedhack": "hacker_speed@example.test",
    "silent_aim": "hacker_silent@example.test",
}
DEVELOPMENT_ENVS = {"development", "dev", "local"}


class ApiClient:
    def __init__(self, base_url):
        self.base_url = base_url.rstrip("/")
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor()
        )

    def post(self, path, payload):
        body = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with self.opener.open(request) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"{path} returned {error.code}: {detail}") from error


def login(client, password, mfa_secret, email):
    status, result = client.post("/auth/login", {"email": email, "password": password})
    if status != 200 or not result.get("mfa_required"):
        raise RuntimeError(f"Password login failed for {email}: {result}")
    status, result = client.post(
        "/auth/verify-mfa",
        {"code": pyotp.TOTP(mfa_secret).now()},
    )
    if status != 200:
        raise RuntimeError(f"MFA login failed for {email}: {result}")


def profile_events(profile):
    common = [
        ("game_started", {}),
        ("player_behavior", {"speed": 2.5}),
        ("aim_behavior", {"rotation_change": 0.02}),
    ]
    if profile == "aimbot":
        common[1] = ("player_behavior", {"speed": 2.0, "reaction_time_ms": 35})
        common[2] = ("aim_behavior", {
            "rotation_change": 0.001,
            "flick_speed_degrees_per_second": 7200,
            "headshot": True,
        })
    elif profile == "wallhack":
        common[2] = ("aim_behavior", {
            "rotation_change": 0.01,
            "line_of_sight": False,
            "tracking_through_walls": True,
            "pre_aim_hidden_target": True,
        })
    elif profile == "speedhack":
        common[1] = ("player_behavior", {
            "speed": 45.0,
            "teleport": True,
            "position": [1000, 1000, 1000],
        })
    elif profile == "silent_aim":
        common[2] = ("aim_behavior", {
            "rotation_change": 0.0,
            "crosshair_on_target": False,
            "silent_aim": True,
        })

    events = common[:]
    for index in range(20):
        hit_telemetry = {
            "target_id": f"{profile}-enemy-{index}",
            "damage": 100,
            "headshot": profile == "aimbot",
            "line_of_sight": profile != "wallhack",
            "crosshair_on_target": profile != "silent_aim",
        }
        events.append(("weapon_fire", {"weapon": "demo-rifle"}))
        events.append(("enemy_hit", hit_telemetry))
        events.append(("enemy_killed", {
            "enemy": f"{profile}-enemy-{index}",
            "wallhack": profile == "wallhack",
        }))
        if index % 5 == 0:
            events.append(("player_behavior", {
                "speed": 45.0 if profile == "speedhack" else 2.0,
                "teleport": profile == "speedhack",
            }))
            events.append(("aim_behavior", {
                "rotation_change": 0.001 if profile in {"aimbot", "silent_aim"} else 0.01,
                "variance": 0.0001 if profile == "silent_aim" else 0.02,
            }))
    events.append(("player_death", {"cause": "demo"}))
    events.append(("game_completed", {}))
    return events


def run_profile(profile, delay):
    password = os.getenv("HACKER_DEMO_PASSWORD", "")
    mfa_secret = os.getenv("HACKER_DEMO_MFA_SECRET", "").strip()
    if not password or not mfa_secret:
        raise RuntimeError("Set HACKER_DEMO_PASSWORD and HACKER_DEMO_MFA_SECRET.")

    client = ApiClient(os.getenv("HACKER_DEMO_BASE_URL", "http://127.0.0.1:5000/api"))
    email = PROFILES[profile]
    login(client, password, mfa_secret, email)
    _, started = client.post("/game/start", {})
    session_id = started["session_id"]
    game_token = started["game_token"]
    print(f"{profile}: started {session_id}")

    for event_type, telemetry in profile_events(profile):
        _, response = client.post("/game-events", {
            "game_token": game_token,
            "session_id": session_id,
            "event_type": event_type,
            "game": "FPS_Microgame",
            "telemetry": telemetry,
        })
        detection = response.get("realtime_detection")
        if detection and detection.get("enforcement_action") not in {None, "none"}:
            print(f"{profile}: {detection}")
        if event_type != "game_completed":
            time.sleep(delay)
    print(f"{profile}: completed {session_id}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("profile", choices=[*PROFILES, "all"])
    parser.add_argument("--fast", action="store_true", help="Run at demo speed.")
    args = parser.parse_args()
    if os.getenv("APP_ENV", "").strip().lower() not in DEVELOPMENT_ENVS:
        raise SystemExit("Hacker simulation is blocked outside development mode.")
    delay = 0.05 if args.fast else 0.2
    profiles = list(PROFILES) if args.profile == "all" else [args.profile]
    for index, profile in enumerate(profiles):
        if index:
            time.sleep(2)
        run_profile(profile, delay)


if __name__ == "__main__":
    main()
