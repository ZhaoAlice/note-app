from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from ..config import AppSettings, get_settings
from ..content import validate_content
from ..database import get_db
from ..dependencies import AuthContext, current_auth, require_csrf
from ..models import Group, Note, Tag, utcnow
from ..schemas import GroupInput, GroupOut, NoteCreate, NoteDetail, NoteSummary, NoteUpdate, TagOut
from ..serializers import note_detail, note_summary


router = APIRouter(prefix="/api", tags=["notes"])


def _note_query():
    return select(Note).options(selectinload(Note.group), selectinload(Note.tags), selectinload(Note.attachments))


def _get_note(db: Session, user_id: str, note_id: str) -> Note:
    note = db.scalar(_note_query().where(Note.id == note_id, Note.user_id == user_id))
    if note is None:
        raise HTTPException(404, "note not found")
    return note


def _set_tags(db: Session, note: Note, user_id: str, names: list[str]) -> None:
    unique: dict[str, str] = {}
    for raw_name in names:
        name = raw_name.strip()
        if not name:
            continue
        if len(name) > 50:
            raise HTTPException(422, "tag names must not exceed 50 characters")
        unique.setdefault(name.casefold(), name)
    if len(unique) > 20:
        raise HTTPException(422, "a note can have at most 20 tags")
    existing = {
        tag.normalized_name: tag
        for tag in db.scalars(select(Tag).where(Tag.user_id == user_id, Tag.normalized_name.in_(list(unique)))).all()
    } if unique else {}
    result: list[Tag] = []
    for normalized, name in unique.items():
        tag = existing.get(normalized)
        if tag is None:
            tag = Tag(user_id=user_id, name=name, normalized_name=normalized)
            db.add(tag)
        result.append(tag)
    note.tags = result


def _get_group(db: Session, user_id: str, group_id: str) -> Group:
    group = db.scalar(select(Group).where(Group.id == group_id, Group.user_id == user_id))
    if group is None:
        raise HTTPException(404, "group not found")
    return group


def _set_group(db: Session, note: Note, user_id: str, group_id: str | None) -> None:
    note.group = _get_group(db, user_id, group_id) if group_id else None


@router.get("/notes", response_model=list[NoteSummary])
def list_notes(
    q: str | None = Query(default=None, max_length=200),
    tag: str | None = Query(default=None, max_length=50),
    group_id: str | None = Query(default=None, max_length=36),
    ungrouped: bool = Query(default=False),
    status: str = Query(default="active", pattern="^(active|trash)$"),
    auth: AuthContext = Depends(current_auth),
    db: Session = Depends(get_db),
) -> list[NoteSummary]:
    statement = _note_query().where(Note.user_id == auth.user.id)
    statement = statement.where(Note.deleted_at.is_(None) if status == "active" else Note.deleted_at.is_not(None))
    if q and q.strip():
        search = f"%{q.strip().casefold()}%"
        statement = statement.where(or_(Note.search_text.like(search), Note.tags.any(Tag.normalized_name.like(search))))
    if tag and tag.strip():
        normalized_tag = tag.strip().casefold()
        statement = statement.where(Note.tags.any(Tag.normalized_name == normalized_tag))
    if group_id:
        statement = statement.where(Note.group_id == group_id)
    elif ungrouped:
        statement = statement.where(Note.group_id.is_(None))
    statement = statement.order_by(Note.is_pinned.desc(), Note.updated_at.desc())
    return [note_summary(note) for note in db.scalars(statement).unique().all()]


@router.post("/notes", response_model=NoteDetail, status_code=201)
def create_note(payload: NoteCreate, auth: AuthContext = Depends(require_csrf), db: Session = Depends(get_db)) -> NoteDetail:
    content_json, plain_text = validate_content(payload.content)
    note = Note(
        user_id=auth.user.id,
        title=payload.title.strip(),
        content=content_json,
        search_text=f"{payload.title} {plain_text}".casefold(),
        is_pinned=payload.is_pinned,
    )
    db.add(note)
    _set_tags(db, note, auth.user.id, payload.tag_names)
    _set_group(db, note, auth.user.id, payload.group_id)
    db.commit()
    return note_detail(_get_note(db, auth.user.id, note.id))


@router.get("/notes/{note_id}", response_model=NoteDetail)
def get_note(note_id: str, auth: AuthContext = Depends(current_auth), db: Session = Depends(get_db)) -> NoteDetail:
    return note_detail(_get_note(db, auth.user.id, note_id))


@router.patch("/notes/{note_id}", response_model=NoteDetail)
def update_note(note_id: str, payload: NoteUpdate, auth: AuthContext = Depends(require_csrf), db: Session = Depends(get_db)) -> NoteDetail:
    note = _get_note(db, auth.user.id, note_id)
    if note.deleted_at is not None:
        raise HTTPException(409, "restore the note before editing it")
    values = payload.model_fields_set
    plain_text: str | None = None
    if "content" in values:
        if payload.content is None:
            raise HTTPException(422, "content cannot be null")
        note.content, plain_text = validate_content(payload.content)
    if "title" in values:
        note.title = (payload.title or "").strip()
    if "is_pinned" in values:
        if payload.is_pinned is None:
            raise HTTPException(422, "is_pinned cannot be null")
        note.is_pinned = payload.is_pinned
    if "tag_names" in values:
        if payload.tag_names is None:
            raise HTTPException(422, "tag_names cannot be null")
        _set_tags(db, note, auth.user.id, payload.tag_names)
    if "group_id" in values:
        _set_group(db, note, auth.user.id, payload.group_id)
    if plain_text is None:
        _, plain_text = validate_content(__import__("json").loads(note.content))
    note.search_text = f"{note.title} {plain_text}".casefold()
    note.updated_at = utcnow()
    db.commit()
    return note_detail(_get_note(db, auth.user.id, note.id))


@router.delete("/notes/{note_id}", status_code=204)
def trash_note(note_id: str, auth: AuthContext = Depends(require_csrf), db: Session = Depends(get_db)) -> None:
    note = _get_note(db, auth.user.id, note_id)
    if note.deleted_at is None:
        note.deleted_at = utcnow()
        note.updated_at = utcnow()
        db.commit()


@router.post("/notes/{note_id}/restore", response_model=NoteDetail)
def restore_note(note_id: str, auth: AuthContext = Depends(require_csrf), db: Session = Depends(get_db)) -> NoteDetail:
    note = _get_note(db, auth.user.id, note_id)
    note.deleted_at = None
    note.updated_at = utcnow()
    db.commit()
    return note_detail(_get_note(db, auth.user.id, note_id))


@router.delete("/notes/{note_id}/permanent", status_code=204)
def permanently_delete_note(
    note_id: str,
    auth: AuthContext = Depends(require_csrf),
    db: Session = Depends(get_db),
    settings: AppSettings = Depends(get_settings),
) -> None:
    note = _get_note(db, auth.user.id, note_id)
    if note.deleted_at is None:
        raise HTTPException(409, "only trashed notes can be permanently deleted")
    attachment_dir = settings.attachment_path()
    stored_names = [item.storage_name for item in note.attachments]
    db.delete(note)
    db.commit()
    for storage_name in stored_names:
        (attachment_dir / storage_name).unlink(missing_ok=True)


@router.get("/tags", response_model=list[TagOut])
def list_tags(auth: AuthContext = Depends(current_auth), db: Session = Depends(get_db)) -> list[Tag]:
    return list(db.scalars(
        select(Tag)
        .where(Tag.user_id == auth.user.id, Tag.notes.any())
        .order_by(Tag.normalized_name)
    ).all())


@router.get("/groups", response_model=list[GroupOut])
def list_groups(auth: AuthContext = Depends(current_auth), db: Session = Depends(get_db)) -> list[Group]:
    return list(db.scalars(select(Group).where(Group.user_id == auth.user.id).order_by(Group.normalized_name)).all())


@router.post("/groups", response_model=GroupOut, status_code=201)
def create_group(payload: GroupInput, auth: AuthContext = Depends(require_csrf), db: Session = Depends(get_db)) -> Group:
    group = Group(user_id=auth.user.id, name=payload.name, normalized_name=payload.name.casefold())
    db.add(group)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "group name already exists")
    db.refresh(group)
    return group


@router.patch("/groups/{group_id}", response_model=GroupOut)
def rename_group(group_id: str, payload: GroupInput, auth: AuthContext = Depends(require_csrf), db: Session = Depends(get_db)) -> Group:
    group = _get_group(db, auth.user.id, group_id)
    group.name = payload.name
    group.normalized_name = payload.name.casefold()
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "group name already exists")
    db.refresh(group)
    return group


@router.delete("/groups/{group_id}", status_code=204)
def delete_group(group_id: str, auth: AuthContext = Depends(require_csrf), db: Session = Depends(get_db)) -> None:
    group = _get_group(db, auth.user.id, group_id)
    db.execute(update(Note).where(Note.user_id == auth.user.id, Note.group_id == group.id).values(group_id=None))
    db.delete(group)
    db.commit()
