from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
import shutil
import sys

from alembic import command
from alembic.config import Config as AlembicConfig
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import Engine, create_engine
from sqlalchemy.engine import make_url

from .config import AppSettings
from .database import resolve_database_url


class DesktopMigrationError(RuntimeError):
    pass


def _bundle_root() -> Path:
    frozen_root = getattr(sys, "_MEIPASS", None)
    if frozen_root:
        return Path(frozen_root)
    return Path(__file__).resolve().parents[1]


def alembic_config(settings: AppSettings | None = None) -> AlembicConfig:
    root = _bundle_root()
    config = AlembicConfig(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    if settings is not None:
        config.set_main_option("sqlalchemy.url", resolve_database_url(settings).replace("%", "%%"))
    return config


def application_revision() -> str:
    heads = ScriptDirectory.from_config(alembic_config()).get_heads()
    if len(heads) != 1:
        raise DesktopMigrationError("desktop sidecar requires exactly one Alembic head")
    return heads[0]


def database_revision(engine: Engine) -> str | None:
    with engine.connect() as connection:
        return MigrationContext.configure(connection).get_current_revision()


def _validate_revision(current: str | None, head: str) -> None:
    if current is None or current == head:
        return
    script = ScriptDirectory.from_config(alembic_config())
    try:
        current_revision = script.get_revision(current)
    except Exception as exc:
        raise DesktopMigrationError(
            f"database revision {current!r} is newer than or unknown to this client"
        ) from exc
    if current_revision is None:
        raise DesktopMigrationError(f"database revision {current!r} is not supported")
    ancestors = {item.revision for item in script.walk_revisions(base="base", head=head)}
    if current not in ancestors:
        raise DesktopMigrationError(
            f"database revision {current!r} is not an ancestor of application revision {head!r}"
        )


def _backup_sqlite(url: str) -> Path | None:
    database = make_url(url).database
    if not database or database == ":memory:":
        return None
    source = Path(database)
    if not source.is_file() or source.stat().st_size == 0:
        return None
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    target = source.with_name(f"{source.name}.{stamp}.bak")
    suffix = 1
    while target.exists():
        target = source.with_name(f"{source.name}.{stamp}.{suffix}.bak")
        suffix += 1
    shutil.copy2(source, target)
    return target


def prepare_database(settings: AppSettings, *, allow_remote_migrations: bool = False) -> Path | None:
    """Validate and, when allowed, upgrade the configured database to the bundled head."""
    url = resolve_database_url(settings)
    engine = create_engine(url, pool_pre_ping=True)
    try:
        current = database_revision(engine)
    finally:
        engine.dispose()
    head = application_revision()
    _validate_revision(current, head)
    if current == head:
        return None
    is_sqlite = url.startswith("sqlite:")
    migrations_allowed = allow_remote_migrations or settings.desktop.allow_remote_migrations
    if not is_sqlite and not migrations_allowed:
        raise DesktopMigrationError(
            f"remote database requires migration from {current or 'base'} to {head}; "
            "restart with --allow-remote-migrations after making a backup"
        )
    backup = _backup_sqlite(url) if is_sqlite else None
    command.upgrade(alembic_config(settings), "head")
    return backup
