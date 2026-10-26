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
        session_cursor.sort.return_value.limit.return_value = [completed_session]
        with app.test_request_context("/api/player/matches"), \
             patch.object(player_routes, "current_user", return_value=str(user_id)), \
             patch.object(player_routes, "users") as users, \
             patch.object(player_routes, "game_sessions") as game_sessions, \
             patch.object(player_routes, "game_events") as game_events, \
             patch.object(player_routes, "game_telemetry") as game_telemetry:
            users.find_one.return_value = {"account_type": "player"}
            game_sessions.count_documents.return_value = 1
            game_sessions.find.return_value = session_cursor
            game_events.find.return_value.sort.return_value = []
            game_telemetry.count_documents.return_value = 0

            response = player_routes.get_matches()

        self.assertEqual(response.get_json()["total_matches"], 1)
        self.assertEqual([match["status"] for match in response.get_json()["matches"]], ["completed"])
        expected_filter = {"user_id": user_id, "status": "completed"}
        game_sessions.count_documents.assert_called_once_with(expected_filter)
        game_sessions.find.assert_called_once_with(expected_filter)


if __name__ == "__main__":
    unittest.main()
