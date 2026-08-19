from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Depends, File, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from ..archive import build_backup, build_markdown_export, import_backup, import_markdown
from ..config import AppSettings, get_settings
from ..database import get_db
from ..dependencies import AuthContext, current_auth, require_csrf


router = APIRouter(prefix="/api/data", tags=["data"])


@router.get("/export")
def export_data(
    format: Literal["backup", "markdown"],
    auth: AuthContext = Depends(current_auth),
    db: Session = Depends(get_db),
    settings: AppSettings = Depends(get_settings),
) -> StreamingResponse:
    output = build_backup(db, auth.user.id, settings) if format == "backup" else build_markdown_export(db, auth.user.id, settings)

    def chunks():
        try:
            while chunk := output.read(1024 * 1024):
                yield chunk
        finally:
            output.close()

    timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    kind = "backup" if format == "backup" else "markdown"
    headers = {"Content-Disposition": f'attachment; filename="note-{kind}-{timestamp}.zip"'}
    return StreamingResponse(chunks(), media_type="application/zip", headers=headers)


@router.post("/import")
def import_data(
    format: Literal["backup", "markdown"],
    file: UploadFile = File(...),
    auth: AuthContext = Depends(require_csrf),
    db: Session = Depends(get_db),
    settings: AppSettings = Depends(get_settings),
) -> dict[str, object]:
    try:
        result = (
            import_backup(file.file, db, auth.user.id, settings)
            if format == "backup"
            else import_markdown(file.file, file.filename or "notes.md", db, auth.user.id, settings)
        )
        return {
            "notes": result.notes,
            "attachments": result.attachments,
            "books": result.books,
            "annotations": result.annotations,
            "renamed": result.renamed,
            "warnings": result.warnings,
        }
    finally:
        file.file.close()
