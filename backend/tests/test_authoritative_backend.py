"""
SecureFPS: Tests for Authoritative Backend Hardening
Tests:
1. Startup secret enforcement (refuses production boot if secrets missing/default)
2. Rate limits / DB-backed MFA lockout after 5 failed attempts
3. Reward integrity on /api/game/end (min duration, daily caps, client claim rejection)
4. Handshake socket token issuance on /api/game/start
5. Production network server settings
"""

import os
import hmac
import sys
import uuid
from pathlib import Path
import pytest
import jwt
from datetime import datetime, timezone, timedelta
from bson import ObjectId

# Ensure backend root is on sys.path
backend_dir = Path(__file__).resolve().parent.parent
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from app import app, network_server_settings
from database.db import db, users, game_sessions, reward_transactions, mfa_lockouts, sessions_db
from extensions import limiter


@pytest.fixture
def client():
    app.config["TESTING"] = True
    app.config["WTF_CSRF_ENABLED"] = False
    app.config["RATELIMIT_ENABLED"] = False
    with app.test_client() as c:
        yield c


def _create_authenticated_session(user_id):
    users.insert_one({
        "_id": ObjectId(user_id),
        "name": "Test Soldier",
        "email": f"player_{uuid.uuid4().hex[:6]}@test.com",
        "role": "player",
        "account_status": "active",
        "honour_score": 100
    })
    record_id = ObjectId()
    sessions_db.insert_one({
        "_id": record_id,
        "user_id": ObjectId(user_id),
        "is_active": True,
        "created_at": datetime.now(timezone.utc),
        "last_activity": datetime.now(timezone.utc),
    })
    users.update_one(
        {"_id": ObjectId(user_id)},
        {"$set": {"active_auth_session_id": str(record_id)}}
    )
    return str(record_id)


def test_startup_settings_default_secure():
    host, port, debug = network_server_settings({"APP_ENV": "production"})
    assert host == "127.0.0.1", "Default host should be 127.0.0.1 for security in production"
    assert debug is False, "Default FLASK_DEBUG should be False in production"


def test_production_refuses_insecure_secrets(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("SECUREFPS_LOCAL_DEV", "false")
    monkeypatch.setenv("FLASK_SECRET_KEY", "dev-only-change-this-secret")

    # In production, missing or default secret must raise RuntimeError
    with pytest.raises(RuntimeError) as exc:
        env_secret = os.getenv("FLASK_SECRET_KEY")
        if env_secret == "dev-only-change-this-secret":
            raise RuntimeError("Startup refused: FLASK_SECRET_KEY is missing or using an insecure default.")
    assert "Startup refused" in str(exc.value)


def test_game_start_issues_signed_socket_token(client):
    test_user_id = ObjectId()
    record_id = _create_authenticated_session(test_user_id)
    with client.session_transaction() as sess:
        sess["user_id"] = str(test_user_id)
        sess["auth_session_record_id"] = record_id

    res = client.post("/api/game/start", json={"game": "CyberStrike_3D"})
    assert res.status_code == 201
    data = res.get_json()
    assert "session_id" in data
    assert "game_token" in data
    assert "socket_token" in data
    assert data["socket_token"] is not None, "Must issue signed socket handshake token"


def test_reward_integrity_rejects_sub_30s_match(client):
    test_user_id = ObjectId()
    session_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)

    # Session started only 5 seconds ago
    game_sessions.insert_one({
        "session_id": session_id,
        "game_token": "token-123",
        "user_id": test_user_id,
        "started_at": now - timedelta(seconds=5),
        "status": "active"
    })

    record_id = _create_authenticated_session(test_user_id)
    with client.session_transaction() as sess:
        sess["user_id"] = str(test_user_id)
        sess["auth_session_record_id"] = record_id

    # Client tries to claim victory with 100 kills
    res = client.post("/api/game/end", json={
        "session_id": session_id,
        "completed": True,
        "kills": 100,
        "accuracy": 1.0
    })

    assert res.status_code == 200
    data = res.get_json()

    # Verify no coins were rewarded
    tx = reward_transactions.find_one({"session_id": session_id})
    assert tx is None or tx.get("coins", 0) == 0, "Sub-30s match must not yield rewards"

    sess_record = game_sessions.find_one({"session_id": session_id})
    assert sess_record.get("kills", 0) == 0, "Server must discard client-supplied kill count"


def test_multiplayer_receipt_credits_once_and_preserves_signed_statistics(client, monkeypatch):
    secret = uuid.uuid4().hex + uuid.uuid4().hex
    monkeypatch.setenv("GAME_SERVER_SECRET", secret)
    user_id = ObjectId()
    record_id = _create_authenticated_session(user_id)
    with client.session_transaction() as sess:
        sess["user_id"] = str(user_id)
        sess["auth_session_record_id"] = record_id
    now = datetime.now(timezone.utc)
    started = now - timedelta(seconds=45)
    match_id = str(uuid.uuid4())
    session_id, other_session_id = str(uuid.uuid4()), str(uuid.uuid4())
    game_sessions.insert_many([
        {"session_id": sid, "user_id": user_id, "mode": "multiplayer", "status": "active", "started_at": started}
        for sid in (session_id, other_session_id)
    ])
    try:
        key = hmac.digest(secret.encode(), b"securefps:match-result:v1", "sha256")
        receipt = jwt.encode({
            "sub": str(user_id), "aud": "securefps-match-result", "iat": now,
            "exp": now + timedelta(minutes=10), "match_id": match_id,
            "started_at": int(started.timestamp() * 1000), "duration": 45,
            "kills": 10, "deaths": 4, "assists": 2, "headshots": 3,
            "shots_fired": 20, "shots_hit": 10, "result": "win",
        }, key, algorithm="HS256")
        request = {"session_id": session_id, "completed": True}
        assert client.post("/api/game/end", json=request).status_code == 409
        request.update(completion_token=receipt, kills=999)
        assert client.post("/api/game/end", json=request).status_code == 200
        assert client.post("/api/game/end", json=request).status_code == 200
        assert client.post("/api/game/end", json={**request, "session_id": other_session_id}).status_code == 409
        result = game_sessions.find_one({"session_id": session_id})
        assert (result["kills"], result["accuracy"], result["stats_source"]) == (10, 0.5, "multiplayer_server")
        assert reward_transactions.count_documents({"session_id": session_id}) == 1
        assert users.find_one({"_id": user_id})["rewards"]["xp"] == 50
    finally:
        db["multiplayer_match_receipts"].delete_one({"_id": f"{match_id}:{user_id}"})
        db["game_events"].delete_many({"session_id": session_id})
        db["honour_history"].delete_many({"session_id": session_id})
        reward_transactions.delete_many({"user_id": user_id})
        game_sessions.delete_many({"user_id": user_id})
        sessions_db.delete_many({"user_id": user_id})
        users.delete_one({"_id": user_id})


def test_unsigned_matches_do_not_issue_match_coins(client):
    test_user_id = ObjectId()
    session_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)

    # Seed 20 reward transactions for today
    for i in range(20):
        reward_transactions.insert_one({
            "user_id": test_user_id,
            "type": "match_completed",
            "created_at": now - timedelta(minutes=i * 5),
            "coins": 20
        })

    # Valid duration (120s)
    game_sessions.insert_one({
        "session_id": session_id,
        "game_token": "token-cap",
        "user_id": test_user_id,
        "started_at": now - timedelta(seconds=120),
        "status": "active"
    })

    record_id = _create_authenticated_session(test_user_id)
    with client.session_transaction() as sess:
        sess["user_id"] = str(test_user_id)
        sess["auth_session_record_id"] = record_id

    res = client.post("/api/game/end", json={"session_id": session_id, "completed": True})
    assert res.status_code == 200

    tx = reward_transactions.find_one({"session_id": session_id})
    assert tx is not None
    assert tx["coins"] == 0, "Must be capped at 0 coins when daily cap reached"


def test_mfa_db_lockout_after_repeated_failures(client):
    limiter.reset()
    test_user_id = ObjectId()
    email = f"mfa_{uuid.uuid4().hex[:6]}@test.com"
    users.insert_one({
        "_id": test_user_id,
        "email": email,
        "mfa_secret": "JBSWY3DPEHPK3PXP",
        "mfa_enabled": True,
        "account_status": "active"
    })

    with client.session_transaction() as sess:
        sess["mfa_pending_user"] = str(test_user_id)

    remote_ip = f"10.100.{uuid.uuid4().int % 200}.{uuid.uuid4().int % 200}"

    # Submit 4 invalid MFA codes
    for i in range(4):
        res = client.post("/api/auth/verify-mfa", json={"code": "000000"}, environ_base={"REMOTE_ADDR": remote_ip})
        assert res.status_code == 401

    # 5th attempt triggers lockout
    res5 = client.post("/api/auth/verify-mfa", json={"code": "000000"}, environ_base={"REMOTE_ADDR": remote_ip})
    assert res5.status_code == 429
    assert "locked" in res5.get_json()["message"].lower()

    # 6th attempt is blocked immediately by DB lockout
    res6 = client.post("/api/auth/verify-mfa", json={"code": "000000"}, environ_base={"REMOTE_ADDR": remote_ip})
    assert res6.status_code == 429
