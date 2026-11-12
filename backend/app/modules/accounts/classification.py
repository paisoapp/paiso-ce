"""What an account *is*, beyond the coarse ``account_type``.

An investment account carries two facts the user chooses:

* **type** (``Account.investment_type``): what the money is for — Stocks &
  Funds, Retirement, Education or Health. It is the Investments tab the account
  lives on. Adding an account by hand starts here.
* **sub-type** (``Account.subtype``): its legal structure, spelled as the
  industry-standard account schema spells it (``403B``, ``roth 401k``). It
  decides the **tax treatment**:
  taxable, pre-tax or tax-free.

A few sub-types are offered under more than one type (a brokerage account or a
UTMA saved for college is Education), which is what used to need a relabel.

US only for now. Non-US subtypes (RRSP, TFSA, ISA …) are recognised and given a
type, but their tax treatment is ``None``, which the tax engine reads as "not
modelled" and leaves alone.

``account_type`` itself is unchanged and still drives net worth and transfers
(:func:`investment_account_type` sets it from the sub-type).
"""
from typing import NamedTuple

#: Investment types, in tab order. ``investing`` is the Stocks & Funds tab and
#: holds crypto too.
PURPOSES = ("investing", "retirement", "education", "health")
PURPOSE_LABELS = {
    "investing": "Stocks & Funds",
    "retirement": "Retirement",
    "education": "Education",
    "health": "Health",
}

TAX_TREATMENTS = ("taxable", "tax_deferred", "tax_free")
TAX_TREATMENT_LABELS = {
    "taxable": "Taxable",
    "tax_deferred": "Pre-tax",
    "tax_free": "Tax-free",
}


class Subtype(NamedTuple):
    #: The schema's spelling, preserved exactly (``403B``, not ``403b``).
    value: str
    label: str
    purpose: str
    #: None = not modelled (non-US, or a structure with no single answer).
    tax_treatment: str | None
    #: Recognised for grouping, but no US tax logic applies.
    us: bool = True


# Every investment account subtype in the common account schema. The
# grouping by purpose is ours.
_INVESTMENT: tuple[Subtype, ...] = (
    # Retirement: US, pre-tax
    Subtype("401a", "401(a)", "retirement", "tax_deferred"),
    Subtype("401k", "401(k)", "retirement", "tax_deferred"),
    Subtype("403B", "403(b)", "retirement", "tax_deferred"),
    Subtype("457b", "457(b)", "retirement", "tax_deferred"),
    Subtype("ira", "Traditional IRA", "retirement", "tax_deferred"),
    Subtype("keogh", "Keogh plan", "retirement", "tax_deferred"),
    Subtype("pension", "Pension", "retirement", "tax_deferred"),
    Subtype("profit sharing plan", "Profit-sharing plan", "retirement", "tax_deferred"),
    Subtype("retirement", "Retirement account", "retirement", "tax_deferred"),
    Subtype("sarsep", "SARSEP", "retirement", "tax_deferred"),
    Subtype("sep ira", "SEP IRA", "retirement", "tax_deferred"),
    Subtype("simple ira", "SIMPLE IRA", "retirement", "tax_deferred"),
    Subtype("thrift savings plan", "Thrift Savings Plan", "retirement", "tax_deferred"),
    # Retirement: US, Roth
    Subtype("roth", "Roth IRA", "retirement", "tax_free"),
    Subtype("roth 401k", "Roth 401(k)", "retirement", "tax_free"),
    Subtype("roth 403B", "Roth 403(b)", "retirement", "tax_free"),
    Subtype("roth 457b", "Roth 457(b)", "retirement", "tax_free"),
    Subtype("roth pension", "Roth pension", "retirement", "tax_free"),
    Subtype("roth profit sharing plan", "Roth profit-sharing plan", "retirement", "tax_free"),
    Subtype("roth thrift savings plan", "Roth Thrift Savings Plan", "retirement", "tax_free"),
    # Education
    Subtype("529", "529 plan", "education", "tax_free"),
    Subtype("education savings account", "Coverdell ESA", "education", "tax_free"),
    # Health
    Subtype("hsa", "HSA", "health", "tax_free"),
    Subtype("health reimbursement arrangement", "HRA", "health", "tax_free"),
    # Brokerage, funds, employee stock plans
    Subtype("brokerage", "Brokerage", "investing", "taxable"),
    Subtype("mutual fund", "Mutual fund account", "investing", "taxable"),
    Subtype("stock plan", "Employee stock plan", "investing", "taxable"),
    Subtype("non-taxable brokerage account", "Non-taxable brokerage", "investing", "tax_free"),
    # Trusts and custodial accounts: taxable, to the trust or the minor
    Subtype("trust", "Trust", "investing", "taxable"),
    Subtype("ugma", "UGMA custodial", "investing", "taxable"),
    Subtype("utma", "UTMA custodial", "investing", "taxable"),
    # Crypto
    Subtype("crypto exchange", "Crypto exchange", "investing", "taxable"),
    Subtype("non-custodial wallet", "Crypto wallet", "investing", "taxable"),
    # Insurance and annuities
    Subtype("fixed annuity", "Fixed annuity", "retirement", "tax_deferred"),
    Subtype("variable annuity", "Variable annuity", "retirement", "tax_deferred"),
    Subtype("other annuity", "Annuity", "retirement", "tax_deferred"),
    Subtype("life insurance", "Life insurance", "investing", "tax_deferred"),
    Subtype("other insurance", "Insurance", "investing", None),
    # Other
    Subtype("prediction market", "Prediction market", "investing", "taxable"),
    Subtype("line of credit", "Line of credit", "investing", None),
    Subtype("other", "Other investment", "investing", "taxable"),
    # Non-US: grouped, no tax logic
    Subtype("lif", "LIF", "retirement", None, us=False),
    Subtype("lira", "LIRA", "retirement", None, us=False),
    Subtype("lrif", "LRIF", "retirement", None, us=False),
    Subtype("lrsp", "LRSP", "retirement", None, us=False),
    Subtype("prif", "PRIF", "retirement", None, us=False),
    Subtype("rlif", "RLIF", "retirement", None, us=False),
    Subtype("rrif", "RRIF", "retirement", None, us=False),
    Subtype("rrsp", "RRSP", "retirement", None, us=False),
    Subtype("sipp", "SIPP", "retirement", None, us=False),
    Subtype("resp", "RESP", "education", None, us=False),
    Subtype("rdsp", "RDSP", "investing", None, us=False),
    Subtype("fhsa", "FHSA", "investing", None, us=False),
    Subtype("tfsa", "TFSA", "investing", None, us=False),
    Subtype("isa", "ISA", "investing", None, us=False),
    Subtype("cash isa", "Cash ISA", "investing", None, us=False),
    Subtype("gic", "GIC", "investing", None, us=False),
    Subtype("qshr", "QSHR", "investing", None, us=False),
)

#: Keyed case-insensitively: the schema's own spelling varies (``403B`` vs
#: ``roth 403B``), and older rows may have been lowercased.
INVESTMENT_SUBTYPES: dict[str, Subtype] = {s.value.lower(): s for s in _INVESTMENT}

#: What adding an account by hand offers under each type, in list order. A
#: sub-type may appear under more than one type; its tax treatment does not
#: change with the type.
MANUAL_SUBTYPES: dict[str, tuple[str, ...]] = {
    "investing": ("brokerage", "crypto exchange", "non-custodial wallet", "stock plan",
                  "trust", "ugma", "utma"),
    "retirement": ("401k", "roth 401k", "403B", "roth 403B", "457b", "ira", "roth",
                   "sep ira", "simple ira", "thrift savings plan", "pension",
                   "other annuity", "brokerage"),
    "education": ("529", "education savings account", "brokerage", "ugma", "utma"),
    "health": ("hsa",),
}

#: The subtype a manual account (or one synced before subtypes were kept)
#: implies from its coarse ``account_type`` alone.
DEFAULT_SUBTYPE_FOR_ACCOUNT_TYPE: dict[str, str] = {
    "brokerage": "brokerage",
    "401k": "401k",
    "ira": "ira",
    "roth_ira": "roth",
    "hsa": "hsa",
    "529": "529",
}


def lookup(subtype: str | None) -> Subtype | None:
    if not subtype:
        return None
    return INVESTMENT_SUBTYPES.get(subtype.strip().lower())


def effective_subtype(account) -> Subtype | None:
    """The account's subtype, falling back to what its account_type implies.

    Only investment-valued accounts have one. The schema reuses some spellings
    across types (``other``/``other``), and a checking account must not pick
    up an investment subtype's purpose or tax treatment.
    """
    from app.modules.portfolio.valuation import INVESTMENT_TYPES

    if account.account_type not in INVESTMENT_TYPES:
        return None
    known = lookup(getattr(account, "subtype", None))
    if known:
        return known
    return lookup(DEFAULT_SUBTYPE_FOR_ACCOUNT_TYPE.get(account.account_type))


def default_purpose(account) -> str | None:
    sub = effective_subtype(account)
    return sub.purpose if sub else None


def purpose(account) -> str | None:
    """The account's investment type: what the user chose, else what its
    sub-type implies. None = not an investment account (checking, a card …)."""
    from app.modules.portfolio.valuation import INVESTMENT_TYPES

    if account.account_type not in INVESTMENT_TYPES:
        return None
    chosen = getattr(account, "investment_type", None)
    if chosen in PURPOSES:
        return chosen
    return default_purpose(account) or "investing"


def tax_treatment(account) -> str | None:
    """Decided by the sub-type. None = not modelled (non-US, unknown)."""
    sub = effective_subtype(account)
    return sub.tax_treatment if sub else None


def subtype_label(account) -> str | None:
    sub = effective_subtype(account)
    if sub:
        return sub.label
    raw = getattr(account, "subtype", None)
    return raw or None


#: An investment sub-type → the coarse ``Account.account_type`` it is stored
#: under. Anything not listed is a brokerage account.
_ACCOUNT_TYPE_BY_SUBTYPE = {
    "401k": "401k",
    "roth 401k": "401k",
    "ira": "ira",
    "roth": "roth_ira",
    "roth ira": "roth_ira",
    "hsa": "hsa",
    "529": "529",
}


def investment_account_type(subtype: str | None) -> str:
    """The ``account_type`` for an investment account of this sub-type."""
    return _ACCOUNT_TYPE_BY_SUBTYPE.get((subtype or "").lower(), "brokerage")


def allowed_for_type(investment_type: str, subtype: str) -> bool:
    known = lookup(subtype)
    return bool(known) and known.value in MANUAL_SUBTYPES.get(investment_type, ())


def describe(account) -> dict:
    """The classification fields the API returns for one account."""
    p = purpose(account)
    t = tax_treatment(account)
    sub = effective_subtype(account)
    return {
        # What the account counts as, even when only its account_type says so
        # (a manual account made before subtypes were stored).
        "subtype": sub.value if sub else getattr(account, "subtype", None),
        "subtype_label": subtype_label(account),
        "investment_type": p,
        "investment_type_label": PURPOSE_LABELS.get(p) if p else None,
        "tax_treatment": t,
        "tax_treatment_label": TAX_TREATMENT_LABELS.get(t) if t else None,
        "classification_set_by_user": bool(getattr(account, "classification_set_by_user", False)),
        # Kept for clients that read the earlier names.
        "purpose": p,
        "purpose_label": PURPOSE_LABELS.get(p) if p else None,
    }
