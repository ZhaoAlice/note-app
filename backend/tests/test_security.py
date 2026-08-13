from app.security import hash_password, verify_password


def test_password_hashes_use_random_salts_and_verify():
    first = hash_password("secret-password", 100_000)
    second = hash_password("secret-password", 100_000)
    assert first != second
    assert verify_password("secret-password", first) == (True, 100_000)
    assert verify_password("wrong-password", first)[0] is False
    assert verify_password("secret-password", "malformed") == (False, 0)

