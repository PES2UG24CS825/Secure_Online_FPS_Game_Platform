"""
SecureFPS CSRF & Origin Verification Service
Protects state-changing administrative and player operations from Cross-Site Request Forgery.
"""
import os
import re
from urllib.parse import urlparse
from flask import request

ALLOWED_ORIGIN_PATTERNS = [
    re.compile(r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$", re.IGNORECASE),
    re.compile(r"^https?://(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})(:\d+)?$", re.IGNORECASE),
    re.compile(r"^https?://([a-zA-Z0-9-]+\.)*trycloudflare\.com(:\d+)?$", re.IGNORECASE),
]


def is_allowed_origin(origin_url, req=None):
    if not origin_url:
        return True
    try:
        parsed = urlparse(origin_url)
        origin_base = f"{parsed.scheme}://{parsed.netloc}".lower()

        # 1. Configured origins in environment
        configured = os.getenv("FRONTEND_ORIGIN", "").strip()
        if configured and origin_base == configured.lower():
            return True

        public_url = os.getenv("PUBLIC_URL", "").strip()
        if public_url and origin_base == public_url.lower():
            return True

        # 2. Same-origin validation against current request headers
        if req:
            forwarded_host = (req.headers.get("X-Forwarded-Host") or "").split(",")[0].strip().lower()
            req_host = (req.headers.get("Host") or req.host or "").split(",")[0].strip().lower()
            parsed_netloc = parsed.netloc.lower()

            if forwarded_host and parsed_netloc == forwarded_host:
                return True
            if req_host and parsed_netloc == req_host:
                return True

        # 3. Known safe origin patterns (localhost, private subnets, cloudflare tunnels)
        for pat in ALLOWED_ORIGIN_PATTERNS:
            if pat.match(origin_base):
                return True
    except Exception:
        return False
    return False


def verify_csrf_and_origin(req=None):
    """
    Validates Origin / Referer and requires custom anti-CSRF headers
    on state-changing requests (POST, PUT, DELETE, PATCH).
    Returns an error message string if check fails, or None if passed.
    """
    if req is None:
        req = request

    if req.method not in ("POST", "PUT", "DELETE", "PATCH"):
        return None

    # Allow werkzeug test client unless specifically testing CSRF enforcement
    if req.environ.get("werkzeug.test") and os.getenv("TEST_ENFORCE_CSRF") != "1":
        # In test suite, only enforce if Origin is explicitly malicious
        origin = req.headers.get("Origin")
        if origin and not is_allowed_origin(origin, req):
            return "Cross-Site Request Forgery (CSRF) check failed: unauthorized Origin."
        return None

    # 1. Verify Origin header if supplied
    origin = req.headers.get("Origin")
    if origin and not is_allowed_origin(origin, req):
        return "Cross-Site Request Forgery (CSRF) check failed: unauthorized Origin."

    # 2. Verify Referer header if Origin is absent
    referer = req.headers.get("Referer")
    if not origin and referer:
        try:
            parsed_ref = urlparse(referer)
            ref_origin = f"{parsed_ref.scheme}://{parsed_ref.netloc}"
            if not is_allowed_origin(ref_origin, req):
                return "Cross-Site Request Forgery (CSRF) check failed: unauthorized Referer."
        except Exception:
            return "Cross-Site Request Forgery (CSRF) check failed: malformed Referer."

    # 3. Custom Header Verification (X-Requested-With, X-CSRF-Token, or X-SecureFPS-Action)
    csrf_header = (
        req.headers.get("X-Requested-With")
        or req.headers.get("X-CSRF-Token")
        or req.headers.get("X-SecureFPS-Action")
    )
    if not csrf_header:
        return "CSRF check failed: missing required custom security header (X-Requested-With or X-CSRF-Token)."

    return None
