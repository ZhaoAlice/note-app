"""Add one-level note groups."""

from alembic import op
import sqlalchemy as sa


revision = "0002_note_groups"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "groups",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(50), nullable=False),
        sa.Column("normalized_name", sa.String(200), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("user_id", "normalized_name", name="uq_groups_user_normalized"),
    )
    op.create_index("ix_groups_user_id", "groups", ["user_id"])
    with op.batch_alter_table("notes") as batch_op:
        batch_op.add_column(sa.Column("group_id", sa.String(36), nullable=True))
        batch_op.create_foreign_key("fk_notes_group_id_groups", "groups", ["group_id"], ["id"], ondelete="SET NULL")
        batch_op.create_index("ix_notes_group_id", ["group_id"])


def downgrade() -> None:
    with op.batch_alter_table("notes") as batch_op:
        batch_op.drop_index("ix_notes_group_id")
        batch_op.drop_constraint("fk_notes_group_id_groups", type_="foreignkey")
        batch_op.drop_column("group_id")
    op.drop_index("ix_groups_user_id", table_name="groups")
    op.drop_table("groups")
