import importlib
import unittest
import uuid

from app import app
from database import db as database
from services.auth import hash_password


class PermanentBanTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()
        self.email = f"banned-{uuid.uuid4().hex}@example.test"
        self.user_id = database.users.insert_one({
            "name": "Banned Demo",
            "email": self.email,
            "password_hash": hash_password("Pass123!"),
            "mfa_secret": "JBSWY3DPEHPK3PXP",
            "mfa_enabled": True,
            "role": "player",
            "revoked": True,
            "account_status": "banned",
        }).inserted_id

    def tearDown(self):
        database.users.delete_one({"_id": self.user_id})

    def test_banned_user_cannot_log_in(self):
        response = self.client.post(
            "/api/auth/login",
            json={"email": self.email, "password": "Pass123!"},
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.get_json()["message"], "This account is permanently banned.")

    def test_banned_user_cannot_send_events_or_open_live_stream(self):
        with self.client.session_transaction() as browser_session:
            browser_session["user_id"] = str(self.user_id)
        event = self.client.post(
            "/api/game-events",
            json={"game_token": "invalid", "session_id": "invalid", "event_type": "weapon_fire"},
        )
        self.assertEqual(event.status_code, 403)
        with self.client.session_transaction() as browser_session:
            browser_session["user_id"] = str(self.user_id)
        live = self.client.get("/api/live/events")
        self.assertEqual(live.status_code, 403)

    def test_ban_state_is_still_present_after_app_reload(self):
        import app as app_module

        importlib.reload(app_module)
        persisted = database.users.find_one({"_id": self.user_id})
        self.assertTrue(persisted["revoked"])
        self.assertEqual(persisted["account_status"], "banned")


if __name__ == "__main__":
    unittest.main()
