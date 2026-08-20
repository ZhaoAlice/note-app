from __future__ import annotations

import hashlib
import json
import tempfile
import uuid
import zipfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from ..config import AppSettings
from ..content import validate_content
from ..models import (
    Attachment,
    Book,
    BookAnnotation,
    BookCategory,
    BookOcrJob,
    BookReadingState,
    BookTextUnit,
    Group,
    Note,
    Tag,
    new_id,
    utcnow,
)


ARCHIVE_FORMAT = "note-backup"
ARCHIVE_VERSION = 3
LEGACY_ARCHIVE_VERSION = 1
BOOKS_ARCHIVE_VERSION = 2
MAX_ARCHIVE_ENTRIES = 10_000
MAX_ARCHIVE_BYTES = 5 * 1024 * 1024 * 1024
MAX_UNCOMPRESSED_BYTES = 10 * 1024 * 1024 * 1024
MAX_JSON_BYTES = 5 * 1024 * 1024
MAX_BOOK_JSON_BYTES = 64 * 1024 * 1024
COPY_CHUNK_BYTES = 1024 * 1024
INLINE_IMAGE_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}


@dataclass(frozen=True)
class ImportResult:
    notes: int
    attachments: int
    renamed: int
    warnings: list[str]
    books: int = 0
    annotations: int = 0


@dataclass(frozen=True)
class ParsedArchive:
    manifest: dict[str, Any]
    notes: list[dict[str, Any]]
    books: list[dict[str, Any]]


def _datetime_out(value: datetime | None) -> str | None:
    if value is None:
        return None
    aware = value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
    return aware.isoformat().replace("+00:00", "Z")


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(COPY_CHUNK_BYTES):
            digest.update(chunk)
    return digest.hexdigest()


def _model_json(value: str, label: str) -> dict[str, Any]:
    try:
        parsed = json.loads(value)
    except (TypeError, json.JSONDecodeError) as exc:
        raise HTTPException(409, f"{label} is invalid") from exc
    if not isinstance(parsed, dict):
        raise HTTPException(409, f"{label} is invalid")
    return parsed


def _optional_model_json(value: str, label: str) -> dict[str, Any] | None:
    try:
        parsed = json.loads(value)
    except (TypeError, json.JSONDecodeError) as exc:
        raise HTTPException(409, f"{label} is invalid") from exc
    if parsed is not None and not isinstance(parsed, dict):
        raise HTTPException(409, f"{label} is invalid")
    return parsed


def build_backup(db: Session, user_id: str, settings: AppSettings) -> BinaryIO:
    groups = list(db.scalars(select(Group).where(Group.user_id == user_id).order_by(Group.id)).all())
    tags = list(db.scalars(select(Tag).where(Tag.user_id == user_id).order_by(Tag.id)).all())
    book_categories = list(
        db.scalars(select(BookCategory).where(BookCategory.user_id == user_id).order_by(BookCategory.id)).all()
    )
    notes = list(
        db.scalars(
            select(Note)
            .options(selectinload(Note.tags), selectinload(Note.attachments))
            .where(Note.user_id == user_id)
            .order_by(Note.id)
        ).unique().all()
    )
    books = list(
        db.scalars(
            select(Book)
            .options(selectinload(Book.reading_state), selectinload(Book.annotations))
            .where(Book.user_id == user_id)
            .order_by(Book.id)
        ).unique().all()
    )
    output = tempfile.SpooledTemporaryFile(max_size=16 * 1024 * 1024, mode="w+b")
    note_index: list[dict[str, str]] = []
    book_index: list[dict[str, str]] = []
    attachment_dir = settings.attachment_path()
    book_dir = settings.book_path()
    try:
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for note in notes:
                attachment_items: list[dict[str, Any]] = []
                for item in sorted(note.attachments, key=lambda value: value.id):
                    source = attachment_dir / item.storage_name
                    if not source.is_file():
                        raise HTTPException(409, f"attachment file is missing: {item.original_name}")
                    extension = Path(item.storage_name).suffix.lower()
                    archive_path = f"attachments/{note.id}/{item.id}{extension}"
                    attachment_items.append(
                        {
                            "id": item.id,
                            "original_name": item.original_name,
                            "mime_type": item.mime_type,
                            "size": item.size,
                            "created_at": _datetime_out(item.created_at),
                            "path": archive_path,
                            "sha256": _file_sha256(source),
                        }
                    )
                    archive.write(source, archive_path)
                try:
                    content = json.loads(note.content)
                except (TypeError, json.JSONDecodeError) as exc:
                    raise HTTPException(409, f"note content is invalid: {note.id}") from exc
                note_value = {
                    "id": note.id,
                    "title": note.title,
                    "content": content,
                    "search_text": note.search_text,
                    "is_pinned": note.is_pinned,
                    "deleted_at": _datetime_out(note.deleted_at),
                    "created_at": _datetime_out(note.created_at),
                    "updated_at": _datetime_out(note.updated_at),
                    "group_id": note.group_id,
                    "tag_ids": sorted(tag.id for tag in note.tags),
                    "attachments": attachment_items,
                }
                note_bytes = _json_bytes(note_value)
                note_path = f"notes/{note.id}.json"
                archive.writestr(note_path, note_bytes)
                note_index.append({"id": note.id, "path": note_path, "sha256": _sha256(note_bytes)})
            for book in books:
                if getattr(book, "storage_mode", "managed") == "linked":
                    source_path = getattr(book, "source_path", None)
                    source = Path(source_path) if source_path else Path()
                    missing_detail = f"linked book source file is missing: {book.title}"
                else:
                    source = book_dir / book.storage_name if book.storage_name else Path()
                    missing_detail = f"book file is missing: {book.original_name}"
                if not source.is_file():
                    raise HTTPException(409, missing_detail)
                extension = Path(book.original_name).suffix.lower() or source.suffix.lower()
                original_path = f"books/{book.id}/original{extension}"
                actual_hash = _file_sha256(source)
                if book.sha256 and actual_hash != book.sha256.lower():
                    if getattr(book, "storage_mode", "managed") == "linked":
                        raise HTTPException(
                            409,
                            f"linked book source has changed; open it before backup: {book.title}",
                        )
                    raise HTTPException(409, f"book checksum mismatch: {book.original_name}")
                archive.write(source, original_path)
                cover_value: dict[str, Any] | None = None
                if book.cover_storage_name:
                    cover_source = book_dir / book.cover_storage_name
                    if not cover_source.is_file():
                        raise HTTPException(409, f"book cover is missing: {book.title}")
                    cover_extension = Path(book.cover_storage_name).suffix.lower() or ".img"
                    cover_path = f"books/{book.id}/cover{cover_extension}"
                    archive.write(cover_source, cover_path)
                    cover_value = {
                        "path": cover_path,
                        "mime_type": book.cover_mime_type,
                        "size": cover_source.stat().st_size,
                        "sha256": _file_sha256(cover_source),
                    }
                state_value: dict[str, Any] | None = None
                if book.reading_state is not None:
                    state_value = {
                        "locator": _optional_model_json(
                            book.reading_state.locator, f"book {book.id} reading locator"
                        ),
                        "progress": book.reading_state.progress,
                        "settings": _model_json(book.reading_state.settings, f"book {book.id} reading settings"),
                        "last_read_at": _datetime_out(book.reading_state.last_read_at),
                        "updated_at": _datetime_out(book.reading_state.updated_at),
                    }
                annotations = [
                    {
                        "id": annotation.id,
                        "type": annotation.type,
                        "locator": _model_json(annotation.locator, f"book annotation {annotation.id} locator"),
                        "color": annotation.color,
                        "quote": annotation.quote,
                        "note": annotation.note,
                        "created_at": _datetime_out(annotation.created_at),
                        "updated_at": _datetime_out(annotation.updated_at),
                    }
                    for annotation in sorted(book.annotations, key=lambda value: value.id)
                ]
                book_value = {
                    "id": book.id,
                    "category_id": book.category_id,
                    "title": book.title,
                    "author": book.author,
                    "format": book.format,
                    "original_name": book.original_name,
                    "size": book.size,
                    "sha256": actual_hash,
                    "page_count": book.page_count,
                    "created_at": _datetime_out(book.created_at),
                    "updated_at": _datetime_out(book.updated_at),
                    "file": {"path": original_path, "size": source.stat().st_size, "sha256": actual_hash},
                    "cover": cover_value,
                    "reading_state": state_value,
                    "annotations": annotations,
                }
                book_bytes = _json_bytes(book_value)
                book_path = f"books/{book.id}.json"
                archive.writestr(book_path, book_bytes)
                book_index.append({"id": book.id, "path": book_path, "sha256": _sha256(book_bytes)})
            manifest = {
                "format": ARCHIVE_FORMAT,
                "version": ARCHIVE_VERSION,
                "exported_at": _datetime_out(utcnow()),
                "groups": [
                    {"id": item.id, "name": item.name, "created_at": _datetime_out(item.created_at)} for item in groups
                ],
                "tags": [{"id": item.id, "name": item.name} for item in tags],
                "book_categories": [
                    {"id": item.id, "name": item.name, "created_at": _datetime_out(item.created_at)}
                    for item in book_categories
                ],
                "notes": note_index,
                "books": book_index,
            }
            archive.writestr("manifest.json", _json_bytes(manifest))
        output.seek(0)
        return output
    except Exception:
        output.close()
        raise


def _archive_error(detail: str) -> HTTPException:
    return HTTPException(422, detail)


def _mapping(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise _archive_error(f"{label} must be an object")
    return value


def _list(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise _archive_error(f"{label} must be an array")
    return value


def _string(value: Any, label: str, max_length: int | None = None, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or (not allow_empty and not value):
        raise _archive_error(f"{label} must be a non-empty string")
    if max_length is not None and len(value) > max_length:
        raise _archive_error(f"{label} is too long")
    return value


def _uuid(value: Any, label: str) -> str:
    raw = _string(value, label, 36)
    try:
        return str(uuid.UUID(raw))
    except ValueError as exc:
        raise _archive_error(f"{label} must be a UUID") from exc


def _timestamp(value: Any, label: str, nullable: bool = False) -> datetime | None:
    if value is None and nullable:
        return None
    raw = _string(value, label, 64)
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as exc:
        raise _archive_error(f"{label} must be an ISO-8601 timestamp") from exc
    if parsed.tzinfo is None:
        raise _archive_error(f"{label} must include a timezone")
    return parsed.astimezone(UTC).replace(tzinfo=None)


def _safe_path(value: Any, label: str) -> str:
    raw = _string(value, label, 512)
    path = PurePosixPath(raw)
    if path.is_absolute() or "\\" in raw or any(part in {"", ".", ".."} for part in path.parts):
        raise _archive_error(f"{label} is unsafe")
    return raw


def _checked_json(archive: zipfile.ZipFile, path: str, label: str) -> dict[str, Any]:
    info = archive.getinfo(path)
    if info.file_size > MAX_JSON_BYTES:
        raise _archive_error(f"{label} exceeds the size limit")
    try:
        with archive.open(info) as source:
            value = json.loads(source.read(MAX_JSON_BYTES + 1))
    except (UnicodeDecodeError, json.JSONDecodeError, RuntimeError, zipfile.BadZipFile) as exc:
        raise _archive_error(f"{label} is invalid JSON") from exc
    return _mapping(value, label)


def _validate_zip(archive: zipfile.ZipFile) -> dict[str, zipfile.ZipInfo]:
    infos = archive.infolist()
    if not infos or len(infos) > MAX_ARCHIVE_ENTRIES:
        raise _archive_error("backup contains an invalid number of files")
    total = 0
    result: dict[str, zipfile.ZipInfo] = {}
    for info in infos:
        path = _safe_path(info.filename, "ZIP entry path")
        if info.is_dir():
            continue
        if info.flag_bits & 0x1:
            raise _archive_error(f"backup contains an encrypted file: {path}")
        if path in result:
            raise _archive_error(f"backup contains a duplicate file: {path}")
        total += info.file_size
        if total > MAX_UNCOMPRESSED_BYTES:
            raise HTTPException(413, "backup uncompressed size exceeds the limit")
        result[path] = info
    if "manifest.json" not in result:
        raise _archive_error("backup manifest is missing")
    return result


def _parse_archive(archive: zipfile.ZipFile, settings: AppSettings) -> ParsedArchive:
    entries = _validate_zip(archive)
    manifest = _checked_json(archive, "manifest.json", "manifest")
    version = manifest.get("version")
    if manifest.get("format") != ARCHIVE_FORMAT or version not in {
        LEGACY_ARCHIVE_VERSION,
        BOOKS_ARCHIVE_VERSION,
        ARCHIVE_VERSION,
    }:
        raise _archive_error("unsupported backup format or version")
    _timestamp(manifest.get("exported_at"), "manifest.exported_at")
    groups = _list(manifest.get("groups"), "manifest.groups")
    tags = _list(manifest.get("tags"), "manifest.tags")
    note_index = _list(manifest.get("notes"), "manifest.notes")
    book_index = _list(manifest.get("books", []), "manifest.books") if version >= BOOKS_ARCHIVE_VERSION else []
    book_categories = (
        _list(manifest.get("book_categories"), "manifest.book_categories") if version >= ARCHIVE_VERSION else []
    )
    group_ids: set[str] = set()
    tag_ids: set[str] = set()
    book_category_ids: set[str] = set()
    book_category_names: set[str] = set()
    for index, raw in enumerate(groups):
        item = _mapping(raw, f"manifest.groups[{index}]")
        item_id = _uuid(item.get("id"), f"manifest.groups[{index}].id")
        if item_id in group_ids:
            raise _archive_error("backup contains duplicate group IDs")
        group_ids.add(item_id)
        name = _string(item.get("name"), f"manifest.groups[{index}].name", 50).strip()
        if not name:
            raise _archive_error("group name cannot be blank")
        item["id"], item["name"] = item_id, name
        item["created_at"] = _timestamp(item.get("created_at"), f"manifest.groups[{index}].created_at")
    for index, raw in enumerate(tags):
        item = _mapping(raw, f"manifest.tags[{index}]")
        item_id = _uuid(item.get("id"), f"manifest.tags[{index}].id")
        if item_id in tag_ids:
            raise _archive_error("backup contains duplicate tag IDs")
        tag_ids.add(item_id)
        name = _string(item.get("name"), f"manifest.tags[{index}].name", 50).strip()
        if not name:
            raise _archive_error("tag name cannot be blank")
        item["id"], item["name"] = item_id, name
    for index, raw in enumerate(book_categories):
        item = _mapping(raw, f"manifest.book_categories[{index}]")
        item_id = _uuid(item.get("id"), f"manifest.book_categories[{index}].id")
        if item_id in book_category_ids:
            raise _archive_error("backup contains duplicate book category IDs")
        book_category_ids.add(item_id)
        name = _string(item.get("name"), f"manifest.book_categories[{index}].name", 50).strip()
        if not name:
            raise _archive_error("book category name cannot be blank")
        normalized_name = name.casefold()
        if normalized_name in book_category_names:
            raise _archive_error("backup contains duplicate book category names")
        book_category_names.add(normalized_name)
        item["id"], item["name"] = item_id, name
        item["created_at"] = _timestamp(
            item.get("created_at"), f"manifest.book_categories[{index}].created_at"
        )
    notes: list[dict[str, Any]] = []
    note_ids: set[str] = set()
    referenced_paths = {"manifest.json"}
    attachment_ids: set[str] = set()
    for index, raw in enumerate(note_index):
        item = _mapping(raw, f"manifest.notes[{index}]")
        note_id = _uuid(item.get("id"), f"manifest.notes[{index}].id")
        if note_id in note_ids:
            raise _archive_error("backup contains duplicate note IDs")
        note_ids.add(note_id)
        path = _safe_path(item.get("path"), f"manifest.notes[{index}].path")
        if path != f"notes/{note_id}.json" or path not in entries:
            raise _archive_error(f"invalid note path: {path}")
        referenced_paths.add(path)
        if entries[path].file_size > MAX_JSON_BYTES:
            raise _archive_error(f"note JSON exceeds the size limit: {note_id}")
        note_bytes = archive.read(path)
        expected_hash = _string(item.get("sha256"), f"manifest.notes[{index}].sha256", 64)
        if len(expected_hash) != 64 or _sha256(note_bytes) != expected_hash.lower():
            raise _archive_error(f"note checksum mismatch: {note_id}")
        try:
            note = _mapping(json.loads(note_bytes), f"note {note_id}")
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise _archive_error(f"note JSON is invalid: {note_id}") from exc
        if _uuid(note.get("id"), f"note {note_id}.id") != note_id:
            raise _archive_error(f"note ID mismatch: {note_id}")
        note["id"] = note_id
        note["title"] = _string(note.get("title"), f"note {note_id}.title", 200, allow_empty=True).strip()
        note["is_pinned"] = note.get("is_pinned")
        if not isinstance(note["is_pinned"], bool):
            raise _archive_error(f"note {note_id}.is_pinned must be a boolean")
        note["created_at"] = _timestamp(note.get("created_at"), f"note {note_id}.created_at")
        note["updated_at"] = _timestamp(note.get("updated_at"), f"note {note_id}.updated_at")
        note["deleted_at"] = _timestamp(note.get("deleted_at"), f"note {note_id}.deleted_at", nullable=True)
        group_id = note.get("group_id")
        if group_id is not None:
            group_id = _uuid(group_id, f"note {note_id}.group_id")
            if group_id not in group_ids:
                raise _archive_error(f"note references an unknown group: {note_id}")
        note["group_id"] = group_id
        raw_tag_ids = _list(note.get("tag_ids"), f"note {note_id}.tag_ids")
        parsed_tag_ids = [_uuid(value, f"note {note_id}.tag_ids") for value in raw_tag_ids]
        if len(parsed_tag_ids) > 20 or len(set(parsed_tag_ids)) != len(parsed_tag_ids) or not set(parsed_tag_ids) <= tag_ids:
            raise _archive_error(f"note has invalid tag references: {note_id}")
        note["tag_ids"] = parsed_tag_ids
        if not isinstance(note.get("content"), dict):
            raise _archive_error(f"note content must be an object: {note_id}")
        try:
            validate_content(note["content"])
        except HTTPException as exc:
            raise _archive_error(f"note content is invalid: {note_id}") from exc
        attachments = _list(note.get("attachments"), f"note {note_id}.attachments")
        for attachment_index, raw_attachment in enumerate(attachments):
            attachment = _mapping(raw_attachment, f"note {note_id}.attachments[{attachment_index}]")
            attachment_id = _uuid(attachment.get("id"), f"note {note_id}.attachment.id")
            if attachment_id in attachment_ids:
                raise _archive_error("backup contains duplicate attachment IDs")
            attachment_ids.add(attachment_id)
            original_name = Path(_string(attachment.get("original_name"), "attachment.original_name", 255)).name
            mime_type = _string(attachment.get("mime_type"), "attachment.mime_type", 120).lower()
            allowed_extensions = settings.storage.allowed_types.get(mime_type)
            if not allowed_extensions or Path(original_name).suffix.lower() not in allowed_extensions:
                raise _archive_error(f"attachment type is not allowed: {original_name}")
            size = attachment.get("size")
            if not isinstance(size, int) or isinstance(size, bool) or size < 0:
                raise _archive_error(f"attachment size is invalid: {original_name}")
            if size > settings.storage.max_file_bytes:
                raise HTTPException(413, f"attachment exceeds configured size limit: {original_name}")
            attachment_path = _safe_path(attachment.get("path"), "attachment.path")
            if not attachment_path.startswith(f"attachments/{note_id}/") or attachment_path not in entries:
                raise _archive_error(f"attachment path is invalid: {original_name}")
            referenced_paths.add(attachment_path)
            entry = entries[attachment_path]
            if entry.file_size != size:
                raise _archive_error(f"attachment size mismatch: {original_name}")
            expected_hash = _string(attachment.get("sha256"), "attachment.sha256", 64)
            digest = hashlib.sha256()
            actual_size = 0
            try:
                with archive.open(entry) as source:
                    while chunk := source.read(COPY_CHUNK_BYTES):
                        actual_size += len(chunk)
                        if actual_size > settings.storage.max_file_bytes:
                            raise HTTPException(413, f"attachment exceeds configured size limit: {original_name}")
                        digest.update(chunk)
            except (RuntimeError, zipfile.BadZipFile) as exc:
                raise _archive_error(f"attachment data is corrupt: {original_name}") from exc
            if actual_size != size or len(expected_hash) != 64 or digest.hexdigest() != expected_hash.lower():
                raise _archive_error(f"attachment checksum mismatch: {original_name}")
            attachment.update(
                id=attachment_id,
                original_name=original_name,
                mime_type=mime_type,
                size=size,
                path=attachment_path,
                created_at=_timestamp(attachment.get("created_at"), "attachment.created_at"),
            )
        notes.append(note)
    books: list[dict[str, Any]] = []
    book_ids: set[str] = set()
    annotation_ids: set[str] = set()
    allowed_formats = {
        "epub": {".epub"},
        "pdf": {".pdf"},
        "txt": {".txt"},
        "markdown": {".md", ".markdown"},
        "md": {".md", ".markdown"},
    }
    for index, raw in enumerate(book_index):
        item = _mapping(raw, f"manifest.books[{index}]")
        book_id = _uuid(item.get("id"), f"manifest.books[{index}].id")
        if book_id in book_ids:
            raise _archive_error("backup contains duplicate book IDs")
        book_ids.add(book_id)
        path = _safe_path(item.get("path"), f"manifest.books[{index}].path")
        if path != f"books/{book_id}.json" or path not in entries:
            raise _archive_error(f"invalid book path: {path}")
        referenced_paths.add(path)
        if entries[path].file_size > MAX_BOOK_JSON_BYTES:
            raise _archive_error(f"book JSON exceeds the size limit: {book_id}")
        book_bytes = archive.read(path)
        expected_record_hash = _string(item.get("sha256"), f"manifest.books[{index}].sha256", 64)
        if len(expected_record_hash) != 64 or _sha256(book_bytes) != expected_record_hash.lower():
            raise _archive_error(f"book record checksum mismatch: {book_id}")
        try:
            book = _mapping(json.loads(book_bytes), f"book {book_id}")
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise _archive_error(f"book JSON is invalid: {book_id}") from exc
        if _uuid(book.get("id"), f"book {book_id}.id") != book_id:
            raise _archive_error(f"book ID mismatch: {book_id}")
        book["id"] = book_id
        if version >= ARCHIVE_VERSION:
            if "category_id" not in book:
                raise _archive_error(f"book category reference is missing: {book_id}")
            category_id = book.get("category_id")
            if category_id is not None:
                category_id = _uuid(category_id, f"book {book_id}.category_id")
                if category_id not in book_category_ids:
                    raise _archive_error(f"book references an unknown category: {book_id}")
            book["category_id"] = category_id
        else:
            book["category_id"] = None
        book["title"] = _string(book.get("title"), f"book {book_id}.title", 300).strip()
        author = book.get("author")
        if author is not None:
            author = _string(author, f"book {book_id}.author", 300).strip() or None
        book["author"] = author
        book_format = _string(book.get("format"), f"book {book_id}.format", 16).lower()
        if book_format not in allowed_formats:
            raise _archive_error(f"unsupported book format: {book_format}")
        book["format"] = "markdown" if book_format == "md" else book_format
        original_name = Path(_string(book.get("original_name"), f"book {book_id}.original_name", 255)).name
        if Path(original_name).suffix.lower() not in allowed_formats[book_format]:
            raise _archive_error(f"book extension does not match its format: {original_name}")
        book["original_name"] = original_name
        size = book.get("size")
        if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
            raise _archive_error(f"book size is invalid: {original_name}")
        if size > settings.storage.max_book_bytes:
            raise HTTPException(413, f"book exceeds configured size limit: {original_name}")
        book["size"] = size
        book["created_at"] = _timestamp(book.get("created_at"), f"book {book_id}.created_at")
        book["updated_at"] = _timestamp(book.get("updated_at"), f"book {book_id}.updated_at")
        page_count = book.get("page_count")
        if page_count is not None and (not isinstance(page_count, int) or isinstance(page_count, bool) or page_count <= 0):
            raise _archive_error(f"book page_count is invalid: {original_name}")
        file_value = _mapping(book.get("file"), f"book {book_id}.file")
        file_path = _safe_path(file_value.get("path"), f"book {book_id}.file.path")
        if not file_path.startswith(f"books/{book_id}/") or file_path not in entries:
            raise _archive_error(f"book file path is invalid: {original_name}")
        referenced_paths.add(file_path)
        entry = entries[file_path]
        if entry.file_size != size:
            raise _archive_error(f"book size mismatch: {original_name}")
        expected_hash = _string(file_value.get("sha256"), f"book {book_id}.file.sha256", 64)
        if _string(book.get("sha256"), f"book {book_id}.sha256", 64).lower() != expected_hash.lower():
            raise _archive_error(f"book checksum metadata mismatch: {original_name}")
        book["sha256"] = expected_hash.lower()
        digest = hashlib.sha256()
        copied = 0
        try:
            with archive.open(entry) as source:
                while chunk := source.read(COPY_CHUNK_BYTES):
                    copied += len(chunk)
                    if copied > settings.storage.max_book_bytes:
                        raise HTTPException(413, f"book exceeds configured size limit: {original_name}")
                    digest.update(chunk)
        except (RuntimeError, zipfile.BadZipFile) as exc:
            raise _archive_error(f"book data is corrupt: {original_name}") from exc
        if copied != size or len(expected_hash) != 64 or digest.hexdigest() != expected_hash.lower():
            raise _archive_error(f"book checksum mismatch: {original_name}")
        file_value.update(path=file_path, size=size, sha256=expected_hash.lower())
        cover = book.get("cover")
        if cover is not None:
            cover = _mapping(cover, f"book {book_id}.cover")
            cover_path = _safe_path(cover.get("path"), f"book {book_id}.cover.path")
            if not cover_path.startswith(f"books/{book_id}/") or cover_path not in entries:
                raise _archive_error(f"book cover path is invalid: {original_name}")
            referenced_paths.add(cover_path)
            cover_mime = _string(cover.get("mime_type"), f"book {book_id}.cover.mime_type", 120).lower()
            if cover_mime not in INLINE_IMAGE_TYPES:
                raise _archive_error(f"book cover type is invalid: {original_name}")
            cover_size = cover.get("size")
            if (
                not isinstance(cover_size, int)
                or isinstance(cover_size, bool)
                or cover_size <= 0
                or cover_size > settings.storage.max_cover_bytes
                or entries[cover_path].file_size != cover_size
            ):
                raise _archive_error(f"book cover size is invalid: {original_name}")
            cover_hash = _string(cover.get("sha256"), f"book {book_id}.cover.sha256", 64)
            cover_bytes = archive.read(cover_path)
            if len(cover_hash) != 64 or _sha256(cover_bytes) != cover_hash.lower():
                raise _archive_error(f"book cover checksum mismatch: {original_name}")
            cover.update(path=cover_path, mime_type=cover_mime, size=cover_size, sha256=cover_hash.lower())
        book["cover"] = cover
        state = book.get("reading_state")
        if state is not None:
            state = _mapping(state, f"book {book_id}.reading_state")
            locator = state.get("locator")
            state["locator"] = (
                _mapping(locator, f"book {book_id}.reading_state.locator")
                if locator is not None
                else None
            )
            state["settings"] = _mapping(state.get("settings"), f"book {book_id}.reading_state.settings")
            progress = state.get("progress")
            if not isinstance(progress, (int, float)) or isinstance(progress, bool) or not 0 <= progress <= 1:
                raise _archive_error(f"book reading progress is invalid: {book_id}")
            state["progress"] = float(progress)
            state["last_read_at"] = _timestamp(state.get("last_read_at"), "book reading_state.last_read_at")
            state["updated_at"] = _timestamp(state.get("updated_at"), "book reading_state.updated_at")
        book["reading_state"] = state
        annotations = _list(book.get("annotations", []), f"book {book_id}.annotations")
        if len(annotations) > 100_000:
            raise _archive_error(f"book contains too many annotations: {book_id}")
        for annotation_index, raw_annotation in enumerate(annotations):
            annotation = _mapping(raw_annotation, f"book {book_id}.annotations[{annotation_index}]")
            annotation_id = _uuid(annotation.get("id"), f"book {book_id}.annotation.id")
            if annotation_id in annotation_ids:
                raise _archive_error("backup contains duplicate annotation IDs")
            annotation_ids.add(annotation_id)
            annotation_type = _string(annotation.get("type"), "book annotation.type", 20)
            if annotation_type not in {"bookmark", "highlight", "underline"}:
                raise _archive_error(f"book annotation type is invalid: {annotation_id}")
            annotation["id"] = annotation_id
            annotation["type"] = annotation_type
            annotation["locator"] = _mapping(annotation.get("locator"), "book annotation.locator")
            for field, maximum in (("color", 32), ("quote", 20_000), ("note", 5_000)):
                value = annotation.get(field)
                if value is not None:
                    value = _string(value, f"book annotation.{field}", maximum, allow_empty=True)
                annotation[field] = value
            annotation["created_at"] = _timestamp(annotation.get("created_at"), "book annotation.created_at")
            annotation["updated_at"] = _timestamp(annotation.get("updated_at"), "book annotation.updated_at")
        books.append(book)
    extras = set(entries) - referenced_paths
    if extras:
        raise _archive_error(f"backup contains unreferenced files: {sorted(extras)[0]}")
    return ParsedArchive(manifest=manifest, notes=notes, books=books)


def _unique_id(imported_id: str, used: set[str]) -> str:
    if imported_id not in used:
        used.add(imported_id)
        return imported_id
    while (candidate := new_id()) in used:
        pass
    used.add(candidate)
    return candidate


def _unique_title(title: str, used: set[str]) -> tuple[str, bool]:
    normalized = title.casefold()
    if normalized not in used:
        used.add(normalized)
        return title, False
    number = 1
    while True:
        suffix = "（导入）" if number == 1 else f"（导入 {number}）"
        candidate = f"{title[: 200 - len(suffix)]}{suffix}"
        normalized = candidate.casefold()
        if normalized not in used:
            used.add(normalized)
            return candidate, True
        number += 1


def _rewrite_attachment_urls(value: Any, id_map: dict[str, str]) -> Any:
    if isinstance(value, dict):
        return {key: _rewrite_attachment_urls(item, id_map) for key, item in value.items()}
    if isinstance(value, list):
        return [_rewrite_attachment_urls(item, id_map) for item in value]
    if isinstance(value, str):
        for old_id, new_id_value in id_map.items():
            if old_id != new_id_value:
                value = value.replace(f"/api/attachments/{old_id}/content", f"/api/attachments/{new_id_value}/content")
        return value
    return value


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
    return True


def import_backup(source: BinaryIO, db: Session, user_id: str, settings: AppSettings) -> ImportResult:
    try:
        source.seek(0, 2)
        if source.tell() > MAX_ARCHIVE_BYTES:
            raise HTTPException(413, "backup upload exceeds the size limit")
        source.seek(0)
        archive = zipfile.ZipFile(source)
    except (OSError, zipfile.BadZipFile) as exc:
        raise _archive_error("uploaded file is not a valid ZIP backup") from exc
    created_files: list[Path] = []
    try:
        parsed = _parse_archive(archive, settings)
        all_model_ids = set(db.scalars(select(Group.id)).all())
        all_model_ids.update(db.scalars(select(Tag.id)).all())
        all_model_ids.update(db.scalars(select(BookCategory.id)).all())
        all_model_ids.update(db.scalars(select(Note.id)).all())
        all_model_ids.update(db.scalars(select(Attachment.id)).all())
        all_model_ids.update(db.scalars(select(Book.id)).all())
        all_model_ids.update(db.scalars(select(BookAnnotation.id)).all())
        current_groups = {
            item.normalized_name: item for item in db.scalars(select(Group).where(Group.user_id == user_id)).all()
        }
        current_tags = {
            item.normalized_name: item for item in db.scalars(select(Tag).where(Tag.user_id == user_id)).all()
        }
        current_book_categories = {
            item.normalized_name: item
            for item in db.scalars(select(BookCategory).where(BookCategory.user_id == user_id)).all()
        }
        group_map: dict[str, Group] = {}
        for raw in parsed.manifest["groups"]:
            normalized = raw["name"].casefold()
            group = current_groups.get(normalized)
            if group is None:
                group = Group(
                    id=_unique_id(raw["id"], all_model_ids), user_id=user_id, name=raw["name"],
                    normalized_name=normalized, created_at=raw["created_at"],
                )
                db.add(group)
                current_groups[normalized] = group
            group_map[raw["id"]] = group
        tag_map: dict[str, Tag] = {}
        for raw in parsed.manifest["tags"]:
            normalized = raw["name"].casefold()
            tag = current_tags.get(normalized)
            if tag is None:
                tag = Tag(
                    id=_unique_id(raw["id"], all_model_ids), user_id=user_id, name=raw["name"], normalized_name=normalized
                )
                db.add(tag)
                current_tags[normalized] = tag
            tag_map[raw["id"]] = tag
        book_category_map: dict[str, BookCategory] = {}
        for raw in parsed.manifest.get("book_categories", []):
            normalized = raw["name"].casefold()
            category = current_book_categories.get(normalized)
            if category is None:
                category = BookCategory(
                    id=_unique_id(raw["id"], all_model_ids),
                    user_id=user_id,
                    name=raw["name"],
                    normalized_name=normalized,
                    created_at=raw["created_at"],
                )
                db.add(category)
                current_book_categories[normalized] = category
            book_category_map[raw["id"]] = category
        used_titles = {value.casefold() for value in db.scalars(select(Note.title).where(Note.user_id == user_id)).all()}
        used_book_titles = {
            value.casefold() for value in db.scalars(select(Book.title).where(Book.user_id == user_id)).all()
        }
        attachment_dir = settings.attachment_path()
        attachment_dir.mkdir(parents=True, exist_ok=True)
        renamed = 0
        attachment_count = 0
        book_count = 0
        annotation_count = 0
        for raw in parsed.notes:
            title, was_renamed = _unique_title(raw["title"], used_titles)
            renamed += int(was_renamed)
            note_id = _unique_id(raw["id"], all_model_ids)
            attachment_id_map = {
                attachment["id"]: _unique_id(attachment["id"], all_model_ids) for attachment in raw["attachments"]
            }
            rewritten_content = _rewrite_attachment_urls(raw["content"], attachment_id_map)
            content_json, plain_text = validate_content(rewritten_content)
            note = Note(
                id=note_id,
                user_id=user_id,
                group=group_map.get(raw["group_id"]),
                title=title,
                content=content_json,
                search_text=f"{title} {plain_text}".casefold(),
                is_pinned=raw["is_pinned"],
                deleted_at=raw["deleted_at"],
                created_at=raw["created_at"],
                updated_at=raw["updated_at"],
                tags=[tag_map[tag_id] for tag_id in raw["tag_ids"]],
            )
            db.add(note)
            for raw_attachment in raw["attachments"]:
                allowed_extensions = settings.storage.allowed_types[raw_attachment["mime_type"]]
                storage_name = f"{uuid.uuid4().hex}{allowed_extensions[0]}"
                target = attachment_dir / storage_name
                try:
                    with archive.open(raw_attachment["path"]) as archive_file, target.open("xb") as destination:
                        copied = 0
                        while chunk := archive_file.read(COPY_CHUNK_BYTES):
                            copied += len(chunk)
                            if copied > settings.storage.max_file_bytes:
                                raise HTTPException(413, "attachment exceeds configured size limit")
                            destination.write(chunk)
                except Exception:
                    target.unlink(missing_ok=True)
                    raise
                created_files.append(target)
                if raw_attachment["mime_type"] in INLINE_IMAGE_TYPES and not _valid_inline_image(target, raw_attachment["mime_type"]):
                    raise _archive_error(f"image content does not match its declared type: {raw_attachment['original_name']}")
                db.add(
                    Attachment(
                        id=attachment_id_map[raw_attachment["id"]],
                        note=note,
                        original_name=raw_attachment["original_name"],
                        storage_name=storage_name,
                        mime_type=raw_attachment["mime_type"],
                        size=raw_attachment["size"],
                        created_at=raw_attachment["created_at"],
                    )
                )
                attachment_count += 1
        book_dir = settings.book_path()
        book_dir.mkdir(parents=True, exist_ok=True)
        from ..book_files import prepare_book_file

        def book_json(value: Any) -> str:
            return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

        for raw in parsed.books:
            title, was_renamed = _unique_title(raw["title"], used_book_titles)
            renamed += int(was_renamed)
            book_id = _unique_id(raw["id"], all_model_ids)
            suffix = Path(raw["original_name"]).suffix.lower()
            token = uuid.uuid4().hex
            storage_name = f"{token}{suffix}"
            reader_storage_name = f"{token}.reader{suffix}"
            target = book_dir / storage_name
            reader_target = book_dir / reader_storage_name
            temp_target = book_dir / f".{token}.import.part"
            temp_reader = book_dir / f".{token}.reader.part"
            try:
                with archive.open(raw["file"]["path"]) as archive_file, temp_target.open("xb") as destination:
                    copied = 0
                    while chunk := archive_file.read(COPY_CHUNK_BYTES):
                        copied += len(chunk)
                        if copied > settings.storage.max_book_bytes:
                            raise HTTPException(413, "book exceeds configured size limit")
                        destination.write(chunk)
                prepared = prepare_book_file(
                    temp_target,
                    raw["original_name"],
                    temp_reader,
                    settings.storage.max_book_bytes,
                    settings.storage.max_cover_bytes,
                )
                temp_target.replace(target)
                temp_reader.replace(reader_target)
            except Exception:
                temp_target.unlink(missing_ok=True)
                temp_reader.unlink(missing_ok=True)
                target.unlink(missing_ok=True)
                reader_target.unlink(missing_ok=True)
                raise
            created_files.extend([target, reader_target])
            cover_storage_name: str | None = None
            cover_mime_type: str | None = None
            if raw["cover"] is not None:
                cover_mime_type = raw["cover"]["mime_type"]
                cover_extension = {"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp"}[
                    cover_mime_type
                ]
                cover_storage_name = f"{token}.cover{cover_extension}"
                cover_target = book_dir / cover_storage_name
                try:
                    with archive.open(raw["cover"]["path"]) as archive_file, cover_target.open("xb") as destination:
                        copied = 0
                        while chunk := archive_file.read(COPY_CHUNK_BYTES):
                            copied += len(chunk)
                            if copied > settings.storage.max_cover_bytes:
                                raise HTTPException(413, "book cover exceeds configured size limit")
                            destination.write(chunk)
                except Exception:
                    cover_target.unlink(missing_ok=True)
                    raise
                created_files.append(cover_target)
                if not _valid_inline_image(cover_target, cover_mime_type):
                    raise _archive_error(f"book cover content is invalid: {raw['original_name']}")
            elif prepared.cover_bytes and prepared.cover_mime_type:
                cover_mime_type = prepared.cover_mime_type
                cover_extension = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}[cover_mime_type]
                cover_storage_name = f"{token}.cover{cover_extension}"
                cover_target = book_dir / cover_storage_name
                cover_target.write_bytes(prepared.cover_bytes)
                created_files.append(cover_target)
            book = Book(
                id=book_id,
                user_id=user_id,
                category=book_category_map.get(raw["category_id"]),
                storage_mode="managed",
                source_path=None,
                source_path_hash=None,
                source_mtime_ns=None,
                title=title,
                author=raw["author"],
                format=raw["format"],
                original_name=raw["original_name"],
                storage_name=storage_name,
                reader_storage_name=reader_storage_name,
                cover_storage_name=cover_storage_name,
                cover_mime_type=cover_mime_type,
                sha256=raw["sha256"],
                size=raw["size"],
                page_count=raw["page_count"] or prepared.page_count,
                search_text=prepared.search_text,
                created_at=raw["created_at"],
                updated_at=raw["updated_at"],
            )
            for unit in prepared.text_units:
                book.text_units.append(
                    BookTextUnit(
                        unit_index=unit["unit_index"],
                        locator=book_json(unit["locator"]),
                        text=unit["text"],
                        boxes=None,
                        source=unit["source"],
                        label=unit["label"],
                    )
                )
            state = raw["reading_state"]
            if state is not None:
                book.reading_state = BookReadingState(
                    locator=book_json(state["locator"]),
                    progress=state["progress"],
                    settings=book_json(state["settings"]),
                    last_read_at=state["last_read_at"],
                    updated_at=state["updated_at"],
                )
            else:
                book.reading_state = BookReadingState(locator="{}", progress=0.0, settings="{}")
            for raw_annotation in raw["annotations"]:
                annotation_id = _unique_id(raw_annotation["id"], all_model_ids)
                book.annotations.append(
                    BookAnnotation(
                        id=annotation_id,
                        type=raw_annotation["type"],
                        locator=book_json(raw_annotation["locator"]),
                        color=raw_annotation["color"],
                        quote=raw_annotation["quote"],
                        note=raw_annotation["note"],
                        created_at=raw_annotation["created_at"],
                        updated_at=raw_annotation["updated_at"],
                    )
                )
                annotation_count += 1
            if raw["format"] == "pdf":
                book.ocr_job = BookOcrJob(status="queued", pages_total=book.page_count or 0, pages_done=0)
            db.add(book)
            book_count += 1
        db.commit()
        if any(book["format"] == "pdf" for book in parsed.books):
            from ..book_ocr import wake_ocr_worker

            wake_ocr_worker()
        return ImportResult(
            notes=len(parsed.notes),
            attachments=attachment_count,
            renamed=renamed,
            warnings=[],
            books=book_count,
            annotations=annotation_count,
        )
    except HTTPException:
        db.rollback()
        for path in created_files:
            path.unlink(missing_ok=True)
        raise
    except Exception as exc:
        db.rollback()
        for path in created_files:
            path.unlink(missing_ok=True)
        raise HTTPException(422, "backup import failed") from exc
    finally:
        archive.close()
