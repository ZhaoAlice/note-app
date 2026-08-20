from __future__ import annotations

import hashlib
import hmac
import time

from fastapi import APIRouter, Depends, Header, HTTPException, Response
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..config import AppSettings, get_settings
from ..database import get_db
from ..desktop_migrations import database_revision, application_revision
from ..dependencies import AuthContext, require_csrf
from ..models import User
from ..schemas import (
    BookDetail,
    DesktopBookLinkInput,
    DesktopBookRelinkInput,
    DesktopStatusOut,
    UserOut,
)
from ..security import hash_password, new_token
from ..serializers import book_out
from .auth import _set_session
from .books import _owned_book, create_linked_book, refresh_linked_book


router = APIRouter(prefix="/api/desktop", tags=["desktop"])


def _require_desktop(settings: AppSettings) -> None:
    if not settings.desktop.enabled:
        raise HTTPException(404, "not found")


def _require_desktop_dependency(settings: AppSettings = Depends(get_settings)) -> None:
    _require_desktop(settings)


def _verify_file_authorization(
    operation: str,
    source_path: str,
    timestamp_header: str | None,
    signature: str | None,
    settings: AppSettings,
) -> None:
    """Verify a short-lived local-path capability issued by Electron's main process."""
    if not timestamp_header or not signature:
        raise HTTPException(403, "desktop file authorization required")
    try:
        timestamp = int(timestamp_header)
    except ValueError as exc:
        raise HTTPException(403, "invalid desktop file authorization") from exc
    if abs(int(time.time()) - timestamp) > 60:
        raise HTTPException(403, "desktop file authorization expired")
    message = f"{operation}\n{timestamp_header}\n{source_path}".encode("utf-8")
    expected = hmac.new(settings.desktop.token.encode("utf-8"), message, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        raise HTTPException(403, "invalid desktop file authorization")


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


@router.post(
    "/books/link",
    response_model=BookDetail,
    status_code=201,
    dependencies=[Depends(_require_desktop_dependency)],
)
def link_local_book(
    body: DesktopBookLinkInput,
    response: Response,
    auth: AuthContext = Depends(require_csrf),
    db: Session = Depends(get_db),
    settings: AppSettings = Depends(get_settings),
    file_timestamp: str | None = Header(default=None, alias="X-Desktop-File-Timestamp"),
    file_signature: str | None = Header(default=None, alias="X-Desktop-File-Signature"),
) -> BookDetail:
    _require_desktop(settings)
    _verify_file_authorization("link", body.source_path, file_timestamp, file_signature, settings)
    book, created = create_linked_book(
        db, auth.user.id, body.source_path, body.category_id, settings
    )
    if not created:
        response.status_code = 200
    return book_out(book)


@router.post(
    "/books/{book_id}/relink",
    response_model=BookDetail,
    dependencies=[Depends(_require_desktop_dependency)],
)
def relink_local_book(
    book_id: str,
    body: DesktopBookRelinkInput,
    auth: AuthContext = Depends(require_csrf),
    db: Session = Depends(get_db),
    settings: AppSettings = Depends(get_settings),
    file_timestamp: str | None = Header(default=None, alias="X-Desktop-File-Timestamp"),
    file_signature: str | None = Header(default=None, alias="X-Desktop-File-Signature"),
) -> BookDetail:
    _require_desktop(settings)
    _verify_file_authorization(
        f"relink:{book_id}", body.source_path, file_timestamp, file_signature, settings
    )
    book = _owned_book(db, auth.user.id, book_id)
    return book_out(refresh_linked_book(db, book, settings, body.source_path))


@router.post(
    "/books/{book_id}/refresh-source",
    response_model=BookDetail,
    dependencies=[Depends(_require_desktop_dependency)],
)
def refresh_local_book_source(
    book_id: str,
    auth: AuthContext = Depends(require_csrf),
    db: Session = Depends(get_db),
    settings: AppSettings = Depends(get_settings),
) -> BookDetail:
    _require_desktop(settings)
    book = _owned_book(db, auth.user.id, book_id)
    return book_out(refresh_linked_book(db, book, settings))
