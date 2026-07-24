from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path, PurePosixPath

DATA_REFERENCE_PREFIX = "keydex-data://"
STORAGE_LAYOUT_MARKER = ".storage-layout-v2.json"


def managed_data_reference(data_dir: Path, target: Path) -> str:
    root = data_dir.expanduser().resolve()
    resolved = target.expanduser().resolve(strict=False)
    try:
        relative = resolved.relative_to(root)
    except ValueError as exc:
        raise ValueError("managed data reference must stay inside the Keydex data root") from exc
    if not relative.parts:
        raise ValueError("managed data reference cannot point at the data root")
    return f"{DATA_REFERENCE_PREFIX}{relative.as_posix()}"


def resolve_data_path(data_dir: Path, value: str | Path) -> Path:
    root = data_dir.expanduser().resolve()
    raw = str(value).strip()
    if raw.startswith(DATA_REFERENCE_PREFIX):
        relative = _safe_reference_path(raw.removeprefix(DATA_REFERENCE_PREFIX))
        return _contained_path(root, relative)

    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        return _contained_path(root, candidate)

    resolved = candidate.resolve(strict=False)
    for legacy_root, replacement_root in _legacy_aliases(str(root)):
        try:
            relative = resolved.relative_to(legacy_root)
        except ValueError:
            continue
        return _contained_path(replacement_root, relative)
    return resolved


def _safe_reference_path(raw: str) -> Path:
    reference = PurePosixPath(raw.replace("\\", "/"))
    if reference.is_absolute() or not reference.parts:
        raise ValueError("invalid Keydex data reference")
    if any(part in {"", ".", ".."} for part in reference.parts):
        raise ValueError("invalid Keydex data reference")
    return Path(*reference.parts)


def _contained_path(root: Path, relative: Path) -> Path:
    resolved = (root / relative).resolve(strict=False)
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise ValueError("Keydex data path escapes the managed data root") from exc
    return resolved


@lru_cache(maxsize=16)
def _legacy_aliases(data_dir: str) -> tuple[tuple[Path, Path], ...]:
    root = Path(data_dir)
    marker_path = root / STORAGE_LAYOUT_MARKER
    try:
        payload = json.loads(marker_path.read_text(encoding="utf-8"))
    except (OSError, TypeError, ValueError):
        return ()

    aliases: list[tuple[Path, Path]] = []
    roaming = payload.get("legacyRoamingDataDir") or payload.get(
        "legacy_roaming_data_dir"
    )
    local = payload.get("legacyLocalDataDir") or payload.get("legacy_local_data_dir")
    if isinstance(roaming, str) and roaming.strip():
        aliases.append((Path(roaming).expanduser().resolve(strict=False), root))
    if isinstance(local, str) and local.strip():
        aliases.append(
            (
                Path(local).expanduser().resolve(strict=False),
                root / "webview" / "main",
            )
        )
    return tuple(aliases)
