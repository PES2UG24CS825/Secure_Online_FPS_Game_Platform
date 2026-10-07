import unittest
import uuid

from bson import ObjectId

from app import app
from database.db import users, matches, detections, security_events, login_history


class SecureFPSAPITests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()
        self.email = f"player{uuid.uuid4().hex[:8]}@example.com"
        self.password = "Pass123!"

    def _create_player(self):
        resp = self.client.post(
            "/api/auth/signup",
            json={"name": "Test Player", "email": self.email, "password": self.password},
        )
        self.assertEqual(resp.status_code, 201, resp.get_data(as_text=True))
        user = users.find_one({"email": self.email})
        self.assertIsNotNone(user)
        return user

    def _login_as_user(self, email, password):
        resp = self.client.post(
            "/api/auth/login",
            json={"email": email, "password": password},
        )
        self.assertEqual(resp.status_code, 200, resp.get_data(as_text=True))
        data = resp.get_json()
        self.assertTrue(data.get("mfa_required"))

        user = users.find_one({"email": email})
        code = __import__("pyotp").TOTP(user["mfa_secret"]).now()
        resp = self.client.post("/api/auth/verify-mfa", json={"code": code})
        self.assertEqual(resp.status_code, 200, resp.get_data(as_text=True))
        return resp

    def test_player_routes_return_data(self):
        user = self._create_player()
        self._login_as_user(self.email, self.password)

        match_resp = self.client.get("/api/player/matches")
        self.assertEqual(match_resp.status_code, 200, match_resp.get_data(as_text=True))
        self.assertIsInstance(match_resp.get_json().get("matches", []), list)

        detections_resp = self.client.get("/api/player/detections")
        self.assertEqual(detections_resp.status_code, 200, detections_resp.get_data(as_text=True))
        self.assertIsInstance(detections_resp.get_json().get("detections", []), list)

        history_resp = self.client.get("/api/player/login-history")
        self.assertEqual(history_resp.status_code, 200, history_resp.get_data(as_text=True))
        self.assertIsInstance(history_resp.get_json().get("login_history", []), list)

    def test_admin_overview_returns_player_and_event_counts(self):
        admin = users.find_one({"email": "admin1@gmail.com"})
        self.assertIsNotNone(admin)

        client = self.client
        resp = client.post("/api/auth/login", json={"email": "admin1@gmail.com", "password": "Admin@12345"})
        self.assertEqual(resp.status_code, 200, resp.get_data(as_text=True))
        code = __import__("pyotp").TOTP(admin["mfa_secret"]).now()
        verify = client.post("/api/auth/verify-mfa", json={"code": code})
        self.assertEqual(verify.status_code, 200, verify.get_data(as_text=True))

        overview = client.get("/api/admin/overview")
        self.assertEqual(overview.status_code, 200, overview.get_data(as_text=True))
        data = overview.get_json()
        self.assertIn("players", data)
        self.assertIn("events", data)
        self.assertIn("summary", data)

    def test_player_cannot_access_admin_routes(self):
        user = self._create_player()
        self._login_as_user(self.email, self.password)

        admin_overview = self.client.get("/api/admin/overview")
        self.assertEqual(admin_overview.status_code, 403, admin_overview.get_data(as_text=True))

        action = self.client.post(f"/api/admin/players/{str(user['_id'])}/suspend")
        self.assertEqual(action.status_code, 403, action.get_data(as_text=True))

    def test_admin_cannot_access_player_routes(self):
        admin = users.find_one({"email": "admin1@gmail.com"})
        self.assertIsNotNone(admin)

        resp = self.client.post("/api/auth/login", json={"email": "admin1@gmail.com", "password": "Admin@12345"})
        self.assertEqual(resp.status_code, 200, resp.get_data(as_text=True))
        code = __import__("pyotp").TOTP(admin["mfa_secret"]).now()
        verify = self.client.post("/api/auth/verify-mfa", json={"code": code})
        self.assertEqual(verify.status_code, 200, verify.get_data(as_text=True))

        player_matches = self.client.get("/api/player/matches")
        self.assertEqual(player_matches.status_code, 403, player_matches.get_data(as_text=True))


if __name__ == "__main__":
    unittest.main()
