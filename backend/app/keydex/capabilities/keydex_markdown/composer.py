from __future__ import annotations

from backend.app.keydex.capabilities.base import CapabilityComposeResult
from backend.app.keydex.capabilities.keydex_markdown.models import (
    EffectiveKeydexMarkdownSnapshot,
    KeydexMarkdownLayerPayload,
)
from backend.app.keydex.models import (
    CapabilityLayerSnapshot,
    KeydexRuntimeMode,
)


def compose_keydex_markdown(
    *,
    mode: KeydexRuntimeMode,
    layers: tuple[CapabilityLayerSnapshot, ...],
) -> CapabilityComposeResult[EffectiveKeydexMarkdownSnapshot]:
    allowed_scopes = {"system"} if mode == "system_only" else {"system", "workspace"}
    documents_by_scope = {}
    diagnostics = []
    for layer in layers:
        diagnostics.extend(layer.diagnostics)
        if layer.scope not in allowed_scopes or not layer.available:
            continue
        payload = layer.payload
        if not isinstance(payload, KeydexMarkdownLayerPayload):
            continue
        document = payload.document
        if document is not None and document.contributes:
            documents_by_scope[layer.scope] = document

    documents = tuple(
        documents_by_scope[scope]
        for scope in ("system", "workspace")
        if scope in documents_by_scope
    )
    effective = EffectiveKeydexMarkdownSnapshot(documents=documents)
    return CapabilityComposeResult(
        payload=effective,
        available=True,
        sources=tuple(document.locator for document in documents),
        diagnostics=tuple(diagnostics),
    )
