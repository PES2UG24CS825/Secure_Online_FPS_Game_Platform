import unittest

from app import network_server_settings


class LocalServerSettingsTests(unittest.TestCase):
    def test_server_binds_to_all_interfaces_by_default(self):
        self.assertEqual(network_server_settings({}), ("0.0.0.0", 5000, True))

    def test_network_host_can_be_configured(self):
        self.assertEqual(
            network_server_settings({"FLASK_HOST": "127.0.0.1"}),
            ("127.0.0.1", 5000, True),
        )

    def test_local_port_and_debug_can_be_configured(self):
        self.assertEqual(
            network_server_settings({"FLASK_PORT": "5100", "FLASK_DEBUG": "0"}),
            ("0.0.0.0", 5100, False),
        )


if __name__ == "__main__":
    unittest.main()
