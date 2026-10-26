import unittest

from app import network_server_settings


class LocalServerSettingsTests(unittest.TestCase):
    def test_server_binds_to_localhost_by_default(self):
        self.assertEqual(network_server_settings({}), ("127.0.0.1", 5000, True))

    def test_network_host_overrides_cannot_expose_the_server(self):
        self.assertEqual(
            network_server_settings({"LAN_MODE": "1", "FLASK_HOST": "0.0.0.0"}),
            ("127.0.0.1", 5000, True),
        )

    def test_local_port_and_debug_can_be_configured(self):
        self.assertEqual(
            network_server_settings({"FLASK_PORT": "5100", "FLASK_DEBUG": "0"}),
            ("127.0.0.1", 5100, False),
        )


if __name__ == "__main__":
    unittest.main()
