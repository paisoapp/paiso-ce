# Paiso architecture

How the self-hosted edition is put together. The code is the reference;
this file says where to look.

## One container

`Dockerfile` builds the web app with Node, then a Python image that serves it.
One `uvicorn` process runs everything:

| Part | Where |
|---|---|
| The API, under `/api` | `backend/app/api/` |
| The built web app, for every other path | `backend/app/core/spa.py`, from `/app/static` |
| Background jobs | `backend/app/workers/scheduler.py` (APScheduler, in a thread) |
| Cache and rate limits | `backend/app/core/cache.py`, `backend/app/core/ratelimit.py` (in memory) |
| Data | the `/data` volume: `paiso.db`, uploads, `secrets/` |

The process runs as user `paiso` (uid 10001). `/healthz` answers while the
process is up; `/readyz` also checks that the database is at the latest
migration. Security headers, including a Content-Security-Policy that allows
only the app's own origin, come from `backend/app/core/security_headers.py`.

## Start-up

`backend/app/main.py`:

1. `backend/app/core/config.py` reads `PAISO_*` settings, then
   `backend/app/core/instance_secrets.py` fills in `jwt_secret` and
   `master_key` from `/data/secrets/`, creating them on the first run.
2. `backend/app/core/migrations.py` upgrades the database with Alembic when
   `PAISO_AUTO_MIGRATE` is on (the default).
3. The scheduler starts unless `PAISO_SCHEDULER=false`.

## Database

SQLite through SQLAlchemy 2 (async, `aiosqlite`), in WAL mode with foreign
keys on (`backend/app/core/database.py`). The models are in
`backend/app/models/`. The schema starts from one Alembic revision,
`backend/alembic/versions/0001_oss_baseline.py`; a change adds a revision
after it (`make migration M="what changed"`).

| Area | Tables |
|---|---|
| Sign-in | `user`, `user_settings`, `user_backup_code`, `refresh_token` |
| Accounts | `institution`, `account`, `account_balance_snapshot`, `account_liability`, `csv_mapping` |
| Transactions | `transaction`, `transaction_attachment`, `category`, `category_rule`, `transfer_link` |
| Investments | `holding`, `trade`, `security`, `security_info`, `security_dividend`, `price_history`, `intraday_price_history` |
| Property and loans | `asset`, `loan`, `payment_schedule` |
| Budget | `budget`, `budget_line`, `budget_line_amount` |
| History | `net_worth_snapshot` |

## Backend modules

| Module | What it does |
|---|---|
| `modules/accounts/` | Account types and subtypes (`classification.py`), CSV parsing, categorization (`categorizer.py`: the user's history, then rules, then built-in patterns), default categories |
| `modules/aggregator/` | Bank CSV formats and OFX/QFX parsing |
| `modules/budgeting/` | Income, expense and transfer totals (`aggregates.py`), the budget (`plan.py`), transfer pairing (`transfer_matcher.py`) |
| `modules/investments/` | Market data from yfinance (`market_data.py`, `refresh.py`, `backfill.py`), dividends, expense ratios, asset classes, trade replay (`activity.py`) |
| `modules/portfolio/` | The investment book (`positions.py`), account valuation (`valuation.py`), net worth now and over time (`summary.py`, `net_worth_history.py`, `account_history.py`), fees, loans and mortgage payments |

`backend/app/cli.py` holds the owner commands, `reset-password` and
`reset-mfa`.

## Sign-in

`backend/app/api/auth.py`. The first sign-up creates the only account; after
that `POST /api/auth/register` answers 403, and `/api/info` reports
`signup_open` so the web app shows sign-in instead. Passwords are hashed with
Argon2. A session is a short-lived access token (JWT, 60 minutes) and a
rotating refresh token per device in an HTTP-only cookie. Two-factor sign-in
uses TOTP, with the secret encrypted by `master_key`, and recovery codes.
Failed sign-ins are limited per address and per email; correct passwords are
never limited.

## Market data

`backend/app/modules/investments/market_data.py` fetches quotes and history
from Yahoo Finance through yfinance and stores closes in `price_history`.
Pages read stored prices and the in-memory quote cache, never the network.
The scheduler refreshes them:

| Job | When (US Eastern) |
|---|---|
| `refresh-market-data` | every minute, 09:00 to 18:00 on weekdays |
| `refresh-market-history` | every 10 minutes in market hours |
| `refresh-market-history-full` | Saturday 10:00 |
| `refresh-security-info` | weekdays 17:30 |
| `refresh-dividend-history` | Saturday 10:30 |
| `rematch-transfers` | daily 03:30 |

## Import

- Bank CSV: `POST /api/imports/bank-csv` recognises common US bank formats
  (`modules/aggregator/csv_parsers.py`); `POST /api/imports/csv` and its
  commit step map any other file column by column.
- OFX/QFX: `POST /api/imports/ofx/preview`, then `POST /api/imports/ofx`, for
  bank and brokerage statements; brokerage activity becomes trades
  (`backend/app/api/aggregator.py`).
- Each import deduplicates on the file's own transaction id where it has one,
  categorizes new rows, and runs transfer pairing
  (`backend/app/modules/accounts/ingest.py`).

## Web app

React 18, TypeScript, Vite and Tailwind, in `frontend/src/`.

| Path | What it holds |
|---|---|
| `pages/` | One folder per section: Dashboard, Portfolio, Investments, Budgeting (Cash Flow and Budget), Transactions, Settings, Onboarding, Auth |
| `components/` | Shared pieces: `ui/` (drawers, inputs, tooltips), `layout/`, `accounts/`, `portfolio/`, `cashflow/`, `onboarding/` |
| `hooks/` | One TanStack Query hook per API resource |
| `store/` | Zustand stores: the session, the theme, interface preferences |
| `lib/` | Formatting, the API client (`api.ts`), icons, chart colours, outbound links (`legal.ts`) |

`npm run build` type-checks and runs two checks: `scripts/check-copy.mjs`
refuses contractions and em-dashes in interface text, and
`scripts/check-charts.mjs` keeps charts consistent. After the Vite build,
`scripts/third-party-licenses.mjs` writes `third-party-licenses.txt`, and the
Docker build appends the Python packages' licenses to it
(`backend/scripts/python_licenses.py`).

## Tests

`make test-unit` runs `backend/tests/unit` and `backend/tests/aggregator`
in-process, each test on its own temporary database. `npm run build` is the
web app's check. `make test-smoke` (`scripts/smoke.sh`) builds the image and
runs `backend/tests/smoke` against it from outside, and
`scripts/upgrade-test.sh` checks that a newer image keeps an older one's data.

## CI and releases

`.github/workflows/ci.yml` runs three required jobs on every pull request:
`backend` (ruff, vulture, the unit tests), `frontend` (tsc, knip, the build)
and `container` (the image, the smoke suite and a Trivy scan that fails on a
fixable High or Critical). When the migrations change, it also runs the
upgrade test from the latest release. `cla.yml` checks the Contributor
License Agreement and `dependency-review.yml` refuses dependencies with a
High advisory.

A `vX.Y.Z` tag runs `release.yml`: it tests the image, then, once a
maintainer approves the `release` environment, builds it for `linux/amd64`
and `linux/arm64`, pushes `ghcr.io/paisoapp/paiso:X.Y.Z`, `:X.Y` and
`:latest`, signs it with cosign, attaches an SBOM and build provenance, and
creates the GitHub Release from the `CHANGELOG.md` section.
