"""The self-hosted edition's schema, in one revision.

Generated from the models in ``app/models`` on SQLite. A new install
starts here.

Revision ID: 0001
Revises:
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0001'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('institution',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('name', sa.String(length=255), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('security',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('ticker', sa.String(length=32), nullable=True),
    sa.Column('name', sa.String(length=255), nullable=False),
    sa.Column('type', sa.String(length=32), nullable=False),
    sa.Column('cusip', sa.String(length=16), nullable=True),
    sa.Column('isin', sa.String(length=16), nullable=True),
    sa.Column('custom_url', sa.String(length=512), nullable=True),
    sa.Column('expense_ratio', sa.Numeric(precision=6, scale=4), nullable=True),
    sa.Column('dividends_synced_at', sa.DateTime(), nullable=True),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('ticker')
    )
    with op.batch_alter_table('security', schema=None) as batch_op:
        batch_op.create_index('uq_security_cusip', ['cusip'], unique=True, sqlite_where=sa.text('cusip IS NOT NULL'))
        batch_op.create_index('uq_security_isin', ['isin'], unique=True, sqlite_where=sa.text('isin IS NOT NULL'))

    op.create_table('user',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('email', sa.String(length=255), nullable=False),
    sa.Column('hashed_password', sa.Text(), nullable=True),
    sa.Column('is_active', sa.Boolean(), nullable=False),
    sa.Column('role', sa.String(length=16), nullable=False),
    sa.Column('first_name', sa.String(length=128), nullable=True),
    sa.Column('last_name', sa.String(length=128), nullable=True),
    sa.Column('dob', sa.Date(), nullable=True),
    sa.Column('phone', sa.String(length=32), nullable=True),
    sa.Column('avatar', sa.Text(), nullable=True),
    sa.Column('totp_secret', sa.Text(), nullable=True),
    sa.Column('totp_enabled', sa.Boolean(), nullable=False),
    sa.Column('email_verified_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('failed_logins', sa.Integer(), nullable=False),
    sa.Column('locked_until', sa.DateTime(timezone=True), nullable=True),
    sa.Column('must_change_password', sa.Boolean(), nullable=False),
    sa.Column('mfa_required', sa.Boolean(), nullable=False),
    sa.Column('token_family', sa.String(length=64), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('email')
    )
    op.create_table('asset',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('category', sa.String(length=32), nullable=False),
    sa.Column('name', sa.String(length=255), nullable=False),
    sa.Column('ownership_pct', sa.Numeric(precision=5, scale=2), nullable=False),
    sa.Column('current_value', sa.Numeric(precision=18, scale=2), nullable=True),
    sa.Column('valuation_source', sa.String(length=64), nullable=True),
    sa.Column('valuation_external_id', sa.String(length=255), nullable=True),
    sa.Column('acquired_value', sa.Numeric(precision=18, scale=2), nullable=True),
    sa.Column('acquired_at', sa.Date(), nullable=True),
    sa.Column('metadata_json', sa.Text(), nullable=True),
    sa.ForeignKeyConstraint(['user_id'], ['user.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('budget',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('name', sa.String(length=60), server_default='My budget', nullable=False),
    sa.Column('is_active', sa.Boolean(), server_default=sa.text('1'), nullable=False),
    sa.Column('total_target', sa.Numeric(precision=12, scale=2), nullable=True),
    sa.Column('income_basis', sa.String(length=8), nullable=False),
    sa.Column('trailing_months', sa.Integer(), nullable=False),
    sa.Column('start_month', sa.Date(), nullable=False),
    sa.Column('rollover_default', sa.Boolean(), server_default=sa.text('0'), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['user.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('budget', schema=None) as batch_op:
        batch_op.create_index('idx_budget_user', ['user_id'], unique=False)
        batch_op.create_index('uq_budget_one_active', ['user_id'], unique=True, sqlite_where=sa.text('is_active'))

    op.create_table('category',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('name', sa.String(length=128), nullable=False),
    sa.Column('parent_id', sa.Integer(), nullable=True),
    sa.Column('is_income', sa.Boolean(), nullable=False),
    sa.Column('treatment', sa.String(length=16), nullable=True),
    sa.Column('color', sa.String(length=16), nullable=True),
    sa.Column('icon', sa.String(length=64), nullable=True),
    sa.Column('is_group', sa.Boolean(), server_default=sa.text('0'), nullable=False),
    sa.Column('position', sa.Integer(), server_default='0', nullable=False),
    sa.ForeignKeyConstraint(['parent_id'], ['category.id'], deferrable=True),
    sa.ForeignKeyConstraint(['user_id'], ['user.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('category', schema=None) as batch_op:
        batch_op.create_index('idx_category_is_income', ['user_id', 'is_income'], unique=False)
        batch_op.create_index('idx_category_user_id', ['user_id'], unique=False)

    op.create_table('intraday_price_history',
    sa.Column('security_id', sa.Integer(), nullable=False),
    sa.Column('ts', sa.DateTime(), nullable=False),
    sa.Column('interval', sa.String(length=8), nullable=False),
    sa.Column('close', sa.Numeric(precision=18, scale=6), nullable=True),
    sa.ForeignKeyConstraint(['security_id'], ['security.id'], ),
    sa.PrimaryKeyConstraint('security_id', 'ts', 'interval')
    )
    with op.batch_alter_table('intraday_price_history', schema=None) as batch_op:
        batch_op.create_index('idx_intraday_sec_interval_ts', ['security_id', 'interval', 'ts'], unique=False)

    op.create_table('net_worth_snapshot',
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('snapshot_date', sa.Date(), nullable=False),
    sa.Column('net_worth', sa.Numeric(precision=18, scale=2), nullable=False),
    sa.Column('total_assets', sa.Numeric(precision=18, scale=2), nullable=False),
    sa.Column('total_liabilities', sa.Numeric(precision=18, scale=2), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['user.id'], ),
    sa.PrimaryKeyConstraint('user_id', 'snapshot_date')
    )
    op.create_table('price_history',
    sa.Column('security_id', sa.Integer(), nullable=False),
    sa.Column('as_of', sa.Date(), nullable=False),
    sa.Column('close', sa.Numeric(precision=18, scale=6), nullable=True),
    sa.Column('open', sa.Numeric(precision=18, scale=6), nullable=True),
    sa.Column('high', sa.Numeric(precision=18, scale=6), nullable=True),
    sa.Column('low', sa.Numeric(precision=18, scale=6), nullable=True),
    sa.ForeignKeyConstraint(['security_id'], ['security.id'], ),
    sa.PrimaryKeyConstraint('security_id', 'as_of')
    )
    op.create_table('refresh_token',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('family', sa.String(length=64), nullable=False),
    sa.Column('token_hash', sa.String(length=64), nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('last_used_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('revoked_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('user_agent', sa.String(length=255), nullable=True),
    sa.ForeignKeyConstraint(['user_id'], ['user.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('family')
    )
    with op.batch_alter_table('refresh_token', schema=None) as batch_op:
        batch_op.create_index('idx_refresh_token_user', ['user_id'], unique=False)

    op.create_table('security_dividend',
    sa.Column('security_id', sa.Integer(), nullable=False),
    sa.Column('ex_date', sa.Date(), nullable=False),
    sa.Column('amount_per_share', sa.Numeric(precision=18, scale=6), nullable=False),
    sa.Column('price_hint', sa.Numeric(precision=18, scale=6), nullable=True),
    sa.ForeignKeyConstraint(['security_id'], ['security.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('security_id', 'ex_date')
    )
    op.create_table('security_info',
    sa.Column('security_id', sa.Integer(), nullable=False),
    sa.Column('updated_at', sa.DateTime(), nullable=False),
    sa.Column('sector', sa.String(length=64), nullable=True),
    sa.Column('industry', sa.String(length=128), nullable=True),
    sa.Column('market_cap', sa.Numeric(precision=20, scale=0), nullable=True),
    sa.Column('pe_ratio', sa.Numeric(precision=12, scale=4), nullable=True),
    sa.Column('dividend_yield', sa.Numeric(precision=10, scale=6), nullable=True),
    sa.Column('week52_high', sa.Numeric(precision=18, scale=6), nullable=True),
    sa.Column('week52_low', sa.Numeric(precision=18, scale=6), nullable=True),
    sa.Column('info_json', sa.Text(), nullable=True),
    sa.ForeignKeyConstraint(['security_id'], ['security.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('security_id')
    )
    op.create_table('user_backup_code',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('code_hash', sa.String(length=64), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('used_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['user_id'], ['user.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('user_backup_code', schema=None) as batch_op:
        batch_op.create_index('idx_backup_code_user', ['user_id'], unique=False)

    op.create_table('user_settings',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('theme', sa.String(length=16), nullable=True),
    sa.Column('theme_variant', sa.String(length=32), nullable=True),
    sa.Column('holdings_column_order', sa.Text(), nullable=True),
    sa.Column('ui_prefs', sa.Text(), nullable=True),
    sa.ForeignKeyConstraint(['user_id'], ['user.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('user_id')
    )
    op.create_table('account',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('institution_id', sa.Integer(), nullable=True),
    sa.Column('account_type', sa.String(length=32), nullable=False),
    sa.Column('display_name', sa.String(length=255), nullable=False),
    sa.Column('external_id', sa.String(length=255), nullable=True),
    sa.Column('currency', sa.String(length=8), nullable=False),
    sa.Column('current_balance', sa.Numeric(precision=18, scale=4), nullable=True),
    sa.Column('balance_as_of', sa.Date(), nullable=True),
    sa.Column('credit_limit', sa.Numeric(precision=18, scale=4), nullable=True),
    sa.Column('linked_asset_id', sa.Integer(), nullable=True),
    sa.Column('description_pattern', sa.String(length=512), nullable=True),
    sa.Column('investment_type', sa.String(length=16), nullable=True),
    sa.Column('subtype', sa.String(length=64), nullable=True),
    sa.Column('classification_set_by_user', sa.Boolean(), nullable=False),
    sa.Column('other_funds_value', sa.Numeric(precision=18, scale=4), nullable=True),
    sa.Column('other_funds_as_of', sa.Date(), nullable=True),
    sa.Column('other_funds_prev_value', sa.Numeric(precision=18, scale=4), nullable=True),
    sa.Column('contributions_total', sa.Numeric(precision=18, scale=4), nullable=True),
    sa.Column('hsa_coverage', sa.String(length=8), nullable=True),
    sa.Column('exclude_from_net_worth', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['institution_id'], ['institution.id'], ),
    sa.ForeignKeyConstraint(['linked_asset_id'], ['asset.id'], deferrable=True),
    sa.ForeignKeyConstraint(['user_id'], ['user.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('budget_line',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('budget_id', sa.Integer(), nullable=False),
    sa.Column('category_id', sa.Integer(), nullable=False),
    sa.Column('amount', sa.Numeric(precision=12, scale=2), nullable=False),
    sa.Column('bucket', sa.String(length=8), nullable=False),
    sa.Column('rollover_enabled', sa.Integer(), nullable=False),
    sa.Column('rollover_from', sa.Date(), nullable=True),
    sa.Column('hidden', sa.Boolean(), server_default=sa.text('0'), nullable=False),
    sa.Column('position', sa.Integer(), server_default='0', nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['budget_id'], ['budget.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['category_id'], ['category.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['user.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('budget_id', 'category_id', name='uq_budget_line_budget_category')
    )
    with op.batch_alter_table('budget_line', schema=None) as batch_op:
        batch_op.create_index('idx_budget_line_budget', ['budget_id'], unique=False)

    op.create_table('category_rule',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('pattern', sa.String(length=512), nullable=False),
    sa.Column('match_field', sa.String(length=16), nullable=False),
    sa.Column('category_id', sa.Integer(), nullable=False),
    sa.Column('priority', sa.Integer(), nullable=False),
    sa.Column('is_case_sensitive', sa.Boolean(), nullable=False),
    sa.ForeignKeyConstraint(['category_id'], ['category.id'], ),
    sa.ForeignKeyConstraint(['user_id'], ['user.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('category_rule', schema=None) as batch_op:
        batch_op.create_index('idx_category_rule_user_id', ['user_id'], unique=False)

    op.create_table('loan',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('asset_id', sa.Integer(), nullable=True),
    sa.Column('principal', sa.Numeric(precision=18, scale=2), nullable=False),
    sa.Column('rate_apr', sa.Numeric(precision=6, scale=4), nullable=False),
    sa.Column('term_months', sa.Integer(), nullable=False),
    sa.Column('origination', sa.Date(), nullable=False),
    sa.Column('extra_principal_monthly', sa.Numeric(precision=18, scale=2), nullable=False),
    sa.Column('insurance_monthly', sa.Numeric(precision=18, scale=2), nullable=False),
    sa.Column('property_tax_monthly', sa.Numeric(precision=18, scale=2), nullable=False),
    sa.Column('escrow_monthly', sa.Numeric(precision=18, scale=2), nullable=True),
    sa.Column('escrow_source', sa.String(length=8), nullable=True),
    sa.Column('extra_principal_source', sa.String(length=8), nullable=True),
    sa.Column('balance_override', sa.Numeric(precision=18, scale=2), nullable=True),
    sa.Column('balance_override_date', sa.Date(), nullable=True),
    sa.ForeignKeyConstraint(['asset_id'], ['asset.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('account_balance_snapshot',
    sa.Column('account_id', sa.Integer(), nullable=False),
    sa.Column('as_of', sa.Date(), nullable=False),
    sa.Column('balance', sa.Numeric(precision=18, scale=4), nullable=False),
    sa.ForeignKeyConstraint(['account_id'], ['account.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('account_id', 'as_of')
    )
    op.create_table('account_liability',
    sa.Column('account_id', sa.Integer(), nullable=False),
    sa.Column('kind', sa.String(length=16), nullable=True),
    sa.Column('apr_pct', sa.Numeric(precision=9, scale=5), nullable=True),
    sa.Column('apr_type', sa.String(length=16), nullable=True),
    sa.Column('aprs_json', sa.Text(), nullable=True),
    sa.Column('minimum_payment', sa.Numeric(precision=18, scale=4), nullable=True),
    sa.Column('next_payment_due_date', sa.Date(), nullable=True),
    sa.Column('next_monthly_payment', sa.Numeric(precision=18, scale=4), nullable=True),
    sa.Column('last_payment_amount', sa.Numeric(precision=18, scale=4), nullable=True),
    sa.Column('last_payment_date', sa.Date(), nullable=True),
    sa.Column('is_overdue', sa.Boolean(), nullable=True),
    sa.Column('past_due_amount', sa.Numeric(precision=18, scale=4), nullable=True),
    sa.Column('last_statement_balance', sa.Numeric(precision=18, scale=4), nullable=True),
    sa.Column('last_statement_date', sa.Date(), nullable=True),
    sa.Column('origination_date', sa.Date(), nullable=True),
    sa.Column('origination_principal', sa.Numeric(precision=18, scale=4), nullable=True),
    sa.Column('maturity_date', sa.Date(), nullable=True),
    sa.Column('expected_payoff_date', sa.Date(), nullable=True),
    sa.Column('term_months', sa.Integer(), nullable=True),
    sa.Column('loan_name', sa.String(length=255), nullable=True),
    sa.Column('escrow_balance', sa.Numeric(precision=18, scale=4), nullable=True),
    sa.Column('ytd_interest_paid', sa.Numeric(precision=18, scale=4), nullable=True),
    sa.Column('ytd_principal_paid', sa.Numeric(precision=18, scale=4), nullable=True),
    sa.Column('has_pmi', sa.Boolean(), nullable=True),
    sa.Column('has_prepayment_penalty', sa.Boolean(), nullable=True),
    sa.Column('property_address_json', sa.Text(), nullable=True),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['account_id'], ['account.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('account_id')
    )
    op.create_table('budget_line_amount',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('budget_line_id', sa.Integer(), nullable=False),
    sa.Column('month', sa.Date(), nullable=False),
    sa.Column('amount', sa.Numeric(precision=12, scale=2), nullable=False),
    sa.Column('scope', sa.String(length=8), server_default='onward', nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['budget_line_id'], ['budget_line.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['user.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('budget_line_id', 'month', 'scope', name='uq_budget_line_amount_line_month_scope')
    )
    with op.batch_alter_table('budget_line_amount', schema=None) as batch_op:
        batch_op.create_index('idx_budget_line_amount_line', ['budget_line_id'], unique=False)

    op.create_table('csv_mapping',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('account_id', sa.Integer(), nullable=False),
    sa.Column('mapping_json', sa.Text(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['account_id'], ['account.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('account_id')
    )
    op.create_table('holding',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('account_id', sa.Integer(), nullable=False),
    sa.Column('security_id', sa.Integer(), nullable=False),
    sa.Column('shares', sa.Numeric(precision=18, scale=6), nullable=True),
    sa.Column('cost_basis_total', sa.Numeric(precision=18, scale=4), nullable=True),
    sa.Column('acquired_at', sa.Date(), nullable=True),
    sa.Column('lot_method', sa.String(length=16), nullable=False),
    sa.Column('exclude_from_net_worth', sa.Boolean(), nullable=False),
    sa.Column('is_favorited', sa.Boolean(), nullable=False),
    sa.ForeignKeyConstraint(['account_id'], ['account.id'], ),
    sa.ForeignKeyConstraint(['security_id'], ['security.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('account_id', 'security_id', name='uq_holding_account_security')
    )
    with op.batch_alter_table('holding', schema=None) as batch_op:
        batch_op.create_index('idx_holding_account_id', ['account_id'], unique=False)
        batch_op.create_index('idx_holding_security_id', ['security_id'], unique=False)

    op.create_table('payment_schedule',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('loan_id', sa.Integer(), nullable=False),
    sa.Column('month_number', sa.Integer(), nullable=False),
    sa.Column('payment_date', sa.Date(), nullable=False),
    sa.Column('principal', sa.Numeric(precision=18, scale=4), nullable=False),
    sa.Column('interest', sa.Numeric(precision=18, scale=4), nullable=False),
    sa.Column('escrow', sa.Numeric(precision=18, scale=4), nullable=False),
    sa.Column('balance', sa.Numeric(precision=18, scale=4), nullable=False),
    sa.ForeignKeyConstraint(['loan_id'], ['loan.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('transaction',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('account_id', sa.Integer(), nullable=False),
    sa.Column('date_posted', sa.Date(), nullable=False),
    sa.Column('transaction_type', sa.String(length=16), nullable=True),
    sa.Column('description', sa.Text(), nullable=True),
    sa.Column('amount', sa.Numeric(precision=18, scale=4), nullable=False),
    sa.Column('balance', sa.Numeric(precision=18, scale=4), nullable=True),
    sa.Column('category_id', sa.Integer(), nullable=True),
    sa.Column('tags', sa.Text(), nullable=True),
    sa.Column('notes', sa.Text(), nullable=True),
    sa.Column('member_name', sa.String(length=128), nullable=True),
    sa.Column('source', sa.String(length=16), nullable=True),
    sa.Column('external_id', sa.String(length=255), nullable=True),
    sa.Column('is_duplicate', sa.Boolean(), server_default='0', nullable=False),
    sa.Column('is_split', sa.Boolean(), server_default='0', nullable=False),
    sa.Column('pending', sa.Boolean(), server_default='0', nullable=False),
    sa.Column('merchant_name', sa.String(length=255), nullable=True),
    sa.Column('date_authorized', sa.Date(), nullable=True),
    sa.Column('category_source', sa.String(length=8), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['account_id'], ['account.id'], ),
    sa.ForeignKeyConstraint(['category_id'], ['category.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('transaction', schema=None) as batch_op:
        batch_op.create_index('idx_txn_account_date', ['account_id', 'date_posted'], unique=False)
        batch_op.create_index('idx_txn_amount_date', ['account_id', 'date_posted', 'amount'], unique=False)
        batch_op.create_index('idx_txn_category', ['category_id'], unique=False)
        batch_op.create_index('idx_txn_pending', ['account_id', 'pending'], unique=False)
        batch_op.create_index('uq_txn_account_external', ['account_id', 'external_id'], unique=True, sqlite_where=sa.text('external_id IS NOT NULL'))

    op.create_table('trade',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('holding_id', sa.Integer(), nullable=False),
    sa.Column('trade_date', sa.Date(), nullable=False),
    sa.Column('action', sa.String(length=16), nullable=False),
    sa.Column('shares', sa.Numeric(precision=18, scale=6), nullable=False),
    sa.Column('price_per_share', sa.Numeric(precision=18, scale=6), nullable=True),
    sa.Column('amount', sa.Numeric(precision=18, scale=4), nullable=True),
    sa.Column('split_ratio', sa.Numeric(precision=12, scale=6), nullable=True),
    sa.Column('is_qualified', sa.Boolean(), nullable=True),
    sa.Column('external_id', sa.String(length=255), nullable=True),
    sa.Column('notes', sa.Text(), nullable=True),
    sa.ForeignKeyConstraint(['holding_id'], ['holding.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('trade', schema=None) as batch_op:
        batch_op.create_index('idx_trade_external_id', ['external_id'], unique=False)
        batch_op.create_index('uq_trade_holding_external', ['holding_id', 'external_id'], unique=True, sqlite_where=sa.text('external_id IS NOT NULL'))

    op.create_table('transaction_attachment',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('transaction_id', sa.Integer(), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('filename', sa.String(length=255), nullable=False),
    sa.Column('stored_name', sa.String(length=255), nullable=False),
    sa.Column('content_type', sa.String(length=128), nullable=True),
    sa.Column('size_bytes', sa.Integer(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['transaction_id'], ['transaction.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['user.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('transfer_link',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('outflow_txn_id', sa.Integer(), nullable=False),
    sa.Column('inflow_txn_id', sa.Integer(), nullable=False),
    sa.Column('amount', sa.Numeric(precision=18, scale=4), nullable=False),
    sa.Column('kind', sa.String(length=24), nullable=False),
    sa.Column('confidence', sa.Numeric(precision=4, scale=3), nullable=False),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('source', sa.String(length=8), nullable=False),
    sa.Column('matched_on', sa.String(length=64), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('confirmed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['inflow_txn_id'], ['transaction.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['outflow_txn_id'], ['transaction.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['user.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('outflow_txn_id', 'inflow_txn_id', name='uq_transfer_pair')
    )
    with op.batch_alter_table('transfer_link', schema=None) as batch_op:
        batch_op.create_index('idx_transfer_user_status', ['user_id', 'status'], unique=False)
        batch_op.create_index('uq_transfer_inflow', ['inflow_txn_id'], unique=True, sqlite_where=sa.text("status <> 'rejected'"))
        batch_op.create_index('uq_transfer_outflow', ['outflow_txn_id'], unique=True, sqlite_where=sa.text("status <> 'rejected'"))



def downgrade() -> None:
    with op.batch_alter_table('transfer_link', schema=None) as batch_op:
        batch_op.drop_index('uq_transfer_outflow', sqlite_where=sa.text("status <> 'rejected'"))
        batch_op.drop_index('uq_transfer_inflow', sqlite_where=sa.text("status <> 'rejected'"))
        batch_op.drop_index('idx_transfer_user_status')

    op.drop_table('transfer_link')
    op.drop_table('transaction_attachment')
    with op.batch_alter_table('trade', schema=None) as batch_op:
        batch_op.drop_index('uq_trade_holding_external', sqlite_where=sa.text('external_id IS NOT NULL'))
        batch_op.drop_index('idx_trade_external_id')

    op.drop_table('trade')
    with op.batch_alter_table('transaction', schema=None) as batch_op:
        batch_op.drop_index('uq_txn_account_external', sqlite_where=sa.text('external_id IS NOT NULL'))
        batch_op.drop_index('idx_txn_pending')
        batch_op.drop_index('idx_txn_category')
        batch_op.drop_index('idx_txn_amount_date')
        batch_op.drop_index('idx_txn_account_date')

    op.drop_table('transaction')
    op.drop_table('payment_schedule')
    with op.batch_alter_table('holding', schema=None) as batch_op:
        batch_op.drop_index('idx_holding_security_id')
        batch_op.drop_index('idx_holding_account_id')

    op.drop_table('holding')
    op.drop_table('csv_mapping')
    with op.batch_alter_table('budget_line_amount', schema=None) as batch_op:
        batch_op.drop_index('idx_budget_line_amount_line')

    op.drop_table('budget_line_amount')
    op.drop_table('account_liability')
    op.drop_table('account_balance_snapshot')
    op.drop_table('loan')
    with op.batch_alter_table('category_rule', schema=None) as batch_op:
        batch_op.drop_index('idx_category_rule_user_id')

    op.drop_table('category_rule')
    with op.batch_alter_table('budget_line', schema=None) as batch_op:
        batch_op.drop_index('idx_budget_line_budget')

    op.drop_table('budget_line')
    op.drop_table('account')
    op.drop_table('user_settings')
    with op.batch_alter_table('user_backup_code', schema=None) as batch_op:
        batch_op.drop_index('idx_backup_code_user')

    op.drop_table('user_backup_code')
    op.drop_table('security_info')
    op.drop_table('security_dividend')
    with op.batch_alter_table('refresh_token', schema=None) as batch_op:
        batch_op.drop_index('idx_refresh_token_user')

    op.drop_table('refresh_token')
    op.drop_table('price_history')
    op.drop_table('net_worth_snapshot')
    with op.batch_alter_table('intraday_price_history', schema=None) as batch_op:
        batch_op.drop_index('idx_intraday_sec_interval_ts')

    op.drop_table('intraday_price_history')
    with op.batch_alter_table('category', schema=None) as batch_op:
        batch_op.drop_index('idx_category_user_id')
        batch_op.drop_index('idx_category_is_income')

    op.drop_table('category')
    with op.batch_alter_table('budget', schema=None) as batch_op:
        batch_op.drop_index('uq_budget_one_active', sqlite_where=sa.text('is_active'))
        batch_op.drop_index('idx_budget_user')

    op.drop_table('budget')
    op.drop_table('asset')
    op.drop_table('user')
    with op.batch_alter_table('security', schema=None) as batch_op:
        batch_op.drop_index('uq_security_isin', sqlite_where=sa.text('isin IS NOT NULL'))
        batch_op.drop_index('uq_security_cusip', sqlite_where=sa.text('cusip IS NOT NULL'))

    op.drop_table('security')
    op.drop_table('institution')
