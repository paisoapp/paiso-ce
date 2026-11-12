"""A symbol no quote source knows must not be re-asked on every page load.

Plan funds arrive under made-up tickers (``PLAN.TARGET.2050.FUND``). Each failed
lookup is three Yahoo round trips, and the failure used to be cached for 60 s
however many times it had already failed. No network anywhere: yfinance
and the cache are both replaced.
"""
import sys
import types

import pytest

from app.modules.investments import market_data

pytestmark = pytest.mark.unit

UNKNOWN = "PLAN.TARGET.2050.FUND"


class _Empty:
    empty = True


@pytest.fixture
def world(monkeypatch):
    """An in-memory cache, a clock, and a Yahoo that counts what it is asked."""
    store: dict[str, object] = {}
    clock = {"now": 1_000_000.0}
    calls: list[str] = []
    prices: dict[str, float] = {}

    monkeypatch.setattr(market_data, "cache_get", lambda k: store.get(k))
    monkeypatch.setattr(market_data, "cache_set", lambda k, v, ttl=None: store.__setitem__(k, v))
    monkeypatch.setattr(market_data, "cache_delete", lambda *ks: [store.pop(k, None) for k in ks])
    monkeypatch.setattr(market_data.time, "time", lambda: clock["now"])

    class Ticker:
        def __init__(self, symbol):
            calls.append(symbol)
            price = prices.get(symbol, 0.0)
            self.fast_info = types.SimpleNamespace(
                last_price=price, previous_close=price, currency="USD",
                day_high=None, day_low=None,
            )
            self.info = {"regularMarketChange": 0.0} if price else {}

        def history(self, **kwargs):
            return _Empty()

    monkeypatch.setitem(sys.modules, "yfinance", types.SimpleNamespace(Ticker=Ticker))

    def advance(seconds: float) -> None:
        """Move the clock, expiring the quote entry the way its TTL would."""
        clock["now"] += seconds
        store.pop(market_data._quote_key(UNKNOWN), None)

    return types.SimpleNamespace(calls=calls, prices=prices, advance=advance, store=store)


def test_the_delay_doubles_and_is_capped():
    assert [market_data._miss_delay(n) for n in (1, 2, 3, 4)] == [60, 120, 240, 480]
    assert market_data._miss_delay(50) == market_data.MISS_MAX_SECONDS


def test_an_unknown_symbol_is_not_refetched_inside_its_backoff(world):
    assert market_data.get_quote(UNKNOWN)["price"] == 0.0
    assert len(world.calls) == 1

    # The first failure waits 60 s, and after it fails again, 120 s.
    world.advance(61)
    market_data.get_quote(UNKNOWN)
    assert len(world.calls) == 2

    world.advance(61)
    quote = market_data.get_quote(UNKNOWN)
    assert len(world.calls) == 2, "still inside the second, longer wait"
    assert quote["price"] == 0.0 and quote["is_stale"] is True

    world.advance(61)
    market_data.get_quote(UNKNOWN)
    assert len(world.calls) == 3


def test_a_forced_refresh_does_not_bypass_the_backoff(world):
    """The per-minute refresh deletes the quote key to force a fetch; that is
    what kept asking Yahoo for these symbols all day."""
    market_data.get_quote(UNKNOWN)
    market_data.refresh_symbols([UNKNOWN])
    assert len(world.calls) == 1


def test_a_symbol_that_starts_pricing_clears_its_backoff(world):
    market_data.get_quote(UNKNOWN)
    world.advance(61)
    world.prices[UNKNOWN] = 42.0

    assert market_data.get_quote(UNKNOWN)["price"] == 42.0
    assert market_data._miss_key(UNKNOWN) not in world.store


def test_a_symbol_that_has_priced_before_still_retries_promptly(world):
    """A real ticker during a Yahoo outage keeps its last price and its 60 s
    retry; only never-priced symbols back off."""
    world.prices[UNKNOWN] = 42.0
    market_data.get_quote(UNKNOWN)
    world.prices[UNKNOWN] = 0.0

    for _ in range(4):
        world.advance(61)
        quote = market_data.get_quote(UNKNOWN)
        assert quote["price"] == 42.0 and quote["is_stale"] is True
    assert len(world.calls) == 5
