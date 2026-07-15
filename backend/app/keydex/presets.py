from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from backend.app.keydex.models import KeydexDiagnostic, resolve_system_keydex_root
from backend.app.keydex.skills.frontmatter import parse_skill_frontmatter, validate_skill_name
from backend.app.keydex.skills.model import SkillDefinitionError, canonical_skill_name

PRESET_CATALOG_SCHEMA_VERSION = 1
PRESET_STATE_SCHEMA_VERSION = 1
BUNDLED_PRESETS_ROOT = Path(__file__).resolve().parent / "bundled_presets"
MANAGED_DIR_NAME = ".keydex-managed"
STATE_FILE_NAME = "presets.json"
LOCK_FILE_NAME = "provision.lock"
STAGING_DIR_NAME = "staging"
DEFAULT_STALE_LOCK_SECONDS = 300.0

PresetProvisionStatus = Literal["empty", "completed", "busy", "failed"]
PresetItemStatus = Literal["installed", "skipped_existing"]


@dataclass(frozen=True)
class BundledPreset:
    id: str
    skill_name: str
    version: int
    content_sha256: str
    source_dir: Path


@dataclass(frozen=True)
class PresetCatalog:
    presets: tuple[BundledPreset, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class PresetProvisionResult:
    status: PresetProvisionStatus
    installed: tuple[str, ...] = field(default_factory=tuple)
    skipped_existing: tuple[str, ...] = field(default_factory=tuple)
    diagnostics: tuple[KeydexDiagnostic, ...] = field(default_factory=tuple)


class PresetValidationError(ValueError):
    def __init__(self, code: str, reason: str, *, path: str | None = None) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason
        self.path = path

    def to_diagnostic(self) -> KeydexDiagnostic:
        return KeydexDiagnostic(
            code=self.code,
            reason=self.reason,
            path=self.path,
            severity="error",
        )


def provision_bundled_presets(
    *,
    bundle_root: str | Path = BUNDLED_PRESETS_ROOT,
    system_root: str | Path | None = None,
    stale_lock_seconds: float = DEFAULT_STALE_LOCK_SECONDS,
) -> PresetProvisionResult:
    """Seed unseen bundled presets into the system layer without taking ownership of them."""

    try:
        catalog = load_and_validate_preset_catalog(bundle_root)
    except PresetValidationError as exc:
        return PresetProvisionResult(status="failed", diagnostics=(exc.to_diagnostic(),))

    # This branch deliberately runs before resolving or creating the system root.
    if not catalog.presets:
        return PresetProvisionResult(status="empty")

    target_root = (
        Path(system_root).expanduser().resolve()
        if system_root is not None
        else resolve_system_keydex_root()
    )
    managed_root = target_root / MANAGED_DIR_NAME
    lock_path = managed_root / LOCK_FILE_NAME
    try:
        managed_root.mkdir(parents=True, exist_ok=True)
        acquired = _acquire_lock(lock_path, stale_lock_seconds=stale_lock_seconds)
    except OSError:
        return _failed_result("preset_lock_unavailable", "preset provision lock is unavailable")
    if not acquired:
        return PresetProvisionResult(
            status="busy",
            diagnostics=(
                KeydexDiagnostic(
                    code="preset_provision_busy",
                    reason="another preset provision operation is active",
                    path=f"{MANAGED_DIR_NAME}/{LOCK_FILE_NAME}",
                    severity="warning",
                ),
            ),
        )

    installed: list[str] = []
    skipped_existing: list[str] = []
    staging_root = managed_root / STAGING_DIR_NAME
    try:
        _cleanup_staging(staging_root)
        state_path = managed_root / STATE_FILE_NAME
        state = _load_state(state_path)
        state_items = state["presets"]
        skills_root = target_root / "skills"
        for preset in catalog.presets:
            if preset.id in state_items:
                continue

            target = skills_root / preset.skill_name
            if _path_exists(target):
                state_items[preset.id] = _state_item(preset, status="skipped_existing")
                _write_state_atomic(state_path, state)
                skipped_existing.append(preset.skill_name)
                continue

            skills_root.mkdir(parents=True, exist_ok=True)
            staging_root.mkdir(parents=True, exist_ok=True)
            temporary_root = Path(tempfile.mkdtemp(prefix="preset-", dir=staging_root))
            staged_skill = temporary_root / "skill"
            try:
                # Preserve any link introduced by a validation/copy race so the
                # staged tree validator rejects it instead of following it.
                shutil.copytree(preset.source_dir, staged_skill, symlinks=True)
                copied_hash = deterministic_tree_sha256(staged_skill)
                if copied_hash != preset.content_sha256:
                    raise PresetValidationError(
                        "preset_staging_hash_mismatch",
                        "copied preset content does not match its catalog hash",
                        path=f"skills/{preset.skill_name}",
                    )
                if _path_exists(target):
                    state_items[preset.id] = _state_item(preset, status="skipped_existing")
                    _write_state_atomic(state_path, state)
                    skipped_existing.append(preset.skill_name)
                    continue
                staged_skill.rename(target)
                state_items[preset.id] = _state_item(preset, status="installed")
                _write_state_atomic(state_path, state)
                installed.append(preset.skill_name)
            finally:
                shutil.rmtree(temporary_root, ignore_errors=True)
        _cleanup_staging(staging_root)
        return PresetProvisionResult(
            status="completed",
            installed=tuple(installed),
            skipped_existing=tuple(skipped_existing),
        )
    except PresetValidationError as exc:
        return PresetProvisionResult(status="failed", diagnostics=(exc.to_diagnostic(),))
    except OSError:
        return _failed_result("preset_provision_failed", "preset provision could not be completed")
    finally:
        try:
            lock_path.unlink(missing_ok=True)
        except OSError:
            pass


def load_and_validate_preset_catalog(bundle_root: str | Path) -> PresetCatalog:
    root = Path(bundle_root).expanduser().resolve()
    catalog_path = root / "catalog.json"
    try:
        payload = json.loads(catalog_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise PresetValidationError(
            "preset_catalog_invalid",
            "bundled preset catalog is unreadable or invalid JSON",
            path="catalog.json",
        ) from exc
    if not isinstance(payload, dict):
        raise PresetValidationError(
            "preset_catalog_invalid", "preset catalog must be an object", path="catalog.json"
        )
    if set(payload) != {"schema_version", "presets"}:
        raise PresetValidationError(
            "preset_catalog_invalid",
            "preset catalog fields must be schema_version and presets",
            path="catalog.json",
        )
    if payload["schema_version"] != PRESET_CATALOG_SCHEMA_VERSION:
        raise PresetValidationError(
            "preset_catalog_version_unsupported",
            "preset catalog schema_version is unsupported",
            path="catalog.json",
        )
    items = payload["presets"]
    if not isinstance(items, list):
        raise PresetValidationError(
            "preset_catalog_invalid", "preset catalog presets must be an array", path="catalog.json"
        )

    presets: list[BundledPreset] = []
    ids: set[str] = set()
    names: set[str] = set()
    for index, item in enumerate(items):
        logical_path = f"catalog.json#presets/{index}"
        preset = _parse_preset(root, item, logical_path=logical_path)
        if preset.id in ids:
            raise PresetValidationError(
                "preset_id_duplicate", "preset ids must be unique", path=logical_path
            )
        canonical_name = canonical_skill_name(preset.skill_name)
        if canonical_name in names:
            raise PresetValidationError(
                "preset_skill_name_duplicate",
                "preset skill names must be unique ignoring case",
                path=logical_path,
            )
        ids.add(preset.id)
        names.add(canonical_name)
        presets.append(preset)
    return PresetCatalog(presets=tuple(presets))


def deterministic_tree_sha256(root: str | Path) -> str:
    tree_root = Path(root).expanduser().resolve()
    if not tree_root.is_dir() or _is_link_like(tree_root):
        raise PresetValidationError(
            "preset_tree_invalid", "preset tree must be a real directory"
        )
    files: list[tuple[str, Path]] = []
    _collect_regular_files(tree_root, tree_root, files)
    digest = hashlib.sha256()
    for relative, path in sorted(files, key=lambda item: item[0]):
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        try:
            digest.update(path.read_bytes())
        except OSError as exc:
            raise PresetValidationError(
                "preset_tree_unreadable",
                "preset tree contains an unreadable file",
                path=relative,
            ) from exc
        digest.update(b"\0")
    return digest.hexdigest()


def _parse_preset(root: Path, item: Any, *, logical_path: str) -> BundledPreset:
    if not isinstance(item, dict) or set(item) != {
        "id",
        "skill_name",
        "version",
        "content_sha256",
    }:
        raise PresetValidationError(
            "preset_catalog_item_invalid",
            "preset item fields must be id, skill_name, version, and content_sha256",
            path=logical_path,
        )
    preset_id = item["id"]
    if not isinstance(preset_id, str) or not preset_id.strip() or len(preset_id) > 128:
        raise PresetValidationError(
            "preset_id_invalid", "preset id must be a non-empty string", path=logical_path
        )
    try:
        skill_name = validate_skill_name(item["skill_name"], path=logical_path)
    except SkillDefinitionError as exc:
        raise PresetValidationError(exc.code, exc.reason, path=logical_path) from exc
    version = item["version"]
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        raise PresetValidationError(
            "preset_version_invalid", "preset version must be a positive integer", path=logical_path
        )
    content_sha256 = item["content_sha256"]
    if (
        not isinstance(content_sha256, str)
        or len(content_sha256) != 64
        or any(character not in "0123456789abcdef" for character in content_sha256)
    ):
        raise PresetValidationError(
            "preset_hash_invalid",
            "preset content_sha256 must be a lowercase SHA-256 digest",
            path=logical_path,
        )
    source_dir = root / "skills" / skill_name
    actual_hash = deterministic_tree_sha256(source_dir)
    entry_file = source_dir / "SKILL.md"
    try:
        metadata = parse_skill_frontmatter(entry_file)
    except SkillDefinitionError as exc:
        raise PresetValidationError(
            exc.code, exc.reason, path=f"skills/{skill_name}/SKILL.md"
        ) from exc
    if metadata["name"] != skill_name or source_dir.name != skill_name:
        raise PresetValidationError(
            "preset_skill_name_mismatch",
            "catalog, directory, and SKILL.md names must match exactly",
            path=f"skills/{skill_name}/SKILL.md",
        )
    if actual_hash != content_sha256:
        raise PresetValidationError(
            "preset_hash_mismatch",
            "preset tree does not match its catalog hash",
            path=f"skills/{skill_name}",
        )
    return BundledPreset(
        id=preset_id.strip(),
        skill_name=skill_name,
        version=version,
        content_sha256=content_sha256,
        source_dir=source_dir,
    )


def _collect_regular_files(root: Path, directory: Path, files: list[tuple[str, Path]]) -> None:
    try:
        children = sorted(directory.iterdir(), key=lambda path: path.name)
    except OSError as exc:
        raise PresetValidationError(
            "preset_tree_unreadable", "preset tree is unreadable"
        ) from exc
    for child in children:
        relative = child.relative_to(root).as_posix()
        if _is_link_like(child):
            raise PresetValidationError(
                "preset_tree_link_forbidden",
                "preset tree must not contain symlinks or junctions",
                path=relative,
            )
        try:
            mode = child.stat(follow_symlinks=False).st_mode
        except OSError as exc:
            raise PresetValidationError(
                "preset_tree_unreadable", "preset tree entry is unreadable", path=relative
            ) from exc
        if stat.S_ISDIR(mode):
            _collect_regular_files(root, child, files)
        elif stat.S_ISREG(mode):
            files.append((relative, child))
        else:
            raise PresetValidationError(
                "preset_tree_special_file_forbidden",
                "preset tree must contain regular files and directories only",
                path=relative,
            )


def _load_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"schema_version": PRESET_STATE_SCHEMA_VERSION, "presets": {}}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise PresetValidationError(
            "preset_state_invalid",
            "preset management state is unreadable or invalid",
            path=f"{MANAGED_DIR_NAME}/{STATE_FILE_NAME}",
        ) from exc
    if (
        not isinstance(payload, dict)
        or set(payload) != {"schema_version", "presets"}
        or payload["schema_version"] != PRESET_STATE_SCHEMA_VERSION
        or not isinstance(payload["presets"], dict)
    ):
        raise PresetValidationError(
            "preset_state_invalid",
            "preset management state has an invalid schema",
            path=f"{MANAGED_DIR_NAME}/{STATE_FILE_NAME}",
        )
    for preset_id, item in payload["presets"].items():
        if not isinstance(preset_id, str) or not _valid_state_item(item):
            raise PresetValidationError(
                "preset_state_invalid",
                "preset management state contains an invalid item",
                path=f"{MANAGED_DIR_NAME}/{STATE_FILE_NAME}",
            )
    return payload


def _valid_state_item(item: Any) -> bool:
    return (
        isinstance(item, dict)
        and set(item) == {"skill_name", "version", "content_sha256", "status"}
        and isinstance(item["skill_name"], str)
        and isinstance(item["version"], int)
        and not isinstance(item["version"], bool)
        and isinstance(item["content_sha256"], str)
        and item["status"] in {"installed", "skipped_existing"}
    )


def _state_item(preset: BundledPreset, *, status: PresetItemStatus) -> dict[str, Any]:
    return {
        "skill_name": preset.skill_name,
        "version": preset.version,
        "content_sha256": preset.content_sha256,
        "status": status,
    }


def _write_state_atomic(path: Path, state: dict[str, Any]) -> None:
    file_descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{STATE_FILE_NAME}.", suffix=".tmp", dir=path.parent
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(file_descriptor, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(state, stream, ensure_ascii=False, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


def _acquire_lock(path: Path, *, stale_lock_seconds: float) -> bool:
    for attempt in range(2):
        try:
            file_descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            if attempt or not _lock_is_stale(path, stale_lock_seconds=stale_lock_seconds):
                return False
            path.unlink(missing_ok=True)
            continue
        with os.fdopen(file_descriptor, "w", encoding="utf-8") as stream:
            json.dump({"pid": os.getpid(), "created_at": time.time()}, stream)
        return True
    return False


def _lock_is_stale(path: Path, *, stale_lock_seconds: float) -> bool:
    try:
        age = max(0.0, time.time() - path.stat().st_mtime)
    except OSError:
        return False
    return age >= max(0.0, stale_lock_seconds)


def _cleanup_staging(path: Path) -> None:
    if _path_exists(path):
        shutil.rmtree(path, ignore_errors=False)


def _path_exists(path: Path) -> bool:
    return os.path.lexists(path)


def _is_link_like(path: Path) -> bool:
    if path.is_symlink():
        return True
    is_junction = getattr(path, "is_junction", None)
    return bool(callable(is_junction) and is_junction())


def _failed_result(code: str, reason: str) -> PresetProvisionResult:
    return PresetProvisionResult(
        status="failed",
        diagnostics=(KeydexDiagnostic(code=code, reason=reason, severity="error"),),
    )
