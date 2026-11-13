"""
SecureFPS: Arena Relay Server (backend/arena_relay.py)
Provides real-time event relay, validation, and session telemetry recording
for WebGL Arena clients (frontend/js/arena.js) and scripted simulation clients.
"""

import asyncio
import json
import logging
import os
import sys
import time
from datetime import datetime, timezone
from typing import Dict, Any, Optional, Set

from database.db import db, game_telemetry, game_sessions
from services.telemetry_validation import validate_telemetry_event, check_rate_limit, clear_session_limits

logging.basicConfig(level=logging.INFO, format="[ArenaRelay] %(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger("ArenaRelay")

DEFAULT_RELAY_HOST = os.getenv("ARENA_RELAY_HOST", "0.0.0.0")
DEFAULT_RELAY_PORT = int(os.getenv("ARENA_RELAY_PORT", "8765"))


class ArenaRelay:
    def __init__(self, record_all: bool = False):
        self.record_all = record_all
        self.active_sessions: Dict[str, Dict[str, Any]] = {}
        self.connected_clients: Set[Any] = set()

    def register_session(
        self,
        session_id: str,
        user_id: Optional[str] = None,
        player_group: Optional[str] = None,
        source: str = "simulated",
        cheat_type: str = "none",
        strength: float = 0.0,
        label: int = 0,
        record_session: bool = False,
    ) -> Dict[str, Any]:
        """Register or configure a match session."""
        session_data = {
            "session_id": session_id,
            "user_id": user_id or f"sim_{player_group or 'anon'}",
            "player_group": player_group or "group_default",
            "source": source,
            "cheat_type": cheat_type,
            "strength": float(strength),
            "label": int(label),
            "record_session": record_session or self.record_all,
            "started_at": datetime.now(timezone.utc),
            "events_count": 0,
            "events": [],
        }
        self.active_sessions[session_id] = session_data

        # Store or update session in MongoDB
        try:
            game_sessions.update_one(
                {"session_id": session_id},
                {
                    "$set": {
                        "session_id": session_id,
                        "user_id": session_data["user_id"],
                        "player_group": session_data["player_group"],
                        "source": source,
                        "cheat_type": cheat_type,
                        "strength": float(strength),
                        "label": int(label),
                        "record_session": session_data["record_session"],
                        "status": "active",
                        "game": "WebGL_Arena",
                        "created_at": datetime.now(timezone.utc),
                    }
                },
                upsert=True,
            )
        except Exception as e:
            logger.warning(f"Could not upsert session in MongoDB: {e}")

        return session_data

    def process_event(self, session_id: str, event_type: str, telemetry: Dict[str, Any]) -> Dict[str, Any]:
        """
        Validate, rate-limit, and process an inbound telemetry event.
        Returns a response status dict.
        """
        session_data = self.active_sessions.get(session_id)
        if not session_data:
            session_data = self.register_session(session_id)

        # 1. Rate limit check
        allowed, rl_err = check_rate_limit(session_id, event_type)
        if not allowed:
            return {"status": "rate_limited", "error": rl_err, "code": 429}

        # 2. Schema and range validation
        valid, val_err = validate_telemetry_event(event_type, telemetry)
        if not valid:
            return {"status": "invalid_telemetry", "error": val_err, "code": 400}

        # Ensure seq and timestamp exist
        session_data["events_count"] += 1
        seq = telemetry.get("seq", session_data["events_count"])
        ts = telemetry.get("timestamp", time.time())
        telemetry["seq"] = seq
        telemetry["timestamp"] = ts

        event_doc = {
            "session_id": session_id,
            "user_id": session_data["user_id"],
            "player_group": session_data.get("player_group"),
            "source": session_data.get("source"),
            "cheat_type": session_data.get("cheat_type"),
            "strength": session_data.get("strength"),
            "label": session_data.get("label"),
            "game": "WebGL_Arena",
            "event_type": event_type,
            "telemetry": telemetry,
            "seq": seq,
            "timestamp": ts,
            "created_at": datetime.now(timezone.utc),
        }

        # Cache in memory
        session_data["events"].append(event_doc)

        # Store to MongoDB
        try:
            game_telemetry.insert_one(event_doc)
        except Exception as e:
            logger.debug(f"Failed to insert telemetry to MongoDB: {e}")

        # If game completed, finalize
        if event_type == "game_completed":
            self.finalize_session(session_id)

        return {"status": "accepted", "code": 200, "seq": seq}

    def finalize_session(self, session_id: str) -> Optional[Dict[str, Any]]:
        """Mark session completed and persist to training_sessions if flagged."""
        session_data = self.active_sessions.get(session_id)
        if not session_data:
            return None

        clear_session_limits(session_id)
        session_data["ended_at"] = datetime.now(timezone.utc)

        try:
            game_sessions.update_one(
                {"session_id": session_id},
                {"$set": {"status": "completed", "ended_at": session_data["ended_at"]}},
            )

            # If recording is enabled or flagged for training collection
            if session_data.get("record_session"):
                training_doc = {
                    "session_id": session_id,
                    "user_id": session_data["user_id"],
                    "player_group": session_data["player_group"],
                    "source": session_data.get("source", "simulated"),
                    "cheat_type": session_data.get("cheat_type", "none"),
                    "strength": session_data.get("strength", 0.0),
                    "label": session_data.get("label", 0),
                    "events_count": len(session_data["events"]),
                    "events": session_data["events"],
                    "created_at": session_data["started_at"],
                    "completed_at": session_data["ended_at"],
                }
                db["training_sessions"].update_one(
                    {"session_id": session_id},
                    {"$set": training_doc},
                    upsert=True,
                )
        except Exception as e:
            logger.warning(f"Error finalizing session in MongoDB: {e}")

        return session_data

    async def handle_ws_client(self, websocket):
        """Handle incoming WebSocket connection from Arena or scripted client."""
        self.connected_clients.add(websocket)
        session_id = None
        try:
            async for raw_message in websocket:
                try:
                    msg = json.loads(raw_message)
                except Exception:
                    await websocket.send(json.dumps({"error": "Invalid JSON"}))
                    continue

                msg_type = msg.get("action") or msg.get("type")
                if msg_type == "register_session":
                    session_id = msg.get("session_id")
                    session_data = self.register_session(
                        session_id=session_id,
                        user_id=msg.get("user_id"),
                        player_group=msg.get("player_group"),
                        source=msg.get("source", "simulated"),
                        cheat_type=msg.get("cheat_type", "none"),
                        strength=msg.get("strength", 0.0),
                        label=msg.get("label", 0),
                        record_session=msg.get("record_session", False),
                    )
                    await websocket.send(json.dumps({"status": "registered", "session_id": session_id}))

                elif msg_type == "telemetry_event":
                    sid = msg.get("session_id") or session_id
                    event_type = msg.get("event_type")
                    telemetry = msg.get("telemetry", {})
                    resp = self.process_event(sid, event_type, telemetry)
                    await websocket.send(json.dumps(resp))

                elif msg_type == "ping":
                    await websocket.send(json.dumps({"type": "pong", "time": time.time()}))

        except Exception as e:
            logger.debug(f"WS client exception: {e}")
        finally:
            self.connected_clients.discard(websocket)
            if session_id and session_id in self.active_sessions:
                clear_session_limits(session_id)


# Global relay instance
relay_instance = ArenaRelay()


async def start_server(host: str = DEFAULT_RELAY_HOST, port: int = DEFAULT_RELAY_PORT):
    import websockets
    logger.info(f"Starting Arena Relay Server on ws://{host}:{port}")
    async with websockets.serve(relay_instance.handle_ws_client, host, port):
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    host = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_RELAY_HOST
    port = int(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_RELAY_PORT
    try:
        asyncio.run(start_server(host, port))
    except KeyboardInterrupt:
        logger.info("Arena relay server stopped.")
