from __future__ import annotations

from collections.abc import Generator
from pathlib import Path

from sqlalchemy import Engine, create_engine, event
from sqlalchemy.engine import make_url
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import AppSettings, get_settings


class Base(DeclarativeBase):
    pass


def build_engine(settings: AppSettings) -> Engine:
    url = resolve_database_url(settings)
    kwargs: dict = {
        "echo": settings.database.echo,
        "pool_pre_ping": settings.database.pool_pre_ping,
    }
    if url.startswith("sqlite:"):
        kwargs["connect_args"] = {"check_same_thread": False}
        database = make_url(url).database
        if database and database != ":memory:":
            Path(database).parent.mkdir(parents=True, exist_ok=True)
    else:
        kwargs["pool_size"] = settings.database.pool_size
        kwargs["max_overflow"] = settings.database.max_overflow
    engine = create_engine(url, **kwargs)
    if engine.dialect.name == "sqlite":
        @event.listens_for(engine, "connect")
        def set_sqlite_pragma(dbapi_connection, _connection_record) -> None:
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()
    return engine


def resolve_database_url(settings: AppSettings) -> str:
    url = settings.database.url
    if url.startswith("sqlite:///./"):
        relative = url.removeprefix("sqlite:///./")
        absolute = (Path(__file__).resolve().parents[1] / relative).resolve()
        return f"sqlite:///{absolute.as_posix()}"
    return url


settings = get_settings()
engine = build_engine(settings)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False, autoflush=False)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
