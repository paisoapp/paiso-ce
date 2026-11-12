"""An account keeps its subtype, and its purpose and tax treatment follow it.

The ~60 investment subtypes of the common account schema used to be folded
into six account types, so a 403(b) became ``brokerage`` and was treated as
taxable. The subtype is now kept, and purpose and tax treatment come from it
unless the user relabels them.
"""
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import app.models  # noqa: F401
from app.api import accounts as accounts_api
from app.api.deps import get_current_user
from app.core.database import Base, get_db
from app.models.account import Account
from app.models.user import User
from app.modules.accounts import classification

pytestmark = pytest.mark.unit

#: Every investment subtype in the common account schema, spelled as the
#: schema spells them. A new one should be added here and mapped.
SCHEMA_INVESTMENT_SUBTYPES = [
    "401a", "401k", "403B", "457b", "ira", "keogh", "pension",
    "profit sharing plan", "retirement", "roth", "roth 401k", "roth 403B",
    "roth 457b", "roth pension", "roth profit sharing plan",
    "roth thrift savings plan", "sarsep", "sep ira", "simple ira",
    "thrift savings plan",
    "lif", "lira", "lrif", "lrsp", "prif", "rlif", "rrif", "rrsp", "sipp",
    "529", "education savings account", "resp",
    "health reimbursement arrangement", "hsa", "rdsp", "fhsa",
    "cash isa", "isa", "tfsa", "non-taxable brokerage account",
    "brokerage", "mutual fund", "stock plan",
    "crypto exchange", "non-custodial wallet",
    "fixed annuity", "life insurance", "other annuity", "other insurance",
    "variable annuity",
    "trust", "ugma", "utma",
    "gic", "line of credit", "other", "prediction market", "qshr",
]


def _acct(account_type, subtype=None, **kw):
    return SimpleNamespace(account_type=account_type, subtype=subtype,
                           investment_type=kw.get("investment_type"),
                           classification_set_by_user=kw.get("set_by_user", False))


def _with_subtype(subtype):
    return _acct(classification.investment_account_type(subtype), subtype)


@pytest.mark.parametrize("subtype", SCHEMA_INVESTMENT_SUBTYPES)
def test_every_schema_investment_subtype_is_classified(subtype):
    known = classification.lookup(subtype)
    assert known is not None, f"unmapped subtype {subtype!r}"
    assert known.value == subtype  # the exact spelling is preserved
    assert known.purpose in classification.PURPOSES
    assert known.tax_treatment in (*classification.TAX_TREATMENTS, None)
    if not known.us:
        assert known.tax_treatment is None


def test_the_table_has_no_subtype_the_schema_does_not_define():
    assert set(classification.INVESTMENT_SUBTYPES) == {
        s.lower() for s in SCHEMA_INVESTMENT_SUBTYPES
    }


@pytest.mark.parametrize("subtype", ["403B", "457b", "sep ira", "simple ira",
                                     "thrift savings plan", "pension"])
def test_employer_plans_folded_into_brokerage_are_not_taxable(subtype):
    acct = _with_subtype(subtype)
    assert acct.account_type == "brokerage"  # the coarse type is unchanged
    assert classification.purpose(acct) == "retirement"
    assert classification.tax_treatment(acct) == "tax_deferred"
    assert classification.tax_treatment(acct) != "taxable"


def test_a_roth_401k_keeps_its_roth_treatment():
    acct = _with_subtype("roth 401k")
    assert acct.account_type == "401k"
    assert classification.tax_treatment(acct) == "tax_free"
    assert classification.subtype_label(acct) == "Roth 401(k)"


def test_case_does_not_matter_but_spelling_is_kept():
    assert classification.tax_treatment(_with_subtype("ROTH 403B")) == "tax_free"


def test_a_manual_account_without_a_subtype_uses_its_type():
    assert classification.purpose(_acct("roth_ira")) == "retirement"
    assert classification.tax_treatment(_acct("roth_ira")) == "tax_free"
    assert classification.tax_treatment(_acct("brokerage")) == "taxable"
    assert classification.purpose(_acct("529")) == "education"
    assert classification.purpose(_acct("hsa")) == "health"


def test_a_non_investment_account_has_no_purpose_even_with_a_shared_spelling():
    # The schema uses "other" as a subtype of several types.
    for t in ("checking", "savings", "credit_card", "loan", "other"):
        acct = _acct(t, "other")
        assert classification.purpose(acct) is None
        assert classification.tax_treatment(acct) is None
        assert classification.tax_treatment(acct) != "taxable"


def test_non_us_accounts_are_grouped_but_get_no_us_tax_logic():
    acct = _with_subtype("tfsa")
    assert classification.purpose(acct) == "investing"
    assert classification.tax_treatment(acct) is None
    assert classification.tax_treatment(acct) != "taxable"


def test_the_chosen_type_wins_and_the_subtype_keeps_its_tax_treatment():
    """A brokerage account saved for college: Education, still taxable."""
    acct = _acct("brokerage", "brokerage", investment_type="education")
    assert classification.purpose(acct) == "education"
    assert classification.tax_treatment(acct) == "taxable"
    d = classification.describe(acct)
    assert d["investment_type"] == "education"
    assert d["subtype_label"] == "Brokerage"


def test_crypto_and_other_investments_are_stocks_and_funds():
    assert classification.purpose(_with_subtype("crypto exchange")) == "investing"
    assert classification.purpose(_with_subtype("life insurance")) == "investing"


def test_the_manual_lists_offer_a_few_subtypes_under_more_than_one_type():
    assert classification.allowed_for_type("education", "brokerage")
    assert classification.allowed_for_type("education", "utma")
    assert classification.allowed_for_type("retirement", "brokerage")
    assert not classification.allowed_for_type("education", "401k")
    for t, subs in classification.MANUAL_SUBTYPES.items():
        for sub in subs:
            assert classification.lookup(sub).us, (t, sub)


# ── API and the tax engine, against a real schema ───────────────────────────

@pytest.fixture
async def sessionmaker(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'cls.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


@pytest.fixture
async def user(sessionmaker):
    async with sessionmaker() as db:
        u = User(email="cls@example.com", hashed_password="x", token_family="f")
        db.add(u)
        await db.commit()
        return u


@pytest.fixture
async def client(sessionmaker, user):
    app = FastAPI()
    app.include_router(accounts_api.router)

    async def _db():
        async with sessionmaker() as s:
            yield s

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: user
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://app.test"
    ) as c:
        yield c


async def test_a_manual_403b_is_created_from_its_type_and_subtype(client):
    r = await client.post("/api/accounts", json={
        "display_name": "School 403(b)", "account_type": "brokerage",
        "investment_type": "retirement", "subtype": "403b", "current_balance": 1000,
    })
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["subtype"] == "403B"
    assert body["account_type"] == "brokerage"
    assert body["investment_type"] == "retirement"
    assert body["subtype_label"] == "403(b)"
    assert body["tax_treatment"] == "tax_deferred"


async def test_the_subtype_decides_the_coarse_account_type(client):
    r = await client.post("/api/accounts", json={
        "display_name": "Roth", "account_type": "brokerage",
        "investment_type": "retirement", "subtype": "roth",
    })
    assert r.json()["account_type"] == "roth_ira"


async def test_a_subtype_must_belong_to_its_type(client):
    for body in ({"investment_type": "retirement", "subtype": "piggy bank"},
                 {"investment_type": "education", "subtype": "401k"},
                 {"investment_type": "vacation", "subtype": "brokerage"},
                 {"investment_type": "retirement"}):
        r = await client.post("/api/accounts", json={
            "display_name": "x", "account_type": "brokerage", **body})
        assert r.status_code == 400, body


async def test_an_account_can_be_reclassified_and_the_choice_sticks(client, sessionmaker, user):
    async with sessionmaker() as db:
        a = Account(user_id=user.id, display_name="Retirement", account_type="brokerage",
                    subtype="retirement")
        db.add(a)
        await db.commit()
        acct_id = a.id
    r = await client.patch(f"/api/accounts/{acct_id}", json={
        "investment_type": "retirement", "subtype": "roth"})
    assert r.status_code == 200, r.text
    assert r.json()["tax_treatment"] == "tax_free"
    assert r.json()["account_type"] == "roth_ira"
    assert r.json()["classification_set_by_user"] is True


async def test_other_funds_keep_the_previous_value(client):
    acct = (await client.post("/api/accounts", json={
        "display_name": "529", "account_type": "529",
        "investment_type": "education", "subtype": "529"})).json()
    await client.patch(f"/api/accounts/{acct['id']}", json={"other_funds_value": 10000})
    r = await client.patch(f"/api/accounts/{acct['id']}", json={
        "other_funds_value": 10400, "contributions_total": 9000})
    body = r.json()
    assert body["other_funds_value"] == 10400
    assert body["other_funds_prev_value"] == 10000
    assert body["other_funds_as_of"] is not None
    assert body["contributions_total"] == 9000


async def test_the_form_lists_each_type_with_its_subtypes(client):
    body = (await client.get("/api/accounts/classification")).json()
    types = {t["value"]: t for t in body["types"]}
    assert list(types) == ["investing", "retirement", "education", "health"]
    assert types["investing"]["label"] == "Stocks & Funds"
    edu = [s["value"] for s in types["education"]["subtypes"]]
    assert edu == ["529", "education savings account", "brokerage", "ugma", "utma"]
    k403 = next(s for s in types["retirement"]["subtypes"] if s["value"] == "403B")
    assert k403["account_type"] == "brokerage" and k403["tax_treatment"] == "tax_deferred"
