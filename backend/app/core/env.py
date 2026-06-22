from __future__ import annotations

import os

ENV_PREFIX = "KEYDEX_"


def env_name(name: str) -> str:
    return f"{ENV_PREFIX}{name}"


def get_prefixed_env(name: str, default: str | None = None) -> str | None:
    return os.getenv(env_name(name), default)
