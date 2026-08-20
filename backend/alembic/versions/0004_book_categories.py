"""Add book categories and optional book category membership."""

from alembic import op
import sqlalchemy as sa


revision = "0004_book_categories"
down_revision = "0003_books"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "book_categories",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "user_id",
            sa.String(36),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(50), nullable=False),
        sa.Column("normalized_name", sa.String(200), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint(
            "user_id",
            "normalized_name",
            name="uq_book_categories_user_normalized",
        ),
    )
    op.create_index("ix_book_categories_user_id", "book_categories", ["user_id"])
    with op.batch_alter_table("books") as batch_op:
        batch_op.add_column(sa.Column("category_id", sa.String(36), nullable=True))
        batch_op.create_index("ix_books_category_id", ["category_id"])
        batch_op.create_foreign_key(
            "fk_books_category_id_book_categories",
            "book_categories",
            ["category_id"],
            ["id"],
            ondelete="SET NULL",
        )


def downgrade() -> None:
    with op.batch_alter_table("books") as batch_op:
        batch_op.drop_constraint("fk_books_category_id_book_categories", type_="foreignkey")
        batch_op.drop_index("ix_books_category_id")
        batch_op.drop_column("category_id")
    op.drop_index("ix_book_categories_user_id", table_name="book_categories")
    op.drop_table("book_categories")
