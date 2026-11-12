"""Print every installed Python package with its licence and licence text.

The Docker build appends the output to the web app's
``third-party-licenses.txt`` (frontend/scripts/third-party-licenses.mjs
writes the npm half), which Settings > About links to.

    python scripts/python_licenses.py >> /app/static/third-party-licenses.txt
"""
import re
from importlib import metadata

_LICENSE_FILE = re.compile(r"(^|/)(licen[cs]e|copying|notice)[^/]*$", re.IGNORECASE)
_RULE = "=" * 78
#: The installer itself, not part of the app.
_SKIP = {"pip", "setuptools", "wheel"}


def _license(dist: metadata.Distribution) -> str:
    meta = dist.metadata
    expression = meta.get("License-Expression")
    if expression:
        return expression
    # The free-text field sometimes holds the whole licence; keep it short.
    text = (meta.get("License") or "").strip()
    if text and "\n" not in text and len(text) < 80:
        return text
    classifiers = [c.split(" :: ")[-1] for c in meta.get_all("Classifier") or []
                   if c.startswith("License ::")]
    return ", ".join(classifiers) or "not stated"


def _texts(dist: metadata.Distribution) -> list[str]:
    out = []
    for file in dist.files or []:
        if _LICENSE_FILE.search(str(file)):
            try:
                out.append(file.read_text().strip())
            except (OSError, UnicodeDecodeError):
                continue
    return out


def main() -> None:
    dists = {}
    for dist in metadata.distributions():
        name = dist.metadata["Name"]
        if name and name.lower() not in _SKIP:
            dists[(name.lower(), dist.version)] = dist
    sections = ["Server (Python)"]
    for key in sorted(dists):
        dist = dists[key]
        head = f"{dist.metadata['Name']} {dist.version}\nLicense: {_license(dist)}"
        sections.append("\n\n".join([head, *_texts(dist)]))
    print("\n\n" + f"\n\n{_RULE}\n\n".join(sections))


if __name__ == "__main__":
    main()
