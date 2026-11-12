"""Keep the bank's own category label on each imported transaction.

Revision ID: 0003
Revises: 0002
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0003'
down_revision: Union[str, None] = '0002'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('transaction', schema=None) as batch_op:
        batch_op.add_column(sa.Column('bank_category', sa.String(length=64), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('transaction', schema=None) as batch_op:
        batch_op.drop_column('bank_category')
