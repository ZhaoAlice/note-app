from __future__ import annotations

import json

from .content import extract_text
from .models import Attachment, Note
from .schemas import AttachmentOut, GroupOut, NoteDetail, NoteSummary, TagOut


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
