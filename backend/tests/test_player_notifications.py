from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from secrets import token_hex

from bson import ObjectId

from app import app
from database.db import login_history, player_notifications, sessions_db, users
from services.auth import hash_password
from services.player_notifications import notify_player


HEADERS = {"X-Requested-With": "XMLHttpRequest"}


def test_notification_delivery_preferences_and_security_lifecycle(monkeypatch):
    monkeypatch.setitem(app.config, "TESTING", True)
    monkeypatch.setitem(app.config, "RATELIMIT_ENABLED", False)
    now = datetime.now(timezone.utc)
    identities = []
    for _ in range(2):
        user_id, session_id = ObjectId(), ObjectId()
        identities.append((user_id, session_id))
        users.insert_one({
            "_id": user_id, "name": "Notification QA", "role": "player",
            "email": f"notice-{token_hex(5)}@example.test", "email_verified": True, "mfa_enabled": True,
            "account_status": "active", "active_auth_session_id": str(session_id),
            "password_hash": hash_password("LocalFixture@25"),
        })
        sessions_db.insert_one({
            "_id": session_id, "user_id": user_id, "is_active": True,
            "created_at": now, "last_activity": now, "device": "QA browser",
        })

    def browser_for(identity):
        browser = app.test_client()
        with browser.session_transaction() as account:
            account["user_id"] = str(identity[0])
            account["auth_session_record_id"] = str(identity[1])
        return browser

    owner = browser_for(identities[0])
    other = browser_for(identities[1])
    user_id, session_id = identities[0]
    path = "/api/player/notifications"

    try:
        assert app.test_client().get(path).status_code == 401
        methods = owner.put(path + "/preferences", json={"matches": False, "security": False}, headers=HEADERS)
        assert methods.status_code == 400
        assert owner.put(path + "/preferences", json={"matches": False}, headers=HEADERS).status_code == 200
        notify_player(user_id, "match_result", "disabled-optional-event")
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda _: notify_player(user_id, "suspicious_login", "same-security-event"), range(8)))
        player_notifications.insert_one({
            "user_id": user_id, "type": "warning", "read": False, "created_at": now,
            "message": "Legacy private details must not leave storage.",
        })
        note = owner.get(path + "?category=security&status=unread").get_json()
        assert note["unread_count"] == 2
        assert note["total"] == 1
        assert note["notifications"][0]["destination"] == "security"
        note_id = note["notifications"][0]["id"]
        assert owner.get(path + "?limit=1&page=2").get_json()["total"] == 2
        assert other.get(path).get_json()["notifications"] == []
        for action in ("read", "unread", "dismiss"):
            assert other.post(path + "/read", json={"action": action, "notification_ids": [note_id]}, headers=HEADERS).status_code == 200
        assert owner.get(path).get_json()["unread_count"] == 2
        for action, count in (("read", 1), ("unread", 2), ("dismiss", 1)):
            assert owner.post(path + "/read", json={"action": action, "notification_ids": [note_id]}, headers=HEADERS).status_code == 200
            assert owner.get(path).get_json()["unread_count"] == count
        assert owner.post(path + "/read", json={"mark_all": True}, headers=HEADERS).status_code == 200
        assert browser_for(identities[0]).get(path).get_json()["unread_count"] == 0
        assert browser_for(identities[0]).get(path + "/preferences").get_json()["preferences"]["matches"] is False

        obsolete_session = sessions_db.insert_one({"user_id": user_id, "is_active": True, "created_at": now, "last_activity": now}).inserted_id
        login_history.insert_one({"user_id": user_id, "type": "login_failed", "status": "failed", "created_at": now})
        protection = owner.get("/api/player/security").get_json()
        assert protection["mfa_status"] == "enabled"
        assert protection["recovery_email"].startswith("n•••@")
        assert protection["login_history"][0]["success"] is False
        assert any(row["id"] == str(session_id) and row["is_current"] for row in protection["active_sessions"])
        revoke = f"/api/player/sessions/{obsolete_session}/revoke"
        assert other.post(revoke, headers=HEADERS).status_code == 404
        assert owner.post(revoke, headers=HEADERS).status_code == 200
        assert not sessions_db.find_one({"_id": obsolete_session})["is_active"]
        rotated = owner.post("/api/auth/recovery-codes/generate", json={"password": "LocalFixture@25"}, headers=HEADERS)
        assert rotated.status_code == 200
        assert len(rotated.get_json()["recovery_codes"]) == 8
        assert rotated.headers["Cache-Control"] == "no-store"
        notices = owner.get(path).get_json()
        assert any(row["type"] == "recovery_codes_rotated" for row in notices["notifications"])
        assert all(code not in str(notices) for code in rotated.get_json()["recovery_codes"])
    finally:
        ids = [identity[0] for identity in identities]
        player_notifications.delete_many({"user_id": {"$in": ids}})
        login_history.delete_many({"user_id": {"$in": ids}})
        sessions_db.delete_many({"user_id": {"$in": ids}})
        users.delete_many({"_id": {"$in": ids}})
