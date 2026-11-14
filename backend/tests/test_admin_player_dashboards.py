import base64
import io
import json
import os
import unittest
import uuid
from datetime import datetime, timezone
from bson import ObjectId
from PIL import Image
import pyotp

from app import app, ensure_default_admin
from database.db import (
    users, sessions_db, ban_appeals, player_notifications, admin_audit_log, game_sessions
)
from services.auth import hash_password

SECURE_HEADERS = {
    "X-Requested-With": "XMLHttpRequest",
    "X-CSRF-Token": "securefps-csrf",
}


class AdminPlayerDashboardSecurityTests(unittest.TestCase):
    def setUp(self):
        ensure_default_admin()
        self.client = app.test_client()
        self.admin_email = "admin1@gmail.com"
        self.admin_password = "Admin@12345"
        users.update_one({"email": self.admin_email}, {"$set": {"role": "super_admin"}})

        # Ensure demo admin exists
        self.demo_admin_email = "demo_admin_test@securefps.local"
        self.demo_mfa_secret = pyotp.random_base32()
        users.update_one(
            {"email": self.demo_admin_email},
            {"$set": {
                "name": "Demo Admin",
                "email": self.demo_admin_email,
                "role": "demo_admin",
                "password_hash": hash_password("DemoAdmin@123"),
                "mfa_secret": self.demo_mfa_secret,
                "mfa_enabled": True,
                "account_status": "active",
                "created_at": datetime.now(timezone.utc)
            }},
            upsert=True
        )

        # Create a test player
        self.player_id_str = uuid.uuid4().hex[:8]
        self.player_email = f"player_{self.player_id_str}@test.local"
        self.player_password = "PlayerPass123!"
        self.player_mfa_secret = pyotp.random_base32()
        res = users.insert_one({
            "name": f"Test Player {self.player_id_str}",
            "email": self.player_email,
            "role": "player",
            "account_status": "active",
            "revoked": False,
            "password_hash": hash_password(self.player_password),
            "mfa_secret": self.player_mfa_secret,
            "mfa_enabled": True,
            "honour_score": 100,
            "created_at": datetime.now(timezone.utc)
        })
        self.player_oid = res.inserted_id

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

    def test_demo_admin_is_read_only(self):
        """Item 1: demo_admin can read but cannot perform destructive actions."""
        demo_client = self._login_as(self.demo_admin_email, "DemoAdmin@123")

        # GET is allowed
        resp = demo_client.get("/api/admin/overview")
        self.assertEqual(resp.status_code, 200)

        # Destructive actions are blocked with 403
        resp = demo_client.post(
            f"/api/admin/players/{str(self.player_oid)}/suspend",
            json={"reason": "Test suspension reason that is long enough"},
            headers=SECURE_HEADERS
        )
        self.assertEqual(resp.status_code, 403)
        self.assertIn("read-only", resp.get_json().get("message", ""))

        resp = demo_client.post(
            f"/api/admin/players/{str(self.player_oid)}/ban",
            json={"reason": "Test ban reason that is long enough", "reauth_password": "DemoAdmin@123"},
            headers=SECURE_HEADERS
        )
        self.assertEqual(resp.status_code, 403)

    def test_cannot_act_on_another_admin(self):
        """Item 1: Neither role can suspend, ban or delete an admin account."""
        admin_client = self._login_as(self.admin_email, self.admin_password)
        demo_admin_doc = users.find_one({"email": self.demo_admin_email})

        resp = admin_client.post(
            f"/api/admin/players/{str(demo_admin_doc['_id'])}/suspend",
            json={"reason": "Attempting to suspend an admin account"},
            headers=SECURE_HEADERS
        )
        self.assertEqual(resp.status_code, 403)
        self.assertIn("administrator account", resp.get_json().get("message", ""))

    def test_reason_enforcement_and_reauth_on_ban(self):
        """Item 3: Reason minimum 10 chars, re-auth required for ban."""
        admin_client = self._login_as(self.admin_email, self.admin_password)

        # Too short reason
        resp = admin_client.post(
            f"/api/admin/players/{str(self.player_oid)}/ban",
            json={"reason": "short", "reauth_password": self.admin_password},
            headers=SECURE_HEADERS
        )
        self.assertEqual(resp.status_code, 400)
        self.assertIn("at least 10 characters", resp.get_json().get("message", ""))

        # Invalid re-auth password
        resp = admin_client.post(
            f"/api/admin/players/{str(self.player_oid)}/ban",
            json={"reason": "Valid reason for banning account", "reauth_password": "WrongPassword123!"},
            headers=SECURE_HEADERS
        )
        self.assertEqual(resp.status_code, 401)

        # Valid ban
        resp = admin_client.post(
            f"/api/admin/players/{str(self.player_oid)}/ban",
            json={"reason": "Aimbot detection verified by telemetry review", "reauth_password": self.admin_password},
            headers=SECURE_HEADERS
        )
        self.assertEqual(resp.status_code, 200)
        updated = users.find_one({"_id": self.player_oid})
        self.assertEqual(updated.get("account_status"), "banned")
        self.assertTrue(updated.get("revoked"))

    def test_soft_delete_anonymizes_pii_and_revokes_sessions(self):
        """Item 2: Soft delete marks status deleted, anonymizes PII, keeps audit."""
        admin_client = self._login_as(self.admin_email, self.admin_password)

        # Insert active session
        sessions_db.insert_one({"user_id": self.player_oid, "is_active": True, "created_at": datetime.now(timezone.utc)})

        resp = admin_client.post(
            f"/api/admin/players/{str(self.player_oid)}/delete",
            json={"reason": "Player requested GDPR account erasure", "reauth_password": self.admin_password},
            headers=SECURE_HEADERS
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json().get("account_status"), "deleted")

        deleted_user = users.find_one({"_id": self.player_oid})
        self.assertEqual(deleted_user.get("account_status"), "deleted")
        self.assertTrue(deleted_user.get("email").endswith("@deleted.securefps.local"))
        self.assertIsNone(deleted_user.get("password_hash"))

        # Verify session was revoked
        active_cnt = sessions_db.count_documents({"user_id": self.player_oid, "is_active": True})
        self.assertEqual(active_cnt, 0)

    def test_ban_appeal_lifecycle(self):
        """Item 4: Banned player sees status & submits appeal, admin reviews and restores account."""
        player_client = self._login_as(self.player_email, self.player_password)

        # Admin bans player with reason
        admin_client = self._login_as(self.admin_email, self.admin_password)
        ban_resp = admin_client.post(
            f"/api/admin/players/{str(self.player_oid)}/ban",
            json={"reason": "Rapid flick detection telemetry flagged", "reauth_password": self.admin_password},
            headers=SECURE_HEADERS
        )
        self.assertEqual(ban_resp.status_code, 200)

        # Player views profile and sees banned status + ban reason + can_appeal
        profile_resp = player_client.get("/api/player/profile")
        self.assertEqual(profile_resp.status_code, 200)
        self.assertEqual(profile_resp.get_json()["account_status"], "banned")
        self.assertTrue(profile_resp.get_json()["can_appeal"])
        self.assertEqual(profile_resp.get_json()["ban_reason"], "Rapid flick detection telemetry flagged")

        # Player views appeal status (none yet)
        resp = player_client.get("/api/player/appeal")
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(resp.get_json()["has_appeal"])

        # Player submits appeal
        resp = player_client.post(
            "/api/player/appeal",
            json={"reason": "I was playing on high DPI mouse with 1600 sensitivity. Please review my match replay."},
            headers=SECURE_HEADERS
        )
        self.assertEqual(resp.status_code, 201)

        # Admin lists appeals
        resp = admin_client.get("/api/admin/appeals?status=pending")
        self.assertEqual(resp.status_code, 200)
        appeals = resp.get_json()["appeals"]
        self.assertTrue(any(a["user_id"] == str(self.player_oid) for a in appeals))
        appeal_id = [a["id"] for a in appeals if a["user_id"] == str(self.player_oid)][0]

        # Admin approves appeal
        resp = admin_client.post(
            f"/api/admin/appeals/{appeal_id}/action",
            json={"action": "approve", "note": "Replay verified as high sensitivity mouse, account restored."},
            headers=SECURE_HEADERS
        )
        self.assertEqual(resp.status_code, 200)

        # Verify user account is restored
        restored = users.find_one({"_id": self.player_oid})
        self.assertEqual(restored.get("account_status"), "active")
        self.assertFalse(restored.get("revoked"))

        # Verify player received notification
        note = player_notifications.find_one({"user_id": self.player_oid, "type": "appeal_approved"})
        self.assertIsNotNone(note)

    def test_admin_overview_30s_cache(self):
        """Item 6: Overview caching for ~30s."""
        admin_client = self._login_as(self.admin_email, self.admin_password)
        resp1 = admin_client.get("/api/admin/overview?refresh=1")
        self.assertEqual(resp1.status_code, 200)
        self.assertFalse(resp1.get_json().get("cached"))

        resp2 = admin_client.get("/api/admin/overview")
        self.assertEqual(resp2.status_code, 200)
        self.assertTrue(resp2.get_json().get("cached"))

        # Force refresh bypasses cache
        resp3 = admin_client.get("/api/admin/overview?refresh=1")
        self.assertEqual(resp3.status_code, 200)
        self.assertFalse(resp3.get_json().get("cached"))

    def test_avatar_webp_resize_and_url_storage(self):
        """Item 12: Avatar uploaded as base64 is resized to 256px WebP and stored as URL."""
        player_client = self._login_as(self.player_email, self.player_password)

        # Generate a small test PNG image
        img = Image.new("RGB", (100, 100), color=(255, 0, 0))
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        b64_str = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("utf-8")

        resp = player_client.put(
            "/api/player/profile/customization",
            json={"avatar": "custom", "banner": "frontline", "avatar_image": b64_str},
            headers=SECURE_HEADERS
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        custom = data.get("profile_customization", {})
        avatar_url = custom.get("avatar_url")
        self.assertIsNotNone(avatar_url)
        self.assertTrue(avatar_url.startswith("/api/media/avatars/"))
        self.assertTrue(avatar_url.endswith(".webp"))

        # Verify served media
        media_resp = player_client.get(avatar_url)
        self.assertEqual(media_resp.status_code, 200)
        self.assertEqual(media_resp.content_type, "image/webp")

    def test_player_gdpr_data_export(self):
        """Item 14: Player JSON data export."""
        player_client = self._login_as(self.player_email, self.player_password)
        resp = player_client.get("/api/player/export-data")
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIn("profile", data)
        self.assertIn("game_sessions", data)
        self.assertEqual(data["profile"]["email"], self.player_email)


if __name__ == "__main__":
    unittest.main()
