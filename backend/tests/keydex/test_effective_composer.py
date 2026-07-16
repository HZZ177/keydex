from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest

from backend.app.keydex.capabilities.base import (
    CapabilityComposeResult,
    CapabilityKey,
    CapabilityLoadResult,
    CapabilityWatchSpec,
    KeydexCapabilityComposeError,
)
from backend.app.keydex.composer import KeydexEffectiveComposer
from backend.app.keydex.models import (
    CapabilityLayerSnapshot,
    KeydexLayerDescriptor,
    KeydexLayerSnapshot,
)
from backend.app.keydex.registry import KeydexCapabilityRegistry


class _JoiningCapability:
    format_revision = "1"
    supported_scopes = frozenset({"builtin", "system", "workspace"})
    watch_specs = (CapabilityWatchSpec("source.txt"),)

    def __init__(self, capability_id: str, *, fail: bool = False) -> None:
        self.id = capability_id
        self.effective_key = CapabilityKey(capability_id, tuple)
        self.fail = fail
        self.seen_scopes: tuple[str, ...] = ()

    def load_layer(self, **kwargs):
        return CapabilityLoadResult(payload=())

    def compose(self, *, mode, layers):
        self.seen_scopes = tuple(layer.scope for layer in layers)
        if self.fail:
            raise KeydexCapabilityComposeError(
                f"{self.id}_compose_failed",
                "controlled compose failure",
                logical_path=".keydex",
            )
        values = tuple(layer.payload for layer in layers if layer.available)
        sources = tuple(source for layer in layers for source in layer.sources)
        diagnostics = tuple(item for layer in layers for item in layer.diagnostics)
        return CapabilityComposeResult(
            payload=values,
            available=any(layer.available for layer in layers),
            sources=sources,
            diagnostics=diagnostics,
        )


def _layer(
    tmp_path: Path,
    scope: str,
    capability_ids: tuple[str, ...],
    *,
    suffix: str = "v1",
) -> KeydexLayerSnapshot:
    capabilities = {
        capability_id: CapabilityLayerSnapshot(
            capability_id=capability_id,
            scope=scope,  # type: ignore[arg-type]
            payload=f"{scope}-{capability_id}",
            fingerprint=f"{scope}-{capability_id}-{suffix}",
            sources=(f"{scope}:{capability_id}",),
        )
        for capability_id in capability_ids
    }
    return KeydexLayerSnapshot(
        descriptor=KeydexLayerDescriptor(
            scope=scope,  # type: ignore[arg-type]
            root=tmp_path / scope,
            logical_root=scope,
        ),
        capabilities=capabilities,
        fingerprint=f"{scope}-{suffix}",
        loaded_at=datetime.now(UTC),
    )


def test_kr08_core_composer_delegates_two_algorithms_in_registry_order(
    tmp_path: Path,
) -> None:
    first = _JoiningCapability("first")
    second = _JoiningCapability("second")
    composer = KeydexEffectiveComposer(
        registry=KeydexCapabilityRegistry((first, second))
    )
    layers = (
        _layer(tmp_path, "builtin", ("first", "second")),
        _layer(tmp_path, "system", ("first", "second")),
        _layer(tmp_path, "workspace", ("first", "second")),
    )

    snapshot = composer.compose(
        mode="workspace_effective",
        layers=layers,
        workspace_root=tmp_path / "workspace-root",
    )

    assert tuple(snapshot.capabilities) == ("first", "second")
    assert first.seen_scopes == ("builtin", "system", "workspace")
    assert second.seen_scopes == ("builtin", "system", "workspace")
    assert snapshot.require(first.effective_key) == (
        "builtin-first",
        "system-first",
        "workspace-first",
    )
    assert snapshot.capabilities["first"].sources == (
        "builtin:first",
        "system:first",
        "workspace:first",
    )


def test_capability_compose_failure_does_not_remove_other_effective_payload(
    tmp_path: Path,
) -> None:
    broken = _JoiningCapability("broken", fail=True)
    good = _JoiningCapability("good")
    composer = KeydexEffectiveComposer(
        registry=KeydexCapabilityRegistry((broken, good))
    )
    layers = (
        _layer(tmp_path, "builtin", ("broken", "good")),
        _layer(tmp_path, "system", ("broken", "good")),
    )

    snapshot = composer.compose(mode="system_only", layers=layers)

    assert snapshot.capabilities["broken"].available is False
    assert snapshot.capabilities["broken"].diagnostics[0].code == "broken_compose_failed"
    assert snapshot.require(good.effective_key) == ("builtin-good", "system-good")


def test_kr13_effective_fingerprint_is_stable_and_capability_sensitive(
    tmp_path: Path,
) -> None:
    capability = _JoiningCapability("sample")
    composer = KeydexEffectiveComposer(
        registry=KeydexCapabilityRegistry((capability,))
    )
    first_layers = (
        _layer(tmp_path / "one", "builtin", ("sample",)),
        _layer(tmp_path / "one", "system", ("sample",)),
    )
    equal_layers = (
        _layer(tmp_path / "two", "builtin", ("sample",)),
        _layer(tmp_path / "two", "system", ("sample",)),
    )
    changed_layers = (
        _layer(tmp_path / "three", "builtin", ("sample",)),
        _layer(tmp_path / "three", "system", ("sample",), suffix="v2"),
    )

    first = composer.compose(mode="system_only", layers=first_layers)
    equal = composer.compose(mode="system_only", layers=equal_layers)
    changed = composer.compose(mode="system_only", layers=changed_layers)

    assert first.fingerprint == equal.fingerprint
    assert first.fingerprint != changed.fingerprint


def test_runtime_mode_enforces_physical_layer_order(tmp_path: Path) -> None:
    capability = _JoiningCapability("sample")
    composer = KeydexEffectiveComposer(
        registry=KeydexCapabilityRegistry((capability,))
    )
    system = _layer(tmp_path, "system", ("sample",))
    builtin = _layer(tmp_path, "builtin", ("sample",))

    with pytest.raises(ValueError, match="requires ordered layers"):
        composer.compose(mode="system_only", layers=(system, builtin))
