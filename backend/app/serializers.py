from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .content import extract_text
from .models import Attachment, Book, BookAnnotation, BookOcrJob, BookReadingState, Note
from .schemas import (
    AnnotationOut,
    AttachmentOut,
    BookCategoryOut,
    BookOcrOut,
    BookDetail,
    GroupOut,
    NoteDetail,
    NoteSummary,
    ReadingStateOut,
    TagOut,
)


def attachment_out(item: Attachment) -> AttachmentOut:
    return AttachmentOut(
        id=item.id,
        original_name=item.original_name,
        mime_type=item.mime_type,
        size=item.size,
        created_at=item.created_at,
        content_url=f"/api/attachments/{item.id}/content",
    )


def note_detail(note: Note) -> NoteDetail:
    return NoteDetail(
        id=note.id,
        title=note.title,
        content=json.loads(note.content),
        tags=[TagOut.model_validate(tag) for tag in sorted(note.tags, key=lambda value: value.normalized_name)],
        group=GroupOut.model_validate(note.group) if note.group else None,
        attachments=[attachment_out(item) for item in sorted(note.attachments, key=lambda value: value.created_at)],
        is_pinned=note.is_pinned,
        deleted_at=note.deleted_at,
        created_at=note.created_at,
        updated_at=note.updated_at,
    )


def note_summary(note: Note) -> NoteSummary:
    return NoteSummary(
        id=note.id,
        title=note.title,
        excerpt=extract_text(json.loads(note.content))[:240],
        tags=[TagOut.model_validate(tag) for tag in sorted(note.tags, key=lambda value: value.normalized_name)],
        group=GroupOut.model_validate(note.group) if note.group else None,
        is_pinned=note.is_pinned,
        deleted_at=note.deleted_at,
        created_at=note.created_at,
        updated_at=note.updated_at,
    )


def _json_value(value: str) -> Any:
    try:
        loaded = json.loads(value)
    except (TypeError, ValueError):
        return None
    return loaded


def book_out(book: Book) -> BookDetail:
    state = book.reading_state
    job = book.ocr_job
    ocr_status = job.status if job else None
    ocr_progress = None
    if job:
        ocr_progress = job.pages_done / job.pages_total if job.pages_total else 0.0
    source_status = None
    if book.storage_mode == "linked":
        try:
            source = Path(book.source_path or "")
            source_stat = source.stat()
            if not source.is_file():
                source_status = "missing"
            elif source_stat.st_mtime_ns != book.source_mtime_ns or source_stat.st_size != book.size:
                source_status = "changed"
            else:
                source_status = "available"
        except OSError:
            source_status = "missing"
    return BookDetail(
        id=book.id,
        title=book.title,
        author=book.author,
        category=BookCategoryOut.model_validate(book.category) if book.category else None,
        format=book.format,
        storage_mode=book.storage_mode,
        source_status=source_status,
        size=book.size,
        page_count=book.page_count,
        cover_url=f"/api/books/{book.id}/cover" if book.cover_storage_name else None,
        content_url=f"/api/books/{book.id}/content",
        download_url=f"/api/books/{book.id}/download",
        progress=state.progress if state else 0.0,
        last_read_at=state.last_read_at if state else None,
        ocr_status=ocr_status,
        ocr_progress=ocr_progress,
        ocr_error=job.error if job else None,
        created_at=book.created_at,
        updated_at=book.updated_at,
    )


def reading_state_out(state: BookReadingState) -> ReadingStateOut:
    settings_value = _json_value(state.settings)
    settings = settings_value if isinstance(settings_value, dict) else {}
    return ReadingStateOut(
        book_id=state.book_id,
        locator=_json_value(state.locator),
        progress=state.progress,
        font_size=settings.get("font_size", 100.0),
        line_height=settings.get("line_height", 1.6),
        font_family=settings.get("font_family", "system"),
        theme=settings.get("theme", "warm"),
        layout=settings.get("layout", "paginated"),
        last_read_at=state.last_read_at,
        updated_at=state.updated_at,
    )


def annotation_out(annotation: BookAnnotation) -> AnnotationOut:
    return AnnotationOut(
        id=annotation.id,
        book_id=annotation.book_id,
        type=annotation.type,
        locator=_json_value(annotation.locator),
        color=annotation.color,
        quote=annotation.quote,
        note=annotation.note,
        created_at=annotation.created_at,
        updated_at=annotation.updated_at,
    )


def ocr_out(job: BookOcrJob) -> BookOcrOut:
    return BookOcrOut(
        book_id=job.book_id,
        status=job.status,
        pages_total=job.pages_total,
        pages_done=job.pages_done,
        error=job.error,
        updated_at=job.updated_at,
    )
