from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
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
