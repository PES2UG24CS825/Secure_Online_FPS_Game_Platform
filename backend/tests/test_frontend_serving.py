import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app as app_module


class FrontendServingTests(unittest.TestCase):
    def setUp(self):
        self.client = app_module.app.test_client()

    def test_root_redirects_to_login(self):
        response = self.client.get("/", follow_redirects=False)
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["Location"], "/login.html")

    def test_full_demo_setup_routes_are_registered(self):
        for path in (
            "/api/admin/gameplay/seed-normal-demo-players",
            "/api/admin/gameplay/seed-hacker-demo-accounts",
        ):
            with self.subTest(path=path):
                response = self.client.post(path)
                self.assertEqual(response.status_code, 403)

        telemetry_response = self.client.get("/api/admin/gameplay/telemetry")
        self.assertEqual(telemetry_response.status_code, 403)

    def test_frontend_pages_and_unity_assets_are_served(self):
        for page in ("login.html", "player.html", "admin.html", "game.html"):
            with self.subTest(page=page):
                response = self.client.get(f"/{page}")
                self.assertEqual(response.status_code, 200)

        wasm = self.client.get("/public/games/FPS_Microgame/Build/fps2.wasm")
        self.assertEqual(wasm.status_code, 200)
        self.assertEqual(wasm.mimetype, "application/wasm")

        data = self.client.get("/public/games/FPS_Microgame/Build/fps2.data")
        self.assertEqual(data.status_code, 200)
        self.assertEqual(data.mimetype, "application/octet-stream")

    def test_precompressed_assets_use_original_type_and_encoding(self):
        with tempfile.TemporaryDirectory() as directory:
            frontend = Path(directory)
            build = frontend / "Build"
            build.mkdir()
            (build / "demo.wasm.br").write_bytes(b"compressed wasm")
            with patch.object(app_module, "FRONTEND_DIR", frontend):
                response = self.client.get(
                    "/Build/demo.wasm",
                    headers={"Accept-Encoding": "br, gzip;q=0.5"},
                )

            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.mimetype, "application/wasm")
            self.assertEqual(response.headers.get("Content-Encoding"), "br")
            self.assertIn("Accept-Encoding", response.headers.get("Vary", ""))
            response.close()


if __name__ == "__main__":
    unittest.main()
