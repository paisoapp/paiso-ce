# Changelog

Every change worth knowing about, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/): a minor version may change
features, a patch version only fixes bugs and security issues.

Each pull request adds a line under "Unreleased". A release moves them under
its version and date.

## [Unreleased]

## [0.1.2] - 2026-11-11

### Changed

- Tests and code comments use made-up accounts, merchants and amounts
  throughout.
- CSV import reads more bank exports by their columns alone: amounts signed
  by a Debit/Credit type column, a running balance column, and an extended
  description when the file has one. The three credit-union formats that had
  parsers of their own now import this way.

## [0.1.1] - 2026-11-09

### Changed

- The mortgage card in the sign-in page demo, and the mortgage tests, use a
  sample loan.

## [0.1.0] - 2026-11-09

The first release of the Paiso Community Edition: free, open-source Paiso
that you self-host and run locally.

### Added

- **Dashboard and Portfolio:** net worth over time, assets and debts, and a
  dashboard you arrange yourself.
- **Investments:** stocks, ETFs and mutual funds priced from public market
  data, property, vehicles and other assets, allocation, fees, and dividends.
  Retirement, education and health accounts each have a tab.
- **Cash Flow and Budget:** income, expenses and transfers, transfer pairing
  you review, and a monthly budget by category.
- **Transactions:** cash, cards, loans and mortgages, with categories, rules,
  receipts and a mortgage's principal and interest split.
- **Import:** CSV files from most US banks, with a mapping wizard for the
  rest, and OFX and QFX files, including the positions in a brokerage
  statement.
- **Security:** one account per install, two-factor sign-in with recovery
  codes, a list of signed-in devices, and privacy blur.
- **Self-hosting:** one container on one data volume, secrets generated on
  first start, a copy of the database in `/data/backups/` before any
  migration runs, and `python -m app.cli reset-password` and `reset-mfa` for
  recovery.
