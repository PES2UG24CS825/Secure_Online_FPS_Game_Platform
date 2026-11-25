import hashlib
import os
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4
from zipfile import ZIP_DEFLATED, ZipFile

import pytest


def _isolated_backend():
    database = os.environ.get("MONGO_DB", "")
    host = urlsplit(os.environ.get("MONGO_URI", "")).hostname
    if not database.startswith("securefps_rewards_test_") or host not in {
        "127.0.0.1", "localhost", "::1",
    }:
        pytest.skip("Requires a dedicated securefps_rewards_test_* loopback database")

    from app import app
    from database.db import (
        game_sessions,
        game_telemetry,
        matches,
        reward_transactions,
        sessions_db,
        users,
    )

    assert app
    return app, game_sessions, game_telemetry, matches, reward_transactions, sessions_db, users


def _authenticated_client(app, users, sessions_db, suffix):
    from bson import ObjectId

    user_id = ObjectId()
    session_id = ObjectId()
    now = datetime.now(timezone.utc)
    users.insert_one({
        "_id": user_id,
        "name": f"Reliability Test {suffix}",
        "email": f"reliability-{suffix}@test.invalid",
        "role": "player",
        "account_status": "active",
        "rewards": {"coins": 40, "xp": 100, "owned_items": []},
    })
    sessions_db.insert_one({
        "_id": session_id,
        "user_id": user_id,
        "is_active": True,
        "created_at": now,
        "last_activity": now,
    })
    users.update_one(
        {"_id": user_id},
        {"$set": {"active_auth_session_id": str(session_id)}},
    )
    client = app.test_client()
    client.environ_base["HTTP_X_REQUESTED_WITH"] = "XMLHttpRequest"
    with client.session_transaction() as state:
        state["user_id"] = str(user_id)
        state["auth_session_record_id"] = str(session_id)
    return client, user_id


def test_daily_claim_recovers_interrupted_ledger_write_without_double_credit(monkeypatch):
    app, _, _, _, reward_transactions, sessions_db, users = _isolated_backend()
    from routes import player_routes

    suffix = uuid4().hex
    client, user_id = _authenticated_client(app, users, sessions_db, suffix)

    class FailFirstLedgerWrite:
        def __init__(self, collection):
            self.collection = collection
            self.fail = True

        def __getattr__(self, name):
            if name != "update_one":
                return getattr(self.collection, name)

            def update_one(*args, **kwargs):
                if self.fail:
                    self.fail = False
                    raise RuntimeError("Simulated interruption after balance credit")
                return self.collection.update_one(*args, **kwargs)

            return update_one

    monkeypatch.setattr(
        player_routes,
        "reward_transactions",
        FailFirstLedgerWrite(reward_transactions),
    )

    interrupted = client.post("/api/player/rewards/claim-daily")
    assert interrupted.status_code == 503
    after_interruption = users.find_one({"_id": user_id})["rewards"]
    assert (after_interruption["coins"], after_interruption["xp"]) == (65, 125)
    assert len([row for row in after_interruption["activity"] if row.get("type") == "daily_login"]) == 1

    retried = client.post("/api/player/rewards/claim-daily")
    assert retried.status_code == 200
    assert retried.get_json()["claimed"] is False
    assert client.post("/api/player/rewards/claim-daily").status_code == 200

    final_rewards = users.find_one({"_id": user_id})["rewards"]
    assert (final_rewards["coins"], final_rewards["xp"]) == (65, 125)
    claim_id = next(
        row["claim_id"] for row in final_rewards["activity"]
        if row.get("type") == "daily_login"
    )
    assert reward_transactions.count_documents({"_id": claim_id, "user_id": user_id}) == 1


def test_legacy_match_summaries_and_telemetry_resolve_once_in_isolated_database():
    app, game_sessions, game_telemetry, matches, _, sessions_db, users = _isolated_backend()
    from bson import ObjectId

    suffix = uuid4().hex
    client, user_id = _authenticated_client(app, users, sessions_db, suffix)
    now = datetime.now(timezone.utc)
    shared_session_id = f"shared-{suffix}"
    legacy_session_id = f"legacy-{suffix}"

    game_sessions.insert_one({
        "session_id": shared_session_id,
        "user_id": user_id,
        "status": "completed",
        "kills": 4,
        "deaths": 1,
        "shots_fired": 10,
        "shots_hit": 4,
        "started_at": now,
        "ended_at": now,
    })
    matches.insert_many([
        {
            "_id": ObjectId(),
            "session_id": shared_session_id,
            "user_id": user_id,
            "kills": 4,
            "deaths": 1,
            "shots": 10,
            "hits": 4,
            "created_at": now,
        },
        {
            "_id": ObjectId(),
            "session_id": legacy_session_id,
            "user_id": user_id,
            "kills": 2,
            "deaths": 1,
            "shots": 5,
            "hits": 2,
            "created_at": now,
        },
    ])
    for session_id, kills, deaths, shots, hits in (
        (shared_session_id, 4, 1, 10, 4),
        (legacy_session_id, 2, 1, 5, 2),
    ):
        events = (
            ["enemy_killed"] * kills
            + ["player_death"] * deaths
            + ["weapon_fire"] * shots
            + ["enemy_hit"] * hits
        )
        game_telemetry.insert_many([
            {
                "user_id": user_id,
                "session_id": session_id,
                "event_type": event_type,
                "timestamp": now,
            }
            for event_type in events
        ])

    response = client.get("/api/player/stats")
    assert response.status_code == 200
    stats = response.get_json()
    assert stats["total_matches"] == 2
    assert (stats["kills"], stats["deaths"], stats["kdr"]) == (6, 2, 3.0)
    assert (stats["shots_fired"], stats["shots_hit"], stats["accuracy"]) == (15, 6, 40.0)
    assert stats["shots_fired_coverage"] == "complete"
    assert stats["shots_hit_coverage"] == "complete"


def test_local_completion_persists_metrics_and_retry_counts_once():
    app, game_sessions, game_telemetry, _, _, sessions_db, users = _isolated_backend()
    client, user_id = _authenticated_client(app, users, sessions_db, uuid4().hex)
    start = client.post("/api/game/start", json={"mode": "bots"}).get_json()
    session_id = start["session_id"]
    payload = {
        "session_id": session_id, "game_token": start["game_token"], "event_type": "game_completed",
        "telemetry": {"kills": 2, "deaths": 0, "shots": 4, "hits": 2, "headshots": 1},
    }
    assert client.post("/api/game-events", json=payload).status_code == 201
    assert client.post("/api/game-events", json=payload).status_code == 200
    assert client.post("/api/game/end", json={"session_id": session_id, "completed": True}).status_code == 200
    stored = game_sessions.find_one({"session_id": session_id, "user_id": user_id})
    assert (stored["status"], stored["stats_source"], stored["kills"], stored["accuracy"]) == (
        "completed", "local_client", 2, 0.5,
    )
    assert game_telemetry.count_documents({"session_id": session_id, "event_type": "game_completed"}) == 1
    stats = client.get("/api/player/stats").get_json()
    assert (stats["total_matches"], stats["accuracy"], stats["headshot_percentage"]) == (1, 50.0, 50.0)


def test_server_confirmed_shot_telemetry_is_idempotent():
    app, game_sessions, game_telemetry, _, _, sessions_db, users = _isolated_backend()
    suffix = uuid4().hex
    client, user_id = _authenticated_client(app, users, sessions_db, suffix)
    session_id = f"confirmed-shot-{suffix}"
    game_token = uuid4().hex
    game_sessions.insert_one({
        "session_id": session_id,
        "game_token": game_token,
        "user_id": user_id,
        "status": "active",
    })
    payload = {
        "session_id": session_id,
        "game_token": game_token,
        "event_type": "weapon_fire",
        "game": "CyberStrike_3D",
        "telemetry": {"shot_id": "server-shot-1", "weapon": "P-24 Carbine"},
    }

    first = client.post("/api/game-events", json=payload)
    duplicate = client.post("/api/game-events", json=payload)

    assert first.status_code == 201
    assert duplicate.status_code == 200
    assert duplicate.get_json()["status"] == "duplicate_ignored"
    assert game_telemetry.count_documents({
        "session_id": session_id,
        "event_type": "weapon_fire",
    }) == 1
    assert game_sessions.find_one({"session_id": session_id})["event_count"] == 1


def test_index_creation_failures_are_independent(monkeypatch):
    _, _, _, _, _, _, _ = _isolated_backend()
    import database.db as database_module
    from pymongo.collection import Collection

    attempted = []

    def create_index(self, keys, **options):
        attempted.append(self.name)
        if self.name == "game_sessions":
            raise RuntimeError("Simulated index-specific failure")
        return "test-index"

    monkeypatch.setattr(Collection, "create_index", create_index)
    database_module.init_indexes()

    assert attempted.count("game_sessions") == 2
    assert "game_telemetry" in attempted
    assert "admin_audit_log" in attempted


def test_backup_listing_validation_requires_a_real_intact_archive(tmp_path):
    from bson import BSON
    from services.database_backup import archive_is_recoverable

    archive_path = tmp_path / "real-backup.zip"
    with ZipFile(archive_path, "w", ZIP_DEFLATED) as archive:
        archive.writestr("collections/0.bson", b"")
        archive.writestr(
            "manifest.bson",
            BSON.encode({
                "database": "test",
                "collections": {
                    "users": {"entry": "collections/0.bson", "count": 0},
                },
            }),
        )
    checksum = "sha256:" + hashlib.sha256(archive_path.read_bytes()).hexdigest()

    assert archive_is_recoverable(tmp_path, archive_path.name, checksum)
    assert archive_path.exists(), "Validation must preserve real backups"
    assert not archive_is_recoverable(tmp_path, "seeded-record.zip", checksum)
