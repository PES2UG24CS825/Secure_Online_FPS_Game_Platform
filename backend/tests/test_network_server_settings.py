import unittest

from app import network_server_settings


class NetworkServerSettingsTests(unittest.TestCase):
    def test_lan_mode_is_off_by_default(self):
        self.assertEqual(
            network_server_settings({}),
            ("127.0.0.1", 5000, True),
        )

    def test_lan_mode_defaults_to_all_interfaces_with_debug_off(self):
        self.assertEqual(
            network_server_settings({"LAN_MODE": "1"}),
            ("0.0.0.0", 5000, False),
        )

    def test_debug_is_forced_off_for_wildcard_host(self):
        self.assertEqual(
            network_server_settings({"FLASK_HOST": "0.0.0.0", "FLASK_DEBUG": "1"}),
            ("0.0.0.0", 5000, False),
        )

    def test_host_port_and_debug_can_be_overridden_locally(self):
        self.assertEqual(
            network_server_settings({
                "LAN_MODE": "1",
                "FLASK_HOST": "127.0.0.1",
                "FLASK_PORT": "5100",
                "FLASK_DEBUG": "0",
            }),
            ("127.0.0.1", 5100, False),
        )


if __name__ == "__main__":
    unittest.main()
