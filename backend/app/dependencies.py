from __future__ import annotations

import hmac
from dataclasses import dataclass

from fastapi import Cookie, Depends, Header, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from .config import AppSettings, get_settings
from .database import get_db
from .models import SessionModel, User, utcnow
from .security import token_hash


@dataclass
class AuthContext:
    user: User
    session: SessionModel


def verify_request_origin(request: Request, settings: AppSettings = Depends(get_settings)) -> None:
    trusted_origins = {item.rstrip("/") for item in settings.server.trusted_origins}
    # The desktop sidecar binds an ephemeral loopback port, so it cannot be
    # listed in static YAML. The desktop-token middleware protects this origin.
    if settings.desktop.enabled:
        trusted_origins.add(str(request.base_url).rstrip("/"))
    origin = request.headers.get("origin")
    if origin and origin.rstrip("/") not in trusted_origins:
        raise HTTPException(403, "untrusted request origin")
    if not origin:
        referer = request.headers.get("referer")
        if referer and not any(referer.startswith(item + "/") for item in trusted_origins):
            raise HTTPException(403, "untrusted request origin")


def current_auth(
    request: Request,
    db: Session = Depends(get_db),
    settings: AppSettings = Depends(get_settings),
) -> AuthContext:
    raw_token = request.cookies.get(settings.security.session_cookie)
    if not raw_token:
        raise HTTPException(401, "authentication required")
    session = db.scalar(
        select(SessionModel)
        .options(joinedload(SessionModel.user))
        .where(SessionModel.token_hash == token_hash(raw_token))
    )
    if session is None or session.expires_at <= utcnow():
        if session is not None:
            db.delete(session)
            db.commit()
        raise HTTPException(401, "session is invalid or expired")
    return AuthContext(user=session.user, session=session)


def require_csrf(
    request: Request,
    auth: AuthContext = Depends(current_auth),
    settings: AppSettings = Depends(get_settings),
    csrf_header: str | None = Header(default=None, alias="X-CSRF-Token"),
) -> AuthContext:
    csrf_cookie = request.cookies.get(settings.security.csrf_cookie)
    expected = auth.session.csrf_token
    if not csrf_header or not csrf_cookie:
        raise HTTPException(403, "CSRF token required")
    if not hmac.compare_digest(csrf_header, expected) or not hmac.compare_digest(csrf_cookie, expected):
        raise HTTPException(403, "invalid CSRF token")
    return auth
