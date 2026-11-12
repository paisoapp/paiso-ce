"""Shared test setup."""
import pytest

from app.core import ratelimit


@pytest.fixture(autouse=True)
def _fresh_rate_limits():
    """Each test starts with no rate-limit counts. The limiter keeps them in
    this process, and a worker that runs many import tests in a row would
    otherwise hit the upload limit part-way through."""
    ratelimit._counts.clear()
    yield
    ratelimit._counts.clear()
