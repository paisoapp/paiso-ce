"""Add the Education, Rent and Childcare expense categories to existing accounts.

``seed_default_categories`` gives a new account all three. An account made before
they joined the defaults gets them here, under its Expense group, unless it
already has a category of that name.

Revision ID: 0002
Revises: 0001
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0002'
down_revision: Union[str, None] = '0001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Name and icon, matching category_emoji.emoji_for.
NEW_CATEGORIES = [("Education", "🎓"), ("Rent", "🏠"), ("Childcare", "🧸")]


def upgrade() -> None:
    conn = op.get_bind()
    groups = conn.execute(sa.text(
        "SELECT id, user_id FROM category"
        " WHERE parent_id IS NULL AND is_group = 1 AND lower(name) = 'expense'"
    )).all()
    for group_id, user_id in groups:
        position = conn.execute(sa.text(
            "SELECT coalesce(max(position), -1) + 1 FROM category WHERE parent_id = :g"
        ), {"g": group_id}).scalar()
        for name, icon in NEW_CATEGORIES:
            exists = conn.execute(sa.text(
                "SELECT 1 FROM category WHERE user_id = :u AND lower(name) = lower(:n)"
            ), {"u": user_id, "n": name}).first()
            if exists:
                continue
            conn.execute(sa.text(
                "INSERT INTO category"
                " (user_id, name, parent_id, is_income, treatment, color, icon, is_group, position)"
                " VALUES (:u, :n, :g, 0, 'expense', '#2563eb', :i, 0, :p)"
            ), {"u": user_id, "n": name, "g": group_id, "i": icon, "p": position})
            position += 1


def downgrade() -> None:
    # The categories may hold transactions by now; leave them in place.
    pass
