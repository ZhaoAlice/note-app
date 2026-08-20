from __future__ import annotations

from io import BytesIO
from pathlib import Path

import pytest
from sqlalchemy import create_engine

from app.config import AppSettings, get_settings, load_settings
from app.desktop_migrations import application_revision, database_revision, prepare_database
from app.desktop_migrations import DesktopMigrationError
from app.desktop_entry import _parser, _set_runtime_environment

from .conftest import csrf_headers, register


DESKTOP_TOKEN = "desktop-test-token-1234567890"


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
