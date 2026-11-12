"""Owner commands for a self-hosted install, run inside the container:

    docker exec -it paiso-ce python -m app.cli reset-password you@example.com
    docker exec -it paiso-ce python -m app.cli reset-mfa you@example.com

Paiso sends no email, so a forgotten password or a lost authenticator is
fixed from the command line. Both commands sign the account out on every device.

``reset-password`` asks for the new password twice. Without a terminal (a
script piping it in) it reads one line from standard input instead.
"""
import argparse
import asyncio
import getpass
import sys

from sqlalchemy import delete, func, select

import app.models  # noqa: F401 (registers every table)
from app.api.auth import end_all_sessions
from app.core.database import AsyncSessionLocal
from app.core.security import hash_password
from app.core.validation import password_problem
from app.models.user import User, UserBackupCode


def _read_password() -> str:
    if not sys.stdin.isatty():
        return sys.stdin.readline().rstrip("\n")
    first = getpass.getpass("New password: ")
    if getpass.getpass("Repeat it: ") != first:
        raise SystemExit("The two passwords differ. Nothing was changed.")
    return first


async def _user(db, email: str) -> User:
    user = await db.scalar(select(User).where(func.lower(User.email) == email.lower()))
    if user is None:
        raise SystemExit(f"No account uses {email}. Nothing was changed.")
    return user


async def reset_password(email: str) -> None:
    async with AsyncSessionLocal() as db:
        user = await _user(db, email)
        password = _read_password()
        problem = password_problem(password, user.email)
        if problem:
            raise SystemExit(f"{problem} Nothing was changed.")
        user.hashed_password = hash_password(password)
        user.must_change_password = False
        user.failed_logins = 0
        user.locked_until = None
        await end_all_sessions(db, user)
        await db.commit()
    print(f"The password for {email} is changed, and every device is signed out.")


async def reset_mfa(email: str) -> None:
    async with AsyncSessionLocal() as db:
        user = await _user(db, email)
        user.totp_enabled = False
        user.totp_secret = None
        user.mfa_required = False
        await db.execute(delete(UserBackupCode).where(UserBackupCode.user_id == user.id))
        await end_all_sessions(db, user)
        await db.commit()
    print(f"Two-factor sign-in is off for {email}, its recovery codes are deleted, "
          "and every device is signed out. Turn it back on in Settings, Security.")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m app.cli", description=__doc__.split("\n\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    for name, help_text in (
        ("reset-password", "set a new password for an account"),
        ("reset-mfa", "turn two-factor sign-in off for an account"),
    ):
        command = commands.add_parser(name, help=help_text)
        command.add_argument("email")
    args = parser.parse_args(argv)
    run = reset_password if args.command == "reset-password" else reset_mfa
    asyncio.run(run(args.email))


if __name__ == "__main__":
    main()
