from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, PlainSerializer, field_validator


def serialize_utc_datetime(value: datetime) -> str:
    """Expose database UTC timestamps with an explicit timezone designator."""
    aware = value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
    return aware.isoformat().replace("+00:00", "Z")


UtcDateTime = Annotated[
    datetime,
    PlainSerializer(serialize_utc_datetime, return_type=str, when_used="json"),
]


class AuthInput(BaseModel):
    username: str = Field(min_length=3, max_length=32)
    password: str = Field(min_length=8, max_length=128)

    @field_validator("username")
    @classmethod
    def clean_username(cls, value: str) -> str:
        value = value.strip()
        if len(value) < 3:
            raise ValueError("username must contain at least 3 non-space characters")
        return value


class RegisterInput(AuthInput):
    display_name: str | None = Field(default=None, max_length=80)


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    username: str
    display_name: str | None
    created_at: UtcDateTime


class ProfileUpdate(BaseModel):
    display_name: str | None = Field(default=None, max_length=80)

    @field_validator("display_name")
    @classmethod
    def clean_display_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        return value or None


class CsrfOut(BaseModel):
    csrf_token: str


class DesktopStatusOut(BaseModel):
    desktop_mode: bool
    database_type: Literal["sqlite", "mysql", "postgresql"]
    config_path: str | None
    database_revision: str | None
    application_revision: str
    database_status: Literal["ready", "migration_required"]
    allow_auto_bootstrap: bool
    user_count: int


class TagOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str


class GroupInput(BaseModel):
    name: str = Field(min_length=1, max_length=50)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("group name cannot be blank")
        return value


class GroupOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str


class AttachmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    original_name: str
    mime_type: str
    size: int
    created_at: UtcDateTime
    content_url: str


EMPTY_DOCUMENT: dict[str, Any] = {"type": "doc", "content": []}


class NoteCreate(BaseModel):
    title: str = Field(default="", max_length=200)
    content: dict[str, Any] = Field(default_factory=lambda: dict(EMPTY_DOCUMENT))
    tag_names: list[str] = Field(default_factory=list, max_length=30)
    group_id: str | None = None
    is_pinned: bool = False


class NoteUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    content: dict[str, Any] | None = None
    tag_names: list[str] | None = Field(default=None, max_length=30)
    group_id: str | None = None
    is_pinned: bool | None = None


class NoteDetail(BaseModel):
    id: str
    title: str
    content: dict[str, Any]
    tags: list[TagOut]
    group: GroupOut | None
    attachments: list[AttachmentOut]
    is_pinned: bool
    deleted_at: UtcDateTime | None
    created_at: UtcDateTime
    updated_at: UtcDateTime


class NoteSummary(BaseModel):
    id: str
    title: str
    excerpt: str
    tags: list[TagOut]
    group: GroupOut | None
    is_pinned: bool
    deleted_at: UtcDateTime | None
    created_at: UtcDateTime
    updated_at: UtcDateTime


BookFormat = Literal["epub", "pdf", "txt", "md", "markdown"]
AnnotationType = Literal["bookmark", "highlight", "underline"]


class EpubBookLocation(BaseModel):
    kind: Literal["epub"]
    cfi: str
    href: str | None = None
    end_cfi: str | None = None


class PdfBookRect(BaseModel):
    left: float
    top: float
    width: float
    height: float


class PdfBookLocation(BaseModel):
    kind: Literal["pdf"]
    page_index: int = Field(ge=0)
    rects: list[PdfBookRect] | None = None


class TextBookLocation(BaseModel):
    kind: Literal["text"]
    start: int = Field(ge=0)
    end: int | None = Field(default=None, ge=0)
    quote: str | None = None


BookLocation = Annotated[EpubBookLocation | PdfBookLocation | TextBookLocation, Field(discriminator="kind")]


class BookCategoryInput(BaseModel):
    name: str = Field(min_length=1, max_length=50)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("book category name cannot be blank")
        return value


class BookCategoryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str
    created_at: UtcDateTime


class BookUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=300)
    author: str | None = Field(default=None, max_length=300)
    category_id: str | None = Field(default=None, max_length=36)

    @field_validator("title")
    @classmethod
    def clean_book_title(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise ValueError("book title cannot be blank")
        return value

    @field_validator("author")
    @classmethod
    def clean_book_author(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return value.strip() or None


class BookSummary(BaseModel):
    id: str
    title: str
    author: str | None
    category: BookCategoryOut | None
    format: BookFormat
    size: int
    page_count: int | None
    cover_url: str | None
    content_url: str
    download_url: str
    progress: float
    last_read_at: UtcDateTime | None
    ocr_status: Literal["queued", "running", "completed", "failed"] | None
    ocr_progress: float | None
    created_at: UtcDateTime
    updated_at: UtcDateTime


class BookDetail(BookSummary):
    ocr_error: str | None


BookOut = BookDetail


class ReadingStateUpdate(BaseModel):
    locator: BookLocation | None = None
    progress: float = Field(default=0.0, ge=0.0, le=1.0)
    font_size: float = Field(default=100.0, ge=50.0, le=300.0)
    line_height: float = Field(default=1.6, ge=1.0, le=3.0)
    font_family: str = Field(default="system", max_length=80)
    theme: str = Field(default="warm", max_length=40)
    layout: str = Field(default="paginated", max_length=40)


class ReadingStateOut(ReadingStateUpdate):
    book_id: str
    last_read_at: UtcDateTime | None = None
    updated_at: UtcDateTime | None = None


class AnnotationCreate(BaseModel):
    type: AnnotationType
    locator: BookLocation
    color: str | None = Field(default=None, max_length=32)
    quote: str | None = Field(default=None, max_length=20_000)
    note: str | None = Field(default=None, max_length=5_000)


class AnnotationUpdate(BaseModel):
    type: AnnotationType | None = None
    locator: BookLocation | None = None
    color: str | None = Field(default=None, max_length=32)
    quote: str | None = Field(default=None, max_length=20_000)
    note: str | None = Field(default=None, max_length=5_000)


class AnnotationOut(AnnotationCreate):
    id: str
    book_id: str
    created_at: UtcDateTime
    updated_at: UtcDateTime


class BookSearchItem(BaseModel):
    unit_index: int
    locator: BookLocation
    label: str | None
    source: str | None
    excerpt: str


class BookSearchOut(BaseModel):
    items: list[BookSearchItem]
    index_complete: bool


class BookOcrTextBox(BaseModel):
    text: str
    score: float = Field(ge=0.0, le=1.0)
    left: float = Field(ge=0.0, le=100.0)
    top: float = Field(ge=0.0, le=100.0)
    width: float = Field(ge=0.0, le=100.0)
    height: float = Field(ge=0.0, le=100.0)


class BookPageTextOut(BaseModel):
    page_index: int
    source: str
    text: str
    boxes: list[BookOcrTextBox]


class BookOcrOut(BaseModel):
    book_id: str
    status: Literal["queued", "running", "completed", "failed"]
    pages_total: int
    pages_done: int
    error: str | None
    updated_at: UtcDateTime
