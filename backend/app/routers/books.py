from __future__ import annotations

import hashlib
import json
import os
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from ..config import AppSettings, get_settings
from ..book_files import prepare_book_file, sniff_cover
from ..book_ocr import wake_ocr_worker
from ..database import get_db
from ..dependencies import AuthContext, current_auth, require_csrf
from ..models import Book, BookAnnotation, BookCategory, BookOcrJob, BookReadingState, BookTextUnit, utcnow
from ..schemas import (
    AnnotationCreate,
    AnnotationOut,
    AnnotationUpdate,
    BookDetail,
    BookSummary,
    BookSearchItem,
    BookSearchOut,
    BookPageTextOut,
    BookUpdate,
    ReadingStateOut,
    ReadingStateUpdate,
)
from ..serializers import annotation_out, book_out, reading_state_out


router = APIRouter(prefix="/api/books", tags=["books"])
SUPPORTED_FORMATS = {"epub", "pdf", "txt", "md", "markdown"}
BOOK_MIME_TYPES = {
    "epub": "application/epub+zip",
    "pdf": "application/pdf",
    "txt": "text/plain; charset=utf-8",
    "md": "text/markdown; charset=utf-8",
    "markdown": "text/markdown; charset=utf-8",
}


def _book_query():
    return select(Book).options(
        selectinload(Book.category),
        selectinload(Book.reading_state),
        selectinload(Book.ocr_job),
    )


def _owned_book(db: Session, user_id: str, book_id: str) -> Book:
    book = db.scalar(_book_query().where(Book.id == book_id, Book.user_id == user_id))
    if book is None:
        raise HTTPException(404, "book not found")
    return book


def _owned_category(db: Session, user_id: str, category_id: str) -> BookCategory:
    category = db.scalar(
        select(BookCategory).where(BookCategory.id == category_id, BookCategory.user_id == user_id)
    )
    if category is None:
        raise HTTPException(404, "book category not found")
    return category


def _owned_annotation(db: Session, user_id: str, book_id: str, annotation_id: str) -> BookAnnotation:
    annotation = db.scalar(
        select(BookAnnotation)
        .join(BookAnnotation.book)
        .where(BookAnnotation.id == annotation_id, BookAnnotation.book_id == book_id, Book.user_id == user_id)
    )
    if annotation is None:
        raise HTTPException(404, "annotation not found")
    return annotation


def _json(value: Any) -> str:
    if hasattr(value, "model_dump"):
        value = value.model_dump(mode="json")
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _validate_location(book: Book, location: Any) -> None:
    if location is None:
        return
    kind = location.kind
    expected = book.format if book.format in {"epub", "pdf"} else "text"
    if kind != expected:
        raise HTTPException(422, "location kind does not match book format")


def _write_upload(file: UploadFile, target: Path, max_bytes: int) -> tuple[int, str]:
    size = 0
    digest = hashlib.sha256()
    with target.open("xb") as output:
        while chunk := file.file.read(1024 * 1024):
            size += len(chunk)
            if size > max_bytes:
                raise HTTPException(413, "book exceeds configured size limit")
            digest.update(chunk)
            output.write(chunk)
    if size == 0:
        raise HTTPException(422, "book file is empty")
    return size, digest.hexdigest()


@router.get("", response_model=list[BookSummary])
def list_books(
    q: str | None = Query(default=None, max_length=300),
    format: str | None = Query(default=None),
    category_id: str | None = Query(default=None, max_length=36),
    uncategorized: bool = Query(default=False),
    sort: str = Query(default="recent", pattern="^(recent|uploaded|title)$"),
    auth: AuthContext = Depends(current_auth),
    db: Session = Depends(get_db),
) -> list[BookSummary]:
    if category_id is not None and uncategorized:
        raise HTTPException(422, "category_id and uncategorized cannot be combined")
    query = _book_query().where(Book.user_id == auth.user.id)
    if category_id is not None:
        _owned_category(db, auth.user.id, category_id)
        query = query.where(Book.category_id == category_id)
    elif uncategorized:
        query = query.where(Book.category_id.is_(None))
    if format is not None:
        if format not in SUPPORTED_FORMATS:
            raise HTTPException(422, "unsupported book format filter")
        query = query.where(Book.format == format)
    if q and q.strip():
        needle = f"%{q.strip().lower()}%"
        query = query.where(or_(func.lower(Book.title).like(needle), func.lower(func.coalesce(Book.author, "")).like(needle)))
    if sort == "title":
        query = query.order_by(func.lower(Book.title), Book.created_at.desc())
    elif sort == "uploaded":
        query = query.order_by(Book.created_at.desc())
    else:
        query = query.outerjoin(BookReadingState).order_by(
            func.coalesce(BookReadingState.last_read_at, Book.created_at).desc()
        )
    return [book_out(book) for book in db.scalars(query).unique().all()]


@router.post("", response_model=BookDetail, status_code=201)
def upload_book(
    file: UploadFile = File(...),
    title: str | None = Form(default=None),
    author: str | None = Form(default=None),
    category_id: str | None = Form(default=None, max_length=36),
    deduplicate: bool = Query(default=False),
    auth: AuthContext = Depends(require_csrf),
    db: Session = Depends(get_db),
    settings: AppSettings = Depends(get_settings),
) -> BookDetail:
    category = _owned_category(db, auth.user.id, category_id) if category_id else None
    original_name = Path(file.filename or "book").name[:255]
    book_format = Path(original_name).suffix.lower().removeprefix(".")
    if book_format not in SUPPORTED_FORMATS:
        raise HTTPException(422, "unsupported book format")
    if title is not None and not title.strip():
        raise HTTPException(422, "book title cannot be blank")
    if title is not None and len(title.strip()) > 300:
        raise HTTPException(422, "book title is too long")
    if author is not None and len(author.strip()) > 300:
        raise HTTPException(422, "book author is too long")
    book_dir = settings.book_path()
    book_dir.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex
    temp_original = book_dir / f".{token}.upload.part"
    temp_reader = book_dir / f".{token}.reader.part"
    storage_name = f"{token}.{book_format}"
    reader_storage_name = f"{token}.reader.{book_format}"
    original_target = book_dir / storage_name
    reader_target = book_dir / reader_storage_name
    created_paths: list[Path] = [temp_original, temp_reader]
    cover_storage_name: str | None = None
    try:
        size, sha256 = _write_upload(file, temp_original, settings.storage.max_book_bytes)
        if deduplicate:
            existing = db.scalar(
                _book_query().where(Book.user_id == auth.user.id, Book.sha256 == sha256)
            )
            if existing is not None:
                temp_original.unlink(missing_ok=True)
                return book_out(existing)
        prepared = prepare_book_file(
            temp_original,
            original_name,
            temp_reader,
            settings.storage.max_book_bytes,
            settings.storage.max_cover_bytes,
        )
        os.replace(temp_original, original_target)
        os.replace(temp_reader, reader_target)
        created_paths.extend([original_target, reader_target])
        if prepared.cover_bytes and prepared.cover_mime_type:
            cover_extension = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}[prepared.cover_mime_type]
            cover_storage_name = f"{token}.cover{cover_extension}"
            cover_target = book_dir / cover_storage_name
            with cover_target.open("xb") as output:
                output.write(prepared.cover_bytes)
            created_paths.append(cover_target)
        fallback_title = Path(original_name).stem.strip() or "Untitled"
        book = Book(
            user_id=auth.user.id,
            category=category,
            title=(title.strip() if title is not None else prepared.title) or fallback_title,
            author=(author.strip() or None) if author is not None else prepared.author,
            format=book_format,
            original_name=original_name,
            storage_name=storage_name,
            reader_storage_name=reader_storage_name,
            cover_storage_name=cover_storage_name,
            cover_mime_type=prepared.cover_mime_type if cover_storage_name else None,
            sha256=sha256,
            size=size,
            page_count=prepared.page_count,
            search_text=prepared.search_text,
        )
        book.reading_state = BookReadingState(locator="null", progress=0.0, settings="{}")
        for unit in prepared.text_units:
            book.text_units.append(
                BookTextUnit(
                    unit_index=unit["unit_index"],
                    locator=_json(unit["locator"]),
                    text=unit["text"],
                    boxes=None,
                    source=unit["source"],
                    label=unit["label"],
                )
            )
        if book_format == "pdf":
            book.ocr_job = BookOcrJob(status="queued", pages_total=prepared.page_count or 0, pages_done=0)
        db.add(book)
        db.commit()
        db.refresh(book)
        if book_format == "pdf":
            wake_ocr_worker()
        return book_out(_owned_book(db, auth.user.id, book.id))
    except Exception:
        db.rollback()
        for path in created_paths:
            path.unlink(missing_ok=True)
        raise
    finally:
        file.file.close()


@router.get("/{book_id}", response_model=BookDetail)
def get_book(book_id: str, auth: AuthContext = Depends(current_auth), db: Session = Depends(get_db)) -> BookDetail:
    return book_out(_owned_book(db, auth.user.id, book_id))


@router.patch("/{book_id}", response_model=BookDetail)
def update_book(
    book_id: str,
    body: BookUpdate,
    auth: AuthContext = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> BookDetail:
    book = _owned_book(db, auth.user.id, book_id)
    if "title" in body.model_fields_set:
        if body.title is None:
            raise HTTPException(422, "book title cannot be null")
        book.title = body.title
    if "author" in body.model_fields_set:
        book.author = body.author
    if "category_id" in body.model_fields_set:
        book.category = (
            _owned_category(db, auth.user.id, body.category_id) if body.category_id is not None else None
        )
    book.updated_at = utcnow()
    db.commit()
    return book_out(_owned_book(db, auth.user.id, book.id))


@router.delete("/{book_id}", status_code=204)
def delete_book(
    book_id: str,
    auth: AuthContext = Depends(require_csrf),
    db: Session = Depends(get_db),
    settings: AppSettings = Depends(get_settings),
) -> None:
    book = _owned_book(db, auth.user.id, book_id)
    names = [book.storage_name, book.reader_storage_name, book.cover_storage_name]
    db.delete(book)
    db.commit()
    for name in names:
        if name:
            (settings.book_path() / name).unlink(missing_ok=True)


def _book_file_response(book: Book, path: Path, *, original: bool) -> FileResponse:
    if not path.is_file():
        raise HTTPException(404, "book file not found")
    media_type = BOOK_MIME_TYPES[book.format]
    response = FileResponse(
        path,
        media_type=media_type,
        filename=book.original_name,
        content_disposition_type="attachment" if original else "inline",
    )
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Content-Security-Policy"] = "sandbox"
    return response


@router.get("/{book_id}/content")
def book_content(
    book_id: str,
    auth: AuthContext = Depends(current_auth),
    db: Session = Depends(get_db),
    settings: AppSettings = Depends(get_settings),
) -> FileResponse:
    book = _owned_book(db, auth.user.id, book_id)
    return _book_file_response(book, settings.book_path() / book.reader_storage_name, original=False)


@router.get("/{book_id}/download")
def download_book(
    book_id: str,
    auth: AuthContext = Depends(current_auth),
    db: Session = Depends(get_db),
    settings: AppSettings = Depends(get_settings),
) -> FileResponse:
    book = _owned_book(db, auth.user.id, book_id)
    return _book_file_response(book, settings.book_path() / book.storage_name, original=True)


@router.get("/{book_id}/cover")
def get_cover(
    book_id: str,
    auth: AuthContext = Depends(current_auth),
    db: Session = Depends(get_db),
    settings: AppSettings = Depends(get_settings),
) -> FileResponse:
    book = _owned_book(db, auth.user.id, book_id)
    if not book.cover_storage_name or not book.cover_mime_type:
        raise HTTPException(404, "book cover not found")
    path = settings.book_path() / book.cover_storage_name
    if not path.is_file():
        raise HTTPException(404, "book cover file not found")
    response = FileResponse(path, media_type=book.cover_mime_type)
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@router.post("/{book_id}/cover", response_model=BookDetail)
def set_cover(
    book_id: str,
    file: UploadFile = File(...),
    auth: AuthContext = Depends(require_csrf),
    db: Session = Depends(get_db),
    settings: AppSettings = Depends(get_settings),
) -> BookDetail:
    book = _owned_book(db, auth.user.id, book_id)
    book_dir = settings.book_path()
    book_dir.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex
    temporary = book_dir / f".{token}.cover.part"
    target: Path | None = None
    old_name = book.cover_storage_name
    try:
        size, _digest = _write_upload(file, temporary, settings.storage.max_cover_bytes)
        if size == 0:
            raise HTTPException(422, "cover file is empty")
        with temporary.open("rb") as source:
            mime_type = sniff_cover(source.read(12))
        if mime_type is None:
            raise HTTPException(422, "cover must be JPEG, PNG, or WebP")
        suffix = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}[mime_type]
        new_name = f"{token}{suffix}"
        target = book_dir / new_name
        os.replace(temporary, target)
        book.cover_storage_name = new_name
        book.cover_mime_type = mime_type
        book.updated_at = utcnow()
        db.commit()
        if old_name:
            (book_dir / old_name).unlink(missing_ok=True)
        return book_out(_owned_book(db, auth.user.id, book.id))
    except Exception:
        db.rollback()
        temporary.unlink(missing_ok=True)
        if target:
            target.unlink(missing_ok=True)
        raise
    finally:
        file.file.close()


@router.delete("/{book_id}/cover", response_model=BookDetail)
def delete_cover(
    book_id: str,
    auth: AuthContext = Depends(require_csrf),
    db: Session = Depends(get_db),
    settings: AppSettings = Depends(get_settings),
) -> BookDetail:
    book = _owned_book(db, auth.user.id, book_id)
    old_name = book.cover_storage_name
    book.cover_storage_name = None
    book.cover_mime_type = None
    book.updated_at = utcnow()
    db.commit()
    if old_name:
        (settings.book_path() / old_name).unlink(missing_ok=True)
    return book_out(_owned_book(db, auth.user.id, book.id))


@router.get("/{book_id}/reading-state", response_model=ReadingStateOut)
def get_reading_state(
    book_id: str, auth: AuthContext = Depends(current_auth), db: Session = Depends(get_db)
) -> ReadingStateOut:
    book = _owned_book(db, auth.user.id, book_id)
    if book.reading_state is None:
        return ReadingStateOut(book_id=book.id)
    return reading_state_out(book.reading_state)


@router.put("/{book_id}/reading-state", response_model=ReadingStateOut)
def put_reading_state(
    book_id: str,
    body: ReadingStateUpdate,
    auth: AuthContext = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> ReadingStateOut:
    book = _owned_book(db, auth.user.id, book_id)
    state = book.reading_state
    if state is None:
        state = BookReadingState(book=book)
        db.add(state)
    _validate_location(book, body.locator)
    state.locator = _json(body.locator)
    state.progress = body.progress
    state.settings = _json(
        {
            "font_size": body.font_size,
            "line_height": body.line_height,
            "font_family": body.font_family,
            "theme": body.theme,
            "layout": body.layout,
        }
    )
    state.last_read_at = utcnow()
    state.updated_at = state.last_read_at
    db.commit()
    db.refresh(state)
    return reading_state_out(state)


@router.get("/{book_id}/annotations", response_model=list[AnnotationOut])
def list_annotations(
    book_id: str, auth: AuthContext = Depends(current_auth), db: Session = Depends(get_db)
) -> list[AnnotationOut]:
    book = _owned_book(db, auth.user.id, book_id)
    annotations = db.scalars(
        select(BookAnnotation).where(BookAnnotation.book_id == book.id).order_by(BookAnnotation.created_at)
    ).all()
    return [annotation_out(item) for item in annotations]


@router.post("/{book_id}/annotations", response_model=AnnotationOut, status_code=201)
def create_annotation(
    book_id: str,
    body: AnnotationCreate,
    auth: AuthContext = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> AnnotationOut:
    book = _owned_book(db, auth.user.id, book_id)
    _validate_location(book, body.locator)
    annotation = BookAnnotation(
        book_id=book.id,
        type=body.type,
        locator=_json(body.locator),
        color=body.color,
        quote=body.quote,
        note=body.note,
    )
    db.add(annotation)
    db.commit()
    db.refresh(annotation)
    return annotation_out(annotation)


@router.patch("/{book_id}/annotations/{annotation_id}", response_model=AnnotationOut)
def update_annotation(
    book_id: str,
    annotation_id: str,
    body: AnnotationUpdate,
    auth: AuthContext = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> AnnotationOut:
    annotation = _owned_annotation(db, auth.user.id, book_id, annotation_id)
    book = _owned_book(db, auth.user.id, book_id)
    for field in body.model_fields_set:
        value = getattr(body, field)
        if field in {"type", "locator"} and value is None:
            raise HTTPException(422, f"annotation {field} cannot be null")
        if field == "locator":
            _validate_location(book, value)
        setattr(annotation, field, _json(value) if field == "locator" else value)
    annotation.updated_at = utcnow()
    db.commit()
    db.refresh(annotation)
    return annotation_out(annotation)


@router.delete("/{book_id}/annotations/{annotation_id}", status_code=204)
def delete_annotation(
    book_id: str,
    annotation_id: str,
    auth: AuthContext = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> None:
    annotation = _owned_annotation(db, auth.user.id, book_id, annotation_id)
    db.delete(annotation)
    db.commit()


def _excerpt(text: str, needle: str, radius: int = 100) -> str:
    position = text.casefold().find(needle.casefold())
    if position < 0:
        return text[: radius * 2].strip()
    start = max(0, position - radius)
    end = min(len(text), position + len(needle) + radius)
    prefix = "…" if start else ""
    suffix = "…" if end < len(text) else ""
    return f"{prefix}{text[start:end].strip()}{suffix}"


@router.get("/{book_id}/search", response_model=BookSearchOut)
def search_book(
    book_id: str,
    q: str = Query(min_length=1, max_length=300),
    auth: AuthContext = Depends(current_auth),
    db: Session = Depends(get_db),
) -> BookSearchOut:
    book = _owned_book(db, auth.user.id, book_id)
    needle = q.strip()
    if not needle:
        raise HTTPException(422, "search query cannot be blank")
    units = db.scalars(
        select(BookTextUnit)
        .where(BookTextUnit.book_id == book.id, func.lower(BookTextUnit.text).like(f"%{needle.lower()}%"))
        .order_by(BookTextUnit.unit_index)
        .limit(100)
    ).all()
    items: list[BookSearchItem] = []
    for unit in units:
        locator = json.loads(unit.locator)
        if unit.source == "ocr" and unit.boxes and isinstance(locator, dict) and locator.get("kind") == "pdf":
            try:
                boxes = json.loads(unit.boxes)
            except json.JSONDecodeError:
                boxes = []
            matching = [
                {key: box[key] for key in ("left", "top", "width", "height")}
                for box in boxes
                if isinstance(box, dict)
                and needle.casefold() in str(box.get("text", "")).casefold()
                and all(key in box for key in ("left", "top", "width", "height"))
            ]
            if matching:
                locator["rects"] = matching
        items.append(
            BookSearchItem(
                unit_index=unit.unit_index,
                locator=locator,
                label=unit.label,
                source=unit.source,
                excerpt=_excerpt(unit.text, needle),
            )
        )
    index_complete = book.ocr_job is None or book.ocr_job.status == "completed"
    return BookSearchOut(items=items, index_complete=index_complete)


@router.get("/{book_id}/pages/{page_index}/text", response_model=BookPageTextOut)
def get_book_page_text(
    book_id: str,
    page_index: int,
    auth: AuthContext = Depends(current_auth),
    db: Session = Depends(get_db),
) -> BookPageTextOut:
    book = _owned_book(db, auth.user.id, book_id)
    if book.format != "pdf" or page_index < 0:
        raise HTTPException(404, "book page text not found")
    unit = db.scalar(
        select(BookTextUnit).where(
            BookTextUnit.book_id == book.id,
            BookTextUnit.unit_index == page_index,
        )
    )
    if unit is None:
        raise HTTPException(404, "book page text not found")
    try:
        boxes = json.loads(unit.boxes) if unit.boxes else []
    except json.JSONDecodeError:
        boxes = []
    return BookPageTextOut(
        page_index=page_index,
        source=unit.source,
        text=unit.text,
        boxes=boxes if isinstance(boxes, list) else [],
    )


@router.post("/{book_id}/ocr/retry", response_model=BookDetail)
def retry_ocr(
    book_id: str,
    auth: AuthContext = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> BookDetail:
    book = _owned_book(db, auth.user.id, book_id)
    if book.format != "pdf" or book.ocr_job is None:
        raise HTTPException(409, "OCR is not applicable to this book")
    job = book.ocr_job
    if job.status != "failed":
        raise HTTPException(409, "only failed OCR jobs can be retried")
    job.status = "queued"
    job.pages_done = 0
    job.error = None
    job.claim_token = None
    job.lease_until = None
    job.updated_at = utcnow()
    db.commit()
    db.refresh(job)
    wake_ocr_worker()
    return book_out(_owned_book(db, auth.user.id, book.id))
