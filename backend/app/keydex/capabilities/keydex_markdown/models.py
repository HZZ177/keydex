from __future__ import annotations

from dataclasses import dataclass

from backend.app.keydex.models import KeydexScope


@dataclass(frozen=True)
class KeydexMarkdownDocument:
    """One immutable, path-safe keydex.md document captured from a layer."""

    scope: KeydexScope
    locator: str
    content: str
    raw_hash: str
    byte_size: int

    def __post_init__(self) -> None:
        if self.scope not in {"system", "workspace"}:
            raise ValueError("keydex.md documents only support system/workspace scope")
        expected_locator = keydex_markdown_locator(self.scope)
        if self.locator != expected_locator:
            raise ValueError(f"invalid keydex.md locator for {self.scope}: {self.locator}")
        if len(self.raw_hash) != 64:
            raise ValueError("keydex.md raw hash must be a SHA-256 hex digest")
        if self.byte_size < 0:
            raise ValueError("keydex.md byte size must not be negative")

    @property
    def contributes(self) -> bool:
        return bool(self.content.strip())


@dataclass(frozen=True)
class KeydexMarkdownLayerPayload:
    """Frozen contribution from one physical Keydex layer."""

    scope: KeydexScope
    locator: str
    document: KeydexMarkdownDocument | None = None

    def __post_init__(self) -> None:
        if self.scope not in {"system", "workspace"}:
            raise ValueError("keydex.md layer payload only supports system/workspace scope")
        if self.locator != keydex_markdown_locator(self.scope):
            raise ValueError(f"invalid keydex.md locator for {self.scope}: {self.locator}")
        if self.document is not None and self.document.scope != self.scope:
            raise ValueError("keydex.md document scope must match its layer payload")


@dataclass(frozen=True)
class EffectiveKeydexMarkdownSnapshot:
    """Ordered effective Markdown documents ready for prompt rendering."""

    documents: tuple[KeydexMarkdownDocument, ...] = ()

    def __post_init__(self) -> None:
        documents = tuple(self.documents)
        scopes = tuple(document.scope for document in documents)
        if len(scopes) != len(set(scopes)):
            raise ValueError("effective keydex.md documents must have unique scopes")
        if scopes not in {(), ("system",), ("workspace",), ("system", "workspace")}:
            raise ValueError("effective keydex.md documents must be system then workspace")
        if any(not document.contributes for document in documents):
            raise ValueError("blank keydex.md documents must not enter the effective snapshot")
        object.__setattr__(self, "documents", documents)

    @property
    def scopes(self) -> tuple[KeydexScope, ...]:
        return tuple(document.scope for document in self.documents)


def keydex_markdown_locator(scope: KeydexScope) -> str:
    if scope == "system":
        return "system:keydex.md"
    if scope == "workspace":
        return "workspace:.keydex/keydex.md"
    raise ValueError("builtin does not support keydex.md")
