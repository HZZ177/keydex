from __future__ import annotations

import base64
import json
import os
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 2:
        return 2
    encoded = os.environ.get("KEYDEX_REBASE_MESSAGES", "")
    if not encoded:
        return 3
    try:
        messages = json.loads(base64.b64decode(encoded, validate=True).decode("utf-8"))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return 4
    if not isinstance(messages, dict) or not all(
        isinstance(key, str) and isinstance(value, str) for key, value in messages.items()
    ):
        return 5
    target = Path(sys.argv[1])
    current = target.read_text(encoding="utf-8", errors="replace")
    subject = next(
        (
            line.strip()
            for line in current.splitlines()
            if line.strip() and not line.startswith("#")
        ),
        "",
    )
    replacement = messages.get(subject)
    if replacement is not None:
        target.write_text(replacement.rstrip() + "\n", encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
