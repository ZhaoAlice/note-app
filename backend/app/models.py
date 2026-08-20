from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def new_id() -> str:
    return str(uuid.uuid4())


def utcnow() -> datetime:
    # Store UTC as a naive value for identical behavior across all dialects.
    return datetime.now(UTC).replace(tzinfo=None)


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    username: Mapped[str] = mapped_column(String(32))
    normalized_username: Mapped[str] = mapped_column(String(128), unique=True)
    display_name: Mapped[str | None] = mapped_column(String(80), nullable=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    sessions: Mapped[list[SessionModel]] = relationship(back_populates="user", cascade="all, delete-orphan")
    notes: Mapped[list[Note]] = relationship(back_populates="user", cascade="all, delete-orphan")
    groups: Mapped[list[Group]] = relationship(back_populates="user", cascade="all, delete-orphan")
    tags: Mapped[list[Tag]] = relationship(back_populates="user", cascade="all, delete-orphan")
    book_categories: Mapped[list[BookCategory]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    books: Mapped[list[Book]] = relationship(back_populates="user", cascade="all, delete-orphan")


class SessionModel(Base):
    __tablename__ = "sessions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    csrf_token: Mapped[str] = mapped_column(String(128))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    user: Mapped[User] = relationship(back_populates="sessions")


class Note(Base):
    __tablename__ = "notes"
    __table_args__ = (Index("ix_notes_user_deleted_updated", "user_id", "deleted_at", "updated_at"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    group_id: Mapped[str | None] = mapped_column(ForeignKey("groups.id", ondelete="SET NULL"), nullable=True, index=True)
    title: Mapped[str] = mapped_column(String(200), default="")
    content: Mapped[str] = mapped_column(Text, default='{"type":"doc","content":[]}')
    search_text: Mapped[str] = mapped_column(Text, default="")
    is_pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    user: Mapped[User] = relationship(back_populates="notes")
    group: Mapped[Group | None] = relationship(back_populates="notes")
    tags: Mapped[list[Tag]] = relationship(secondary="note_tags", back_populates="notes")
    attachments: Mapped[list[Attachment]] = relationship(back_populates="note", cascade="all, delete-orphan")


class Group(Base):
    __tablename__ = "groups"
    __table_args__ = (UniqueConstraint("user_id", "normalized_name", name="uq_groups_user_normalized"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(50))
    normalized_name: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    user: Mapped[User] = relationship(back_populates="groups")
    notes: Mapped[list[Note]] = relationship(back_populates="group")


class Tag(Base):
    __tablename__ = "tags"
    __table_args__ = (UniqueConstraint("user_id", "normalized_name", name="uq_tags_user_normalized"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(50))
    normalized_name: Mapped[str] = mapped_column(String(200))
    user: Mapped[User] = relationship(back_populates="tags")
    notes: Mapped[list[Note]] = relationship(secondary="note_tags", back_populates="tags")


class NoteTag(Base):
    __tablename__ = "note_tags"
    note_id: Mapped[str] = mapped_column(ForeignKey("notes.id", ondelete="CASCADE"), primary_key=True)
    tag_id: Mapped[str] = mapped_column(ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True)


class Attachment(Base):
    __tablename__ = "attachments"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    note_id: Mapped[str] = mapped_column(ForeignKey("notes.id", ondelete="CASCADE"), index=True)
    original_name: Mapped[str] = mapped_column(String(255))
    storage_name: Mapped[str] = mapped_column(String(100), unique=True)
    mime_type: Mapped[str] = mapped_column(String(120))
    size: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    note: Mapped[Note] = relationship(back_populates="attachments")


class BookCategory(Base):
    __tablename__ = "book_categories"
    __table_args__ = (
        UniqueConstraint("user_id", "normalized_name", name="uq_book_categories_user_normalized"),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(50))
    normalized_name: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    user: Mapped[User] = relationship(back_populates="book_categories")
    books: Mapped[list[Book]] = relationship(back_populates="category")


class Book(Base):
    __tablename__ = "books"
    __table_args__ = (
        Index("ix_books_user_updated", "user_id", "updated_at"),
        Index("ix_books_user_format", "user_id", "format"),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    category_id: Mapped[str | None] = mapped_column(
        ForeignKey("book_categories.id", ondelete="SET NULL"), nullable=True, index=True
    )
    title: Mapped[str] = mapped_column(String(300))
    author: Mapped[str | None] = mapped_column(String(300), nullable=True)
    format: Mapped[str] = mapped_column(String(16))
    original_name: Mapped[str] = mapped_column(String(255))
    storage_name: Mapped[str] = mapped_column(String(100), unique=True)
    reader_storage_name: Mapped[str] = mapped_column(String(100), unique=True)
    cover_storage_name: Mapped[str | None] = mapped_column(String(100), nullable=True, unique=True)
    cover_mime_type: Mapped[str | None] = mapped_column(String(120), nullable=True)
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    size: Mapped[int] = mapped_column(Integer)
    page_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    search_text: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    user: Mapped[User] = relationship(back_populates="books")
    category: Mapped[BookCategory | None] = relationship(back_populates="books")
    reading_state: Mapped[BookReadingState | None] = relationship(
        back_populates="book", cascade="all, delete-orphan", uselist=False
    )
    annotations: Mapped[list[BookAnnotation]] = relationship(back_populates="book", cascade="all, delete-orphan")
    text_units: Mapped[list[BookTextUnit]] = relationship(back_populates="book", cascade="all, delete-orphan")
    ocr_job: Mapped[BookOcrJob | None] = relationship(
        back_populates="book", cascade="all, delete-orphan", uselist=False
    )


class BookReadingState(Base):
    __tablename__ = "book_reading_states"
    book_id: Mapped[str] = mapped_column(ForeignKey("books.id", ondelete="CASCADE"), primary_key=True)
    locator: Mapped[str] = mapped_column(Text, default="null")
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    settings: Mapped[str] = mapped_column(Text, default="{}")
    last_read_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    book: Mapped[Book] = relationship(back_populates="reading_state")


class BookAnnotation(Base):
    __tablename__ = "book_annotations"
    __table_args__ = (Index("ix_book_annotations_book_created", "book_id", "created_at"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    book_id: Mapped[str] = mapped_column(ForeignKey("books.id", ondelete="CASCADE"), index=True)
    type: Mapped[str] = mapped_column(String(20))
    locator: Mapped[str] = mapped_column(Text)
    color: Mapped[str | None] = mapped_column(String(32), nullable=True)
    quote: Mapped[str | None] = mapped_column(Text, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    book: Mapped[Book] = relationship(back_populates="annotations")


class BookTextUnit(Base):
    __tablename__ = "book_text_units"
    __table_args__ = (UniqueConstraint("book_id", "unit_index", name="uq_book_text_units_book_index"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    book_id: Mapped[str] = mapped_column(ForeignKey("books.id", ondelete="CASCADE"), index=True)
    unit_index: Mapped[int] = mapped_column(Integer)
    locator: Mapped[str] = mapped_column(Text)
    text: Mapped[str] = mapped_column(Text, default="")
    boxes: Mapped[str | None] = mapped_column(Text, nullable=True)
    source: Mapped[str] = mapped_column(String(24), default="native")
    label: Mapped[str | None] = mapped_column(String(300), nullable=True)
    book: Mapped[Book] = relationship(back_populates="text_units")


class BookOcrJob(Base):
    __tablename__ = "book_ocr_jobs"
    book_id: Mapped[str] = mapped_column(ForeignKey("books.id", ondelete="CASCADE"), primary_key=True)
    status: Mapped[str] = mapped_column(String(24), default="queued", index=True)
    pages_total: Mapped[int] = mapped_column(Integer, default=0)
    pages_done: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    claim_token: Mapped[str | None] = mapped_column(String(64), nullable=True)
    lease_until: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    book: Mapped[Book] = relationship(back_populates="ocr_job")
