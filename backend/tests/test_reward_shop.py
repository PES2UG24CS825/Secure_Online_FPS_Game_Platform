"""Run with a dedicated loopback test database called securefps_rewards_test_*."""
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from uuid import uuid4
from urllib.parse import urlsplit

import pytest


def test_rewards_concurrency_equipment_permissions_and_retry():
    database = os.environ.get("MONGO_DB", "")
    host = urlsplit(os.environ.get("MONGO_URI", "")).hostname
    if not database.startswith("securefps_rewards_test_") or host not in {"127.0.0.1", "localhost", "::1"}:
        pytest.skip("Requires an explicit loopback MONGO_URI and a dedicated securefps_rewards_test_* database")
    # The test database must be explicit before importing the application.
    from bson import ObjectId
    from app import app
    from database.db import db, game_sessions, sessions_db, users
    from services.auth import hash_password
    from services.reward_catalog import catalog

    assert db.name == database
    app.config.update(TESTING=True, RATELIMIT_ENABLED=False)
    suffix = uuid4().hex
    item_ids = [f"reward-test-{suffix}-{kind}" for kind in ("avatar", "banner")]
    for key, slot in zip(item_ids, ("avatar", "banner")):
        catalog.insert_one({
            "_id": key, "item_id": key, "category": slot, "price": 100,
            "name": f"Test {slot}", "preview": f"/public/cosmetics/{'avatar-100.png' if slot == 'avatar' else 'background-100.jpg'}",
            "enabled": True,
        })

    def identity(role, **fields):
        now = datetime.now(timezone.utc)
        user = users.insert_one({
            "name": f"Reward test {role}", "email": f"{role}-{suffix}@test.invalid",
            "role": role, "account_status": "active", **fields,
        }).inserted_id
        record = sessions_db.insert_one({
            "user_id": user, "is_active": True, "last_activity": now, "created_at": now,
        }).inserted_id
        users.update_one({"_id": user}, {"$set": {"active_auth_session_id": str(record)}})
        return user, record

    player = identity("player", rewards={"coins": 250, "xp": 80, "owned_items": ["neon_badge"]})
    normal = identity("normal_admin")
    password = uuid4().hex
    super_admin = identity("super_admin", password_hash=hash_password(password))
    demo = identity("demo_admin")

    def client_for(account):
        client = app.test_client()
        client.environ_base["HTTP_X_REQUESTED_WITH"] = "XMLHttpRequest"
        with client.session_transaction() as state:
            state["user_id"], state["auth_session_record_id"] = map(str, account)
        return client

    def buy(_):
        return client_for(player).post(
            "/api/player/rewards/purchase", json={"item_id": item_ids[0], "price": 100}
        ).status_code

    with ThreadPoolExecutor(max_workers=4) as pool:
        assert sorted(pool.map(buy, range(4))) == [200, 409, 409, 409]
    browser = client_for(player)
    assert browser.post("/api/player/rewards/purchase", json={"item_id": item_ids[1], "price": 99}).status_code == 409
    assert browser.post("/api/player/rewards/purchase", json={"item_id": item_ids[1], "price": 100}).status_code == 200
    for item in item_ids:
        assert browser.post("/api/player/rewards/equip", json={"item_id": item}).status_code == 200
    refreshed = client_for(player).get("/api/player/rewards").get_json()
    assert refreshed["equipped_slots"] == dict(zip(("avatar", "banner"), item_ids))
    assert refreshed["coins"] == 50
    assert refreshed["xp"] == 80
    assert "neon_badge" in refreshed["owned_items"]
    assert sum(row["type"] == "purchase" for row in refreshed["transactions"]) == 2

    change = {"name": "Disabled test avatar", "price": 200, "enabled": False, "reason": "Disable for testing"}
    uri = f"/api/admin/rewards/shop/{item_ids[0]}"
    for account in (normal, demo):
        assert client_for(account).get("/api/admin/rewards/shop").status_code == 200
        assert client_for(account).put(uri, json=change).status_code == 403
    root = client_for(super_admin)
    assert root.put(uri, json=change).status_code == 200
    assert browser.post("/api/player/rewards/equip", json={"item_id": item_ids[0]}).status_code == 200
    adjust_uri = "/api/admin/rewards/adjustments"
    adjustment = {
        "player_id": str(player[0]), "coins": -10, "reason": "Correct test balance",
        "password": password, "request_id": uuid4().hex,
    }
    assert client_for(normal).post(adjust_uri, json=adjustment).status_code == 403
    assert root.post(adjust_uri, json=adjustment).status_code == 200
    assert root.post(adjust_uri, json=adjustment).status_code == 200

    match_id = ObjectId()
    game_sessions.insert_one({
        "_id": match_id, "user_id": player[0], "session_id": f"rewards-{suffix}", "status": "completed",
        "reward_credit": {"status": "failed", "transaction": {
            "type": "match_completed", "description": "Test match credit", "coins": 20, "xp": 50,
            "created_at": datetime.now(timezone.utc),
        }},
    })
    route = f"/api/admin/rewards/credits/{match_id}/retry"
    assert root.post(route).status_code == 200
    assert root.post(route).status_code == 200
    after_retry = browser.get("/api/player/rewards").get_json()
    assert (after_retry["coins"], after_retry["xp"]) == (60, 130)
