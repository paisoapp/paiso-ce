# Contributing to Paiso

Thank you for helping. This file says what we accept, how to set up, and how
a change gets in.

## What we accept

- Bug fixes and security fixes. Report a security problem privately first:
  see [SECURITY.md](SECURITY.md).
- Performance and accessibility improvements.
- Documentation and tests.
- Improvements to features this edition already has: the dashboard,
  portfolio, investments, cash flow, budget, transactions, CSV and OFX
  import, categories and rules, two-factor sign-in, themes and the setup
  guide.
- Support for more banks' CSV formats.

## New features

Paiso decides which features this edition has. Before you build a feature
that Paiso does not have yet, open a feature request and wait for a
maintainer to agree to it; a pull request for a new feature nobody discussed
may be closed without review.

If you are not sure whether an idea counts as a new feature, ask in a
feature request before you write the code.

## Set up

[README.md](README.md), "Develop", shows how to run the backend and the web
app. [ARCHITECTURE.md](ARCHITECTURE.md) says where things are.

## Before you open a pull request

- Run `make test-unit`, and `npm run build` in `frontend/`. Both must pass.
- Add a test for a bug fix or a change in behaviour.
- A database change adds an Alembic revision: `make migration M="what changed"`.
- Keep a pull request to one change.

## Writing style

Interface text, documentation and comments follow the same rules:

- no contractions ("do not", not "don't");
- no em-dashes;
- the active voice;
- name the file or function a statement is about.

`npm run build` refuses contractions and em-dashes in interface text
(`frontend/scripts/check-copy.mjs`).

## The Contributor License Agreement

Before we can merge your first pull request, you sign the
[Contributor License Agreement](CLA.md) by commenting on the pull request:

> I have read the CLA Document and I hereby sign the CLA

The CLA check asks for it and records your signature in this repository. You
sign once. The agreement assigns the copyright in your contributions to
Artificial Systems LLC (Paiso), gives you a licence to keep using your own
work for anything, and commits Paiso to publish it as open source. It lets
Paiso use a contribution in the hosted service too.

## How a change gets in

1. Open an issue for anything larger than a small fix, so we can agree on
   the approach first.
2. Open a pull request against `main` and fill in its checklist.
3. The checks run (tests, build, CLA). A maintainer reviews it.
4. Once it is approved and the checks pass, a maintainer merges it.

## Names and logos

The code is AGPL-3.0; the Paiso name and logo are not. A fork you distribute
needs a name and logo of its own: see [TRADEMARK.md](TRADEMARK.md).

## Conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
