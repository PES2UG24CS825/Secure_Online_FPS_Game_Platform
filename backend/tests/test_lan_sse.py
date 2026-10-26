import unittest
import uuid

from app import app
from database.db import sessions_db, users
from routes.game_routes import publish_live_update


class LiveServerSentEventsTests(unittest.TestCase):
    def setUp(self):
        self.user_id = users.insert_one({
            "name": "LAN SSE test admin",
            "email": f"lan-sse-{uuid.uuid4().hex}@example.test",
            "role": "admin",
            "account_status": "active",
        }).inserted_id
        self.auth_session_id = sessions_db.insert_one({
            "user_id": self.user_id,
            "is_active": True,
        }).inserted_id
        users.update_one(
            {"_id": self.user_id},
            {"$set": {"active_auth_session_id": str(self.auth_session_id)}},
        )
        self.client = app.test_client()
        with self.client.session_transaction() as flask_session:
            flask_session["user_id"] = str(self.user_id)
            flask_session["auth_session_record_id"] = str(self.auth_session_id)

    def tearDown(self):
        sessions_db.delete_one({"_id": self.auth_session_id})
        users.delete_one({"_id": self.user_id})

    def test_authenticated_admin_receives_live_stream_updates(self):
        response = self.client.get("/api/live/events", buffered=False)
        try:
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.mimetype, "text/event-stream")
            self.assertIn(b"event: ready", next(response.response))

            publish_live_update(
                self.user_id,
                event_type="lan_sse_test",
                force=True,
            )
            event = next(response.response)
            self.assertIn(b"event: update", event)
            self.assertIn(b"lan_sse_test", event)
        finally:
            response.close()


if __name__ == "__main__":
    unittest.main()
