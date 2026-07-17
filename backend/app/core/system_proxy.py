from __future__ import annotations

import hashlib
import json
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field, replace
from typing import Any, Literal
from urllib.request import getproxies

from backend.app.core.logger import logger

_ROUTE_PROXY_KEYS = ("http", "https", "all")
_SUPPORTED_PROXY_KEYS = frozenset((*_ROUTE_PROXY_KEYS, "no"))

ProxyMode = Literal["direct", "proxy"]
ProxyReader = Callable[[], Mapping[str, Any]]


@dataclass(frozen=True, slots=True)
class SystemProxySnapshot:
    """Immutable routing snapshot without a credential-bearing representation."""

    fingerprint: str
    mode: ProxyMode
    schemes: tuple[str, ...]
    generation: int = 0
    _entries: tuple[tuple[str, str], ...] = field(default=(), repr=False)

    @property
    def fingerprint_short(self) -> str:
        return self.fingerprint[:12]

    @property
    def no_proxy_hosts(self) -> tuple[str, ...]:
        raw = self._value_for("no")
        return tuple(raw.split(",")) if raw else ()

    def proxy_for(self, scheme: str) -> str | None:
        key = str(scheme).strip().lower()
        if key not in _ROUTE_PROXY_KEYS:
            return None
        return self._value_for(key)

    def safe_summary(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "generation": self.generation,
            "schemes": self.schemes,
            "fingerprint": self.fingerprint_short,
        }

    def with_generation(self, generation: int) -> SystemProxySnapshot:
        return replace(self, generation=max(0, int(generation)))

    def _value_for(self, key: str) -> str | None:
        for entry_key, value in self._entries:
            if entry_key == key:
                return value
        return None


def normalize_system_proxies(proxy_info: Mapping[str, Any] | None) -> SystemProxySnapshot:
    """Normalize urllib proxy data into the HTTP routing semantics used by Keydex."""

    normalized: dict[str, str] = {}
    if isinstance(proxy_info, Mapping):
        for raw_key, raw_value in proxy_info.items():
            key = str(raw_key).strip().lower()
            if key not in _SUPPORTED_PROXY_KEYS or not isinstance(raw_value, str):
                continue
            value = raw_value.strip()
            if not value:
                continue
            if key == "no":
                hosts = sorted({host.strip() for host in value.split(",") if host.strip()})
                if hosts:
                    normalized[key] = ",".join(hosts)
                continue
            normalized[key] = value

    entries = tuple(sorted(normalized.items()))
    payload = json.dumps(entries, ensure_ascii=False, separators=(",", ":"))
    fingerprint = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    schemes = tuple(key for key in _ROUTE_PROXY_KEYS if key in normalized)
    no_proxy_hosts = tuple(normalized.get("no", "").split(","))
    mode: ProxyMode = "proxy" if schemes and "*" not in no_proxy_hosts else "direct"
    return SystemProxySnapshot(
        fingerprint=fingerprint,
        mode=mode,
        schemes=schemes,
        _entries=entries,
    )


class SystemProxyState:
    """Thread-safe, pull-based system proxy snapshot source."""

    def __init__(self, reader: ProxyReader = getproxies) -> None:
        self._reader = reader
        self._lock = threading.Lock()
        self._snapshot: SystemProxySnapshot | None = None
        self._reader_failure_type: str | None = None

    def current(self) -> SystemProxySnapshot:
        with self._lock:
            proxy_info = self._read_proxy_info()
            candidate = normalize_system_proxies(proxy_info)
            previous = self._snapshot
            if previous is None:
                self._snapshot = candidate
                return candidate
            if previous.fingerprint == candidate.fingerprint:
                return previous

            current = candidate.with_generation(previous.generation + 1)
            self._snapshot = current
            summary = current.safe_summary()
            logger.info(
                "[SystemProxy] network route changed | code=network_route_changed | "
                "mode={} | generation={} | schemes={} | fingerprint={}",
                summary["mode"],
                summary["generation"],
                ",".join(summary["schemes"]) or "-",
                summary["fingerprint"],
            )
            return current

    def _read_proxy_info(self) -> Mapping[str, Any]:
        try:
            value = self._reader()
        except Exception as exc:
            error_type = type(exc).__name__
            if error_type != self._reader_failure_type:
                logger.warning(
                    "[SystemProxy] failed to read system proxy | error_type={}",
                    error_type,
                )
                self._reader_failure_type = error_type
            if self._snapshot is not None:
                return dict(self._snapshot._entries)
            return {}
        self._reader_failure_type = None
        return value if isinstance(value, Mapping) else {}
