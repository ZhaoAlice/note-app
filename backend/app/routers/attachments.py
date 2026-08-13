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
IMAGE_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp"}
OTHER_TYPES = {
    "application/pdf": ".pdf", "text/plain": ".txt", "text/markdown": ".md", "text/csv": ".csv",
    "application/zip": ".zip", "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.ms-powerpoint": ".ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
}
ALLOWED_TYPES = {**IMAGE_TYPES, **OTHER_TYPES}


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
    expected_extension = ALLOWED_TYPES.get(mime_type)
    original_name = Path(file.filename or "attachment").name[:255]
    if not expected_extension:
        raise HTTPException(422, "unsupported attachment type")
    actual_extension = Path(original_name).suffix.lower()
    compatible_extensions = {expected_extension}
    if mime_type == "image/jpeg": compatible_extensions.add(".jpeg")
    if mime_type == "text/markdown": compatible_extensions.add(".markdown")
    if actual_extension not in compatible_extensions:
        raise HTTPException(422, "file extension does not match its content type")
    upload_dir = settings.resolve_path(settings.storage.upload_dir)
    upload_dir.mkdir(parents=True, exist_ok=True)
    storage_name = f"{uuid.uuid4().hex}{expected_extension}"
    target = upload_dir / storage_name
    size = 0
    try:
        with target.open("xb") as destination:
            while chunk := file.file.read(1024 * 1024):
                size += len(chunk)
                if size > settings.storage.max_file_bytes:
                    raise HTTPException(413, "attachment exceeds configured size limit")
                destination.write(chunk)
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
    path = settings.resolve_path(settings.storage.upload_dir) / item.storage_name
    if not path.is_file():
        raise HTTPException(404, "attachment file not found")
    disposition = "inline" if item.mime_type in IMAGE_TYPES else "attachment"
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
    (settings.resolve_path(settings.storage.upload_dir) / storage_name).unlink(missing_ok=True)

