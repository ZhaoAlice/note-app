from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any

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
