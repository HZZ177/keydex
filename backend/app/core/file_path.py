from __future__ import annotations

from pathlib import Path

from backend.app.core.env import get_prefixed_env


def _resolve_log_path() -> Path:
    explicit = get_prefixed_env("LOG_DIR")
    if explicit:
        return Path(explicit).expanduser().resolve()
    data_dir = Path(get_prefixed_env("DATA_DIR", ".data") or ".data").expanduser().resolve()
    return data_dir / "logs"


_log_path = _resolve_log_path()
_log_path.mkdir(parents=True, exist_ok=True)

log_path = str(_log_path)
