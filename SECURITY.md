# Security policy

## Reporting a vulnerability

Please report a vulnerability privately, not in a public issue:

- through GitHub: the repository's **Security** tab, **Report a vulnerability**;
- or by email to **security@paisoapp.com**.

Say what you found, how to reproduce it, and which version you tested (Settings,
About shows it). We reply within 5 business days, keep you told of progress,
and credit you in the advisory unless you would rather we did not.

## Coordinated disclosure

Please give us time to release a fix before you publish anything. We agree a
date with you, normally within 90 days of your report, and publish a GitHub
security advisory with the release that fixes it.

The hosted Paiso at paisoapp.com shares much of this code. We treat every
report as affecting it too, so a fix ships there first and then in a release
of this repository, with its advisory.

## Supported versions

Only the latest release gets security fixes. Upgrade with:

```bash
git pull
docker compose up -d --build
```

## What this edition does to stay safe

- One account per install; sign-up closes once it exists.
- Secrets are generated on first start and kept in the data volume, readable
  only by the app's user.
- The container runs as a non-root user and publishes its port on
  `127.0.0.1` only. Put an HTTPS reverse proxy in front to reach it from
  elsewhere (see the README).
- Passwords are hashed with Argon2. Two-factor sign-in uses TOTP with
  recovery codes, and failed sign-ins are limited.
- Uploads are capped in size, checked by their content rather than their
  name, and stored outside the web root.
