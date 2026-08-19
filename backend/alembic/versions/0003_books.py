"""Add books, reading state, annotations, text index, and OCR jobs."""

from alembic import op
import sqlalchemy as sa


revision = "0003_books"
down_revision = "0002_note_groups"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "books",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("title", sa.String(300), nullable=False),
        sa.Column("author", sa.String(300), nullable=True),
        sa.Column("format", sa.String(16), nullable=False),
        sa.Column("original_name", sa.String(255), nullable=False),
        sa.Column("storage_name", sa.String(100), nullable=False, unique=True),
        sa.Column("reader_storage_name", sa.String(100), nullable=False, unique=True),
        sa.Column("cover_storage_name", sa.String(100), nullable=True, unique=True),
        sa.Column("cover_mime_type", sa.String(120), nullable=True),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("page_count", sa.Integer(), nullable=True),
        sa.Column("search_text", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_books_user_id", "books", ["user_id"])
    op.create_index("ix_books_sha256", "books", ["sha256"])
    op.create_index("ix_books_user_updated", "books", ["user_id", "updated_at"])
    op.create_index("ix_books_user_format", "books", ["user_id", "format"])
    op.create_table(
        "book_reading_states",
        sa.Column("book_id", sa.String(36), sa.ForeignKey("books.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("locator", sa.Text(), nullable=False),
        sa.Column("progress", sa.Float(), nullable=False),
        sa.Column("settings", sa.Text(), nullable=False),
        sa.Column("last_read_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "book_annotations",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("book_id", sa.String(36), sa.ForeignKey("books.id", ondelete="CASCADE"), nullable=False),
        sa.Column("type", sa.String(20), nullable=False),
        sa.Column("locator", sa.Text(), nullable=False),
        sa.Column("color", sa.String(32), nullable=True),
        sa.Column("quote", sa.Text(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_book_annotations_book_id", "book_annotations", ["book_id"])
    op.create_index("ix_book_annotations_book_created", "book_annotations", ["book_id", "created_at"])
    op.create_table(
        "book_text_units",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("book_id", sa.String(36), sa.ForeignKey("books.id", ondelete="CASCADE"), nullable=False),
        sa.Column("unit_index", sa.Integer(), nullable=False),
        sa.Column("locator", sa.Text(), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("boxes", sa.Text(), nullable=True),
        sa.Column("source", sa.String(24), nullable=False),
        sa.Column("label", sa.String(300), nullable=True),
        sa.UniqueConstraint("book_id", "unit_index", name="uq_book_text_units_book_index"),
    )
    op.create_index("ix_book_text_units_book_id", "book_text_units", ["book_id"])
    op.create_table(
        "book_ocr_jobs",
        sa.Column("book_id", sa.String(36), sa.ForeignKey("books.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("pages_total", sa.Integer(), nullable=False),
        sa.Column("pages_done", sa.Integer(), nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("claim_token", sa.String(64), nullable=True),
        sa.Column("lease_until", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_book_ocr_jobs_status", "book_ocr_jobs", ["status"])
    op.create_index("ix_book_ocr_jobs_lease_until", "book_ocr_jobs", ["lease_until"])


def downgrade() -> None:
    op.drop_table("book_ocr_jobs")
    op.drop_table("book_text_units")
    op.drop_table("book_annotations")
    op.drop_table("book_reading_states")
    op.drop_table("books")
