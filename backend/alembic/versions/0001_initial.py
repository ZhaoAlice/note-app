"""Initial cross-database schema."""
from alembic import op
import sqlalchemy as sa


revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("username", sa.String(32), nullable=False),
        sa.Column("normalized_username", sa.String(128), nullable=False),
        sa.Column("display_name", sa.String(80), nullable=True),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("normalized_username"),
    )
    op.create_table(
        "sessions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("csrf_token", sa.String(128), nullable=False),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("token_hash"),
    )
    op.create_index("ix_sessions_user_id", "sessions", ["user_id"])
    op.create_index("ix_sessions_expires_at", "sessions", ["expires_at"])
    op.create_table(
        "notes",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("search_text", sa.Text(), nullable=False),
        sa.Column("is_pinned", sa.Boolean(), nullable=False),
        sa.Column("deleted_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_notes_user_id", "notes", ["user_id"])
    op.create_index("ix_notes_user_deleted_updated", "notes", ["user_id", "deleted_at", "updated_at"])
    op.create_table(
        "tags",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(50), nullable=False),
        sa.Column("normalized_name", sa.String(200), nullable=False),
        sa.UniqueConstraint("user_id", "normalized_name", name="uq_tags_user_normalized"),
    )
    op.create_index("ix_tags_user_id", "tags", ["user_id"])
    op.create_table(
        "note_tags",
        sa.Column("note_id", sa.String(36), sa.ForeignKey("notes.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("tag_id", sa.String(36), sa.ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True),
    )
    op.create_table(
        "attachments",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("note_id", sa.String(36), sa.ForeignKey("notes.id", ondelete="CASCADE"), nullable=False),
        sa.Column("original_name", sa.String(255), nullable=False),
        sa.Column("storage_name", sa.String(100), nullable=False, unique=True),
        sa.Column("mime_type", sa.String(120), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_attachments_note_id", "attachments", ["note_id"])


def downgrade() -> None:
    op.drop_table("attachments")
    op.drop_table("note_tags")
    op.drop_table("tags")
    op.drop_table("notes")
    op.drop_table("sessions")
    op.drop_table("users")
