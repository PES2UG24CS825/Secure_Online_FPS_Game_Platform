import json
import unittest
import uuid
from datetime import datetime, timezone
import pyotp

from app import app, ensure_default_admin
from database.db import (
    users, sessions_db, system_config, admin_permissions, model_versions,
    system_backups, admin_audit_log, seed_two_tier_system
)
from services.auth import hash_password

SECURE_HEADERS = {
    "X-Requested-With": "XMLHttpRequest",
    "X-CSRF-Token": "securefps-csrf",
}

class TwoTierAdminSystemSecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ensure_default_admin()
        seed_two_tier_system()

    def setUp(self):
        self.super_admin_email = "superadmin@securefps.io"
        self.super_admin_password = "SuperAdmin@2026!"
        self.normal_admin_email = "admin1@gmail.com"
        self.normal_admin_password = "Admin@12345"

        # Ensure a test player exists for Level 1 moderation tests
        self.player_id_str = uuid.uuid4().hex[:8]
        self.player_email = f"player_{self.player_id_str}@test.local"
        self.player_res = users.insert_one({
            "name": f"Test Player {self.player_id_str}",
            "email": self.player_email,
            "role": "player",
            "account_status": "active",
            "revoked": False,
            "password_hash": hash_password("PlayerPass123!"),
            "mfa_secret": pyotp.random_base32(),
            "mfa_enabled": True,
            "honour_score": 100,
            "created_at": datetime.now(timezone.utc)
        })
        self.player_oid = self.player_res.inserted_id

    def _login_as(self, email, password):
        client = app.test_client()
        resp = client.post(
            "/api/auth/login",
            json={"email": email, "password": password, "takeover": True},
            headers=SECURE_HEADERS
        )
        self.assertEqual(resp.status_code, 200, f"Login failed for {email}: {resp.get_data(as_text=True)}")
        data = resp.get_json()
        if data.get("mfa_required"):
            u = users.find_one({"email": email})
            code = pyotp.TOTP(u["mfa_secret"]).now()
            verify_resp = client.post("/api/auth/verify-mfa", json={"code": code}, headers=SECURE_HEADERS)
            self.assertEqual(verify_resp.status_code, 200, f"MFA failed for {email}: {verify_resp.get_data(as_text=True)}")
        return client

    def test_01_normal_admin_permitted_on_level_one_endpoints(self):
        """Requirement 1: Normal Admin can access Level 1 operations."""
        client = self._login_as(self.normal_admin_email, self.normal_admin_password)

        # Overview
        r_overview = client.get("/api/admin/overview?refresh=1", headers=SECURE_HEADERS)
        self.assertEqual(r_overview.status_code, 200)
        self.assertIn("stats", r_overview.get_json())

        # Threats
        r_threats = client.get("/api/admin/threats", headers=SECURE_HEADERS)
        self.assertEqual(r_threats.status_code, 200)
        self.assertIn("active_threat_count", r_threats.get_json())

        # Analytics Reports
        r_analytics = client.get("/api/admin/analytics/reports", headers=SECURE_HEADERS)
        self.assertEqual(r_analytics.status_code, 200)
        self.assertIn("player_distribution", r_analytics.get_json())

        # Issue Warning
        r_warn = client.post(
            f"/api/admin/players/{str(self.player_oid)}/warning",
            json={"warning_message": "Excessive packet jitter detected during competitive match."},
            headers=SECURE_HEADERS
        )
        self.assertEqual(r_warn.status_code, 200)

        # Investigation Notes
        r_notes = client.post(
            f"/api/admin/players/{str(self.player_oid)}/notes",
            json={"note": "Observed erratic flick speed in round 4, flag for further review."},
            headers=SECURE_HEADERS
        )
        self.assertEqual(r_notes.status_code, 200)

    def test_02_normal_admin_forbidden_from_super_admin_endpoints(self):
        """Requirement 2: Normal Admin receives HTTP 403 on Super Admin endpoints."""
        client = self._login_as(self.normal_admin_email, self.normal_admin_password)

        super_endpoints = [
            ("GET", "/api/admin/super/admins"),
            ("POST", "/api/admin/super/admins"),
            ("GET", "/api/admin/super/roles-permissions"),
            ("GET", "/api/admin/super/ml-models"),
            ("POST", "/api/admin/super/ml-models/rollback"),
            ("GET", "/api/admin/super/risk-config"),
            ("POST", "/api/admin/super/risk-config/simulate"),
            ("GET", "/api/admin/super/security-command"),
            ("POST", "/api/admin/super/lockdown"),
            ("GET", "/api/admin/super/system-metrics"),
            ("GET", "/api/admin/super/backups"),
            ("GET", "/api/admin/super/platform-config"),
        ]

        for method, endpoint in super_endpoints:
            if method == "GET":
                resp = client.get(endpoint, headers=SECURE_HEADERS)
            else:
                resp = client.post(endpoint, json={}, headers=SECURE_HEADERS)
            self.assertEqual(
                resp.status_code, 403,
                f"Normal Admin expected 403 on {method} {endpoint}, got {resp.status_code}: {resp.get_data(as_text=True)}"
            )
            msg = resp.get_json().get("message", "")
            self.assertIn("Super Administrator", msg)

    def test_03_unauthenticated_requests_rejected(self):
        """Requirement 3: Direct API access without authentication is rejected."""
        anon_client = app.test_client()

        # Unauthenticated Level 1
        r1 = anon_client.get("/api/admin/overview", headers=SECURE_HEADERS)
        self.assertEqual(r1.status_code, 403)

        # Unauthenticated Super Admin
        r2 = anon_client.get("/api/admin/super/admins", headers=SECURE_HEADERS)
        self.assertEqual(r2.status_code, 403)

    def test_04_super_admin_access_command_center_modules(self):
        """Requirement 4: Super Admin can access all Command Center endpoints."""
        client = self._login_as(self.super_admin_email, self.super_admin_password)

        r_admins = client.get("/api/admin/super/admins", headers=SECURE_HEADERS)
        self.assertEqual(r_admins.status_code, 200)
        self.assertIn("admins", r_admins.get_json())

        r_roles = client.get("/api/admin/super/roles-permissions", headers=SECURE_HEADERS)
        self.assertEqual(r_roles.status_code, 200)
        self.assertIn("roles", r_roles.get_json())

        r_ml = client.get("/api/admin/super/ml-models", headers=SECURE_HEADERS)
        self.assertEqual(r_ml.status_code, 200)
        self.assertIn("models", r_ml.get_json())

        r_risk = client.get("/api/admin/super/risk-config", headers=SECURE_HEADERS)
        self.assertEqual(r_risk.status_code, 200)
        self.assertIn("risk_engine", r_risk.get_json())

        r_cmd = client.get("/api/admin/super/security-command", headers=SECURE_HEADERS)
        self.assertEqual(r_cmd.status_code, 200)
        self.assertIn("recent_critical_incidents", r_cmd.get_json())

        r_sys = client.get("/api/admin/super/system-metrics", headers=SECURE_HEADERS)
        self.assertEqual(r_sys.status_code, 200)
        self.assertIn("runtime", r_sys.get_json())
        self.assertIn("database", r_sys.get_json())

        r_backups = client.get("/api/admin/super/backups", headers=SECURE_HEADERS)
        self.assertEqual(r_backups.status_code, 200)
        self.assertIn("backups", r_backups.get_json())

        r_cfg = client.get("/api/admin/super/platform-config", headers=SECURE_HEADERS)
        self.assertEqual(r_cfg.status_code, 200)
        self.assertIn("security_policies", r_cfg.get_json())

    def test_05_admin_provisioning_and_lifecycle(self):
        """Requirement 5 & 6: Super Admin can provision and manage Normal Admin lifecycle."""
        client = self._login_as(self.super_admin_email, self.super_admin_password)

        temp_email = f"temp_admin_{uuid.uuid4().hex[:6]}@securefps.io"
        create_payload = {
            "name": "Junior Ops Lead",
            "email": temp_email,
            "password": "SecurePassword@2026!",
            "role": "admin"
        }

        # Provision
        r_create = client.post("/api/admin/super/admins", json=create_payload, headers=SECURE_HEADERS)
        self.assertEqual(r_create.status_code, 201)
        created_data = r_create.get_json()
        new_admin_id = created_data.get("admin", {}).get("id")
        self.assertTrue(new_admin_id)

        # Update Status to suspended
        r_status = client.post(
            f"/api/admin/super/admins/{new_admin_id}/status",
            json={"status": "suspended", "reason": "Routine security rotation check."},
            headers=SECURE_HEADERS
        )
        self.assertEqual(r_status.status_code, 200)

        # Reset MFA
        r_mfa = client.post(f"/api/admin/super/admins/{new_admin_id}/reset-mfa", json={}, headers=SECURE_HEADERS)
        self.assertEqual(r_mfa.status_code, 200)
        self.assertTrue(r_mfa.get_json().get("success"))
        self.assertTrue(r_mfa.get_json().get("new_mfa_seed"))

        # Revoke Sessions
        r_revoke = client.post(f"/api/admin/super/admins/{new_admin_id}/revoke-sessions", json={}, headers=SECURE_HEADERS)
        self.assertEqual(r_revoke.status_code, 200)

        # Delete with reauth
        r_del = client.delete(
            f"/api/admin/super/admins/{new_admin_id}",
            json={"reauth_password": self.super_admin_password},
            headers=SECURE_HEADERS
        )
        self.assertEqual(r_del.status_code, 200)

    def test_06_last_super_admin_protection(self):
        """Requirement 7: Deleting or deactivating the last Super Admin is blocked."""
        client = self._login_as(self.super_admin_email, self.super_admin_password)
        super_admin_doc = users.find_one({"email": self.super_admin_email})
        super_admin_id = str(super_admin_doc["_id"])

        # Attempt to suspend own super admin account (also caught by self-moderation)
        r_suspend = client.post(
            f"/api/admin/super/admins/{super_admin_id}/status",
            json={"status": "suspended"},
            headers=SECURE_HEADERS
        )
        self.assertEqual(r_suspend.status_code, 403)

        # Attempt to delete own super admin account
        r_del = client.delete(
            f"/api/admin/super/admins/{super_admin_id}",
            json={"reauth_password": self.super_admin_password},
            headers=SECURE_HEADERS
        )
        self.assertEqual(r_del.status_code, 403)

    def test_07_prevent_self_moderation(self):
        """Requirement 8: Admin cannot perform privileged moderation on themselves."""
        client = self._login_as(self.super_admin_email, self.super_admin_password)
        super_admin_doc = users.find_one({"email": self.super_admin_email})
        super_admin_id = str(super_admin_doc["_id"])

        r_self = client.post(
            f"/api/admin/super/admins/{super_admin_id}/status",
            json={"status": "deactivated"},
            headers=SECURE_HEADERS
        )
        self.assertEqual(r_self.status_code, 403)
        self.assertIn("own account", r_self.get_json().get("message", "").lower())

    def test_08_risk_engine_simulator(self):
        """Requirement 10: Super Admin can run risk score simulation."""
        client = self._login_as(self.super_admin_email, self.super_admin_password)

        sim_payload = {
            "headshot_ratio": 0.85,
            "reaction_time_ms": 75,
            "aim_jitter": 0.01,
            "speed_multiplier": 1.45,
            "accuracy": 0.88
        }
        resp = client.post("/api/admin/super/risk-config/simulate", json=sim_payload, headers=SECURE_HEADERS)
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIn("simulated_risk_score", data)
        self.assertGreater(data.get("simulated_risk_score", 0), 40)
        self.assertIn("risk_category", data)
        self.assertIn("verdict", data)

    def test_09_ml_model_rollback(self):
        """Requirement 11: Super Admin can rollback deployed ML model."""
        client = self._login_as(self.super_admin_email, self.super_admin_password)

        resp = client.post(
            "/api/admin/super/ml-models/rollback",
            json={"version": "v1.5-rf", "reason": "Operational safety rollback test."},
            headers=SECURE_HEADERS
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json().get("active_model"), "v1.5-rf")

        # Roll back to v2.0-rf
        resp2 = client.post(
            "/api/admin/super/ml-models/rollback",
            json={"version": "v2.0-rf", "reason": "Restore primary production model."},
            headers=SECURE_HEADERS
        )
        self.assertEqual(resp2.status_code, 200)
        self.assertEqual(resp2.get_json().get("active_model"), "v2.0-rf")

    def test_10_platform_emergency_lockdown(self):
        """Requirement 12: Emergency Platform Lockdown toggle with reauthentication."""
        client = self._login_as(self.super_admin_email, self.super_admin_password)

        # Trigger lockdown
        r_lock = client.post(
            "/api/admin/super/lockdown",
            json={
                "lockdown": True,
                "reason": "Simulated zero-day telemetry anomaly testing.",
                "reauth_password": self.super_admin_password
            },
            headers=SECURE_HEADERS
        )
        self.assertEqual(r_lock.status_code, 200)
        self.assertTrue(r_lock.get_json().get("lockdown"))

        # Verify platform config reflects lockdown
        r_cfg = client.get("/api/admin/super/platform-config", headers=SECURE_HEADERS)
        self.assertTrue(r_cfg.get_json()["security_policies"]["emergency_lockdown"])

        # Release lockdown
        r_unlock = client.post(
            "/api/admin/super/lockdown",
            json={
                "lockdown": False,
                "reason": "Test incident resolved successfully.",
                "reauth_password": self.super_admin_password
            },
            headers=SECURE_HEADERS
        )
        self.assertEqual(r_unlock.status_code, 200)
        self.assertFalse(r_unlock.get_json().get("lockdown"))

    def test_11_audit_log_immutability(self):
        """Requirement 9: Audit records cannot be modified or deleted via API."""
        client = self._login_as(self.super_admin_email, self.super_admin_password)

        # DELETE on audit log is blocked
        r_del = client.delete("/api/admin/audit_log", headers=SECURE_HEADERS)
        self.assertIn(r_del.status_code, [403, 405])

        # PUT on audit log is blocked
        r_put = client.put("/api/admin/audit_log", json={"action": "tampered"}, headers=SECURE_HEADERS)
        self.assertIn(r_put.status_code, [403, 405])

    def tearDown(self):
        if hasattr(self, "player_oid"):
            users.delete_one({"_id": self.player_oid})

if __name__ == "__main__":
    unittest.main()
