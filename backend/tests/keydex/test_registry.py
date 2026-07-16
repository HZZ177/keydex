from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from backend.app.keydex.capabilities.base import (
    CapabilityKey,
    CapabilityWatchSpec,
    UnsupportedCapabilityLayer,
    load_capability_layer,
)
from backend.app.keydex.capabilities.keydex_markdown import (
    KEYDEX_MARKDOWN_CAPABILITY_KEY,
)
from backend.app.keydex.capabilities.skills import SKILLS_CAPABILITY_KEY
from backend.app.keydex.registry import (
    DEFAULT_KEYDEX_CAPABILITY_REGISTRY,
    KEYDEX_RUNTIME_REVISION,
    KeydexCapabilityRegistry,
)


class _Capability:
    format_revision = "test-1"
    supported_scopes = frozenset({"system"})
    watch_specs = (CapabilityWatchSpec("source.txt"),)

    def __init__(self, capability_id: str, key: CapabilityKey[Any]) -> None:
        self.id = capability_id
        self.effective_key = key
        self.load_calls = 0

    def load_layer(self, *, scope: str, root: Path) -> str:
        self.load_calls += 1
        return f"{scope}:{root.name}"

    def compose(self, *, mode: str, layers: tuple[Any, ...]) -> tuple[Any, ...]:
        return layers


def test_kr01_default_registry_is_ordered_immutable_and_typed() -> None:
    registry = DEFAULT_KEYDEX_CAPABILITY_REGISTRY

    assert KEYDEX_RUNTIME_REVISION == "2"
    assert tuple(item.id for item in registry) == ("skills", "keydex_markdown")
    assert registry.capabilities == tuple(registry)
    assert registry.get_by_key(SKILLS_CAPABILITY_KEY).id == "skills"
    assert registry.get_by_key(KEYDEX_MARKDOWN_CAPABILITY_KEY).id == "keydex_markdown"
    with pytest.raises(AttributeError):
        registry.capabilities.append("extra")  # type: ignore[attr-defined]


@pytest.mark.parametrize(
    ("capabilities", "error"),
    [
        ((_Capability("", CapabilityKey("one")),), "id must not be empty"),
        (
            (
                _Capability("same", CapabilityKey("one")),
                _Capability("same", CapabilityKey("two")),
            ),
            "duplicate capability id",
        ),
        (
            (
                _Capability("one", CapabilityKey("same")),
                _Capability("two", CapabilityKey("same")),
            ),
            "duplicate capability typed key",
        ),
    ],
)
def test_kr02_registry_rejects_invalid_identity(
    capabilities: tuple[_Capability, ...],
    error: str,
) -> None:
    with pytest.raises(ValueError, match=error):
        KeydexCapabilityRegistry(capabilities)


def test_kr03_unsupported_scope_is_neutral_without_calling_loader(tmp_path: Path) -> None:
    capability = _Capability("sample", CapabilityKey("sample"))

    result = load_capability_layer(capability, scope="workspace", root=tmp_path)

    assert result == UnsupportedCapabilityLayer(
        capability_id="sample",
        scope="workspace",
    )
    assert capability.load_calls == 0
