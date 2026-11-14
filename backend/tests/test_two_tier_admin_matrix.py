import unittest
from datetime import datetime, timezone, timedelta
from bson import ObjectId
from app import app
from database.db import users, admin_approvals, sessions_db, security_events, admin_audit_log
from services.auth import hash_password


class TestTwoTierAdminMatrix(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()
        self.now = datetime.now(timezone.utc)

        # 1. Ensure clean test normal admin
        users.delete_many({"email": {"$in": ["test_normal_admin@securefps.local", "test_super_admin@securefps.local", "test_victim_player@securefps.local"]}})
        admin_approvals.delete_many({"player_email": "test_victim_player@securefps.local"})

        self.normal_admin = users.insert_one({
            "name": "Test Normal Admin",
            "email": "test_normal_admin@securefps.local",
            "password_hash": hash_password("NormalAdmin123!"),
            "role": "normal_admin",
            "is_super_admin": False,
            "account_status": "active",
            "mfa_secret": "JBSWY3DPEHPK3PXP",
            "created_at": self.now
        })

        # 2. Ensure test super admin
        self.super_admin = users.insert_one({
            "name": "Test Super Admin",
            "email": "test_super_admin@securefps.local",
            "password_hash": hash_password("SuperAdmin123!"),
            "role": "super_admin",
            "is_super_admin": True,
            "account_status": "active",
            "mfa_secret": "JBSWY3DPEHPK3PXP",
            "created_at": self.now
        })

        # 3. Test victim player
        self.victim = users.insert_one({
            "name": "Test Victim Player",
            "email": "test_victim_player@securefps.local",
            "password_hash": hash_password("Player123!"),
            "role": "player",
            "account_status": "active",
            "mfa_secret": "JBSWY3DPEHPK3PXP",
            "created_at": self.now
        })
        self.victim_id = str(self.victim.inserted_id)

    def tearDown(self):
        users.delete_many({"email": {"$in": ["test_normal_admin@securefps.local", "test_super_admin@securefps.local", "test_victim_player@securefps.local"]}})
        admin_approvals.delete_many({"player_email": "test_victim_player@securefps.local"})

    def _login_as(self, email, password):
        c = app.test_client()
        r1 = c.post("/api/auth/login", json={"email": email, "password": password, "takeover": True})
        self.assertEqual(r1.status_code, 200, f"Login failed: {r1.json}")
        r2 = c.post("/api/auth/verify-mfa", json={"code": "123456"})
        self.assertEqual(r2.status_code, 200, f"MFA failed: {r2.json}")
        return c

    def test_01_normal_admin_can_access_read_dashboards(self):
        admin_client = self._login_as("test_normal_admin@securefps.local", "NormalAdmin123!")
        
        # Overview
        r = admin_client.get("/api/admin/overview")
        self.assertEqual(r.status_code, 200)

        # Players
        r = admin_client.get("/api/admin/players")
        self.assertEqual(r.status_code, 200)

        # Identity me
        r = admin_client.get("/api/admin/me")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json["admin"]["role"], "normal_admin")
        self.assertFalse(r.json["admin"]["is_super_admin"])

    def test_02_normal_admin_cannot_permanent_ban_directly(self):
        admin_client = self._login_as("test_normal_admin@securefps.local", "NormalAdmin123!")
        r = admin_client.post(
            f"/api/admin/players/{self.victim_id}/ban",
            json={"reason": "Suspicious aim snaps detected in telemetry", "reauth_password": "NormalAdmin123!"},
            headers={"X-Requested-With": "XMLHttpRequest"}
        )
        # Must be forbidden with guidance to submit approval request
        self.assertEqual(r.status_code, 403)
        self.assertTrue(r.json.get("can_request_approval"))
        self.assertEqual(r.json.get("permission_denied"), "ban_player")

    def test_03_normal_admin_cannot_delete_directly(self):
        admin_client = self._login_as("test_normal_admin@securefps.local", "NormalAdmin123!")
        r = admin_client.post(
            f"/api/admin/players/{self.victim_id}/delete",
            json={"reason": "GDPR deletion request from player", "reauth_password": "NormalAdmin123!"},
            headers={"X-Requested-With": "XMLHttpRequest"}
        )
        self.assertEqual(r.status_code, 403)

    def test_04_normal_admin_suspension_7_day_limit(self):
        admin_client = self._login_as("test_normal_admin@securefps.local", "NormalAdmin123!")
        
        # 14-day suspension must be rejected
        two_weeks = (self.now + timedelta(days=14)).isoformat()
        r = admin_client.post(
            f"/api/admin/players/{self.victim_id}/suspend",
            json={"reason": "Toxic behavior in match voice chat", "suspended_until": two_weeks},
            headers={"X-Requested-With": "XMLHttpRequest"}
        )
        self.assertEqual(r.status_code, 403)
        self.assertTrue(r.json.get("can_request_approval"))

        # 5-day suspension must succeed
        five_days = (self.now + timedelta(days=5)).isoformat()
        r = admin_client.post(
            f"/api/admin/players/{self.victim_id}/suspend",
            json={"reason": "Toxic behavior in match voice chat", "suspended_until": five_days},
            headers={"X-Requested-With": "XMLHttpRequest"}
        )
        self.assertEqual(r.status_code, 200)

    def test_05_two_tier_approval_flow_ban(self):
        # Step 1: Normal admin submits ban approval request
        normal_client = self._login_as("test_normal_admin@securefps.local", "NormalAdmin123!")
        r_req = normal_client.post(
            "/api/admin/approvals/request",
            json={
                "player_id": self.victim_id,
                "action": "ban",
                "reason": "Repeated wallhack and speedhack telemetry flags",
                "evidence": "Session ID match_telemetry_5f8d"
            },
            headers={"X-Requested-With": "XMLHttpRequest"}
        )
        self.assertEqual(r_req.status_code, 201)
        approval_id = r_req.json["approval"]["id"]

        # Step 2: Super admin reviews approvals queue
        super_client = self._login_as("test_super_admin@securefps.local", "SuperAdmin123!")
        r_list = super_client.get("/api/admin/approvals?status=pending")
        self.assertEqual(r_list.status_code, 200)
        self.assertGreaterEqual(r_list.json["pending_count"], 1)

        # Step 3: Super admin approves request
        r_act = super_client.post(
            f"/api/admin/approvals/{approval_id}/action",
            json={"decision": "approve", "note": "Verified telemetry and aim flick distributions"},
            headers={"X-Requested-With": "XMLHttpRequest"}
        )
        self.assertEqual(r_act.status_code, 200)
        self.assertEqual(r_act.json["status"], "approved")

        # Step 4: Verify target player is now permanently banned
        v = users.find_one({"_id": ObjectId(self.victim_id)})
        self.assertEqual(v.get("account_status"), "banned")
        self.assertTrue(v.get("revoked"))

    def test_06_normal_admin_privilege_escalation_blocked(self):
        normal_client = self._login_as("test_normal_admin@securefps.local", "NormalAdmin123!")
        
        # 1. Cannot create new admin accounts
        r1 = normal_client.post(
            "/api/admin/super/admins",
            json={"name": "Attacker Admin", "email": "attacker@evil.local", "password": "Password123!"},
            headers={"X-Requested-With": "XMLHttpRequest"}
        )
        self.assertEqual(r1.status_code, 403)

        # 2. Cannot tune ML anti-cheat thresholds
        r2 = normal_client.post(
            "/api/admin/super/ml-models/tune",
            json={"high_risk_threshold": 95, "auto_flag_threshold": 99},
            headers={"X-Requested-With": "XMLHttpRequest"}
        )
        self.assertEqual(r2.status_code, 403)

        # 3. Cannot toggle emergency security lockdown
        r3 = normal_client.post(
            "/api/admin/super/lockdown",
            json={"enabled": True},
            headers={"X-Requested-With": "XMLHttpRequest"}
        )
        self.assertEqual(r3.status_code, 403)

    def test_07_last_super_admin_protection(self):
        super_client = self._login_as("test_super_admin@securefps.local", "SuperAdmin123!")
        
        # Ensure only 1 active super admin for this test
        users.update_many({"role": "super_admin", "email": {"$ne": "test_super_admin@securefps.local"}}, {"$set": {"account_status": "deactivated"}})
        
        # Attempt to deactivate or delete the last active Super Admin
        r = super_client.post(
            f"/api/admin/super/admins/{self.super_admin.inserted_id}/status",
            json={"status": "deactivated"},
            headers={"X-Requested-With": "XMLHttpRequest"}
        )
        self.assertEqual(r.status_code, 403)
        self.assertTrue("last remaining Super Administrator" in r.json.get("message", "") or "own account" in r.json.get("message", ""))

        # Restore superadmin@securefps.io
        users.update_one({"email": "superadmin@securefps.io"}, {"$set": {"account_status": "active", "role": "super_admin", "is_super_admin": True}})


if __name__ == "__main__":
    unittest.main()
