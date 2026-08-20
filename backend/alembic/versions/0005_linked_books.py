"""Add desktop linked-book storage metadata."""

from alembic import op
import sqlalchemy as sa


revision = "0005_linked_books"
down_revision = "0004_book_categories"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("books") as batch_op:
        batch_op.add_column(
            sa.Column("storage_mode", sa.String(16), nullable=False, server_default="managed")
        )
        batch_op.add_column(sa.Column("source_path", sa.Text(), nullable=True))
        batch_op.add_column(sa.Column("source_path_hash", sa.String(64), nullable=True))
        batch_op.add_column(sa.Column("source_mtime_ns", sa.BigInteger(), nullable=True))
        batch_op.alter_column("storage_name", existing_type=sa.String(100), nullable=True)
        batch_op.create_check_constraint(
            "ck_books_storage_mode", "storage_mode IN ('managed', 'linked')"
        )
        batch_op.create_unique_constraint(
            "uq_books_user_source_path_hash", ["user_id", "source_path_hash"]
        )


def downgrade() -> None:
    # A downgraded schema has no linked-source metadata. Promote the safe reader
    # cache to the managed file slot so linked rows remain readable and satisfy
    # the restored NOT NULL constraint.
    op.execute(
        sa.text(
            "UPDATE books SET storage_name = reader_storage_name "
            "WHERE storage_name IS NULL"
        )
    )
    with op.batch_alter_table("books") as batch_op:
        batch_op.drop_constraint("uq_books_user_source_path_hash", type_="unique")
        batch_op.drop_constraint("ck_books_storage_mode", type_="check")
        batch_op.drop_column("source_mtime_ns")
        batch_op.drop_column("source_path_hash")
        batch_op.drop_column("source_path")
        batch_op.drop_column("storage_mode")
        batch_op.alter_column("storage_name", existing_type=sa.String(100), nullable=False)
