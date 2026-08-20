from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..config import AppSettings, get_settings
from ..database import get_db
from ..desktop_migrations import database_revision, application_revision
from ..models import User
from ..schemas import DesktopStatusOut, UserOut
from ..security import hash_password, new_token
from .auth import _set_session


router = APIRouter(prefix="/api/desktop", tags=["desktop"])


def _require_desktop(settings: AppSettings) -> None:
    if not settings.desktop.enabled:
        raise HTTPException(404, "not found")


def _database_type(settings: AppSettings) -> str:
    if settings.database.url.startswith("sqlite:"):
        return "sqlite"
    if settings.database.url.startswith("mysql+"):
        return "mysql"
    return "postgresql"


@router.get("/status", response_model=DesktopStatusOut)
def desktop_status(
    db: Session = Depends(get_db), settings: AppSettings = Depends(get_settings)
) -> DesktopStatusOut:
    _require_desktop(settings)
    users = db.scalar(select(func.count()).select_from(User)) or 0
    current = database_revision(db.get_bind())
    head = application_revision()
    return DesktopStatusOut(
        desktop_mode=True,
        database_type=_database_type(settings),
        config_path=settings.desktop.config_path,
        database_revision=current,
        application_revision=head,
        database_status="ready" if current == head else "migration_required",
        allow_auto_bootstrap=users == 0,
        user_count=users,
    )


@router.post("/bootstrap", response_model=UserOut, status_code=201)
def bootstrap_local_profile(
    response: Response,
    db: Session = Depends(get_db),
    settings: AppSettings = Depends(get_settings),
) -> User:
    _require_desktop(settings)
    if (db.scalar(select(func.count()).select_from(User)) or 0) != 0:
        raise HTTPException(409, "database already contains users")
    # The generated secret makes password login intentionally unavailable while
    # retaining the existing User schema and session machinery.
    user = User(
        username="local",
        normalized_username="local",
        display_name="本地档案",
        password_hash=hash_password(new_token() + new_token(), settings.security.pbkdf2_iterations),
    )
    db.add(user)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "database already contains users")
    _set_session(response, user, db, settings)
    return user
