"""Compatibility launcher for the canonical backend application.

The backend must be started from ``backend`` so its packages and environment
file resolve consistently. This wrapper keeps ``python app.py`` working from
the repository root without maintaining a second Flask application.
"""

import sys
import importlib.util
from pathlib import Path


BACKEND_DIR = Path(__file__).resolve().parent / "backend"
sys.path.insert(0, str(BACKEND_DIR))

_backend_spec = importlib.util.spec_from_file_location(
    "securefps_backend_app",
    BACKEND_DIR / "app.py",
)
if _backend_spec is None or _backend_spec.loader is None:
    raise ImportError("Could not load the canonical backend application.")
_backend_module = importlib.util.module_from_spec(_backend_spec)
_backend_spec.loader.exec_module(_backend_module)

app = _backend_module.app
ensure_default_admin = _backend_module.ensure_default_admin
network_server_settings = _backend_module.network_server_settings


if __name__ == "__main__":
    ensure_default_admin()
    flask_host, flask_port, debug_enabled = network_server_settings()
    app.run(
        host=flask_host,
        port=flask_port,
        debug=debug_enabled,
        threaded=True,
    )
