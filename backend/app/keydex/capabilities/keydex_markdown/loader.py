from __future__ import annotations

import hashlib
import stat
from pathlib import Path

from backend.app.keydex.capabilities.base import (
    CapabilityLoadResult,
    KeydexCapabilityLoadError,
)
from backend.app.keydex.capabilities.keydex_markdown.models import (
    KeydexMarkdownDocument,
    KeydexMarkdownLayerPayload,
    keydex_markdown_locator,
)
from backend.app.keydex.models import KeydexScope
from backend.app.security.workspace import is_relative_to

KEYDEX_MARKDOWN_MAX_BYTES = 32 * 1024


def load_keydex_markdown_layer(
    *,
    scope: KeydexScope,
    root: Path,
) -> CapabilityLoadResult[KeydexMarkdownLayerPayload]:
    locator = keydex_markdown_locator(scope)
    layer_root = Path(root).expanduser().absolute()
    source = layer_root / "keydex.md"
    payload = KeydexMarkdownLayerPayload(scope=scope, locator=locator)

    if _is_link_like(layer_root):
        raise _load_error(
            "keydex_markdown_forbidden",
            "Keydex layer root must not be a symlink, junction, or reparse point.",
            locator,
        )
    if not source.exists() and not source.is_symlink():
        return CapabilityLoadResult(payload=payload, state="empty")
    if _is_link_like(source):
        raise _load_error(
            "keydex_markdown_forbidden",
            "keydex.md must not be a symlink, junction, or reparse point.",
            locator,
        )
    try:
        source_stat = source.stat(follow_symlinks=False)
    except OSError as exc:
        raise _load_error(
            "keydex_markdown_unreadable",
            "keydex.md could not be inspected.",
            locator,
        ) from exc
    if not stat.S_ISREG(source_stat.st_mode):
        raise _load_error(
            "keydex_markdown_not_file",
            "keydex.md must be a regular file.",
            locator,
        )
    try:
        resolved_source = source.resolve(strict=True)
        resolved_root = layer_root.resolve(strict=True)
    except OSError as exc:
        raise _load_error(
            "keydex_markdown_unreadable",
            "keydex.md could not be resolved.",
            locator,
        ) from exc
    if not is_relative_to(resolved_source, resolved_root):
        raise _load_error(
            "keydex_markdown_forbidden",
            "keydex.md must stay inside its Keydex layer.",
            locator,
        )
    if source_stat.st_size > KEYDEX_MARKDOWN_MAX_BYTES:
        raise _load_error(
            "keydex_markdown_too_large",
            f"keydex.md exceeds {KEYDEX_MARKDOWN_MAX_BYTES} bytes.",
            locator,
            details={"limit": KEYDEX_MARKDOWN_MAX_BYTES, "actual": source_stat.st_size},
        )
    try:
        raw = source.read_bytes()
    except OSError as exc:
        raise _load_error(
            "keydex_markdown_unreadable",
            "keydex.md could not be read.",
            locator,
        ) from exc
    if len(raw) > KEYDEX_MARKDOWN_MAX_BYTES:
        raise _load_error(
            "keydex_markdown_too_large",
            f"keydex.md exceeds {KEYDEX_MARKDOWN_MAX_BYTES} bytes.",
            locator,
            details={"limit": KEYDEX_MARKDOWN_MAX_BYTES, "actual": len(raw)},
        )
    if b"\0" in raw:
        raise _load_error(
            "keydex_markdown_not_text",
            "keydex.md must be valid UTF-8 text without NUL bytes.",
            locator,
        )
    try:
        content = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise _load_error(
            "keydex_markdown_not_text",
            "keydex.md must be valid UTF-8 text.",
            locator,
        ) from exc

    document = KeydexMarkdownDocument(
        scope=scope,
        locator=locator,
        content=content,
        raw_hash=hashlib.sha256(raw).hexdigest(),
        byte_size=len(raw),
    )
    return CapabilityLoadResult(
        payload=KeydexMarkdownLayerPayload(
            scope=scope,
            locator=locator,
            document=document,
        ),
        state="loaded" if document.contributes else "empty",
    )


def _load_error(
    code: str,
    reason: str,
    locator: str,
    *,
    details: dict[str, int] | None = None,
) -> KeydexCapabilityLoadError:
    return KeydexCapabilityLoadError(
        code,
        reason,
        logical_path=locator,
        details=details,
    )


def _is_link_like(path: Path) -> bool:
    if path.is_symlink():
        return True
    is_junction = getattr(path, "is_junction", None)
    if callable(is_junction) and is_junction():
        return True
    try:
        return bool(path.lstat().st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT)
    except (AttributeError, FileNotFoundError, OSError):
        return False
