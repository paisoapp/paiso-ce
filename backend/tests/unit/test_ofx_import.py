"""Importing an OFX or QFX file into a chosen account, through the routes."""
import json
from datetime import date
from decimal import Decimal
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import app.models  # noqa: F401
from app.api import imports as imports_api
from app.core.database import Base, get_db
from app.models.account import Account
from app.models.transaction import Transaction
from app.models.user import User

from tests.unit.session_tokens import app_headers
pytestmark = pytest.mark.unit

FIXTURES = Path(__file__).parents[1] / "aggregator" / "fixtures"
CHECKING = "synthetic_checking_sgml.qfx"
CARD = "synthetic_card_sgml.qfx"
BROKERAGE = "synthetic_brokerage_sgml.ofx"
TWO = "synthetic_two_accounts_xml.ofx"


@pytest.fixture
async def maker(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'ofx.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


@pytest.fixture
async def world(maker):
    """A user with one account of each kind. Returns ids by name."""
    async with maker() as s:
        user = User(email="ofx@example.com", hashed_password="x", token_family="fam")
        s.add(user)
        await s.flush()
        accounts = {
            "checking": Account(user_id=user.id, account_type="checking", display_name="Checking"),
            "savings": Account(user_id=user.id, account_type="savings", display_name="Savings"),
            "card": Account(user_id=user.id, account_type="credit_card", display_name="Card"),
            "brokerage": Account(user_id=user.id, account_type="brokerage", display_name="Brokerage"),
        }
        s.add_all(accounts.values())
        await s.commit()
        return {"user": user.id, **{k: a.id for k, a in accounts.items()}}


@pytest.fixture
async def client(maker, world):
    app = FastAPI()
    app.include_router(imports_api.router)

    async def _db():
        async with maker() as s:
            yield s

    app.dependency_overrides[get_db] = _db
    headers = await app_headers(maker, world['user'], 'fam')
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://app.test", headers=headers
    ) as c:
        yield c


def _file(name: str) -> dict:
    return {"file": (name, (FIXTURES / name).read_bytes(), "application/octet-stream")}


async def _preview(client, name, account_id):
    return await client.post("/api/imports/ofx/preview", files=_file(name),
                             data={"account_id": str(account_id)})


async def _import(client, name, account_id, **extra):
    return await client.post("/api/imports/ofx", files=_file(name),
                             data={"account_id": str(account_id), **{k: str(v) for k, v in extra.items()}})


async def _transactions(maker, account_id) -> list[Transaction]:
    async with maker() as s:
        return list((await s.scalars(
            select(Transaction).where(Transaction.account_id == account_id)
            .order_by(Transaction.date_posted, Transaction.id)
        )).all())


async def _account(maker, account_id) -> Account:
    async with maker() as s:
        return await s.get(Account, account_id)


# ── Preview ──────────────────────────────────────────────────────────────────

async def test_preview_says_what_would_happen_and_writes_nothing(client, maker, world):
    r = await _preview(client, CHECKING, world["checking"])
    assert r.status_code == 200, r.text
    body = r.json()
    (stmt,) = body["statements"]
    assert body["suggested_index"] == 0
    assert stmt["kind"] == "bank" and stmt["account_type"] == "CHECKING"
    assert stmt["account_last4"] == "2333"
    assert (stmt["transaction_count"], stmt["new_count"], stmt["already_imported"]) == (7, 7, 0)
    assert (stmt["date_from"], stmt["date_to"]) == ("2026-09-02", "2026-09-30")
    assert stmt["balance"] == 4310.81 and stmt["balance_as_of"] == "2026-09-30"
    assert stmt["fits_account"] is True
    assert len(stmt["sample"]) == 5 and stmt["sample"][0]["date"] == "2026-09-30"
    # The full account number never leaves the server.
    assert "000111222333" not in json.dumps(body)

    assert await _transactions(maker, world["checking"]) == []
    assert (await _account(maker, world["checking"])).current_balance is None


async def test_preview_flags_a_statement_that_does_not_fit_the_account(client, world):
    (stmt,) = (await _preview(client, CARD, world["checking"])).json()["statements"]
    assert stmt["kind"] == "card" and stmt["fits_account"] is False
    (stmt,) = (await _preview(client, CARD, world["card"])).json()["statements"]
    assert stmt["fits_account"] is True
    # Owed money is a positive balance on a card account here.
    assert stmt["balance"] == 946.04
    assert stmt["unreadable"] == 1


async def test_a_card_sent_as_a_bank_statement_fits_a_card_account(client, maker, world):
    name = "synthetic_card_as_creditline.ofx"
    (stmt,) = (await _preview(client, name, world["card"])).json()["statements"]
    assert stmt["kind"] == "card" and stmt["fits_account"] is True
    assert stmt["balance"] == 312.45  # owed, as a positive amount
    # And it does not fit a checking account.
    (stmt,) = (await _preview(client, name, world["checking"])).json()["statements"]
    assert stmt["fits_account"] is False

    assert (await _import(client, name, world["card"])).json()["imported"] == 3
    assert float((await _account(maker, world["card"])).current_balance) == 312.45


async def test_preview_of_a_brokerage_file_reports_what_is_not_imported(client, world):
    (stmt,) = (await _preview(client, BROKERAGE, world["brokerage"])).json()["statements"]
    assert stmt["kind"] == "investment" and stmt["fits_account"] is True
    assert (stmt["trade_count"], stmt["position_count"], stmt["income_count"]) == (2, 2, 2)


async def test_preview_of_a_two_account_file_suggests_the_one_that_is_new(client, world):
    await _import(client, TWO, world["checking"], statement_index=0)
    body = (await _preview(client, TWO, world["checking"])).json()
    checking, savings = body["statements"]
    assert (checking["new_count"], checking["already_imported"]) == (0, 3)
    assert savings["new_count"] == 2
    assert body["suggested_index"] == 1


# ── Import ───────────────────────────────────────────────────────────────────

async def test_import_lands_in_the_chosen_account(client, maker, world):
    r = await _import(client, CHECKING, world["checking"])
    assert r.status_code == 200, r.text
    assert r.json() == {"imported": 7, "skipped": 0, "unreadable": 0, "income_recorded": 0,
                        "balance_updated": True, "holdings_created": 0, "holdings_updated": 0,
                        "holdings_kept": 0}

    rows = await _transactions(maker, world["checking"])
    assert len(rows) == 7
    rent = next(t for t in rows if t.external_id == "SYN2026090300002")
    assert rent.description == "RENT & UTILITIES LLC"
    assert float(rent.amount) == -1250.0 and rent.date_posted == date(2026, 9, 3)
    assert rent.transaction_type == "debit"
    payroll = next(t for t in rows if t.external_id == "SYN2026091500003")
    assert payroll.transaction_type == "credit"

    acct = await _account(maker, world["checking"])
    assert float(acct.current_balance) == 4310.81 and acct.balance_as_of == date(2026, 9, 30)
    # Nothing was created on the side, and no other account was touched.
    async with maker() as s:
        assert len((await s.scalars(select(Account))).all()) == 4
    assert await _transactions(maker, world["savings"]) == []


async def test_importing_the_same_file_twice_adds_nothing(client, maker, world):
    await _import(client, CHECKING, world["checking"])
    r = await _import(client, CHECKING, world["checking"])
    assert r.json()["imported"] == 0 and r.json()["skipped"] == 7
    assert len(await _transactions(maker, world["checking"])) == 7


async def test_a_card_statement_stores_what_is_owed_as_positive(client, maker, world):
    r = await _import(client, CARD, world["card"])
    assert (r.json()["imported"], r.json()["unreadable"]) == (4, 1)
    assert float((await _account(maker, world["card"])).current_balance) == 946.04
    # A charge is still an outflow.
    rows = await _transactions(maker, world["card"])
    assert sorted(float(t.amount) for t in rows) == [-412.30, -23.75, -9.99, 500.00]


async def test_a_row_without_an_id_is_not_doubled_on_a_second_import(client, maker, world):
    await _import(client, CARD, world["card"])
    await _import(client, CARD, world["card"])
    rows = await _transactions(maker, world["card"])
    assert sum(1 for t in rows if t.description == "STREAMING SERVICE") == 1


async def test_each_statement_of_a_two_account_file_goes_where_it_is_sent(client, maker, world):
    assert (await _import(client, TWO, world["checking"], statement_index=0)).json()["imported"] == 3
    assert (await _import(client, TWO, world["savings"], statement_index=1)).json()["imported"] == 2
    assert {t.external_id for t in await _transactions(maker, world["savings"])} == {"X-SAV-1", "X-SAV-2"}
    assert float((await _account(maker, world["savings"])).current_balance) == 12507.15

    r = await _import(client, TWO, world["checking"], statement_index=5)
    assert r.status_code == 400


async def test_an_older_statement_does_not_overwrite_a_newer_balance(client, maker, world):
    async with maker() as s:
        acct = await s.get(Account, world["checking"])
        acct.current_balance, acct.balance_as_of = 9999.0, date(2026, 10, 15)
        await s.commit()
    r = await _import(client, CHECKING, world["checking"])
    assert r.json()["balance_updated"] is False
    assert float((await _account(maker, world["checking"])).current_balance) == 9999.0


async def _holdings(maker, account_id):
    from app.models.holding import Holding
    from app.models.security import Security

    async with maker() as s:
        rows = (await s.execute(
            select(Security.ticker, Security.cusip, Security.name, Holding.shares)
            .join(Holding, Holding.security_id == Security.id)
            .where(Holding.account_id == account_id)
            .order_by(Security.cusip)
        )).all()
    return [(t, c, n, float(sh)) for t, c, n, sh in rows]


async def test_a_brokerage_file_brings_its_positions_and_only_its_cash(client, maker, world):
    """The positions become holdings; only the transfer in is cash. Buys,
    sales and income used to land in the ledger as spending and income."""
    r = await _import(client, "synthetic_brokerage_seclist.ofx", world["brokerage"])
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["imported"], body["holdings_created"], body["holdings_updated"]) == (1, 3, 0)
    assert [t.description for t in await _transactions(maker, world["brokerage"])] == [
        "ELECTRONIC FUNDS TRANSFER"
    ]
    assert await _holdings(maker, world["brokerage"]) == [
        ("VTSAX", "922908728", "SYNTHETIC TOTAL STOCK MARKET INDEX FUND", 245.096),
        ("VTI", "922908769", "SYNTHETIC TOTAL STOCK MARKET ETF", 110.0),
        (None, "99999TRST", "SYNTHETIC TARGET RETIREMENT 2050 TRUST", 400.0),
    ]


async def test_a_fund_with_no_ticker_is_priced_from_the_statement(client, maker, world):
    from app.models.security import PriceHistory, Security

    await _import(client, "synthetic_brokerage_seclist.ofx", world["brokerage"])
    async with maker() as s:
        row = (await s.execute(
            select(PriceHistory.as_of, PriceHistory.close)
            .join(Security, Security.id == PriceHistory.security_id)
            .where(Security.cusip == "99999TRST")
        )).one()
    assert (row.as_of.isoformat(), float(row.close)) == ("2026-09-30", 25.75)


async def test_importing_again_updates_rather_than_duplicates(client, maker, world):
    await _import(client, "synthetic_brokerage_seclist.ofx", world["brokerage"])
    again = (await _import(client, "synthetic_brokerage_seclist.ofx", world["brokerage"])).json()
    assert (again["imported"], again["holdings_created"], again["holdings_updated"]) == (0, 0, 0)
    assert len(await _holdings(maker, world["brokerage"])) == 3


async def test_a_holding_kept_by_trades_is_left_alone_and_gets_its_dividend(client, maker, world):
    """The user records VTI by trades: the statement does not overwrite the
    shares, and the dividend (keyed on the CUSIP) lands on it as income."""
    from app.models.holding import Holding
    from app.models.security import Security
    from app.models.trade import Trade

    async with maker() as s:
        vti = Security(ticker="VTI", name="VTI", type="etf")
        s.add(vti)
        await s.flush()
        h = Holding(account_id=world["brokerage"], security_id=vti.id, shares=Decimal("100"))
        s.add(h)
        await s.flush()
        s.add(Trade(holding_id=h.id, trade_date=date(2026, 1, 5), action="buy",
                    shares=Decimal("100"), price_per_share=Decimal("250")))
        await s.commit()

    body = (await _import(client, "synthetic_brokerage_seclist.ofx", world["brokerage"])).json()
    assert (body["holdings_kept"], body["holdings_created"], body["income_recorded"]) == (1, 2, 1)
    async with maker() as s:
        vti_row = await s.scalar(select(Holding).join(Security).where(Security.ticker == "VTI"))
        assert float(vti_row.shares) == 100  # not the statement's 110
        actions = (await s.scalars(select(Trade.action).where(Trade.holding_id == vti_row.id))).all()
    assert sorted(actions) == ["buy", "dividend"]


async def test_positions_need_an_investment_account(client, maker, world):
    body = (await _import(client, "synthetic_brokerage_seclist.ofx", world["checking"])).json()
    assert body["holdings_created"] == 0
    assert await _holdings(maker, world["checking"]) == []


async def test_the_preview_offers_a_statement_of_positions(client, world):
    preview = (await _preview(client, "synthetic_brokerage_seclist.ofx", world["brokerage"])).json()
    (stmt,) = preview["statements"]
    assert (stmt["transaction_count"], stmt["position_count"]) == (1, 3)
    assert preview["suggested_index"] == 0


async def _vtsax(maker, account_id, *, by_trades: bool) -> int:
    from app.models.holding import Holding
    from app.models.security import Security
    from app.models.trade import Trade

    async with maker() as s:
        sec = Security(ticker="VTSAX", name="VTSAX", type="mutual_fund")
        s.add(sec)
        await s.flush()
        h = Holding(account_id=account_id, security_id=sec.id, shares=Decimal("245"),
                    cost_basis_total=Decimal("25000"))
        s.add(h)
        await s.flush()
        if by_trades:
            s.add(Trade(holding_id=h.id, trade_date=date(2026, 1, 5), action="buy",
                        shares=Decimal("245"), price_per_share=Decimal("102.04")))
        await s.commit()
        return h.id


async def test_a_reinvestment_never_replaces_a_share_count(client, maker, world):
    """The file has one reinvestment and nothing else. On a holding kept by
    its share count it changes nothing; it used to leave 0.096 shares."""
    from app.models.holding import Holding

    hid = await _vtsax(maker, world["brokerage"], by_trades=False)
    preview = (await _preview(client, "synthetic_reinvest_only.ofx", world["brokerage"])).json()
    (stmt,) = preview["statements"]
    assert (stmt["income_count"], stmt["income_new"], preview["suggested_index"]) == (1, 0, None)

    body = (await _import(client, "synthetic_reinvest_only.ofx", world["brokerage"])).json()
    assert (body["imported"], body["income_recorded"]) == (0, 0)
    async with maker() as s:
        h = await s.get(Holding, hid)
        assert (float(h.shares), float(h.cost_basis_total)) == (245, 25000)


async def test_a_reinvestment_on_a_holding_kept_by_trades_is_offered_and_recorded(client, maker, world):
    from app.models.holding import Holding

    hid = await _vtsax(maker, world["brokerage"], by_trades=True)
    preview = (await _preview(client, "synthetic_reinvest_only.ofx", world["brokerage"])).json()
    assert (preview["statements"][0]["income_new"], preview["suggested_index"]) == (1, 0)

    body = (await _import(client, "synthetic_reinvest_only.ofx", world["brokerage"])).json()
    assert body["income_recorded"] == 1
    async with maker() as s:
        h = await s.get(Holding, hid)
        assert float(h.shares) == pytest.approx(245.096)
    again = (await _preview(client, "synthetic_reinvest_only.ofx", world["brokerage"])).json()
    assert again["statements"][0]["income_new"] == 0


# ── Refusals ─────────────────────────────────────────────────────────────────

async def test_a_file_that_is_not_ofx_is_named_as_such(client, world):
    r = await _import(client, "synthetic_not_ofx.qfx", world["checking"])
    assert r.status_code == 422 and "not an OFX or QFX file" in r.json()["detail"]
    r = await _preview(client, "synthetic_not_ofx.qfx", world["checking"])
    assert r.status_code == 422


async def test_an_empty_or_oversized_file_is_refused(client, world, monkeypatch):
    r = await client.post("/api/imports/ofx", data={"account_id": str(world["checking"])},
                          files={"file": ("empty.qfx", b"", "application/octet-stream")})
    assert r.status_code == 400
    monkeypatch.setattr(imports_api, "STATEMENT_MAX_BYTES", 100)
    r = await _import(client, CHECKING, world["checking"])
    assert r.status_code == 413


async def test_someone_elses_account_is_not_found(client, maker, world):
    async with maker() as s:
        other = User(email="other@example.com", hashed_password="x", token_family="f")
        s.add(other)
        await s.flush()
        theirs = Account(user_id=other.id, account_type="checking", display_name="Theirs")
        s.add(theirs)
        await s.commit()
        theirs_id = theirs.id
    assert (await _import(client, CHECKING, theirs_id)).status_code == 404
    assert (await _preview(client, CHECKING, theirs_id)).status_code == 404
    assert await _transactions(maker, theirs_id) == []



# ── Positions-only statements ─────────────────────────────────────

async def test_a_positions_only_statement_previews_and_imports(client, maker, world):
    """A brokerage snapshot with holdings and no cash rows used to be refused
    with "No transactions found" before the code that handles it could run."""
    r = await _preview(client, "synthetic_positions_only.ofx", world["brokerage"])
    assert r.status_code == 200, r.text
    (stmt,) = r.json()["statements"]
    assert stmt["position_count"] == 3 and r.json()["suggested_index"] == 0

    r = await _import(client, "synthetic_positions_only.ofx", world["brokerage"])
    assert r.status_code == 200, r.text
    assert (r.json()["imported"], r.json()["holdings_created"]) == (0, 3)
    assert await _transactions(maker, world["brokerage"]) == []
    assert len(await _holdings(maker, world["brokerage"])) == 3


async def test_a_statement_with_nothing_in_it_is_still_refused(client, world):
    import re

    src = (FIXTURES / "synthetic_positions_only.ofx").read_text()
    empty = re.sub(r"<INVPOSLIST>.*?</INVPOSLIST>", "", src, flags=re.S)
    r = await client.post("/api/imports/ofx/preview",
                          files={"file": ("e.ofx", empty.encode(), "application/octet-stream")},
                          data={"account_id": str(world["brokerage"])})
    assert r.status_code == 422
    assert r.json()["detail"] == "This file has no transactions or positions to import."
