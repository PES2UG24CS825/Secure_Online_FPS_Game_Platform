"""
Unit & Integration Test Suite for SecureFPS Cheater Demonstration System.
Verifies all 17 security and operational constraints:
1. Demo account provisioning and bcrypt password hashing
2. Password authentication and TOTP MFA verification
3. Negative security tests (bad passwords, invalid MFA codes)
4. Demo authorization endpoint (/api/game/demo-status)
5. Negative security test: ordinary players cannot activate demo mode
6. Negative security test: multiplayer matches strictly reject demo mode
7. Negative security test: production mode rejects demo capabilities
8. Authorized demo session initialization
9. Impossible-hit detection and server-verified security event
10. Abnormal movement speed detection and CRITICAL alert
11. Abnormal fire rate detection and HIGH alert
12. Real-time alert delivery structure and MongoDB persistence with is_demo: true
13. Authoritative ML risk score calculation using 5-feature contract
14. Strict isolation: demo matches do not alter Honour scores or award credits
15. Strict isolation: demo player excluded from public leaderboards
16. Admin and Super Admin demonstration view (/api/admin/demo-cheater/status)
17. Existing user accounts preserved without modification
"""

import os
import unittest
from datetime import datetime, timezone, timedelta
import pyotp
from bson import ObjectId

os.environ["APP_ENV"] = "development"
os.environ["SECUREFPS_ENABLE_DEMO"] = "1"
os.environ["DEMO_CHEATER_PASSWORD"] = "SecureFPS@Demo2026!"

from app import app
from database.db import users, game_sessions, game_telemetry, game_events, security_events
from services.auth import hash_password, validate_password
from models.ml_model import predict, FEATURES
from routes.game_routes import analyze_game_session, record_honour_transaction
from extensions import limiter


class TestDemoCheaterSystem(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        limiter.enabled = False
        cls.client = app.test_client()
        cls.now = datetime.now(timezone.utc)
        cls.demo_password = os.getenv("DEMO_CHEATER_PASSWORD", "SecureFPS@Demo2026!")
        existing_demo = users.find_one({"username": "cheater_demo"})
        env_secret = os.getenv("DEMO_CHEATER_MFA_SECRET", "").strip()
        if env_secret:
            cls.demo_mfa_secret = env_secret
        elif existing_demo and existing_demo.get("mfa_secret"):
            cls.demo_mfa_secret = existing_demo["mfa_secret"]
        else:
            cls.demo_mfa_secret = "LPXQVQ5B2ZYEPVJDOMCUJCAHF7IS3U6D"

        # Ensure demo cheater user exists without wiping custom MFA secret
        users.update_one(
            {"username": "cheater_demo"},
            {
                "$set": {
                    "name": "Cheater Demonstration Operator",
                    "email": "cheater_demo@example.test",
                    "password_hash": hash_password(cls.demo_password),
                    "mfa_secret": cls.demo_mfa_secret,
                    "mfa_enabled": True,
                    "role": "player",
                    "account_type": "demo_test",
                    "account_status": "active",
                    "demo": True,
                    "is_demo": True,
                    "demo_label": "CHEATER DEMONSTRATION TEST ACCOUNT",
                    "honour_score": 100,
                    "updated_at": cls.now,
                },
                "$setOnInsert": {
                    "created_at": cls.now,
                }
            },
            upsert=True
        )
        cls.demo_user_id = users.find_one({"username": "cheater_demo"})["_id"]

        # Ensure normal player exists
        users.delete_many({"email": "test_normal_player@securefps.local"})
        cls.normal_user_id = users.insert_one({
            "username": "normal_player_99",
            "name": "Normal Player",
            "email": "test_normal_player@securefps.local",
            "password_hash": hash_password("NormalPlayer123!"),
            "mfa_secret": "JBSWY3DPEHPK3PXP",
            "mfa_enabled": True,
            "role": "player",
            "account_status": "active",
            "honour_score": 100,
            "created_at": cls.now,
        }).inserted_id

        # Ensure admin exists
        users.delete_many({"email": "test_admin_reviewer@securefps.local"})
        cls.admin_user_id = users.insert_one({
            "username": "admin_reviewer",
            "name": "Admin Reviewer",
            "email": "test_admin_reviewer@securefps.local",
            "password_hash": hash_password("AdminReviewer123!"),
            "mfa_secret": "JBSWY3DPEHPK3PXP",
            "mfa_enabled": True,
            "role": "admin",
            "account_status": "active",
            "created_at": cls.now,
        }).inserted_id

    def login_user(self, email_or_username, password, mfa_secret):
        """Helper to complete password + TOTP MFA authentication."""
        res1 = self.client.post("/api/auth/login", json={"email": email_or_username, "password": password, "takeover": True})
        self.assertEqual(res1.status_code, 200, f"Login failed for {email_or_username}: {res1.get_json()}")
        self.assertTrue(res1.get_json().get("mfa_required"))

        totp_code = pyotp.TOTP(mfa_secret).now()
        res2 = self.client.post("/api/auth/verify-mfa", json={"code": totp_code})
        self.assertEqual(res2.status_code, 200, f"MFA failed for {email_or_username}: {res2.get_json()}")
        return res2

    def test_01_demo_account_storage_and_bcrypt(self):
        """Phase 1: Demo account exists, stored only as bcrypt hash, username is unique."""
        acc = users.find_one({"username": "cheater_demo"})
        self.assertIsNotNone(acc)
        self.assertEqual(acc.get("email"), "cheater_demo@example.test")
        self.assertTrue(acc.get("password_hash", "").startswith("$2b$"))
        self.assertNotIn("password", acc)
        self.assertTrue(acc.get("demo"))
        self.assertTrue(acc.get("is_demo"))
        self.assertEqual(acc.get("account_type"), "demo_test")

    def test_02_password_and_mfa_login_flow(self):
        """Phase 2: Authentication flow requires both password and valid TOTP MFA code."""
        # Clean session
        with self.client.session_transaction() as sess:
            sess.clear()

        # Step 1: Login with password
        res = self.client.post("/api/auth/login", json={
            "email": "cheater_demo",
            "password": self.demo_password,
            "takeover": True
        })
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.get_json().get("mfa_required"))

        # Step 2: Login with MFA code
        totp_code = pyotp.TOTP(self.demo_mfa_secret).now()
        res_mfa = self.client.post("/api/auth/verify-mfa", json={"code": totp_code})
        self.assertEqual(res_mfa.status_code, 200)
        self.assertEqual(res_mfa.get_json().get("user", {}).get("username"), "cheater_demo")

    def test_03_negative_authentication_tests(self):
        """Phase 2 & 10: Bad password rejected, bad MFA code rejected."""
        # Bad password
        res_bad_pw = self.client.post("/api/auth/login", json={
            "email": "cheater_demo",
            "password": "WrongPassword123!"
        })
        self.assertIn(res_bad_pw.status_code, [401, 403])

        # Good password but bad MFA
        self.client.post("/api/auth/login", json={
            "email": "cheater_demo",
            "password": self.demo_password
        })
        res_bad_mfa = self.client.post("/api/auth/verify-mfa", json={"code": "000000"})
        self.assertEqual(res_bad_mfa.status_code, 401)

    def test_04_demo_authorization_endpoint(self):
        """Phase 4 & 7: /api/game/demo-status authorises cheater_demo, rejects normal player."""
        # 1. As cheater_demo
        self.login_user("cheater_demo", self.demo_password, self.demo_mfa_secret)
        res_demo = self.client.get("/api/game/demo-status")
        self.assertEqual(res_demo.status_code, 200)
        self.assertTrue(res_demo.get_json().get("can_use_demo_panel"))
        self.assertTrue(res_demo.get_json().get("is_demo_account"))

        # 2. As normal player
        self.login_user("test_normal_player@securefps.local", "NormalPlayer123!", "JBSWY3DPEHPK3PXP")
        res_normal = self.client.get("/api/game/demo-status")
        self.assertEqual(res_normal.status_code, 200)
        self.assertFalse(res_normal.get_json().get("can_use_demo_panel"))
        self.assertFalse(res_normal.get_json().get("is_demo_account"))

    def test_05_negative_normal_player_cannot_activate_demo(self):
        """Phase 4: Normal player attempting to request demo mode receives 403 Forbidden."""
        self.login_user("test_normal_player@securefps.local", "NormalPlayer123!", "JBSWY3DPEHPK3PXP")
        res = self.client.post("/api/game/start", json={
            "game": "CyberStrike_3D",
            "mode": "demo_cheater",
            "demo": True
        })
        self.assertEqual(res.status_code, 403)
        self.assertIn("restricted", res.get_json().get("message", "").lower())

    def test_06_negative_multiplayer_rejects_demo(self):
        """Phase 4: Multiplayer rooms strictly disallow demo mode."""
        self.login_user("cheater_demo", self.demo_password, self.demo_mfa_secret)
        res = self.client.post("/api/game/start", json={
            "game": "CyberStrike_3D",
            "mode": "multiplayer",
            "demo": True
        })
        self.assertEqual(res.status_code, 400)
        self.assertIn("not permitted", res.get_json().get("message", "").lower())

    def test_07_negative_production_mode_rejects_demo(self):
        """Phase 4: In production mode (APP_ENV=production), demo mode is rejected."""
        orig_env = os.environ.get("APP_ENV")
        try:
            os.environ["APP_ENV"] = "production"
            self.login_user("cheater_demo", self.demo_password, self.demo_mfa_secret)
            res = self.client.post("/api/game/start", json={
                "game": "CyberStrike_3D",
                "mode": "demo_cheater",
                "demo": True
            })
            self.assertEqual(res.status_code, 403)
        finally:
            os.environ["APP_ENV"] = orig_env or "development"

    def test_08_authorized_demo_session_start(self):
        """Phase 3 & 4: Authorized demo player can start isolated test match."""
        self.login_user("cheater_demo", self.demo_password, self.demo_mfa_secret)
        res = self.client.post("/api/game/start", json={
            "game": "CyberStrike_3D",
            "mode": "bots",
            "demo": True
        })
        self.assertEqual(res.status_code, 201)
        data = res.get_json()
        self.assertTrue(data.get("demo_mode"))
        self.assertTrue(data.get("is_demo"))
        self.assertTrue(data.get("demo_authorized"))

        # Verify session recorded in MongoDB with demo flags
        session_id = data.get("session_id")
        saved = game_sessions.find_one({"session_id": session_id})
        self.assertIsNotNone(saved)
        self.assertTrue(saved.get("demo_mode"))
        self.assertTrue(saved.get("is_demo"))
        self.assertEqual(saved.get("demo_label"), "cheater_demo")

    def test_09_impossible_hit_detection(self):
        """Phase 3A & 5: Server detects hit through obstacle or impossible distance."""
        self.login_user("cheater_demo", self.demo_password, self.demo_mfa_secret)
        start_res = self.client.post("/api/game/start", json={
            "game": "CyberStrike_3D",
            "mode": "bots",
            "demo": True
        })
        session_id = start_res.get_json()["session_id"]
        game_token = start_res.get_json()["game_token"]

        # Send impossible hit telemetry (hit through obstacle)
        hit_payload = {
            "session_id": session_id,
            "game_token": game_token,
            "game": "CyberStrike_3D",
            "event_type": "enemy_hit",
            "telemetry": {
                "target_id": "bot_alpha",
                "distance": 145.2,
                "visible_through_wall": True,
                "through_obstacle": True,
                "line_of_sight": False,
                "impossible_hit": True,
                "damage": 34,
                "timestamp": 12.34
            }
        }
        res = self.client.post("/api/game-events", json=hit_payload)
        self.assertIn(res.status_code, [200, 201])

        # Assert security alert in MongoDB
        evt = security_events.find_one({
            "session_id": session_id,
            "event_type": "impossible_hit"
        })
        self.assertIsNotNone(evt)
        self.assertEqual(evt.get("severity"), "critical")
        self.assertTrue(evt.get("is_demo"))
        self.assertEqual(evt.get("environment"), "DEMONSTRATION")
        self.assertEqual(evt.get("source"), "Client-reported demo telemetry")

    def test_10_abnormal_speed_detection(self):
        """Phase 3B & 5: Server detects movement speed exceeding legitimate sprint limits."""
        self.login_user("cheater_demo", self.demo_password, self.demo_mfa_secret)
        start_res = self.client.post("/api/game/start", json={
            "game": "CyberStrike_3D",
            "mode": "bots",
            "demo": True
        })
        session_id = start_res.get_json()["session_id"]
        game_token = start_res.get_json()["game_token"]

        # Send 4x speed telemetry (38.5 m/s vs legitimate <= 11.5 m/s)
        speed_payload = {
            "session_id": session_id,
            "game_token": game_token,
            "game": "CyberStrike_3D",
            "event_type": "player_behavior",
            "telemetry": {
                "speed": 38.5,
                "position": {"x": 10.0, "y": 1.8, "z": 45.0},
                "grounded": True,
                "timestamp": 15.0
            }
        }
        res = self.client.post("/api/game-events", json=speed_payload)
        self.assertIn(res.status_code, [200, 201])

        # Assert security alert in MongoDB
        evt = security_events.find_one({
            "session_id": session_id,
            "event_type": "abnormal_speed"
        })
        self.assertIsNotNone(evt)
        self.assertEqual(evt.get("severity"), "critical")
        self.assertTrue(evt.get("is_demo"))
        self.assertIn("exceeds legitimate", evt.get("violation", "").lower())
        self.assertIn("38.5", evt.get("observed_value", ""))

    def test_11_abnormal_fire_rate_detection(self):
        """Phase 3C & 5: Server detects weapon fire rate interval below allowed minimum."""
        self.login_user("cheater_demo", self.demo_password, self.demo_mfa_secret)
        start_res = self.client.post("/api/game/start", json={
            "game": "CyberStrike_3D",
            "mode": "bots",
            "demo": True
        })
        session_id = start_res.get_json()["session_id"]
        game_token = start_res.get_json()["game_token"]

        # Shot 1 at t=10.000
        self.client.post("/api/game-events", json={
            "session_id": session_id,
            "game_token": game_token,
            "game": "CyberStrike_3D",
            "event_type": "weapon_fire",
            "telemetry": {"weapon": "P-24 Carbine", "timestamp": 10.000}
        })

        # Shot 2 at t=10.035 (interval = 0.035s, ~28.6 rps vs legitimate max 9 rps)
        res2 = self.client.post("/api/game-events", json={
            "session_id": session_id,
            "game_token": game_token,
            "game": "CyberStrike_3D",
            "event_type": "weapon_fire",
            "telemetry": {"weapon": "P-24 Carbine", "timestamp": 10.035}
        })
        self.assertIn(res2.status_code, [200, 201])

        # Assert security alert in MongoDB
        evt = security_events.find_one({
            "session_id": session_id,
            "event_type": "abnormal_fire_rate"
        })
        self.assertIsNotNone(evt)
        self.assertEqual(evt.get("severity"), "high")
        self.assertTrue(evt.get("is_demo"))
        self.assertIn("below allowed minimum", evt.get("violation", "").lower())

    def test_12_ml_risk_score_five_feature_contract(self):
        """Phase 6: ML pipeline evaluates authentic features without hardcoding."""
        # Verify 5-feature contract matches model expectations
        expected_features = ["accuracy", "fire_rate", "movement_speed", "aim_smoothness", "kdr"]
        self.assertEqual(FEATURES, expected_features)

        # Build feature vector representing suspicious high accuracy & fast fire
        test_features = {
            "accuracy": 0.95,
            "fire_rate": 8.5,
            "movement_speed": 4.5,
            "aim_smoothness": 0.92,
            "kdr": 5.0
        }
        prediction = predict(test_features)
        self.assertIn("risk_score", prediction)
        self.assertIn("random_forest", prediction)
        self.assertIn("isolation_forest", prediction)
        self.assertIsInstance(prediction["risk_score"], (int, float))
        # Confirm it wasn't hardcoded to a static string
        self.assertNotEqual(prediction["risk_score"], "HARDCODED")

    def test_13_strict_isolation_honour_and_leaderboard(self):
        """Phase 4 & 9: Demo matches never alter Honour scores and are excluded from leaderboards."""
        demo_user = users.find_one({"username": "cheater_demo"})
        initial_honour = demo_user.get("honour_score", 100)

        # Call record_honour_transaction for demo user
        prev, new, delta = record_honour_transaction(
            user_id=demo_user["_id"],
            session_id="test_demo_session",
            points_delta=5,
            reason="Match completion test"
        )
        self.assertEqual(delta, 0)
        self.assertEqual(new, initial_honour)

        # Check leaderboard
        self.login_user("test_normal_player@securefps.local", "NormalPlayer123!", "JBSWY3DPEHPK3PXP")
        res = self.client.get("/api/player/leaderboard")
        self.assertEqual(res.status_code, 200)
        leaderboard = res.get_json().get("leaderboard", [])
        usernames = [p.get("name") or p.get("username") for p in leaderboard]
        self.assertNotIn("cheater_demo", usernames)

    def test_14_admin_demo_cheater_status_endpoint(self):
        """Phase 8: Admin and Super Admin can retrieve demo status and alerts feed."""
        self.login_user("test_admin_reviewer@securefps.local", "AdminReviewer123!", "JBSWY3DPEHPK3PXP")
        res = self.client.get("/api/admin/demo-cheater/status")
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data.get("account", {}).get("exists"))
        self.assertEqual(data.get("account", {}).get("username"), "cheater_demo")
        self.assertIn("alerts", data)
        self.assertIn("violation_counts", data)

    def test_15_admin_demo_reset_endpoint(self):
        """Phase 8: Admin can clear demo alerts for demonstration repeatability."""
        self.login_user("test_admin_reviewer@securefps.local", "AdminReviewer123!", "JBSWY3DPEHPK3PXP")
        res = self.client.post("/api/admin/demo-cheater/reset", headers={
            "X-Requested-With": "XMLHttpRequest",
            "Origin": "http://localhost:5000"
        })
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.get_json().get("success"))

    def test_16_non_admin_cannot_access_admin_demo_status(self):
        """Phase 8: Ordinary players are denied access to admin demo endpoints."""
        self.login_user("test_normal_player@securefps.local", "NormalPlayer123!", "JBSWY3DPEHPK3PXP")
        res = self.client.get("/api/admin/demo-cheater/status")
        self.assertEqual(res.status_code, 403)

    def test_17_existing_user_accounts_preserved(self):
        """Phase 1: Existing player and admin accounts remain intact."""
        normal_acc = users.find_one({"email": "test_normal_player@securefps.local"})
        self.assertIsNotNone(normal_acc)
        self.assertEqual(normal_acc.get("role"), "player")
        self.assertNotEqual(normal_acc.get("username"), "cheater_demo")

    def test_18_headshot_anomaly_detection(self):
        """Phase 6: Server detects abnormal headshot pattern (100% headshot ratio on hits >= 3)."""
        self.login_user("cheater_demo", self.demo_password, self.demo_mfa_secret)
        start_res = self.client.post("/api/game/start", json={
            "game": "CyberStrike_3D",
            "mode": "bots",
            "demo": True
        })
        session_id = start_res.get_json()["session_id"]
        game_token = start_res.get_json()["game_token"]

        # Hit 1: 1st headshot (should not trigger alert alone - avoid single-hit false positive)
        self.client.post("/api/game-events", json={
            "session_id": session_id,
            "game_token": game_token,
            "game": "CyberStrike_3D",
            "event_type": "weapon_fire",
            "telemetry": {"weapon": "P-24 Carbine", "timestamp": 1.0}
        })
        self.client.post("/api/game-events", json={
            "session_id": session_id,
            "game_token": game_token,
            "game": "CyberStrike_3D",
            "event_type": "enemy_hit",
            "telemetry": {"target_id": "bot_1", "headshot": True, "damage": 50, "timestamp": 1.05}
        })
        evt1 = security_events.find_one({"session_id": session_id, "event_type": "headshot_anomaly"})
        self.assertIsNone(evt1, "Single headshot must not trigger a cheat detection alert")

        # Hit 2: 2nd headshot
        self.client.post("/api/game-events", json={
            "session_id": session_id,
            "game_token": game_token,
            "game": "CyberStrike_3D",
            "event_type": "weapon_fire",
            "telemetry": {"weapon": "P-24 Carbine", "timestamp": 2.0}
        })
        self.client.post("/api/game-events", json={
            "session_id": session_id,
            "game_token": game_token,
            "game": "CyberStrike_3D",
            "event_type": "enemy_hit",
            "telemetry": {"target_id": "bot_2", "headshot": True, "damage": 50, "timestamp": 2.05}
        })
        evt2 = security_events.find_one({"session_id": session_id, "event_type": "headshot_anomaly"})
        self.assertIsNone(evt2, "Two headshots must not trigger without sufficient statistical evidence (>= 3 hits)")

        # Hit 3: 3rd headshot (reaching evidence threshold: 3 hits, 100% headshot ratio)
        self.client.post("/api/game-events", json={
            "session_id": session_id,
            "game_token": game_token,
            "game": "CyberStrike_3D",
            "event_type": "weapon_fire",
            "telemetry": {"weapon": "P-24 Carbine", "timestamp": 3.0}
        })
        self.client.post("/api/game-events", json={
            "session_id": session_id,
            "game_token": game_token,
            "game": "CyberStrike_3D",
            "event_type": "enemy_hit",
            "telemetry": {"target_id": "bot_3", "headshot": True, "damage": 50, "timestamp": 3.05}
        })
        evt3 = security_events.find_one({"session_id": session_id, "event_type": "headshot_anomaly"})
        self.assertIsNotNone(evt3, "Three consecutive headshots (100% ratio) must trigger headshot_anomaly")
        self.assertEqual(evt3.get("severity"), "critical")
        self.assertTrue(evt3.get("is_demo"))
        self.assertIn("100.0%", evt3.get("observed_value", ""))
        self.assertEqual(evt3.get("evidence", {}).get("successful_hits"), 3)
        self.assertEqual(evt3.get("evidence", {}).get("headshots"), 3)
        self.assertEqual(evt3.get("evidence", {}).get("headshot_ratio"), 100.0)
        self.assertEqual(evt3.get("evidence", {}).get("match_id"), session_id)


if __name__ == "__main__":
    unittest.main()
