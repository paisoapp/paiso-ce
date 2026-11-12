"""OFX SGML/XML parser for 1.x and 2.x responses.

Two views of a file:

* ``parse_ofx_response`` flattens everything into one ``OFXResult``.
* ``parse_ofx_statements`` keeps each account's statement apart, which is what
  an import needs: a file can carry a checking and a savings account, and the
  person importing picks which one goes into which Paiso account.
"""
import hashlib
import html
import re
import xml.etree.ElementTree as ET

import defusedxml.ElementTree as safe_ET
from dataclasses import dataclass, field
from datetime import date, datetime, timezone

import structlog

from app.core.validation import finite_amount

log = structlog.get_logger()

# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------


@dataclass
class ParsedTransaction:
    fitid: str
    date_posted: date
    amount: float
    trntype: str
    name: str
    memo: str = ""
    member_name: str = ""  # card member name (e.g. from Citibank CC statements)
    #: The bank's own category label, from a CSV's Category column.
    bank_category: str = ""
    #: A buy, sale, reinvestment or income row of an investment statement:
    #: a change inside the account, not cash in or out of it. INVBANKTRAN
    #: rows (deposits, withdrawals, fees) are the account's cash and say False.
    investment: bool = False


@dataclass
class ParsedHolding:
    """One position of an investment statement (INVPOSLIST)."""
    #: The ticker, from the SECID when the file keys on tickers or from the
    #: file's SECLIST; empty when neither gives one.
    ticker: str
    units: float
    unit_price: float
    market_value: float
    #: The SECID as the file gives it: usually a CUSIP.
    uniqueid: str = ""
    uniqueid_type: str = ""
    #: The security's name, from the SECLIST.
    name: str = ""
    #: POSSTOCK, POSMF, POSDEBT or POSOTHER.
    kind: str = ""
    price_as_of: date | None = None


@dataclass
class ParsedBalance:
    amount: float
    as_of_date: date | None = None


@dataclass
class ParsedAccount:
    account_number: str
    account_type: str  # OFX type: CHECKING, SAVINGS, CREDITLINE, etc.
    routing_number: str = ""
    broker_id: str = ""


@dataclass
class ParsedInvIncome:
    """Structured INCOME/REINVEST investment transaction (dividends, interest,
    capital-gain distributions). The generic cash ParsedTransaction is still
    emitted for these FITIDs for backward compatibility — importers that map
    inv_income to holdings should skip the matching cash rows to avoid
    double-counting."""
    fitid: str
    date_posted: date
    uniqueid: str          # SECID UNIQUEID (ticker or CUSIP)
    income_type: str       # DIV | INTEREST | CGLONG | CGSHORT | MISC
    total: float           # cash amount (absolute value)
    is_reinvest: bool = False
    units: float = 0.0     # shares purchased (REINVEST only)
    unit_price: float = 0.0
    memo: str = ""
    ticker: str = ""       # from the SECLIST when uniqueid is a CUSIP


@dataclass
class OFXResult:
    accounts: list[ParsedAccount] = field(default_factory=list)
    transactions: list[ParsedTransaction] = field(default_factory=list)
    holdings: list[ParsedHolding] = field(default_factory=list)
    balances: list[ParsedBalance] = field(default_factory=list)
    inv_income: list[ParsedInvIncome] = field(default_factory=list)
    # Buys and sells seen in an investment statement. Their cash legs are in
    # `transactions`; nothing here turns them into trades.
    trade_count: int = 0
    # Rows the file listed that could not be read (no date, no amount).
    unreadable: int = 0


@dataclass
class OFXStatement:
    """One account's statement inside a file."""
    kind: str  # "bank" | "card" | "investment"
    account: ParsedAccount | None = None
    transactions: list[ParsedTransaction] = field(default_factory=list)
    # LEDGERBAL, as the file states it. For a card or a loan a negative
    # amount means money owed.
    ledger_balance: ParsedBalance | None = None
    holdings: list[ParsedHolding] = field(default_factory=list)
    inv_income: list[ParsedInvIncome] = field(default_factory=list)
    trade_count: int = 0
    unreadable: int = 0


# ---------------------------------------------------------------------------
# Leaf value helpers
# ---------------------------------------------------------------------------

def parse_ofx_amount(raw: str) -> float:
    """An OFX amount as a float.

    The spec allows either a point or a comma as the decimal mark, and some
    exports add thousands separators, so "1,234.56", "1.234,56", "-12,34" and
    "+5.00" all turn up. The last separator is the decimal mark when both
    appear; a lone comma is a decimal mark unless exactly three digits follow
    more than one group (e.g. "1,234,567").
    """
    t = raw.strip().replace(" ", "").replace("\u00a0", "")
    if not t:
        raise ValueError("empty amount")
    if "," in t and "." in t:
        if t.rfind(",") > t.rfind("."):
            t = t.replace(".", "").replace(",", ".")
        else:
            t = t.replace(",", "")
    elif t.count(",") > 1:
        t = t.replace(",", "")
    elif "," in t:
        t = t.replace(",", ".")
    return finite_amount(float(t))


def _number(raw: str | None) -> float:
    """A unit count, price or value from an investment statement: empty is
    zero, anything non-finite or absurd raises ValueError. The caller's
    except then skips that one position or income row, as for any bad cell."""
    return finite_amount(float(raw or "0"))


def _fallback_fitid(date_raw: str, amount_raw: str, name: str, position: int) -> str:
    """A stable id for a row whose file gave it none.

    FITID is required by the spec, and a few institutions leave it out anyway.
    Dropping those rows loses transactions without a word; hashing what the
    row says keeps a second import of the same file from doubling them.
    """
    digest = hashlib.sha1(
        f"{date_raw}|{amount_raw}|{name}|{position}".encode("utf-8", "replace"),
        usedforsecurity=False,  # a dedupe key, not a signature
    ).hexdigest()[:20]
    return f"nofitid-{digest}"


# ---------------------------------------------------------------------------
# OFX date parser
# ---------------------------------------------------------------------------

_OFX_DATE_RE = re.compile(
    r"(\d{4})(\d{2})(\d{2})"  # YYYYMMDD
    r"(?:(\d{2})(\d{2})(\d{2}))?"  # HHMMSS optional
    r"(?:\.\d+)?"  # fractional seconds optional
    r"(?:\[([+-]?\d+(?:\.\d+)?):([A-Z]+)\])?"  # timezone offset optional
)


def parse_ofx_date(raw: str) -> date:
    """Parse OFX date format into a Python date (UTC)."""
    raw = raw.strip()
    m = _OFX_DATE_RE.match(raw)
    if not m:
        log.warning("ofx_parser.bad_date", raw=raw)
        return datetime.now(timezone.utc).date()

    year, month, day = int(m.group(1)), int(m.group(2)), int(m.group(3))
    return date(year, month, day)


# ---------------------------------------------------------------------------
# SGML parser helpers
# ---------------------------------------------------------------------------

def _split_ofx_sgml(raw: str) -> tuple[dict[str, str], str]:
    """Split OFX SGML into headers dict and body string."""
    # Headers end at blank line
    lines = raw.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    headers: dict[str, str] = {}
    body_start = 0
    for i, line in enumerate(lines):
        if ":" in line and not line.strip().startswith("<"):
            k, _, v = line.partition(":")
            headers[k.strip()] = v.strip()
        elif line.strip() == "" and headers:
            body_start = i + 1
            break

    body = "\n".join(lines[body_start:]).strip()
    return headers, body


_CLOSE_RE = re.compile(r"</([^>]+)>")
_OPEN_RE = re.compile(r"<([^/>\s][^>]*)>")


def _sgml_to_dict(text: str) -> dict:
    """
    Parse OFX SGML body into a nested dict.

    OFX SGML uses two kinds of tags:
    - Aggregate (container) tags that have closing </TAG> pairs
    - Element (leaf) tags like <TAG>value that have NO closing tag

    Strategy: tokenize into (tag_open | tag_close | text) tokens.
    When we encounter an open tag followed immediately by text (no nested open tag),
    treat it as a leaf and store the value without pushing onto the stack.
    When we encounter a close tag, pop the matching aggregate off the stack.
    """
    tokens = re.split(r"(<[^>]+>)", text)

    # Build a flat list of clean tokens (drop empties)
    clean: list[str] = []
    for t in tokens:
        s = t.strip()
        if s:
            clean.append(s)

    stack: list[tuple[str, dict]] = [("__root__", {})]

    i = 0
    while i < len(clean):
        token = clean[i]

        # Closing tag — pop the aggregate it names
        cm = _CLOSE_RE.match(token)
        if cm:
            tag = cm.group(1).upper().split()[0]
            depth = next(
                (d for d in range(len(stack) - 1, 0, -1) if stack[d][0] == tag), None
            )
            # Not on the stack: it closes a leaf (<NAME>Shop</NAME>), which
            # many banks write even though SGML does not need it. Popping an
            # aggregate here used to close the transaction around the leaf
            # and scatter the rest of its fields.
            if depth is not None:
                # Anything still open above it was an empty leaf (<MEMO> with
                # no value) that got pushed as an aggregate. Its "children"
                # are really its siblings: hand them back to the parent.
                while len(stack) - 1 > depth:
                    name, obj = stack.pop()
                    parent = stack[-1][1]
                    _merge_into_parent(parent, name, "")
                    for k, v in obj.items():
                        for item in (v if isinstance(v, list) else [v]):
                            _merge_into_parent(parent, k, item)
                name, obj = stack.pop()
                _merge_into_parent(stack[-1][1], name, obj)
            i += 1
            continue

        # Opening tag
        om = _OPEN_RE.match(token)
        if om:
            tag = om.group(1).upper().split()[0]

            # Peek ahead: if next token is plain text (not a tag), it's a leaf
            if (i + 1) < len(clean) and not clean[i + 1].startswith("<"):
                # SGML escapes &, < and > in values (AT&amp;T).
                value = html.unescape(clean[i + 1])
                _merge_into_parent(stack[-1][1], tag, value)
                i += 2
                continue
            else:
                # Aggregate tag — push onto stack
                stack.append((tag, {}))
                i += 1
                continue

        # Bare text with no preceding open tag — unlikely in well-formed OFX, skip
        i += 1

    # Drain remaining stack entries (handles truncated/malformed OFX)
    while len(stack) > 1:
        name, obj = stack.pop()
        _merge_into_parent(stack[-1][1], name, obj)

    return stack[0][1]


def _merge_into_parent(parent: dict, tag: str, value) -> None:
    """Insert tag→value into parent, converting to list on duplicates."""
    if tag in parent:
        existing = parent[tag]
        if isinstance(existing, list):
            existing.append(value)
        else:
            parent[tag] = [existing, value]
    else:
        parent[tag] = value


def _get(d: dict, *keys: str) -> str | None:
    """Traverse nested dict and return string leaf value or None."""
    cur = d
    for k in keys:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(k.upper())
        if cur is None:
            return None
    if isinstance(cur, str):
        return cur
    if isinstance(cur, dict):
        # Should not happen for leaves, but handle gracefully
        return cur.get("_text")
    return None


# ---------------------------------------------------------------------------
# Transaction extractor
# ---------------------------------------------------------------------------

def _extract_transactions(
    stmttrn_list: list[dict], result: "OFXResult | None" = None
) -> list[ParsedTransaction]:
    results = []
    for position, txn in enumerate(stmttrn_list):
        try:
            date_raw = _get(txn, "DTPOSTED") or _get(txn, "DTUSER") or ""
            amount_raw = _get(txn, "TRNAMT") or ""
            trntype = _get(txn, "TRNTYPE") or "OTHER"
            # Some exports put the payee in a PAYEE aggregate, not NAME.
            name = (
                _get(txn, "NAME") or _get(txn, "PAYEE", "NAME") or _get(txn, "MEMO") or ""
            )
            memo = _get(txn, "MEMO") or ""

            # A row with no date or no amount is not a transaction anyone can
            # place. It used to be imported dated today, or as $0.
            if not _OFX_DATE_RE.match(date_raw.strip()) or not amount_raw.strip():
                if result is not None:
                    result.unreadable += 1
                continue

            fitid = _get(txn, "FITID") or _fallback_fitid(date_raw, amount_raw, name, position)
            results.append(ParsedTransaction(
                fitid=fitid,
                date_posted=parse_ofx_date(date_raw),
                amount=parse_ofx_amount(amount_raw),
                trntype=trntype,
                name=name,
                memo=memo,
            ))
        except Exception as exc:
            if result is not None:
                result.unreadable += 1
            log.warning("ofx_parser.txn_parse_error", error=str(exc))
    return results


# ---------------------------------------------------------------------------
# Main parse function
# ---------------------------------------------------------------------------

def decode_ofx(content: bytes) -> str:
    """File bytes to text. OFX 1.x names its code page in the header
    (CHARSET:1252 is the common one); 2.x is UTF-8 unless its XML declaration
    says otherwise."""
    if content.startswith(b"\xef\xbb\xbf"):
        content = content[3:]
    head = content[:400].decode("ascii", "replace").upper()
    m = re.search(r"CHARSET:\s*(\d+)", head)
    if m and m.group(1) != "0":
        try:
            return content.decode(f"cp{m.group(1)}")
        except (LookupError, UnicodeDecodeError):
            pass
    try:
        return content.decode("utf-8")
    except UnicodeDecodeError:
        return content.decode("cp1252", "replace")


def looks_like_ofx(content: bytes) -> bool:
    """Whether these bytes are an OFX or QFX file at all, so a renamed CSV or
    a PDF gets a plain answer and not "no transactions found"."""
    head = content[:2000].decode("ascii", "replace").upper()
    return "OFXHEADER" in head or "<OFX>" in head or "<?OFX" in head


def _ofx_tree(raw: str) -> dict:
    """The file as one nested dict, whichever syntax it was written in."""
    raw = raw.strip()
    if raw.startswith("<?OFX") or raw.startswith("<?xml"):
        body = re.sub(r"<\?(OFX|xml)[^?]*\?>", "", raw, flags=re.IGNORECASE).strip()
        # defusedxml: a statement is an untrusted file, so no entities or DTDs.
        d = {"OFX": _xml_to_dict(safe_ET.fromstring(body))}
    else:
        _headers, body = _split_ofx_sgml(raw)
        d = _sgml_to_dict(body)
    return d.get("OFX", d)  # top-level may be OFX


def _xml_to_dict(el: ET.Element) -> dict | str:
    """An XML element in the shape `_sgml_to_dict` produces, so one set of
    extractors reads both syntaxes."""
    children = list(el)
    if not children:
        return (el.text or "").strip()
    out: dict = {}
    for child in children:
        _merge_into_parent(out, child.tag.upper(), _xml_to_dict(child))
    return out


#: ACCTTYPE values in a bank statement that mean the account is a card.
_CARD_ACCOUNT_TYPES = frozenset({"CREDITLINE", "CREDITCARD"})


def parse_ofx_statements(raw: str) -> list[OFXStatement]:
    """Every account statement in the file, each with its own transactions.

    Returns an empty list for a file that cannot be read at all.
    """
    try:
        ofx = _ofx_tree(raw)
    except Exception as exc:
        log.warning("ofx_parser.parse_error", error=str(exc))
        return []
    if not isinstance(ofx, dict):
        return []

    statements: list[OFXStatement] = []

    def collect(kind: str, extract, stmt: dict | None) -> None:
        if not isinstance(stmt, dict):
            return
        part = OFXResult()
        try:
            extract(stmt, part)
        except Exception as exc:
            log.warning("ofx_parser.statement_error", kind=kind, error=str(exc))
            return
        account = part.accounts[0] if part.accounts else None
        # Some card issuers send a card as a bank statement whose account type
        # is CREDITLINE, not as a credit card statement. It is a card all the
        # same: money owed, stated as a negative balance.
        if kind == "bank" and account and account.account_type.upper() in _CARD_ACCOUNT_TYPES:
            kind = "card"
        statements.append(OFXStatement(
            kind=kind,
            account=account,
            transactions=part.transactions,
            ledger_balance=part.balances[0] if part.balances else None,
            holdings=part.holdings,
            inv_income=part.inv_income,
            trade_count=part.trade_count,
            unreadable=part.unreadable,
        ))

    for wrapper in _flatten_list(ofx, "BANKMSGSRSV1", "STMTTRNRS"):
        collect("bank", _extract_bank_stmt, wrapper.get("STMTRS"))
    for wrapper in _flatten_list(ofx, "CREDITCARDMSGSRSV1", "CCSTMTTRNRS"):
        collect("card", _extract_cc_stmt, wrapper.get("CCSTMTRS"))
    for wrapper in _flatten_list(ofx, "INVSTMTMSGSRSV1", "INVSTMTTRNRS"):
        collect("investment", _extract_inv_stmt, wrapper.get("INVSTMTRS"))

    securities = _security_list(ofx)
    for stmt in statements:
        for h in stmt.holdings:
            ticker, name = securities.get(h.uniqueid, ("", ""))
            h.ticker = h.ticker or ticker
            h.name = name
        for inc in stmt.inv_income:
            ticker, _ = securities.get(inc.uniqueid, ("", ""))
            inc.ticker = ticker
    return statements


def parse_ofx_response(raw: str) -> OFXResult:
    """Parse an OFX SGML or XML response into one flattened OFXResult."""
    result = OFXResult()
    for stmt in parse_ofx_statements(raw):
        if stmt.account:
            result.accounts.append(stmt.account)
        result.transactions.extend(stmt.transactions)
        if stmt.ledger_balance:
            result.balances.append(stmt.ledger_balance)
        result.holdings.extend(stmt.holdings)
        result.inv_income.extend(stmt.inv_income)
        result.trade_count += stmt.trade_count
        result.unreadable += stmt.unreadable
    return result


def _flatten_list(d: dict, *keys: str) -> list[dict]:
    """Navigate dict by keys (last key may be a list or single dict)."""
    cur = d
    for k in keys[:-1]:
        if not isinstance(cur, dict):
            return []
        cur = cur.get(k)
        if cur is None:
            return []
    if not isinstance(cur, dict):
        return []
    val = cur.get(keys[-1])
    if val is None:
        return []
    if isinstance(val, list):
        return [v for v in val if isinstance(v, dict)]
    if isinstance(val, dict):
        return [val]
    return []


def _extract_bank_stmt(stmtrs: dict, result: OFXResult) -> None:
    acct_from = stmtrs.get("BANKACCTFROM")
    if isinstance(acct_from, dict):
        acct_num = _dict_text(acct_from, "ACCTID") or ""
        routing = _dict_text(acct_from, "BANKID") or ""
        acct_type_raw = _dict_text(acct_from, "ACCTTYPE") or "CHECKING"

        result.accounts.append(ParsedAccount(
            account_number=acct_num,
            account_type=acct_type_raw,
            routing_number=routing,
        ))

    txn_list = _flatten_list(stmtrs, "BANKTRANLIST", "STMTTRN")
    result.transactions.extend(_extract_transactions(txn_list, result))

    _extract_balances(stmtrs, result)


def _extract_cc_stmt(ccstmtrs: dict, result: OFXResult) -> None:
    acct_from = ccstmtrs.get("CCACCTFROM")
    if isinstance(acct_from, dict):
        acct_num = _dict_text(acct_from, "ACCTID") or ""
        result.accounts.append(ParsedAccount(
            account_number=acct_num,
            account_type="CREDITCARD",
        ))

    txn_list = _flatten_list(ccstmtrs, "BANKTRANLIST", "STMTTRN")
    result.transactions.extend(_extract_transactions(txn_list, result))
    _extract_balances(ccstmtrs, result)


def _extract_inv_stmt(invstmtrs: dict, result: OFXResult) -> None:
    acct_from = invstmtrs.get("INVACCTFROM")
    if isinstance(acct_from, dict):
        acct_num = _dict_text(acct_from, "ACCTID") or ""
        broker_id = _dict_text(acct_from, "BROKERID") or ""
        result.accounts.append(ParsedAccount(
            account_number=acct_num,
            account_type="INVESTMENT",
            broker_id=broker_id,
        ))

    # Investment transactions
    invtranlist = invstmtrs.get("INVTRANLIST")
    if isinstance(invtranlist, dict):
        for inv_type in ("BUYMF", "SELLMF", "BUYSTOCK", "SELLSTOCK", "INCOME", "REINVEST", "INVBANKTRAN"):
            for inv_txn in _as_list(invtranlist.get(inv_type)):
                _parse_inv_txn(inv_txn, result)
                if inv_type.startswith(("BUY", "SELL")):
                    result.trade_count += 1
                if inv_type in ("INCOME", "REINVEST"):
                    _parse_income_txn(inv_txn, result, is_reinvest=(inv_type == "REINVEST"))

    # Positions
    invposlist = invstmtrs.get("INVPOSLIST")
    if isinstance(invposlist, dict):
        for pos_type in ("POSSTOCK", "POSMF", "POSDEBT", "POSOTHER"):
            for pos in _as_list(invposlist.get(pos_type)):
                _parse_position(pos, result, pos_type)


def _as_list(val) -> list:
    if val is None:
        return []
    if isinstance(val, list):
        return val
    return [val]


def _parse_inv_txn(inv_txn: dict, result: OFXResult) -> None:
    """Parse a single investment transaction (BUYMF, SELLMF, INVBANKTRAN, etc.)."""
    try:
        if not isinstance(inv_txn, dict):
            return

        # INVBANKTRAN wraps STMTTRN
        stmttrn = inv_txn.get("STMTTRN")
        if isinstance(stmttrn, dict):
            fitid = _dict_text(stmttrn, "FITID")
            date_raw = _dict_text(stmttrn, "DTPOSTED") or _dict_text(stmttrn, "DTUSER") or ""
            amount_raw = _dict_text(stmttrn, "TRNAMT") or "0"
            name_raw = _dict_text(stmttrn, "NAME") or _dict_text(stmttrn, "MEMO") or "Investment transaction"
            trntype = _dict_text(stmttrn, "TRNTYPE") or "OTHER"
            memo = _dict_text(stmttrn, "MEMO") or ""
        else:
            # BUYMF/SELLMF etc. wrap INVBUY/INVSELL which wraps INVTRAN
            invbuy = inv_txn.get("INVBUY") or inv_txn.get("INVSELL") or inv_txn
            if not isinstance(invbuy, dict):
                return
            invtran = invbuy.get("INVTRAN") or {}
            if not isinstance(invtran, dict):
                invtran = {}

            fitid = _dict_text(invtran, "FITID") or _dict_text(inv_txn, "FITID")
            date_raw = (
                _dict_text(invtran, "DTTRADE")
                or _dict_text(invtran, "DTPOSTED")
                or _dict_text(inv_txn, "DTTRADE")
                or ""
            )
            amount_raw = _dict_text(invbuy, "TOTAL") or _dict_text(inv_txn, "TOTAL") or "0"
            name_raw = _dict_text(invtran, "MEMO") or _dict_text(invbuy, "MEMO") or "Investment transaction"
            trntype = "OTHER"
            memo = name_raw

        if not fitid:
            return

        result.transactions.append(ParsedTransaction(
            fitid=fitid,
            date_posted=parse_ofx_date(date_raw) if date_raw else datetime.now().date(),
            amount=parse_ofx_amount(amount_raw),
            trntype=trntype,
            name=name_raw,
            memo=memo,
            investment=not isinstance(stmttrn, dict),
        ))
    except Exception as exc:
        log.warning("ofx_parser.inv_txn_error", error=str(exc))


def _parse_income_txn(inv_txn: dict, result: OFXResult, *, is_reinvest: bool) -> None:
    """Parse an INCOME or REINVEST aggregate into a structured ParsedInvIncome.

    Runs in addition to the generic _parse_inv_txn cash row (same FITID), so
    existing cash-transaction imports keep working unchanged.
    """
    try:
        if not isinstance(inv_txn, dict):
            return
        invtran = inv_txn.get("INVTRAN") or {}
        if not isinstance(invtran, dict):
            invtran = {}

        fitid = _dict_text(invtran, "FITID") or _dict_text(inv_txn, "FITID")
        if not fitid:
            return

        date_raw = (
            _dict_text(invtran, "DTTRADE")
            or _dict_text(invtran, "DTSETTLE")
            or _dict_text(inv_txn, "DTTRADE")
            or ""
        )
        secid = inv_txn.get("SECID")
        uniqueid = _dict_text(secid, "UNIQUEID") if isinstance(secid, dict) else None
        total = abs(_number(_dict_text(inv_txn, "TOTAL")))
        income_type = (_dict_text(inv_txn, "INCOMETYPE") or "MISC").upper()

        result.inv_income.append(ParsedInvIncome(
            fitid=fitid,
            date_posted=parse_ofx_date(date_raw) if date_raw else datetime.now().date(),
            uniqueid=uniqueid or "",
            income_type=income_type,
            total=total,
            is_reinvest=is_reinvest,
            units=abs(_number(_dict_text(inv_txn, "UNITS"))) if is_reinvest else 0.0,
            unit_price=_number(_dict_text(inv_txn, "UNITPRICE")) if is_reinvest else 0.0,
            memo=_dict_text(invtran, "MEMO") or "",
        ))
    except Exception as exc:
        log.warning("ofx_parser.income_txn_error", error=str(exc))


def _parse_position(pos: dict, result: OFXResult, kind: str = "") -> None:
    try:
        invpos = pos.get("INVPOS") if isinstance(pos, dict) else pos
        if not isinstance(invpos, dict):
            invpos = pos
        secid = invpos.get("SECID")
        uniqueid = uniqueid_type = ""
        if isinstance(secid, dict):
            uniqueid = (_dict_text(secid, "UNIQUEID") or "").strip()
            uniqueid_type = (_dict_text(secid, "UNIQUEIDTYPE") or "").strip().upper()
        units_raw = _dict_text(invpos, "UNITS") or "0"
        price_raw = _dict_text(invpos, "UNITPRICE") or "0"
        mktval_raw = _dict_text(invpos, "MKTVAL") or "0"
        as_of_raw = _dict_text(invpos, "DTPRICEASOF") or ""

        result.holdings.append(ParsedHolding(
            ticker=uniqueid.upper() if uniqueid_type == "TICKER" else "",
            units=_number(units_raw),
            unit_price=_number(price_raw),
            market_value=_number(mktval_raw),
            uniqueid=uniqueid,
            uniqueid_type=uniqueid_type,
            kind=kind,
            price_as_of=parse_ofx_date(as_of_raw) if as_of_raw else None,
        ))
    except Exception as exc:
        log.warning("ofx_parser.position_error", error=str(exc))


#: SECLIST entries, by the kind of security they describe.
_SECINFO_KINDS = ("MFINFO", "STOCKINFO", "DEBTINFO", "OPTINFO", "OTHERINFO")


def _security_list(ofx: dict) -> dict[str, tuple[str, str]]:
    """The file's SECLIST: SECID UNIQUEID -> (ticker, name).

    Positions and income rows name a security by its SECID, which is usually
    a CUSIP. The ticker and the name are only here.
    """
    out: dict[str, tuple[str, str]] = {}
    seclists = _flatten_list(ofx, "SECLISTMSGSRSV1", "SECLIST")
    for seclist in seclists:
        for info_kind in _SECINFO_KINDS:
            for info in _as_list(seclist.get(info_kind)):
                if not isinstance(info, dict):
                    continue
                secinfo = info.get("SECINFO")
                if not isinstance(secinfo, dict):
                    continue
                secid = secinfo.get("SECID")
                uniqueid = (_dict_text(secid, "UNIQUEID") or "").strip() if isinstance(secid, dict) else ""
                if not uniqueid:
                    continue
                ticker = (_dict_text(secinfo, "TICKER") or "").strip().upper()
                name = (_dict_text(secinfo, "SECNAME") or "").strip()
                out[uniqueid] = (ticker, name)
    return out


def _extract_balances(stmt: dict, result: OFXResult) -> None:
    for bal_key in ("LEDGERBAL", "AVAILBAL"):
        bal = stmt.get(bal_key)
        if not isinstance(bal, dict):
            continue
        amt_raw = _dict_text(bal, "BALAMT") or "0"
        date_raw = _dict_text(bal, "DTASOF") or ""
        try:
            result.balances.append(ParsedBalance(
                amount=parse_ofx_amount(amt_raw),
                as_of_date=parse_ofx_date(date_raw) if date_raw else None,
            ))
        except Exception:
            pass


def _dict_text(d: dict, key: str) -> str | None:
    """Get a leaf string value from a dict by key (case-insensitive key lookup)."""
    # Try exact key first, then uppercase
    val = d.get(key) or d.get(key.upper())
    if isinstance(val, str):
        return val
    if isinstance(val, dict):
        # Fallback for old-style _text dicts
        return val.get("_text")
    return None
