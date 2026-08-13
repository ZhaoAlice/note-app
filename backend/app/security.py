from __future__ import annotations

import base64
import hashlib
import hmac
import secrets


ALGORITHM = "pbkdf2_sha256"


def hash_password(password: str, iterations: int) -> str:
    salt = secrets.token_bytes(32)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations, dklen=32)
    return "$".join((ALGORITHM, str(iterations), base64.b64encode(salt).decode(), base64.b64encode(digest).decode()))


def verify_password(password: str, encoded: str) -> tuple[bool, int]:
    try:
        algorithm, iterations_text, salt_text, expected_text = encoded.split("$", 3)
        if algorithm != ALGORITHM:
            return False, 0
        iterations = int(iterations_text)
        if iterations <= 0:
            return False, 0
        salt = base64.b64decode(salt_text, validate=True)
        expected = base64.b64decode(expected_text, validate=True)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations, dklen=len(expected))
        return hmac.compare_digest(actual, expected), iterations
    except (ValueError, TypeError):
        return False, 0


def new_token(byte_count: int = 32) -> str:
    return secrets.token_urlsafe(byte_count)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()

