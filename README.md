<p align="center">
  <img src=".github/assets/community-edition-banner.webp" alt="Paiso Community Edition, open source" width="100%">
</p>

# Paiso Community Edition

Paiso is a personal finance app that you self-host and run locally. It
tracks your net worth, investments, budget and cash flow from data you enter
or import from your bank's CSV and OFX files. Everything stays in one
container and one data volume that you control.

Paiso is free software under the GNU Affero General Public License, version
3 ([LICENSE](LICENSE)).

> Prefer not to self-host? The hosted Paiso at
> [paisoapp.com](https://paisoapp.com/sign-up) runs it for you, with nothing
> to install, update or back up.

## Why Paiso is open source

- **Trust.** The code that handles your money should be open to read. Anyone
  can check what Paiso does with your data, and every problem someone reports
  here makes the hosted Paiso better too.
- **Privacy.** You can self-host Paiso and run it locally, so your financial
  data stays under your control.

## What it does

- **Dashboard and Portfolio:** net worth over time, assets and debts, and a
  dashboard you arrange yourself.
- **Investments:** stocks, ETFs and funds priced from public market data,
  property, vehicles and other assets, asset allocation, fees, and dividends
  and other investment income. Retirement, education and health accounts
  (401(k), IRA, 529, HSA) each have a tab.
- **Cash Flow and Budget:** income, expenses and transfers, transfer pairing
  you review, and a monthly budget by category.
- **Transactions:** cash, cards, loans and mortgages, with categories, rules,
  attachments and a mortgage's principal and interest split.
- **Import:** CSV from most US banks, with a mapping wizard for the rest, and
  OFX/QFX files.
- **Security:** one account per install, two-factor sign-in with recovery
  codes, a list of signed-in devices, and a privacy blur for amounts.

Paiso sends no email and no usage data. It asks Yahoo Finance for prices by
ticker symbol, and Zillow or Wikipedia for a property or vehicle photo when
you ask for one.

## Install

You need [Docker](https://docs.docker.com/get-docker/) with Compose.

```bash
git clone https://github.com/paisoapp/paiso-ce.git
cd paiso-ce
docker compose up -d --build
```

Open <http://127.0.0.1:8080> and create your account. The first account is
the only one: once it exists, sign-up is closed.

On first start Paiso creates its database and writes two random secrets to
`/data/secrets/` in the data volume: `jwt_secret` signs your sessions and
`master_key` encrypts two-factor secrets. You do not set either. To use your
own, set `PAISO_JWT_SECRET` and `PAISO_MASTER_KEY` before the first start.

The compose file publishes port 8080 on `127.0.0.1` only, so nothing else on
your network can reach it. To use Paiso from other devices, put an HTTPS
reverse proxy in front (see below).

To try it from another machine on a network you trust, you can publish the
port itself (`"8080:8080"` under `ports:`) and open `http://<address>:8080`.
Paiso works over plain HTTP, but your password and session then cross the
network unencrypted, so use HTTPS for anything you keep.

## Upgrade

```bash
git pull
docker compose up -d --build
```

Read [CHANGELOG.md](CHANGELOG.md) first. Paiso applies any database
migrations when it starts, and copies the database to
`/data/backups/pre-<version>.db` before it does; a backup of your own is still
the safe way back (next section).

## Back up and restore

Everything Paiso keeps is in the `paiso-data` volume: the SQLite database
(`paiso.db`), uploaded files, and the two secrets. Back up the volume as a
whole. Without `secrets/master_key`, two-factor sign-in cannot be decrypted.

The database runs in WAL mode, so stop the container before you copy it:

```bash
docker compose stop
docker run --rm -v paiso-ce_paiso-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/paiso-backup.tar.gz -C /data .
docker compose start
```

`docker volume ls` shows the volume's full name, which starts with the name of
the folder the compose file is in.

To restore, stop the container, empty the volume and unpack the archive into
it:

```bash
docker compose stop
docker run --rm -v paiso-ce_paiso-data:/data -v "$PWD":/backup alpine \
  sh -c "rm -rf /data/* && tar xzf /backup/paiso-backup.tar.gz -C /data"
docker compose start
```

## Reverse proxy with HTTPS

Any HTTPS proxy works. With [Caddy](https://caddyserver.com), which gets a
certificate for you, the whole configuration is:

```
paiso.example.com {
    reverse_proxy 127.0.0.1:8080 {
        header_up X-Real-IP {remote_host}
    }
}
```

Then tell Paiso which header carries the visitor's address, so sign-in limits
count each visitor separately. Add this to the `paiso-ce` service in
`docker-compose.yml`:

```yaml
    environment:
      - PAISO_TRUSTED_IP_HEADER=X-Real-IP
```

Set it only when a proxy you control sets that header on every request;
otherwise a visitor could send it themselves. Behind Cloudflare, use
`CF-Connecting-IP`. HSTS is the proxy's job, and Caddy sends it by default.

## Forgot your password, or lost your authenticator

Paiso sends no email, so you reset access from the command line:

```bash
docker exec -it paiso-ce python -m app.cli reset-password you@example.com
docker exec -it paiso-ce python -m app.cli reset-mfa you@example.com
```

`reset-password` asks for the new password twice. `reset-mfa` turns
two-factor sign-in off and deletes the recovery codes, so you can set it up
again in Settings, Security. Both sign the account out on every device.

## Configuration

Paiso needs no configuration. These settings exist for special cases. Set
them as environment variables on the `paiso-ce` service.

| Variable | Default | What it does |
|---|---|---|
| `PAISO_TRUSTED_IP_HEADER` | empty | The header your proxy sets to the visitor's address |
| `PAISO_SCHEDULER` | `true` | `false` stops the background jobs (market prices, transfer pairing) |
| `PAISO_JWT_SECRET` | generated | Signs sessions; generated into `/data/secrets` when unset |
| `PAISO_MASTER_KEY` | generated | Encrypts two-factor secrets; generated into `/data/secrets` when unset |
| `PAISO_SQLITE_PATH` | `/data/paiso.db` | The database file |
| `PAISO_STORAGE_ROOT` | `/data` | Uploads and generated secrets |
| `PAISO_JWT_ACCESS_EXPIRE_MINUTES` | `60` | How long a sign-in token lasts before the app renews it in the background |
| `PAISO_JWT_REFRESH_EXPIRE_DAYS` | `30` | How long a device stays signed in without use |
| `PAISO_AUTO_MIGRATE` | `true` | `false` stops the start-up migrations; run `python -m app.core.migrations` yourself |
| `PAISO_ALLOWED_ORIGINS` | empty | Other web origins allowed to call the API with the session, as a JSON list; the app itself never needs it |

The image sets `PAISO_RELEASE_CHANNEL`, `PAISO_APP_VERSION`, `PAISO_GIT_COMMIT`,
`PAISO_BUILD_TIME` and `PAISO_STATIC_DIR` itself; leave them alone. To
change the port, edit `ports:` in `docker-compose.yml`: the first number is
the host's port, and `127.0.0.1:` keeps it off your network.

## Develop

The backend is FastAPI and SQLAlchemy on SQLite; the web app is React, Vite
and TypeScript. [ARCHITECTURE.md](ARCHITECTURE.md) maps the code.

```bash
# Backend, on port 8000
cd backend
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
PAISO_SQLITE_PATH=./dev.db PAISO_STORAGE_ROOT=./data python -m uvicorn app.main:app --reload

# Web app, on port 5174, which passes /api to port 8000
cd frontend
npm ci
npm run dev
```

Run these before you send a change:

```bash
make test-unit
cd frontend && npm run build
```

`make test-smoke` builds the image, starts it on an empty volume and runs the
container smoke suite (`backend/tests/smoke`): sign-up, two-factor sign-in,
imports, the main pages, the recovery commands and a restart.

`npm run build` type-checks, then runs `check-copy`, which refuses
contractions and em-dashes in interface text, and `check-charts`.

## Security

Report a vulnerability privately: see [SECURITY.md](SECURITY.md).

## How Paiso is built

Paiso is written and maintained by its author, with help from AI coding
assistants. Claude (Anthropic) and Codex (OpenAI) helped with bug fixes, code
cleanup and security fixes, and Claude helped prepare this repository for
release. The maintainer reviews every change before it is merged and is
responsible for the code in this repository.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Contributors sign the
[Contributor License Agreement](CLA.md), and everyone follows the
[Code of Conduct](CODE_OF_CONDUCT.md).

## License

Paiso is licensed under the GNU Affero General Public License, version 3. If
you run a changed copy for other people over a network, the license requires
you to offer them its source code. Build the image with your repository's
address, and the About page links to it:

```bash
docker compose build --build-arg SOURCE_URL=https://github.com/you/your-paiso
```

Settings, About lists the licenses of the open-source software Paiso
includes.

The Paiso name and logo are trademarks of Artificial Systems LLC and are not
covered by the license: see [TRADEMARK.md](TRADEMARK.md).
