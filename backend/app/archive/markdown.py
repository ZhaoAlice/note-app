from __future__ import annotations

import copy
import json
import re
import tempfile
import uuid
import zipfile
from dataclasses import dataclass
from datetime import UTC, date, datetime, time
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO

import yaml
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from ..config import AppSettings
from ..content import validate_content
from ..markdown_codec import MarkdownExportResult, MarkdownImageReference, markdown_to_tiptap, tiptap_to_markdown
from ..models import Attachment, Group, Note, Tag, new_id, utcnow
from .service import (
    COPY_CHUNK_BYTES,
    INLINE_IMAGE_TYPES,
    MAX_ARCHIVE_BYTES,
    MAX_ARCHIVE_ENTRIES,
    MAX_JSON_BYTES,
    MAX_UNCOMPRESSED_BYTES,
    ImportResult,
    _archive_error,
    _datetime_out,
    _safe_path,
    _unique_title,
    _valid_inline_image,
)


WINDOWS_INVALID_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
WINDOWS_RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{value}" for value in range(1, 10)), *(f"LPT{value}" for value in range(1, 10))}
FRONT_MATTER_BOUNDARY_RE = re.compile(r"^---\s*$")
H1_RE = re.compile(r"^#\s+(.+?)\s*$")


@dataclass
class MarkdownNote:
    path: str
    title: str
    group_name: str | None
    tag_names: list[str]
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None
    is_pinned: bool
    document: dict[str, Any]
    image_references: tuple[MarkdownImageReference, ...]
    warnings: tuple[str, ...]


def _windows_safe_name(value: str, fallback: str, max_length: int = 100) -> str:
    cleaned = WINDOWS_INVALID_RE.sub("_", value).strip().rstrip(". ")
    if not cleaned:
        cleaned = fallback
    if cleaned.upper() in WINDOWS_RESERVED:
        cleaned = f"_{cleaned}"
    return cleaned[:max_length].rstrip(". ") or fallback


def _markdown_archive_path(note: Note) -> str:
    return f"notes/{markdown_filename(note)}"


def markdown_filename(note: Note) -> str:
    stem = _windows_safe_name(note.title, "untitled")
    return f"{stem}-{note.id[:8]}.md"


def _attachment_export_paths(note: Note) -> tuple[dict[str, str], dict[str, str]]:
    relative: dict[str, str] = {}
    archive: dict[str, str] = {}
    for item in sorted(note.attachments, key=lambda value: value.id):
        original = Path(item.original_name)
        stem = _windows_safe_name(original.stem, "attachment", 80)
        extension = Path(item.storage_name).suffix.lower() or original.suffix.lower()
        path = f"assets/{note.id[:8]}/{stem}-{item.id[:8]}{extension}"
        relative[item.id] = path
        archive[item.id] = f"notes/{path}"
    return relative, archive


def render_note_markdown(note: Note, attachment_paths: dict[str, str] | None = None) -> MarkdownExportResult:
    try:
        document = json.loads(note.content)
    except (TypeError, json.JSONDecodeError) as exc:
        raise HTTPException(409, f"note content is invalid: {note.id}") from exc
    converted = tiptap_to_markdown(document, attachment_paths)
    front_matter = {
        "title": note.title,
        "tags": sorted(item.name for item in note.tags),
        "group": note.group.name if note.group else None,
        "created_at": _datetime_out(note.created_at),
        "updated_at": _datetime_out(note.updated_at),
        "deleted_at": _datetime_out(note.deleted_at),
        "is_pinned": note.is_pinned,
    }
    header = yaml.safe_dump(front_matter, allow_unicode=True, sort_keys=False).strip()
    return MarkdownExportResult(
        markdown=f"---\n{header}\n---\n\n{converted.markdown}",
        warnings=converted.warnings,
    )


def build_markdown_export(db: Session, user_id: str, settings: AppSettings) -> BinaryIO:
    notes = list(
        db.scalars(
            select(Note)
            .options(selectinload(Note.group), selectinload(Note.tags), selectinload(Note.attachments))
            .where(Note.user_id == user_id)
            .order_by(Note.id)
        ).unique().all()
    )
    output = tempfile.SpooledTemporaryFile(max_size=16 * 1024 * 1024, mode="w+b")
    warnings: list[str] = []
    attachment_dir = settings.attachment_path()
    try:
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for note in notes:
                note_path = _markdown_archive_path(note)
                relative_paths, archive_paths = _attachment_export_paths(note)
                converted = render_note_markdown(note, relative_paths)
                archive.writestr(note_path, converted.markdown.encode("utf-8"))
                warnings.extend(f"{note_path}: {warning}" for warning in converted.warnings)
                for item in note.attachments:
                    source = attachment_dir / item.storage_name
                    if not source.is_file():
                        raise HTTPException(409, f"attachment file is missing: {item.original_name}")
                    archive.write(source, archive_paths[item.id])
            if warnings:
                archive.writestr("_warnings.txt", ("\n".join(dict.fromkeys(warnings)) + "\n").encode("utf-8"))
        output.seek(0)
        return output
    except Exception:
        output.close()
        raise


def _front_matter(markdown: str, path: str) -> tuple[dict[str, Any], str]:
    normalized = markdown.replace("\r\n", "\n").replace("\r", "\n")
    lines = normalized.split("\n")
    if not lines or not FRONT_MATTER_BOUNDARY_RE.fullmatch(lines[0]):
        return {}, normalized
    closing = next((index for index in range(1, len(lines)) if FRONT_MATTER_BOUNDARY_RE.fullmatch(lines[index])), None)
    if closing is None:
        raise _archive_error(f"Markdown front matter is not closed: {path}")
    try:
        loaded = yaml.safe_load("\n".join(lines[1:closing])) or {}
    except yaml.YAMLError as exc:
        raise _archive_error(f"Markdown front matter is invalid: {path}") from exc
    if not isinstance(loaded, dict):
        raise _archive_error(f"Markdown front matter must be an object: {path}")
    return loaded, "\n".join(lines[closing + 1 :]).lstrip("\n")


def _extract_h1(markdown: str) -> tuple[str | None, str]:
    lines = markdown.split("\n")
    fence: str | None = None
    for index, line in enumerate(lines):
        fence_match = re.match(r"^\s*(`{3,}|~{3,})", line)
        if fence_match:
            marker = fence_match.group(1)
            if fence is None:
                fence = marker[0]
            elif marker[0] == fence:
                fence = None
            continue
        if fence is None and (match := H1_RE.fullmatch(line)):
            del lines[index]
            return match.group(1).strip(), "\n".join(lines)
    return None, markdown


def _text_field(value: Any, label: str, max_length: int, nullable: bool = False) -> str | None:
    if value is None and nullable:
        return None
    if not isinstance(value, str):
        raise _archive_error(f"{label} must be a string")
    value = value.strip()
    if not value or len(value) > max_length:
        raise _archive_error(f"{label} must contain 1 to {max_length} characters")
    return value


def _front_matter_datetime(value: Any, label: str, default: datetime | None, nullable: bool = False) -> datetime | None:
    if value is None:
        if nullable:
            return None
        assert default is not None
        return default
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, date):
        parsed = datetime.combine(value, time(), UTC)
    elif isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise _archive_error(f"{label} must be an ISO-8601 timestamp") from exc
    else:
        raise _archive_error(f"{label} must be an ISO-8601 timestamp")
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC).replace(tzinfo=None)


def _parse_markdown_note(markdown: str, path: str, default_group: str | None) -> MarkdownNote:
    metadata, body = _front_matter(markdown, path)
    raw_title = metadata.get("title")
    if raw_title is None or raw_title == "":
        h1_title, body = _extract_h1(body)
        raw_title = h1_title or PurePosixPath(path).stem
    title = _text_field(raw_title, f"{path} title", 200)
    assert title is not None
    raw_tags = metadata.get("tags", [])
    if not isinstance(raw_tags, list) or len(raw_tags) > 20:
        raise _archive_error(f"{path} tags must be an array with at most 20 items")
    tag_names: list[str] = []
    normalized_tags: set[str] = set()
    for raw_tag in raw_tags:
        tag = _text_field(raw_tag, f"{path} tag", 50)
        assert tag is not None
        if tag.casefold() not in normalized_tags:
            normalized_tags.add(tag.casefold())
            tag_names.append(tag)
    if "group" in metadata:
        group_name = _text_field(metadata.get("group"), f"{path} group", 50, nullable=True)
    else:
        group_name = default_group
    now = utcnow()
    created_at = _front_matter_datetime(metadata.get("created_at"), f"{path} created_at", now)
    updated_at = _front_matter_datetime(metadata.get("updated_at"), f"{path} updated_at", created_at)
    deleted_at = _front_matter_datetime(metadata.get("deleted_at"), f"{path} deleted_at", None, nullable=True)
    assert created_at is not None and updated_at is not None
    is_pinned = metadata.get("is_pinned", False)
    if not isinstance(is_pinned, bool):
        raise _archive_error(f"{path} is_pinned must be a boolean")
    converted = markdown_to_tiptap(body)
    return MarkdownNote(
        path=path,
        title=title,
        group_name=group_name,
        tag_names=tag_names,
        created_at=created_at,
        updated_at=updated_at,
        deleted_at=deleted_at,
        is_pinned=is_pinned,
        document=converted.document,
        image_references=converted.image_references,
        warnings=converted.warnings,
    )


def _zip_entries(archive: zipfile.ZipFile) -> dict[str, zipfile.ZipInfo]:
    infos = archive.infolist()
    if not infos or len(infos) > MAX_ARCHIVE_ENTRIES:
        raise _archive_error("Markdown ZIP contains an invalid number of files")
    total = 0
    result: dict[str, zipfile.ZipInfo] = {}
    for info in infos:
        path = _safe_path(info.filename, "ZIP entry path")
        if info.is_dir():
            continue
        if info.flag_bits & 0x1:
            raise _archive_error("encrypted ZIP entries are not supported")
        if path in result:
            raise _archive_error(f"Markdown ZIP contains a duplicate file: {path}")
        total += info.file_size
        if total > MAX_UNCOMPRESSED_BYTES:
            raise HTTPException(413, "Markdown ZIP uncompressed size exceeds the limit")
        result[path] = info
    return result


def _decode_markdown(value: bytes, path: str) -> str:
    if len(value) > MAX_JSON_BYTES:
        raise HTTPException(413, f"Markdown file exceeds the size limit: {path}")
    try:
        return value.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise _archive_error(f"Markdown file must use UTF-8: {path}") from exc


def _safe_image_path(note_path: str, reference: MarkdownImageReference) -> str | None:
    try:
        relative = _safe_path(reference.source_path, "Markdown image path")
    except HTTPException:
        return None
    return (PurePosixPath(note_path).parent / PurePosixPath(relative)).as_posix()


def _read_input(source: BinaryIO, filename: str) -> tuple[list[MarkdownNote], zipfile.ZipFile | None, dict[str, zipfile.ZipInfo]]:
    suffix = Path(filename).suffix.lower()
    source.seek(0, 2)
    size = source.tell()
    source.seek(0)
    if suffix in {".md", ".markdown"}:
        if size > MAX_JSON_BYTES:
            raise HTTPException(413, "Markdown file exceeds the size limit")
        markdown = _decode_markdown(source.read(MAX_JSON_BYTES + 1), Path(filename).name)
        return [_parse_markdown_note(markdown, Path(filename).name, None)], None, {}
    if suffix != ".zip":
        raise _archive_error("upload must be a .md, .markdown, or .zip file")
    if size > MAX_ARCHIVE_BYTES:
        raise HTTPException(413, "Markdown ZIP upload exceeds the size limit")
    try:
        archive = zipfile.ZipFile(source)
    except (OSError, zipfile.BadZipFile) as exc:
        raise _archive_error("uploaded file is not a valid Markdown ZIP") from exc
    try:
        entries = _zip_entries(archive)
        markdown_paths = sorted(path for path in entries if PurePosixPath(path).suffix.lower() in {".md", ".markdown"})
        if not markdown_paths:
            raise _archive_error("Markdown ZIP does not contain any Markdown files")
        notes: list[MarkdownNote] = []
        for path in markdown_paths:
            info = entries[path]
            if info.file_size > MAX_JSON_BYTES:
                raise HTTPException(413, f"Markdown file exceeds the size limit: {path}")
            try:
                value = archive.read(info)
            except (RuntimeError, zipfile.BadZipFile) as exc:
                raise _archive_error(f"Markdown ZIP entry is corrupt: {path}") from exc
            parts = PurePosixPath(path).parts
            default_group = _text_field(parts[0], f"{path} default group", 50) if len(parts) > 1 else None
            notes.append(_parse_markdown_note(_decode_markdown(value, path), path, default_group))
        return notes, archive, entries
    except Exception:
        archive.close()
        raise


def _replace_or_remove_images(node: dict[str, Any], replacements: dict[str, str]) -> None:
    children = node.get("content")
    if not isinstance(children, list):
        return
    retained: list[dict[str, Any]] = []
    for child in children:
        if not isinstance(child, dict):
            continue
        if child.get("type") == "image" and str((child.get("attrs") or {}).get("src", "")).startswith("markdown-import://"):
            placeholder = child["attrs"]["src"]
            if placeholder not in replacements:
                continue
            child["attrs"]["src"] = replacements[placeholder]
        _replace_or_remove_images(child, replacements)
        retained.append(child)
    node["content"] = retained


def _extension_types(settings: AppSettings) -> dict[str, str]:
    result: dict[str, str] = {}
    for mime_type, extensions in settings.storage.allowed_types.items():
        for extension in extensions:
            result.setdefault(extension, mime_type)
    return result


def import_markdown(source: BinaryIO, filename: str, db: Session, user_id: str, settings: AppSettings) -> ImportResult:
    notes, archive, entries = _read_input(source, filename)
    created_files: list[Path] = []
    warnings: list[str] = []
    try:
        current_groups = {
            item.normalized_name: item for item in db.scalars(select(Group).where(Group.user_id == user_id)).all()
        }
        current_tags = {
            item.normalized_name: item for item in db.scalars(select(Tag).where(Tag.user_id == user_id)).all()
        }
        used_titles = {value.casefold() for value in db.scalars(select(Note.title).where(Note.user_id == user_id)).all()}
        attachment_dir = settings.attachment_path()
        attachment_dir.mkdir(parents=True, exist_ok=True)
        extension_types = _extension_types(settings)
        renamed = 0
        attachment_count = 0
        for parsed in notes:
            title, was_renamed = _unique_title(parsed.title, used_titles)
            renamed += int(was_renamed)
            group: Group | None = None
            if parsed.group_name:
                normalized = parsed.group_name.casefold()
                group = current_groups.get(normalized)
                if group is None:
                    group = Group(user_id=user_id, name=parsed.group_name, normalized_name=normalized)
                    db.add(group)
                    current_groups[normalized] = group
            tags: list[Tag] = []
            for tag_name in parsed.tag_names:
                normalized = tag_name.casefold()
                tag = current_tags.get(normalized)
                if tag is None:
                    tag = Tag(user_id=user_id, name=tag_name, normalized_name=normalized)
                    db.add(tag)
                    current_tags[normalized] = tag
                tags.append(tag)
            document = copy.deepcopy(parsed.document)
            replacements: dict[str, str] = {}
            pending_attachments: list[Attachment] = []
            imported_assets: dict[str, Attachment] = {}
            for reference in parsed.image_references:
                asset_path = _safe_image_path(parsed.path, reference)
                if archive is None or asset_path is None or asset_path not in entries:
                    warnings.append(f"{parsed.path}: local image was not found and was omitted: {reference.source_path}")
                    continue
                existing = imported_assets.get(asset_path)
                if existing is not None:
                    replacements[reference.placeholder] = f"/api/attachments/{existing.id}/content"
                    continue
                info = entries[asset_path]
                if info.file_size > settings.storage.max_file_bytes:
                    raise HTTPException(413, f"attachment exceeds configured size limit: {asset_path}")
                extension = PurePosixPath(asset_path).suffix.lower()
                mime_type = extension_types.get(extension)
                if mime_type not in INLINE_IMAGE_TYPES:
                    raise _archive_error(f"Markdown image type is not allowed: {asset_path}")
                attachment_id = new_id()
                storage_name = f"{uuid.uuid4().hex}{settings.storage.allowed_types[mime_type][0]}"
                target = attachment_dir / storage_name
                try:
                    with archive.open(info) as archive_file, target.open("xb") as destination:
                        copied = 0
                        while chunk := archive_file.read(COPY_CHUNK_BYTES):
                            copied += len(chunk)
                            if copied > settings.storage.max_file_bytes:
                                raise HTTPException(413, f"attachment exceeds configured size limit: {asset_path}")
                            destination.write(chunk)
                except Exception:
                    target.unlink(missing_ok=True)
                    raise
                created_files.append(target)
                if not _valid_inline_image(target, mime_type):
                    raise _archive_error(f"image content does not match its extension: {asset_path}")
                attachment = Attachment(
                    id=attachment_id,
                    original_name=PurePosixPath(asset_path).name[:255],
                    storage_name=storage_name,
                    mime_type=mime_type,
                    size=info.file_size,
                    created_at=parsed.created_at,
                )
                imported_assets[asset_path] = attachment
                pending_attachments.append(attachment)
                replacements[reference.placeholder] = f"/api/attachments/{attachment_id}/content"
                attachment_count += 1
            _replace_or_remove_images(document, replacements)
            content_json, plain_text = validate_content(document)
            note = Note(
                id=new_id(),
                user_id=user_id,
                group=group,
                title=title,
                content=content_json,
                search_text=f"{title} {plain_text}".casefold(),
                is_pinned=parsed.is_pinned,
                deleted_at=parsed.deleted_at,
                created_at=parsed.created_at,
                updated_at=parsed.updated_at,
                tags=tags,
            )
            db.add(note)
            for attachment in pending_attachments:
                attachment.note = note
                db.add(attachment)
            warnings.extend(f"{parsed.path}: {warning}" for warning in parsed.warnings)
        db.commit()
        return ImportResult(
            notes=len(notes), attachments=attachment_count, renamed=renamed, warnings=list(dict.fromkeys(warnings))
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
        raise HTTPException(422, "Markdown import failed") from exc
    finally:
        if archive is not None:
            archive.close()
