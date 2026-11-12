# Backend

## Python dependencies

Two files, both checked in:

- `requirements.txt` is the list people edit: the direct dependencies, most
  pinned exactly, a few as ranges.
- `requirements.lock` is generated from it. It pins every package, transitive
  ones included, with the hashes of every published file. The image installs
  only from it, with `pip install --require-hashes`, so a rebuild of the same
  commit installs the same bytes.

After any change to `requirements.txt`, including a Dependabot update,
regenerate the lock in the same pull request:

```bash
cd backend
uv pip compile requirements.txt --universal --python-version 3.12 \
  --generate-hashes --no-header -o requirements.lock
```

`make lock` at the repository root runs the same command. For a Dependabot
pull request, check out its branch, run `make lock`, and push the new lock
to that branch.

`--universal` resolves for every platform at once, so the lock built on a Mac
also covers the Linux image in `Dockerfile` at the repository root. `tests/unit/test_requirements_lock.py` fails when
a pin in `requirements.txt` and the lock disagree, so a forgotten
regeneration shows up in CI instead of in a deploy.
