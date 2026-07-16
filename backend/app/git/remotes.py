from __future__ import annotations

from .models import GitRemoteResponse


def parse_remote_verbose(payload: str, tracking: dict[str, list[str]]) -> list[GitRemoteResponse]:
    values: dict[str, dict[str, str | None]] = {}
    for line in payload.splitlines():
        header, separator, kind = line.rpartition(" ")
        if not separator or kind not in {"(fetch)", "(push)"}:
            continue
        name, tab, url = header.partition("\t")
        if not tab:
            parts = header.split(None, 1)
            if len(parts) != 2:
                continue
            name, url = parts
        item = values.setdefault(name, {"fetch": None, "push": None})
        item["fetch" if kind == "(fetch)" else "push"] = url
    return [
        GitRemoteResponse(
            name=name,
            fetch_url=value["fetch"],
            push_url=value["push"],
            tracking_branches=sorted(tracking.get(name, [])),
        )
        for name, value in sorted(values.items())
    ]
