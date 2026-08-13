from __future__ import annotations

import copy
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field, field_validator


BASE_DIR = Path(__file__).resolve().parents[1]


class ServerSettings(BaseModel):
    host: str = "127.0.0.1"
    port: int = 8000
    debug: bool = False
    trusted_origins: list[str] = Field(default_factory=lambda: ["http://localhost:5173"])
    frontend_dist: str = "../frontend/dist"


class DatabaseSettings(BaseModel):
    url: str = "sqlite:///./data/notebook.db"
    echo: bool = False
    pool_size: int = 5
    max_overflow: int = 10
    pool_pre_ping: bool = True

    @field_validator("url")
    @classmethod
    def supported_database(cls, value: str) -> str:
        if not value.startswith(("sqlite:", "mysql+pymysql:", "postgresql+psycopg:")):
            raise ValueError("database.url must use SQLite, mysql+pymysql, or postgresql+psycopg")
        return value


class StorageSettings(BaseModel):
    upload_dir: str = "./data/uploads"
    max_file_bytes: int = 10 * 1024 * 1024


class SecuritySettings(BaseModel):
    session_cookie: str = "note_session"
    csrf_cookie: str = "note_csrf"
    session_days: int = 30
    cookie_secure: bool = False
    pbkdf2_iterations: int = 600_000

    @field_validator("pbkdf2_iterations")
    @classmethod
    def iterations_are_safe(cls, value: int) -> int:
        if value < 100_000:
            raise ValueError("security.pbkdf2_iterations must be at least 100000")
        return value


class AppSettings(BaseModel):
    server: ServerSettings = Field(default_factory=ServerSettings)
    database: DatabaseSettings = Field(default_factory=DatabaseSettings)
    storage: StorageSettings = Field(default_factory=StorageSettings)
    security: SecuritySettings = Field(default_factory=SecuritySettings)

    def resolve_path(self, value: str) -> Path:
        path = Path(value)
        return path if path.is_absolute() else (BASE_DIR / path).resolve()


def _merge(target: dict[str, Any], source: dict[str, Any]) -> None:
    for key, value in source.items():
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            _merge(target[key], value)
        else:
            target[key] = value


def _read_yaml(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    loaded = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if not isinstance(loaded, dict):
        raise ValueError(f"configuration root must be a mapping: {path}")
    return loaded


def _coerce_env(value: str) -> Any:
    try:
        return yaml.safe_load(value)
    except yaml.YAMLError:
        return value


def load_settings() -> AppSettings:
    values: dict[str, Any] = {}
    configured = os.getenv("NOTE_CONFIG_FILE")
    default_path = Path(configured).resolve() if configured else BASE_DIR / "config.yaml"
    _merge(values, _read_yaml(default_path))
    local_path = BASE_DIR / "config.local.yaml"
    if not configured:
        _merge(values, _read_yaml(local_path))
    for name, raw_value in os.environ.items():
        if not name.startswith("NOTE_") or name == "NOTE_CONFIG_FILE":
            continue
        parts = name[5:].lower().split("__")
        cursor = values
        for part in parts[:-1]:
            cursor = cursor.setdefault(part, {})
        cursor[parts[-1]] = _coerce_env(raw_value)
    return AppSettings.model_validate(copy.deepcopy(values))


@lru_cache
def get_settings() -> AppSettings:
    return load_settings()

