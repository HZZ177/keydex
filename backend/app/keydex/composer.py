from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from backend.app.core.time import utc_now
from backend.app.keydex.capabilities.base import (
    CapabilityComposeResult,
    KeydexCapabilityComposeError,
)
from backend.app.keydex.models import (
    EffectiveCapabilitySnapshot,
    KeydexDiagnostic,
    KeydexEffectiveSnapshot,
    KeydexLayerSnapshot,
    KeydexRuntimeMode,
)
from backend.app.keydex.registry import (
    DEFAULT_KEYDEX_CAPABILITY_REGISTRY,
    KEYDEX_RUNTIME_REVISION,
    KeydexCapabilityRegistry,
)


class KeydexEffectiveComposer:
    """Compose effective capabilities without knowing their payload types."""

    def __init__(
        self,
        *,
        registry: KeydexCapabilityRegistry = DEFAULT_KEYDEX_CAPABILITY_REGISTRY,
        runtime_revision: str = KEYDEX_RUNTIME_REVISION,
    ) -> None:
        self.registry = registry
        self.runtime_revision = runtime_revision

    def compose(
        self,
        *,
        mode: KeydexRuntimeMode,
        layers: tuple[KeydexLayerSnapshot, ...],
        workspace_root: str | Path | None = None,
    ) -> KeydexEffectiveSnapshot:
        ordered_layers = self._validate_layers(mode, tuple(layers))
        effective: dict[str, EffectiveCapabilitySnapshot] = {}
        for capability in self.registry:
            contributions = tuple(
                layer.capabilities[capability.id]
                for layer in ordered_layers
                if capability.id in layer.capabilities
            )
            fingerprint = _capability_effective_fingerprint(
                runtime_revision=self.runtime_revision,
                capability_id=capability.id,
                format_revision=capability.format_revision,
                mode=mode,
                layers=contributions,
            )
            try:
                result = capability.compose(mode=mode, layers=contributions)
                if not isinstance(result, CapabilityComposeResult):
                    raise TypeError(
                        f"{capability.id}.compose must return CapabilityComposeResult"
                    )
                snapshot = EffectiveCapabilitySnapshot(
                    capability_id=capability.id,
                    key=capability.effective_key,
                    payload=result.payload,
                    fingerprint=fingerprint,
                    available=result.available,
                    sources=result.sources,
                    diagnostics=result.diagnostics,
                )
            except KeydexCapabilityComposeError as exc:
                diagnostic = KeydexDiagnostic(
                    code=exc.code,
                    reason=exc.reason,
                    severity="error",
                    details=exc.details,
                    capability_id=capability.id,
                    logical_path=exc.logical_path,
                )
                snapshot = EffectiveCapabilitySnapshot(
                    capability_id=capability.id,
                    key=capability.effective_key,
                    payload=None,
                    fingerprint=fingerprint,
                    available=False,
                    diagnostics=(diagnostic,),
                )
            effective[capability.id] = snapshot
        diagnostics = tuple(
            diagnostic
            for capability in effective.values()
            for diagnostic in capability.diagnostics
        )
        return KeydexEffectiveSnapshot(
            mode=mode,
            layers=ordered_layers,
            capabilities=effective,
            fingerprint=_effective_fingerprint(
                runtime_revision=self.runtime_revision,
                mode=mode,
                capabilities=effective,
            ),
            loaded_at=utc_now(),
            diagnostics=diagnostics,
            workspace_root=workspace_root,
        )

    @staticmethod
    def _validate_layers(
        mode: KeydexRuntimeMode,
        layers: tuple[KeydexLayerSnapshot, ...],
    ) -> tuple[KeydexLayerSnapshot, ...]:
        expected = (
            ("builtin", "system")
            if mode == "system_only"
            else ("builtin", "system", "workspace")
        )
        actual = tuple(layer.scope for layer in layers)
        if actual != expected:
            raise ValueError(
                f"{mode} requires ordered layers {expected!r}, got {actual!r}"
            )
        return layers


def _capability_effective_fingerprint(
    *,
    runtime_revision: str,
    capability_id: str,
    format_revision: str,
    mode: KeydexRuntimeMode,
    layers: tuple[Any, ...],
) -> str:
    return _digest(
        {
            "runtime_revision": runtime_revision,
            "capability_id": capability_id,
            "format_revision": format_revision,
            "mode": mode,
            "layers": tuple(
                {
                    "scope": layer.scope,
                    "fingerprint": layer.fingerprint,
                    "state": layer.state,
                    "available": layer.available,
                }
                for layer in layers
            ),
        }
    )


def _effective_fingerprint(
    *,
    runtime_revision: str,
    mode: KeydexRuntimeMode,
    capabilities: dict[str, EffectiveCapabilitySnapshot],
) -> str:
    return _digest(
        {
            "runtime_revision": runtime_revision,
            "mode": mode,
            "capabilities": tuple(
                (capability_id, snapshot.fingerprint)
                for capability_id, snapshot in capabilities.items()
            ),
        }
    )


def _digest(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()
