import unittest
from unittest.mock import MagicMock, patch

from bson import ObjectId

from app import app
from routes import player_routes


class PlayerCompletedMatchesTests(unittest.TestCase):
    def test_matches_endpoint_queries_only_completed_sessions(self):
        user_id = ObjectId()
        completed_session = {
            "session_id": "completed-session",
            "status": "completed",
            "started_at": None,
        }
        session_cursor = MagicMock()
        session_cursor.sort.return_value = [
            completed_session, completed_session,
            {"session_id": "abandoned-session", "status": "abandoned"},
            {"session_id": "training-session", "status": "completed", "mode": "training"},
        ]
        with app.test_request_context("/api/player/matches"), \
             patch.object(player_routes, "current_user", return_value=str(user_id)), \
             patch.object(player_routes, "users") as users, \
             patch.object(player_routes, "game_sessions") as game_sessions, \
             patch.object(player_routes, "matches") as legacy_matches, \
             patch.object(player_routes, "game_events") as game_events, \
             patch.object(player_routes, "game_telemetry") as game_telemetry:
            users.find_one.return_value = {"account_type": "player"}
            game_sessions.find.return_value = session_cursor
            legacy_matches.find.return_value.sort.return_value = [completed_session]
            game_events.find.return_value.sort.return_value = []
            game_telemetry.find.return_value.sort.return_value = [
                {"session_id": "abandoned-session", "telemetry": {"kills": 2}},
            ]

            response = player_routes.get_matches()

        self.assertEqual(response.get_json()["total_matches"], 1)
        self.assertEqual([match["status"] for match in response.get_json()["matches"]], ["completed"])
        expected_filter = {"$or": [
            {"user_id": {"$in": [user_id, str(user_id)]}},
            {"player_id": {"$in": [user_id, str(user_id)]}},
        ]}
        game_sessions.find.assert_called_once_with(expected_filter)


if __name__ == "__main__":
    unittest.main()
