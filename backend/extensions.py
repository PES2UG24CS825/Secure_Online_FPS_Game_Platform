"""
SecureFPS Backend Extensions
Provides shared application extensions such as Flask-Limiter.
"""
import logging
import os
import sys
from flask import current_app

logger = logging.getLogger(__name__)

def _is_rate_limit_exempt():
    if "pytest" in sys.modules or os.getenv("PYTEST_CURRENT_TEST"):
        return True
    try:
        if current_app and (current_app.testing or not current_app.config.get("RATELIMIT_ENABLED", True)):
            return True
    except RuntimeError:
        pass
    return False

try:
    from flask_limiter import Limiter
    from flask_limiter.util import get_remote_address

    limiter = Limiter(
        key_func=get_remote_address,
        default_limits=[],
        storage_uri=os.getenv("RATELIMIT_STORAGE_URI", "memory://"),
        strategy="fixed-window",
    )
    limiter.request_filter(_is_rate_limit_exempt)
except ImportError:
    logger.warning("Flask-Limiter is not installed. Falling back to no-op rate limiter.")

    class _NoOpLimiter:
        def __init__(self, *args, **kwargs):
            pass

        def init_app(self, app):
            pass

        def limit(self, *args, **kwargs):
            def decorator(f):
                return f
            return decorator

    limiter = _NoOpLimiter()
