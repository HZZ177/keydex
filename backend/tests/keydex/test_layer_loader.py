from __future__ import annotations

from pathlib import Path

import pytest

from backend.app.keydex.capabilities.base import (
    CapabilityKey,
    CapabilityLoadResult,
    CapabilityWatchSpec,
    KeydexCapabilityLoadError,
)
from backend.app.keydex.loader import KeydexLayerLoader
from backend.app.keydex.models import KeydexLayerDescriptor
from backend.app.keydex.registry import KeydexCapabilityRegistry
from backend.app.keydex.runtime import KeydexSnapshotUnstableError


class _Capability:
    supported_scopes = frozenset({"system", "workspace"})

    def __init__(
        self,
        capability_id: str,
        relative_path: str,
        *,
        fail: bool = False,
        mutate: tuple[Path, str] | None = None,
    ) -> None:
        self.id = capability_id
        self.effective_key = CapabilityKey(capability_id)
        self.format_revision = "1"
        self.watch_specs = (CapabilityWatchSpec(relative_path),)
        self.fail = fail
        self.mutate = mutate
        self.calls = 0

    def load_layer(self, *, scope, root):
        self.calls += 1
        if self.mutate is not None and self.calls == 1:
            path, content = self.mutate
            path.write_text(content, encoding="utf-8")
        if self.fail:
            raise KeydexCapabilityLoadError(
                f"{self.id}_invalid",
                "controlled capability failure",
                logical_path=f".keydex/{self.watch_specs[0].relative_path}",
            )
        source = root / self.watch_specs[0].relative_path
        if not source.is_file():
            return CapabilityLoadResult(payload="", state="empty")
        return CapabilityLoadResult(payload=source.read_text(encoding="utf-8"))

    def compose(self, **kwargs):
        return kwargs["layers"]


def _descriptor(tmp_path: Path, scope="system") -> KeydexLayerDescriptor:
    return KeydexLayerDescriptor(
        scope=scope,
        root=tmp_path / ".keydex",
        logical_root=".keydex",
    )


def test_kr08_controlled_capability_failure_is_isolated(tmp_path: Path) -> None:
    descriptor = _descriptor(tmp_path)
    descriptor.root.mkdir()
    (descriptor.root / "good.txt").write_text("good", encoding="utf-8")
    broken = _Capability("broken", "broken.txt", fail=True)
    good = _Capability("good", "good.txt")
    loader = KeydexLayerLoader(registry=KeydexCapabilityRegistry((broken, good)))

    snapshot = loader.load(descriptor)

    assert snapshot.capabilities["broken"].state == "failed"
    assert snapshot.capabilities["broken"].diagnostics[0].code == "broken_invalid"
    assert snapshot.capabilities["good"].payload == "good"
    assert snapshot.capabilities["good"].state == "loaded"


@pytest.mark.parametrize("mutating_id", ["first", "second"])
def test_kr12_any_capability_change_retries_the_entire_layer(
    tmp_path: Path,
    mutating_id: str,
) -> None:
    descriptor = _descriptor(tmp_path)
    descriptor.root.mkdir()
    first_path = descriptor.root / "first.txt"
    second_path = descriptor.root / "second.txt"
    first_path.write_text("first-v1", encoding="utf-8")
    second_path.write_text("second-v1", encoding="utf-8")
    mutation = second_path if mutating_id == "first" else first_path
    first = _Capability(
        "first",
        "first.txt",
        mutate=(mutation, "changed") if mutating_id == "first" else None,
    )
    second = _Capability(
        "second",
        "second.txt",
        mutate=(mutation, "changed") if mutating_id == "second" else None,
    )
    loader = KeydexLayerLoader(
        registry=KeydexCapabilityRegistry((first, second)),
        attempts=3,
    )

    snapshot = loader.load(descriptor)

    assert first.calls == 2
    assert second.calls == 2
    assert snapshot.capabilities["first"].payload == first_path.read_text(encoding="utf-8")
    assert snapshot.capabilities["second"].payload == second_path.read_text(encoding="utf-8")


def test_unstable_layer_never_publishes_a_partial_snapshot(tmp_path: Path) -> None:
    descriptor = _descriptor(tmp_path)
    descriptor.root.mkdir()
    source = descriptor.root / "source.txt"
    source.write_text("0", encoding="utf-8")
    capability = _Capability("sample", "source.txt")

    def always_changing(scope, root):
        current = int(source.read_text(encoding="utf-8")) + 1
        source.write_text(str(current), encoding="utf-8")
        from backend.app.keydex.runtime import build_keydex_layer_fingerprint

        return build_keydex_layer_fingerprint(
            scope,
            root,
            registry=KeydexCapabilityRegistry((capability,)),
        )

    loader = KeydexLayerLoader(
        registry=KeydexCapabilityRegistry((capability,)),
        attempts=2,
        fingerprint_builder=always_changing,
    )

    with pytest.raises(KeydexSnapshotUnstableError) as exc_info:
        loader.load(descriptor)

    assert exc_info.value.code == "keydex_snapshot_unstable"
    assert exc_info.value.scope == "system"


def test_km11_builtin_unsupported_capability_is_empty_without_loading(tmp_path: Path) -> None:
    capability = _Capability("keydex_markdown", "keydex.md")
    capability.supported_scopes = frozenset({"system", "workspace"})
    descriptor = KeydexLayerDescriptor(
        scope="builtin",
        root=tmp_path / "builtin",
        logical_root="builtin",
    )
    descriptor.root.mkdir()
    (descriptor.root / "keydex.md").write_text("ignored", encoding="utf-8")
    loader = KeydexLayerLoader(registry=KeydexCapabilityRegistry((capability,)))

    snapshot = loader.load(descriptor)

    assert snapshot.capabilities["keydex_markdown"].state == "unsupported"
    assert snapshot.capabilities["keydex_markdown"].payload is None
    assert capability.calls == 0


def test_non_directory_root_fails_supported_capabilities_without_calling_them(
    tmp_path: Path,
) -> None:
    descriptor = _descriptor(tmp_path)
    descriptor.root.parent.mkdir(parents=True, exist_ok=True)
    descriptor.root.write_text("not a directory", encoding="utf-8")
    capability = _Capability("sample", "source.txt")
    loader = KeydexLayerLoader(registry=KeydexCapabilityRegistry((capability,)))

    snapshot = loader.load(descriptor)

    assert snapshot.capabilities["sample"].state == "failed"
    assert snapshot.capabilities["sample"].diagnostics[0].code == "keydex_root_invalid"
    assert capability.calls == 0
