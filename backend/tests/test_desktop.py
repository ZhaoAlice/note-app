from __future__ import annotations

import hashlib
import hmac
from datetime import datetime
from io import BytesIO
from pathlib import Path
import time

import pytest
from sqlalchemy import create_engine, text

from app.config import AppSettings, get_settings, load_settings
from app.desktop_migrations import application_revision, database_revision, prepare_database
from app.desktop_migrations import DesktopMigrationError
from app.desktop_entry import _parser, _set_runtime_environment

from .conftest import csrf_headers, register


DESKTOP_TOKEN = "desktop-test-token-1234567890"


def _desktop_session_headers(client) -> dict[str, str]:
    headers = {"X-Desktop-Token": DESKTOP_TOKEN}
    created = client.post("/api/desktop/bootstrap", headers=headers)
    assert created.status_code == 201, created.text
    csrf = client.get("/api/auth/csrf", headers=headers)
    assert csrf.status_code == 200, csrf.text
    return {**headers, "X-CSRF-Token": csrf.json()["csrf_token"]}


def _signed_file_headers(operation: str, source_path: str) -> dict[str, str]:
    timestamp = str(int(time.time()))
    message = f"{operation}\n{timestamp}\n{source_path}".encode("utf-8")
    signature = hmac.new(DESKTOP_TOKEN.encode(), message, hashlib.sha256).hexdigest()
    return {
        "X-Desktop-File-Timestamp": timestamp,
        "X-Desktop-File-Signature": signature,
    }


def test_explicit_local_config_overrides_primary_config(tmp_path: Path, monkeypatch):
    primary = tmp_path / "config.yaml"
    local = tmp_path / "config.local.yaml"
    primary.write_text("server:\n  port: 7001\n", encoding="utf-8")
    local.write_text("server:\n  port: 7002\n", encoding="utf-8")
    monkeypatch.setenv("NOTE_CONFIG_FILE", str(primary))
    monkeypatch.setenv("NOTE_CONFIG_LOCAL_FILE", str(local))
    settings = load_settings()
    assert settings.server.port == 7002


def test_cli_does_not_disable_yaml_remote_migration_confirmation(tmp_path: Path, monkeypatch):
    config = tmp_path / "config.yaml"
    config.write_text("desktop:\n  allow_remote_migrations: true\n", encoding="utf-8")
    monkeypatch.delenv("NOTE_DESKTOP__ALLOW_REMOTE_MIGRATIONS", raising=False)
    args = _parser().parse_args(
        ["--desktop", "--config", str(config), "--token", DESKTOP_TOKEN]
    )
    _set_runtime_environment(args)
    assert load_settings().desktop.allow_remote_migrations is True


def test_cli_resource_directory_overrides_imported_web_paths(tmp_path: Path, monkeypatch):
    config = tmp_path / "config.yaml"
    config.write_text(
        "server:\n  frontend_dist: ../frontend/dist\nocr:\n  model_dir: ./old-models\n",
        encoding="utf-8",
    )
    resources = tmp_path / "installed-resources"
    args = _parser().parse_args(
        [
            "--desktop", "--config", str(config), "--token", DESKTOP_TOKEN,
            "--resource-dir", str(resources),
        ]
    )
    _set_runtime_environment(args)
    settings = load_settings()
    assert settings.server.frontend_dist == str(resources.resolve() / "frontend")
    assert settings.ocr.model_dir == str(resources.resolve() / "ocr-models")


def test_desktop_token_status_and_bootstrap(client):
    settings = get_settings()
    previous = settings.desktop.model_copy(deep=True)
    settings.desktop.enabled = True
    settings.desktop.token = DESKTOP_TOKEN
    settings.desktop.config_path = "C:/example/config.local.yaml"
    try:
        assert client.get("/api/health").status_code == 404
        assert client.get("/api/health", headers={"X-Desktop-Token": "wrong"}).status_code == 404
        headers = {"X-Desktop-Token": DESKTOP_TOKEN}
        assert client.get("/api/health", headers=headers).json() == {"status": "ok"}

        status = client.get("/api/desktop/status", headers=headers)
        assert status.status_code == 200, status.text
        assert status.json()["desktop_mode"] is True
        assert status.json()["database_type"] == "sqlite"
        assert status.json()["allow_auto_bootstrap"] is True

        created = client.post("/api/desktop/bootstrap", headers=headers)
        assert created.status_code == 201, created.text
        assert created.json()["display_name"] == "本地档案"
        assert client.get("/api/auth/me", headers=headers).status_code == 200
        assert client.post("/api/desktop/bootstrap", headers=headers).status_code == 409
    finally:
        settings.desktop = previous


def test_desktop_accepts_its_ephemeral_same_origin(client):
    settings = get_settings()
    previous = settings.desktop.model_copy(deep=True)
    settings.desktop.enabled = True
    settings.desktop.token = DESKTOP_TOKEN
    try:
        response = client.post(
            "/api/auth/register",
            headers={"X-Desktop-Token": DESKTOP_TOKEN, "Origin": "http://testserver"},
            json={"username": "desktop-user", "password": "password123"},
        )
        assert response.status_code == 201, response.text
    finally:
        settings.desktop = previous


def test_desktop_routes_are_hidden_in_web_mode(client):
    assert client.get("/api/desktop/status").status_code == 404
    assert client.post("/api/desktop/bootstrap").status_code == 404
    assert client.post(
        "/api/desktop/books/link", json={"source_path": "C:/book.txt"}
    ).status_code == 404


def test_linked_book_lifecycle_refresh_relink_and_delete(client, tmp_path: Path):
    settings = get_settings()
    previous = settings.desktop.model_copy(deep=True)
    settings.desktop.enabled = True
    settings.desktop.token = DESKTOP_TOKEN
    source = tmp_path / "linked.txt"
    source.write_text("first linked content", encoding="utf-8")
    replacement = tmp_path / "replacement.txt"
    replacement.write_text("replacement linked content", encoding="utf-8")
    try:
        headers = _desktop_session_headers(client)
        category = client.post(
            "/api/book-categories", headers=headers, json={"name": "Linked"}
        ).json()
        source_path = str(source.resolve())
        linked = client.post(
            "/api/desktop/books/link",
            headers={**headers, **_signed_file_headers("link", source_path)},
            json={"source_path": source_path, "category_id": category["id"]},
        )
        assert linked.status_code == 201, linked.text
        book = linked.json()
        assert book["storage_mode"] == "linked"
        assert book["source_status"] == "available"
        assert book["category"]["id"] == category["id"]
        assert "source_path" not in book
        assert client.get(book["content_url"], headers=headers).text == "first linked content"
        assert client.get(book["download_url"], headers=headers).content == source.read_bytes()
        assert len(list(settings.book_path().iterdir())) == 1

        duplicate = client.post(
            "/api/desktop/books/link",
            headers={**headers, **_signed_file_headers("link", source_path)},
            json={"source_path": source_path},
        )
        assert duplicate.status_code == 200, duplicate.text
        assert duplicate.json()["id"] == book["id"]

        state = client.put(
            f"/api/books/{book['id']}/reading-state",
            headers=headers,
            json={"locator": {"kind": "text", "start": 2}, "progress": 0.4},
        )
        assert state.status_code == 200, state.text
        source.write_text("second linked content is longer", encoding="utf-8")
        changed = client.get(f"/api/books/{book['id']}", headers=headers).json()
        assert changed["source_status"] == "changed"
        assert client.get(book["content_url"], headers=headers).text == "first linked content"
        refreshed = client.post(
            f"/api/desktop/books/{book['id']}/refresh-source", headers=headers
        )
        assert refreshed.status_code == 200, refreshed.text
        assert refreshed.json()["source_status"] == "available"
        assert client.get(book["content_url"], headers=headers).text == "second linked content is longer"
        assert client.get(f"/api/books/{book['id']}/reading-state", headers=headers).json()[
            "progress"
        ] == 0.4

        source.write_bytes(b"\x00invalid text source")
        failed_refresh = client.post(
            f"/api/desktop/books/{book['id']}/refresh-source", headers=headers
        )
        assert failed_refresh.status_code == 422
        assert client.get(book["content_url"], headers=headers).text == "second linked content is longer"

        source.unlink()
        missing = client.get(f"/api/books/{book['id']}", headers=headers).json()
        assert missing["source_status"] == "missing"
        assert client.get(book["content_url"], headers=headers).status_code == 200
        assert client.get(book["download_url"], headers=headers).status_code == 404

        replacement_path = str(replacement.resolve())
        relinked = client.post(
            f"/api/desktop/books/{book['id']}/relink",
            headers={
                **headers,
                **_signed_file_headers(f"relink:{book['id']}", replacement_path),
            },
            json={"source_path": replacement_path},
        )
        assert relinked.status_code == 200, relinked.text
        assert relinked.json()["source_status"] == "available"
        assert relinked.json()["title"] == book["title"]
        assert relinked.json()["category"]["id"] == category["id"]
        assert client.get(book["content_url"], headers=headers).text == "replacement linked content"

        assert client.delete(f"/api/books/{book['id']}", headers=headers).status_code == 204
        assert replacement.read_text(encoding="utf-8") == "replacement linked content"
        assert not list(settings.book_path().iterdir())
    finally:
        settings.desktop = previous


def test_linked_book_authorization_and_validation(client, tmp_path: Path):
    settings = get_settings()
    previous = settings.desktop.model_copy(deep=True)
    settings.desktop.enabled = True
    settings.desktop.token = DESKTOP_TOKEN
    source = tmp_path / "authorized.md"
    source.write_text("# Linked", encoding="utf-8")
    source_path = str(source.resolve())
    try:
        headers = _desktop_session_headers(client)
        unsigned = client.post(
            "/api/desktop/books/link", headers=headers, json={"source_path": source_path}
        )
        assert unsigned.status_code == 403
        invalid = client.post(
            "/api/desktop/books/link",
            headers={
                **headers,
                "X-Desktop-File-Timestamp": str(int(time.time())),
                "X-Desktop-File-Signature": "0" * 64,
            },
            json={"source_path": source_path},
        )
        assert invalid.status_code == 403
        stale_timestamp = str(int(time.time()) - 61)
        stale_signature = hmac.new(
            DESKTOP_TOKEN.encode(),
            f"link\n{stale_timestamp}\n{source_path}".encode(),
            hashlib.sha256,
        ).hexdigest()
        stale = client.post(
            "/api/desktop/books/link",
            headers={
                **headers,
                "X-Desktop-File-Timestamp": stale_timestamp,
                "X-Desktop-File-Signature": stale_signature,
            },
            json={"source_path": source_path},
        )
        assert stale.status_code == 403
        assert not list(settings.book_path().iterdir())
    finally:
        settings.desktop = previous


def test_book_upload_deduplicates_for_current_user(client):
    register(client)
    headers = csrf_headers(client)
    payload = b"same desktop import"
    first = client.post(
        "/api/books?deduplicate=true",
        headers=headers,
        files={"file": ("one.txt", BytesIO(payload), "text/plain")},
    )
    second = client.post(
        "/api/books?deduplicate=true",
        headers=headers,
        files={"file": ("renamed.txt", BytesIO(payload), "text/plain")},
    )
    assert first.status_code == 201, first.text
    assert second.status_code == 201, second.text
    assert second.json()["id"] == first.json()["id"]
    assert len(client.get("/api/books").json()) == 1
    assert len(list(get_settings().book_path().iterdir())) == 2


def test_prepare_database_upgrades_sqlite_and_creates_backup(tmp_path: Path):
    database = tmp_path / "desktop.db"
    settings = AppSettings.model_validate(
        {
            "database": {"url": f"sqlite:///{database.as_posix()}"},
            "ocr": {"enabled": False},
        }
    )
    assert prepare_database(settings) is None
    engine = create_engine(settings.database.url)
    try:
        assert database_revision(engine) == application_revision()
    finally:
        engine.dispose()

    # Put a real older schema in place and verify a recoverable copy is made.
    from alembic import command
    from app.desktop_migrations import alembic_config

    command.downgrade(alembic_config(settings), "0002_note_groups")
    backup = prepare_database(settings)
    assert backup is not None and backup.is_file()
    assert backup.parent == database.parent


def test_linked_book_migration_downgrade_promotes_reader_cache(tmp_path: Path):
    from alembic import command
    from app.desktop_migrations import alembic_config

    database = tmp_path / "linked-downgrade.db"
    settings = AppSettings.model_validate(
        {
            "database": {"url": f"sqlite:///{database.as_posix()}"},
            "ocr": {"enabled": False},
        }
    )
    command.upgrade(alembic_config(settings), "head")
    engine = create_engine(settings.database.url)
    now = datetime(2026, 1, 1)
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO users "
                    "(id, username, normalized_username, display_name, password_hash, created_at) "
                    "VALUES (:id, 'linked', 'linked', NULL, 'hash', :created_at)"
                ),
                {"id": "user-linked", "created_at": now},
            )
            connection.execute(
                text(
                    "INSERT INTO books "
                    "(id, user_id, category_id, title, author, format, original_name, "
                    "storage_mode, storage_name, reader_storage_name, source_path, "
                    "source_path_hash, source_mtime_ns, cover_storage_name, cover_mime_type, "
                    "sha256, size, page_count, search_text, created_at, updated_at) "
                    "VALUES (:id, :user_id, NULL, 'Linked', NULL, 'txt', 'linked.txt', "
                    "'linked', NULL, 'safe-reader.txt', 'C:/linked.txt', :path_hash, 1, "
                    "NULL, NULL, :sha256, 10, NULL, '', :created_at, :updated_at)"
                ),
                {
                    "id": "book-linked",
                    "user_id": "user-linked",
                    "path_hash": "1" * 64,
                    "sha256": "2" * 64,
                    "created_at": now,
                    "updated_at": now,
                },
            )
        command.downgrade(alembic_config(settings), "0004_book_categories")
        with engine.connect() as connection:
            storage_name = connection.scalar(
                text("SELECT storage_name FROM books WHERE id = 'book-linked'")
            )
        assert storage_name == "safe-reader.txt"
    finally:
        engine.dispose()


def test_remote_migration_requires_cli_or_yaml_confirmation(monkeypatch):
    import app.desktop_migrations as migrations

    class FakeEngine:
        def dispose(self):
            pass

    monkeypatch.setattr(migrations, "create_engine", lambda *_args, **_kwargs: FakeEngine())
    monkeypatch.setattr(migrations, "database_revision", lambda _engine: "0002_note_groups")
    upgraded: list[str] = []
    monkeypatch.setattr(migrations.command, "upgrade", lambda _config, target: upgraded.append(target))

    denied = AppSettings.model_validate(
        {"database": {"url": "postgresql+psycopg://user:secret@localhost/note"}}
    )
    with pytest.raises(DesktopMigrationError, match="--allow-remote-migrations"):
        prepare_database(denied)

    allowed = AppSettings.model_validate(
        {
            "database": {"url": "postgresql+psycopg://user:secret@localhost/note"},
            "desktop": {"allow_remote_migrations": True},
        }
    )
    assert prepare_database(allowed) is None
    assert upgraded == ["head"]
