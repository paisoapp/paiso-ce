"""Ticker news must survive Yahoo retiring one of its two endpoints.

The stream behind ``Ticker.news`` began answering 404, which yfinance reports
as an empty list, and the drawer showed "No recent news" for every ticker. No
network here: yfinance is replaced by a stub.
"""
import sys
import types

from app.modules.investments import market_data


def _stub(monkeypatch, *, search, stream):
    class Search:
        def __init__(self, query, **kwargs):
            if isinstance(search, Exception):
                raise search
            self.news = search

    class Ticker:
        def __init__(self, symbol):
            self.news = stream

    monkeypatch.setitem(sys.modules, "yfinance", types.SimpleNamespace(Search=Search, Ticker=Ticker))


SEARCH_ITEM = {
    "title": "Apple reports", "publisher": "Wire", "link": "https://example.com/a",
    "providerPublishTime": 1_700_000_000,
}
STREAM_ITEM = {"content": {
    "title": "Apple, again", "provider": {"displayName": "Desk"},
    "pubDate": "2026-10-01T12:00:00Z", "canonicalUrl": {"url": "https://example.com/b"},
}}


def test_search_headlines_come_back_in_the_drawers_shape(monkeypatch):
    _stub(monkeypatch, search=[SEARCH_ITEM], stream=[])
    assert market_data.get_news("AAPL") == [{
        "title": "Apple reports", "publisher": "Wire", "url": "https://example.com/a",
        "published_at": "2023-11-14T22:13:20+00:00",
    }]


def test_count_is_honoured(monkeypatch):
    _stub(monkeypatch, search=[SEARCH_ITEM] * 9, stream=[])
    assert len(market_data.get_news("AAPL", 5)) == 5


def test_an_empty_search_falls_back_to_the_ticker_stream(monkeypatch):
    _stub(monkeypatch, search=[], stream=[STREAM_ITEM])
    assert market_data.get_news("AAPL") == [{
        "title": "Apple, again", "publisher": "Desk", "url": "https://example.com/b",
        "published_at": "2026-10-01T12:00:00Z",
    }]


def test_a_failing_search_falls_back_too(monkeypatch):
    _stub(monkeypatch, search=RuntimeError("404"), stream=[STREAM_ITEM])
    assert market_data.get_news("AAPL")[0]["title"] == "Apple, again"


def test_no_headlines_anywhere_is_an_empty_list(monkeypatch):
    _stub(monkeypatch, search=[], stream=[])
    assert market_data.get_news("AAPL") == []
