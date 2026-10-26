import uuid
import unittest

import pyotp

from app import app
from database import db
from services.auth import hash_password


class AuthSessionRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.client_a = app.test_client()
        self.client_b = app.test_client()
        self.email = f"session-{uuid.uuid4().hex}@example.test"
        self.secret = "JBSWY3DPEHPK3PXP"
        self.user_id = db.users.insert_one({
            "name": "Session Recovery Test",
            "email": self.email,
            "password_hash": hash_password("Pass123!"),
            "mfa_secret": self.secret,
            "mfa_enabled": True,
            "role": "player",
        }).inserted_id

    def tearDown(self):
        db.sessions_db.delete_many({"user_id": self.user_id})
        db.users.delete_one({"_id": self.user_id})

    def _login(self, client, takeover=False):
        response = client.post(
            "/api/auth/login",
            json={
                "email": self.email,
                "password": "Pass123!",
                **({"takeover": True} if takeover else {}),
            },
        )
        self.assertEqual(response.status_code, 200)
        return client.post(
            "/api/auth/verify-mfa",
            json={"code": pyotp.TOTP(self.secret).now()},
        )

    def test_second_browser_can_explicitly_take_over_session(self):
        self._login(self.client_a)
        conflict = self.client_b.post(
            "/api/auth/login",
            json={"email": self.email, "password": "Pass123!"},
        )
        self.assertEqual(conflict.status_code, 409)
        self.assertTrue(conflict.get_json()["can_takeover"])

        self.assertEqual(self._login(self.client_b, takeover=True).status_code, 200)
        self.assertEqual(self.client_a.get("/api/auth/me").status_code, 401)

    def test_logout_clears_account_lock(self):
        self._login(self.client_a)
        self.assertEqual(self.client_a.post("/api/auth/logout").status_code, 200)
        self.assertIsNone(
            db.users.find_one({"_id": self.user_id}).get("active_auth_session_id")
        )


if __name__ == "__main__":
    unittest.main()
