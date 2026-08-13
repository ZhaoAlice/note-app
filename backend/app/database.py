from __future__ import annotations

from collections.abc import Generator
from pathlib import Path

from sqlalchemy import Engine, create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import AppSettings, get_settings


class Base(DeclarativeBase):
    pass


def build_engine(settings: AppSettings) -> Engine:
    url = settings.database.url
    kwargs: dict = {
        "echo": settings.database.echo,
        "pool_pre_ping": settings.database.pool_pre_ping,
    }
    if url.startswith("sqlite:"):
        kwargs["connect_args"] = {"check_same_thread": False}
        if url.startswith("sqlite:///./"):
            relative = url.removeprefix("sqlite:///./")
            absolute = (Path(__file__).resolve().parents[1] / relative).resolve()
            absolute.parent.mkdir(parents=True, exist_ok=True)
            url = f"sqlite:///{absolute.as_posix()}"
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


settings = get_settings()
engine = build_engine(settings)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False, autoflush=False)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

