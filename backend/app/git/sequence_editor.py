from __future__ import annotations

import base64
import os
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 2:
        return 2
    encoded = os.environ.get("KEYDEX_REBASE_TODO", "")
    if not encoded:
        return 3
    try:
        todo = base64.b64decode(encoded, validate=True).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return 4
    target = Path(sys.argv[1])
    target.write_text(todo, encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
