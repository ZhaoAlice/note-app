from __future__ import annotations

import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from ..config import AppSettings, get_settings
from ..database import get_db
from ..dependencies import AuthContext, current_auth, require_csrf
from ..models import Attachment, Note
from ..schemas import AttachmentOut
from ..serializers import attachment_out


router = APIRouter(prefix="/api", tags=["attachments"])
INLINE_IMAGE_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}


def _valid_inline_image(path: Path, mime_type: str) -> bool:
    with path.open("rb") as source:
        header = source.read(12)
    if mime_type == "image/jpeg":
        return header.startswith(b"\xff\xd8\xff")
    if mime_type == "image/png":
        return header.startswith(b"\x89PNG\r\n\x1a\n")
    if mime_type == "image/gif":
        return header.startswith((b"GIF87a", b"GIF89a"))
    if mime_type == "image/webp":
        return header.startswith(b"RIFF") and header[8:12] == b"WEBP"
    return False


def _owned_attachment(db: Session, user_id: str, attachment_id: str) -> Attachment:
    item = db.scalar(
        select(Attachment)
        .join(Attachment.note)
        .options(joinedload(Attachment.note))
        .where(Attachment.id == attachment_id, Note.user_id == user_id)
    )
    if item is None:
        raise HTTPException(404, "attachment not found")
    return item


@router.post("/notes/{note_id}/attachments", response_model=AttachmentOut, status_code=201)
def upload_attachment(
    note_id: str,
    file: UploadFile = File(...),
    auth: AuthContext = Depends(require_csrf),
    db: Session = Depends(get_db),
    settings: AppSettings = Depends(get_settings),
) -> AttachmentOut:
    note = db.scalar(select(Note).where(Note.id == note_id, Note.user_id == auth.user.id))
    if note is None:
        raise HTTPException(404, "note not found")
    if note.deleted_at is not None:
        raise HTTPException(409, "restore the note before uploading attachments")
    mime_type = (file.content_type or "").lower()
    allowed_extensions = settings.storage.allowed_types.get(mime_type)
    original_name = Path(file.filename or "attachment").name[:255]
    if not allowed_extensions:
        raise HTTPException(422, "unsupported attachment type")
    actual_extension = Path(original_name).suffix.lower()
    if actual_extension not in allowed_extensions:
        raise HTTPException(422, "file extension does not match its content type")
    attachment_dir = settings.attachment_path()
    attachment_dir.mkdir(parents=True, exist_ok=True)
    storage_name = f"{uuid.uuid4().hex}{allowed_extensions[0]}"
    target = attachment_dir / storage_name
    size = 0
    try:
        with target.open("xb") as destination:
            while chunk := file.file.read(1024 * 1024):
                size += len(chunk)
                if size > settings.storage.max_file_bytes:
                    raise HTTPException(413, "attachment exceeds configured size limit")
                destination.write(chunk)
        if mime_type in INLINE_IMAGE_TYPES and not _valid_inline_image(target, mime_type):
            raise HTTPException(422, "image content does not match its declared type")
        item = Attachment(note_id=note.id, original_name=original_name, storage_name=storage_name, mime_type=mime_type, size=size)
        db.add(item)
        db.commit()
        db.refresh(item)
        return attachment_out(item)
    except Exception:
        db.rollback()
        target.unlink(missing_ok=True)
        raise
    finally:
        file.file.close()


@router.get("/attachments/{attachment_id}/content")
def attachment_content(
    attachment_id: str,
    auth: AuthContext = Depends(current_auth),
    db: Session = Depends(get_db),
    settings: AppSettings = Depends(get_settings),
) -> FileResponse:
    item = _owned_attachment(db, auth.user.id, attachment_id)
    path = settings.attachment_path() / item.storage_name
    if not path.is_file():
        raise HTTPException(404, "attachment file not found")
    disposition = "inline" if item.mime_type in INLINE_IMAGE_TYPES else "attachment"
    response = FileResponse(path, media_type=item.mime_type, filename=item.original_name, content_disposition_type=disposition)
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@router.delete("/attachments/{attachment_id}", status_code=204)
def delete_attachment(
    attachment_id: str,
    auth: AuthContext = Depends(require_csrf),
    db: Session = Depends(get_db),
    settings: AppSettings = Depends(get_settings),
) -> None:
    item = _owned_attachment(db, auth.user.id, attachment_id)
    storage_name = item.storage_name
    db.delete(item)
    db.commit()
    (settings.attachment_path() / storage_name).unlink(missing_ok=True)
