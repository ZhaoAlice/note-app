from __future__ import annotations

import os
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config as AlembicConfig
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

os.environ.setdefault("NOTE_SECURITY__PBKDF2_ITERATIONS", "100000")
os.environ.setdefault("NOTE_OCR__ENABLED", "false")

from app.config import get_settings
from app.database import Base, get_db
from app.main import app
from app import models as _models  # noqa: F401


@pytest.fixture
def client(tmp_path: Path):
    external_url = os.getenv("NOTE_TEST_DATABASE_URL")
    database_url = external_url or f"sqlite:///{(tmp_path / 'test.db').as_posix()}"
    connect_args = {"check_same_thread": False} if database_url.startswith("sqlite:") else {}
    engine = create_engine(database_url, connect_args=connect_args, pool_pre_ping=True)
    if database_url.startswith("sqlite:"):
        @event.listens_for(engine, "connect")
        def foreign_keys(connection, _record):
            connection.execute("PRAGMA foreign_keys=ON")
    TestingSession = sessionmaker(bind=engine, expire_on_commit=False)
    alembic_config = None
    if external_url:
        alembic_config = AlembicConfig(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
        command.upgrade(alembic_config, "head")
    else:
        Base.metadata.create_all(engine)
    settings = get_settings()
    previous_attachment_dir = settings.storage.attachment_dir
    previous_book_dir = settings.storage.book_dir
    settings.storage.attachment_dir = str(tmp_path / "uploads")
    settings.storage.book_dir = str(tmp_path / "books")

    def override_db():
        with TestingSession() as db:
            yield db

    app.dependency_overrides[get_db] = override_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()
    settings.storage.attachment_dir = previous_attachment_dir
    settings.storage.book_dir = previous_book_dir
    if alembic_config is not None:
        command.downgrade(alembic_config, "base")
    else:
        Base.metadata.drop_all(engine)
    engine.dispose()


def register(client: TestClient, username: str = "alice") -> dict:
    response = client.post("/api/auth/register", json={"username": username, "password": "password123"})
    assert response.status_code == 201, response.text
    return response.json()


def csrf_headers(client: TestClient) -> dict[str, str]:
    token = client.get("/api/auth/csrf").json()["csrf_token"]
    return {"X-CSRF-Token": token}
