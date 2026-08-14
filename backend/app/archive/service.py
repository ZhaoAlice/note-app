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
from ..models import Attachment, Group, Note, Tag, new_id, utcnow


ARCHIVE_FORMAT = "note-backup"
ARCHIVE_VERSION = 1
MAX_ARCHIVE_ENTRIES = 10_000
MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024
MAX_JSON_BYTES = 5 * 1024 * 1024
COPY_CHUNK_BYTES = 1024 * 1024
INLINE_IMAGE_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}


@dataclass(frozen=True)
class ImportResult:
    notes: int
    attachments: int
    renamed: int
    warnings: list[str]


@dataclass(frozen=True)
class ParsedArchive:
    manifest: dict[str, Any]
    notes: list[dict[str, Any]]


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


def build_backup(db: Session, user_id: str, settings: AppSettings) -> BinaryIO:
    groups = list(db.scalars(select(Group).where(Group.user_id == user_id).order_by(Group.id)).all())
    tags = list(db.scalars(select(Tag).where(Tag.user_id == user_id).order_by(Tag.id)).all())
    notes = list(
        db.scalars(
            select(Note)
            .options(selectinload(Note.tags), selectinload(Note.attachments))
            .where(Note.user_id == user_id)
            .order_by(Note.id)
        ).unique().all()
    )
    output = tempfile.SpooledTemporaryFile(max_size=16 * 1024 * 1024, mode="w+b")
    note_index: list[dict[str, str]] = []
    attachment_dir = settings.attachment_path()
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
            manifest = {
                "format": ARCHIVE_FORMAT,
                "version": ARCHIVE_VERSION,
                "exported_at": _datetime_out(utcnow()),
                "groups": [
                    {"id": item.id, "name": item.name, "created_at": _datetime_out(item.created_at)} for item in groups
                ],
                "tags": [{"id": item.id, "name": item.name} for item in tags],
                "notes": note_index,
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
    if manifest.get("format") != ARCHIVE_FORMAT or manifest.get("version") != ARCHIVE_VERSION:
        raise _archive_error("unsupported backup format or version")
    _timestamp(manifest.get("exported_at"), "manifest.exported_at")
    groups = _list(manifest.get("groups"), "manifest.groups")
    tags = _list(manifest.get("tags"), "manifest.tags")
    note_index = _list(manifest.get("notes"), "manifest.notes")
    group_ids: set[str] = set()
    tag_ids: set[str] = set()
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
    extras = set(entries) - referenced_paths
    if extras:
        raise _archive_error(f"backup contains unreferenced files: {sorted(extras)[0]}")
    return ParsedArchive(manifest=manifest, notes=notes)


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
        all_model_ids.update(db.scalars(select(Note.id)).all())
        all_model_ids.update(db.scalars(select(Attachment.id)).all())
        current_groups = {
            item.normalized_name: item for item in db.scalars(select(Group).where(Group.user_id == user_id)).all()
        }
        current_tags = {
            item.normalized_name: item for item in db.scalars(select(Tag).where(Tag.user_id == user_id)).all()
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
        used_titles = {value.casefold() for value in db.scalars(select(Note.title).where(Note.user_id == user_id)).all()}
        attachment_dir = settings.attachment_path()
        attachment_dir.mkdir(parents=True, exist_ok=True)
        renamed = 0
        attachment_count = 0
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
        db.commit()
        return ImportResult(notes=len(parsed.notes), attachments=attachment_count, renamed=renamed, warnings=[])
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
