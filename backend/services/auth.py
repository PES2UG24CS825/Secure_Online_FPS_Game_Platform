import bcrypt
import re

PASSWORD_RULES_MESSAGE = (
    "Password must be at least 8 characters and include an uppercase letter, "
    "a number, and a special character."
)

def validate_password(password: str) -> bool:
    return bool(
        len(password) >= 8
        and re.search(r"[A-Z]", password)
        and re.search(r"\d", password)
        and re.search(r"[^A-Za-z0-9]", password)
    )

def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")

def verify_password(password: str, password_hash: str) -> bool:
    return bcrypt.checkpw(
        password.encode("utf-8"),
        password_hash.encode("utf-8")
    )
