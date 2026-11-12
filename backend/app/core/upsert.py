"""INSERT ... ON CONFLICT support for SQLite.

``dialect_insert`` returns SQLite's ``insert`` construct, which carries the
on_conflict_do_nothing/do_update API.
"""
from sqlalchemy.dialects.sqlite import insert as _sqlite_insert


def dialect_insert(table):
    """Return an INSERT construct supporting on_conflict_*."""
    return _sqlite_insert(table)
