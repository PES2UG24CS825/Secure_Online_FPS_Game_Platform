import os
import unittest
from unittest.mock import patch

from scripts.seed_demo_players import NORMAL_PLAYERS, build_demo_player, main, seed_normal_demo_players
from scripts.seed_hackers import HACKERS, seed_hacker_accounts


class SeedDemoPlayersTests(unittest.TestCase):
    def test_builds_two_normal_active_player_accounts(self):
        accounts = [
            build_demo_player(email, name, username, "hashed-password", "TESTSECRET")
            for email, name, username in NORMAL_PLAYERS
        ]

        self.assertEqual(len(accounts), 2)
        self.assertEqual({account["email"] for account in accounts}, {
            "demo_player_one@example.test",
            "demo_player_two@example.test",
        })
        for account in accounts:
            self.assertEqual(account["role"], "player")
            self.assertEqual(account["account_type"], "demo_normal")
            self.assertEqual(account["account_status"], "active")
            self.assertTrue(account["demo"])
            self.assertTrue(account["mfa_enabled"])
            self.assertNotIn("hacker_profile", account)

    def test_seeding_creates_both_accounts_and_is_repeatable(self):
        class Users:
            def __init__(self):
                self.accounts = {}

            def find_one(self, query):
                for account in self.accounts.values():
                    if any(
                        all(account.get(key) == value for key, value in clause.items())
                        for clause in query["$or"]
                    ):
                        return account
                return None

            def update_one(self, query, update, upsert):
                from types import SimpleNamespace

                email = query["email"]
                created = email not in self.accounts
                self.accounts.setdefault(email, {}).update(update["$set"])
                self.accounts[email].setdefault("created_at", update["$setOnInsert"]["created_at"])
                return SimpleNamespace(upserted_id=email if created else None)

        users = Users()
        with patch("services.auth.validate_password", return_value=True), patch(
            "services.auth.hash_password", return_value="hashed"
        ):
            first = seed_normal_demo_players(users, "StrongDemoPass123!", "JBSWY3DPEHPK3PXP")
            again = seed_normal_demo_players(users, "StrongDemoPass123!", "JBSWY3DPEHPK3PXP")

        self.assertEqual(len(first["created"]), 2)
        self.assertEqual(again["created"], [])
        self.assertEqual(len(again["updated"]), 2)
        self.assertEqual(len(users.accounts), 2)

    def test_seeding_refuses_an_existing_non_demo_account(self):
        class Users:
            def find_one(self, query):
                return {"email": "demo_player_one@example.test", "role": "player", "demo": False}

        with patch("services.auth.validate_password", return_value=True), patch(
            "services.auth.hash_password", return_value="hashed"
        ), self.assertRaisesRegex(ValueError, "conflicting non-demo"):
            seed_normal_demo_players(Users(), "StrongDemoPass123!", "JBSWY3DPEHPK3PXP")

    def test_full_demo_seeds_all_four_hacker_profiles(self):
        class Users:
            def __init__(self):
                self.accounts = {}

            def find_one(self, query):
                for account in self.accounts.values():
                    if any(all(account.get(key) == value for key, value in clause.items()) for clause in query["$or"]):
                        return account
                return None

            def update_one(self, query, update, upsert):
                from types import SimpleNamespace

                email = query["email"]
                created = email not in self.accounts
                self.accounts.setdefault(email, {}).update(update["$set"])
                self.accounts[email].setdefault("created_at", update["$setOnInsert"]["created_at"])
                return SimpleNamespace(upserted_id=email if created else None)

        users = Users()
        with patch("services.auth.validate_password", return_value=True), patch(
            "services.auth.hash_password", return_value="hashed"
        ):
            result = seed_hacker_accounts(users, "StrongDemoPass123!", "JBSWY3DPEHPK3PXP")

        self.assertEqual(len(HACKERS), 4)
        self.assertEqual(len(result["created"]), 4)
        self.assertEqual({account["hacker_profile"] for account in users.accounts.values()}, {
            "aimbot", "wallhack", "speedhack", "silent_aim",
        })
        self.assertTrue(all(account["account_status"] == "active" for account in users.accounts.values()))

    def test_seeding_is_disabled_outside_development(self):
        with patch.dict(os.environ, {"APP_ENV": "production"}, clear=True):
            self.assertEqual(main(), 1)


if __name__ == "__main__":
    unittest.main()
