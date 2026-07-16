from __future__ import annotations

from pathlib import Path
from typing import Any

from backend.app.keydex.capabilities.base import (
    CapabilityKey,
    CapabilityLoadResult,
    CapabilityWatchSpec,
)
from backend.app.keydex.capabilities.keydex_markdown.composer import (
    compose_keydex_markdown,
)
from backend.app.keydex.capabilities.keydex_markdown.loader import (
    load_keydex_markdown_layer,
)
from backend.app.keydex.capabilities.keydex_markdown.models import (
    EffectiveKeydexMarkdownSnapshot,
    KeydexMarkdownLayerPayload,
)
from backend.app.keydex.models import KeydexRuntimeMode, KeydexScope

KEYDEX_MARKDOWN_CAPABILITY_KEY: CapabilityKey[EffectiveKeydexMarkdownSnapshot] = (
    CapabilityKey("keydex_markdown", EffectiveKeydexMarkdownSnapshot)
)


class KeydexMarkdownCapability:
    id = "keydex_markdown"
    effective_key = KEYDEX_MARKDOWN_CAPABILITY_KEY
    format_revision = "1"
    supported_scopes: frozenset[KeydexScope] = frozenset({"system", "workspace"})
    watch_specs = (CapabilityWatchSpec("keydex.md"),)

    def load_layer(
        self,
        *,
        scope: KeydexScope,
        root: Path,
    ) -> CapabilityLoadResult[KeydexMarkdownLayerPayload]:
        return load_keydex_markdown_layer(scope=scope, root=root)

    def compose(
        self,
        *,
        mode: KeydexRuntimeMode,
        layers: tuple[Any, ...],
    ) -> Any:
        return compose_keydex_markdown(mode=mode, layers=layers)
