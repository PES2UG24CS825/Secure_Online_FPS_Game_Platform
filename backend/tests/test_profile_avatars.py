from datetime import datetime, timezone
from io import BytesIO
from uuid import uuid4

import pyotp
from bson import ObjectId
from PIL import Image

from app import app
from database.db import login_history, sessions_db, users
from services.auth import hash_password


def test_all_chibi_avatars_persist_through_login_and_reach_leaderboard(monkeypatch):
    monkeypatch.setitem(app.config, "TESTING", True)
    monkeypatch.setitem(app.config, "RATELIMIT_ENABLED", False)
    user_id = ObjectId()
    email = f"avatar-qa-{uuid4().hex}@example.test"
    password = uuid4().hex
    authenticator = pyotp.TOTP(pyotp.random_base32())
    users.insert_one({
        "_id": user_id, "name": "Avatar QA", "email": email, "email_verified": True,
        "role": "player", "account_status": "active", "mfa_enabled": True,
        "mfa_secret": authenticator.secret, "password_hash": hash_password(password),
        "created_at": datetime.now(timezone.utc),
        "profile_customization": {"avatar": "robot", "banner": "frontline"},
        "rewards": {"owned_items": ["skin_ghost_specops"]},
    })

    def login():
        browser = app.test_client()
        assert browser.post("/api/auth/login", json={"email": email, "password": password}).status_code == 200
        assert browser.post("/api/auth/verify-mfa", json={"code": authenticator.now()}).status_code == 200
        return browser

    try:
        browser = login()
        profile = browser.get("/api/player/profile").get_json()
        assert profile["avatar"]["key"] == "default-operator"
        options = profile["avatar_options"]
        assert "ghost-specops" in {option["key"] for option in options}
        assert "robot" not in {option["key"] for option in options}
        chibis = [option for option in options if option["name"].startswith("Chibi Version ")]
        assert [(option["name"], option["key"]) for option in chibis] == [
            ("Chibi Version 1", "chibi-male-1"),
            ("Chibi Version 2", "chibi-male-2"),
            ("Chibi Version 3", "chibi-female-1"),
            ("Chibi Version 4", "chibi-female-2"),
        ]

        for option in chibis:
            image_response = browser.get(option["src"])
            assert image_response.status_code == 200
            with Image.open(BytesIO(image_response.data)) as image:
                assert image.format == "PNG"
                assert image.size == (320, 320)
                image.verify()

            saved = browser.put(
                "/api/player/profile/customization", json={"avatar": option["key"], "banner": "frontline"},
                headers={"X-Requested-With": "XMLHttpRequest"},
            )
            assert saved.status_code == 200, saved.get_json()
            assert saved.get_json()["avatar"] == option
            assert users.find_one({"_id": user_id})["profile_customization"]["avatar"] == option["key"]
            assert browser.get("/api/player/profile").get_json()["avatar"] == option

            assert browser.post("/api/auth/logout").status_code == 200
            browser = login()
            refreshed = browser.get("/api/player/profile").get_json()
            assert refreshed["avatar"] == option
            assert refreshed["profile_customization"]["banner"] == "frontline"
            leaderboard = browser.get("/api/player/leaderboard").get_json()
            assert leaderboard["current_player"]["avatar"] == option
    finally:
        sessions_db.delete_many({"user_id": user_id})
        login_history.delete_many({"user_id": user_id})
        users.delete_one({"_id": user_id})
