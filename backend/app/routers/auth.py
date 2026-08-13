from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..config import AppSettings, get_settings
from ..database import get_db
from ..dependencies import AuthContext, current_auth, require_csrf, verify_request_origin
from ..models import SessionModel, User, utcnow
from ..schemas import AuthInput, CsrfOut, ProfileUpdate, RegisterInput, UserOut
from ..security import hash_password, new_token, token_hash, verify_password


router = APIRouter(prefix="/api/auth", tags=["auth"])


def _set_session(response: Response, user: User, db: Session, settings: AppSettings) -> None:
    raw_token = new_token()
    csrf_token = new_token()
    max_age = settings.security.session_days * 86400
    session = SessionModel(
        token_hash=token_hash(raw_token),
        csrf_token=csrf_token,
        user_id=user.id,
        expires_at=utcnow() + timedelta(seconds=max_age),
    )
    db.add(session)
    db.commit()
    response.set_cookie(
        settings.security.session_cookie,
        raw_token,
        max_age=max_age,
        httponly=True,
        secure=settings.security.cookie_secure,
        samesite="lax",
        path="/",
    )
    response.set_cookie(
        settings.security.csrf_cookie,
        csrf_token,
        max_age=max_age,
        httponly=False,
        secure=settings.security.cookie_secure,
        samesite="lax",
        path="/",
    )


@router.post("/register", response_model=UserOut, status_code=201, dependencies=[Depends(verify_request_origin)])
def register(payload: RegisterInput, response: Response, db: Session = Depends(get_db), settings: AppSettings = Depends(get_settings)) -> User:
    normalized = payload.username.casefold()
    user = User(
        username=payload.username,
        normalized_username=normalized,
        display_name=payload.display_name.strip() if payload.display_name else None,
        password_hash=hash_password(payload.password, settings.security.pbkdf2_iterations),
    )
    db.add(user)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "username is already registered")
    _set_session(response, user, db, settings)
    return user


@router.post("/login", response_model=UserOut, dependencies=[Depends(verify_request_origin)])
def login(payload: AuthInput, response: Response, db: Session = Depends(get_db), settings: AppSettings = Depends(get_settings)) -> User:
    user = db.scalar(select(User).where(User.normalized_username == payload.username.casefold()))
    verified, previous_iterations = verify_password(payload.password, user.password_hash if user else "")
    if user is None or not verified:
        raise HTTPException(401, "invalid username or password")
    if previous_iterations < settings.security.pbkdf2_iterations:
        user.password_hash = hash_password(payload.password, settings.security.pbkdf2_iterations)
    _set_session(response, user, db, settings)
    return user


@router.post("/logout", status_code=204)
def logout(response: Response, auth: AuthContext = Depends(require_csrf), db: Session = Depends(get_db), settings: AppSettings = Depends(get_settings)) -> None:
    db.delete(auth.session)
    db.commit()
    response.delete_cookie(settings.security.session_cookie, path="/")
    response.delete_cookie(settings.security.csrf_cookie, path="/")


@router.get("/me", response_model=UserOut)
def me(auth: AuthContext = Depends(current_auth)) -> User:
    return auth.user


@router.patch("/me", response_model=UserOut)
def update_me(payload: ProfileUpdate, auth: AuthContext = Depends(require_csrf), db: Session = Depends(get_db)) -> User:
    auth.user.display_name = payload.display_name
    db.commit()
    db.refresh(auth.user)
    return auth.user


@router.get("/csrf", response_model=CsrfOut)
def csrf(response: Response, auth: AuthContext = Depends(current_auth), settings: AppSettings = Depends(get_settings)) -> CsrfOut:
    response.set_cookie(
        settings.security.csrf_cookie,
        auth.session.csrf_token,
        max_age=settings.security.session_days * 86400,
        httponly=False,
        secure=settings.security.cookie_secure,
        samesite="lax",
        path="/",
    )
    return CsrfOut(csrf_token=auth.session.csrf_token)
