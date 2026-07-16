from __future__ import annotations

import base64
import json
import os
import stat
import unicodedata
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Any, Iterable, Protocol

from backend.app.security import is_relative_to, normalize_workspace_root_for_storage


class FileResourceScopeKind(StrEnum):
    WORKSPACE = "workspace"
    EXTERNAL = "external"


class FileHistoryPathError(ValueError):
    def __init__(self, code: str, message: str, *, path: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.path = path


def _normalize_identity(value: str) -> str:
    normalized = unicodedata.normalize("NFC", value.strip().replace("\\", "/")).rstrip("/")
    if os.name == "nt":
        normalized = normalized.casefold()
    return normalized


def _normalize_canonical(value: str) -> str:
    normalized = unicodedata.normalize("NFC", value.replace("\\", "/")).strip("/")
    if os.name == "nt":
        normalized = normalized.casefold()
    return normalized or "."


@dataclass(frozen=True, slots=True)
class FileResourceScope:
    kind: FileResourceScopeKind | str
    identity: str
    root: Path
    label: str

    def __post_init__(self) -> None:
        try:
            kind = FileResourceScopeKind(self.kind)
        except ValueError as exc:
            raise FileHistoryPathError("scope_kind_invalid", "文件资源作用域类型无效") from exc
        identity = _normalize_identity(self.identity)
        if not identity:
            raise FileHistoryPathError("scope_identity_empty", "文件资源作用域身份不能为空")
        root = Path(self.root).expanduser()
        if not root.is_absolute():
            raise FileHistoryPathError("scope_root_relative", "文件资源作用域根路径必须为绝对路径")
        object.__setattr__(self, "kind", kind)
        object.__setattr__(self, "identity", identity)
        object.__setattr__(self, "root", root.resolve(strict=False))
        object.__setattr__(self, "label", self.label.strip() or str(root))

    def to_dict(self) -> dict[str, str]:
        return {
            "kind": self.kind.value,
            "identity": self.identity,
            "root": str(self.root),
            "label": self.label,
        }

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> FileResourceScope:
        return cls(
            kind=str(value.get("kind") or ""),
            identity=str(value.get("identity") or ""),
            root=Path(str(value.get("root") or "")),
            label=str(value.get("label") or ""),
        )


@dataclass(frozen=True, slots=True)
class FileResourceIdentity:
    scope_kind: FileResourceScopeKind | str
    scope_identity: str
    canonical_path: str

    def __post_init__(self) -> None:
        try:
            kind = FileResourceScopeKind(self.scope_kind)
        except ValueError as exc:
            raise FileHistoryPathError("scope_kind_invalid", "文件资源作用域类型无效") from exc
        identity = _normalize_identity(self.scope_identity)
        if not identity:
            raise FileHistoryPathError("scope_identity_empty", "文件资源作用域身份不能为空")
        canonical = _normalize_canonical(self.canonical_path)
        if canonical.startswith("../") or canonical == "..":
            raise FileHistoryPathError("canonical_path_unsafe", "文件资源相对路径越界")
        object.__setattr__(self, "scope_kind", kind)
        object.__setattr__(self, "scope_identity", identity)
        object.__setattr__(self, "canonical_path", canonical)

    @property
    def resource_key(self) -> str:
        return f"{self.scope_kind.value}\0{self.scope_identity}\0{self.canonical_path}"

    @property
    def resource_id(self) -> str:
        raw = json.dumps(
            [self.scope_kind.value, self.scope_identity, self.canonical_path],
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        return "fr1_" + base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")

    def to_dict(self) -> dict[str, str]:
        return {
            "scope_kind": self.scope_kind.value,
            "scope_identity": self.scope_identity,
            "canonical_path": self.canonical_path,
            "resource_id": self.resource_id,
        }

    @classmethod
    def from_resource_id(cls, resource_id: str) -> FileResourceIdentity:
        if not resource_id.startswith("fr1_"):
            raise FileHistoryPathError("resource_id_invalid", "文件资源 ID 无效")
        try:
            payload = resource_id[4:]
            decoded = base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))
            value = json.loads(decoded.decode("utf-8"))
            if not isinstance(value, list) or len(value) != 3:
                raise ValueError("invalid payload")
            kind, identity, canonical = value
        except (ValueError, UnicodeError, json.JSONDecodeError) as exc:
            raise FileHistoryPathError("resource_id_invalid", "文件资源 ID 无效") from exc
        return cls(kind, identity, canonical)


@dataclass(frozen=True, slots=True)
class FileHistoryPath:
    absolute_path: Path
    scope_root: Path
    scope_kind: FileResourceScopeKind | str
    scope_identity: str
    canonical_path: str
    display_path: str
    scope_label: str

    def __post_init__(self) -> None:
        identity = FileResourceIdentity(self.scope_kind, self.scope_identity, self.canonical_path)
        object.__setattr__(self, "scope_kind", identity.scope_kind)
        object.__setattr__(self, "scope_identity", identity.scope_identity)
        object.__setattr__(self, "canonical_path", identity.canonical_path)
        object.__setattr__(self, "scope_root", Path(self.scope_root).resolve(strict=False))
        object.__setattr__(self, "absolute_path", Path(self.absolute_path).resolve(strict=False))

    @property
    def identity(self) -> FileResourceIdentity:
        return FileResourceIdentity(self.scope_kind, self.scope_identity, self.canonical_path)

    @property
    def resource_id(self) -> str:
        return self.identity.resource_id

    @property
    def resource_key(self) -> str:
        return self.identity.resource_key

    @property
    def requires_full_access(self) -> bool:
        return self.scope_kind == FileResourceScopeKind.EXTERNAL

    @property
    def workspace_root(self) -> Path:
        return self.scope_root

    @property
    def workspace_identity(self) -> str:
        return self.scope_identity

    def to_locator(self) -> dict[str, str]:
        return {
            **self.identity.to_dict(),
            "scope_root": str(self.scope_root),
            "scope_label": self.scope_label,
            "display_path": self.display_path,
        }


class WorkspaceScopeRecord(Protocol):
    id: str
    name: str
    root_path: str


@dataclass(frozen=True, slots=True)
class FileResourceScopeCatalog:
    workspace_scopes: tuple[FileResourceScope, ...]

    @classmethod
    def from_workspaces(
        cls,
        workspaces: Iterable[WorkspaceScopeRecord],
    ) -> FileResourceScopeCatalog:
        scopes: list[FileResourceScope] = []
        for workspace in workspaces:
            root = Path(workspace.root_path).expanduser()
            if not root.is_absolute():
                continue
            scope = FileResourceScope(
                FileResourceScopeKind.WORKSPACE,
                workspace.id or normalize_workspace_root_for_storage(root),
                root,
                workspace.name or str(root),
            )
            if all(scope.identity != current.identity for current in scopes):
                scopes.append(scope)
        return cls(tuple(sorted(scopes, key=lambda item: len(item.root.parts), reverse=True)))

    def resolver(
        self,
        workspace_root: str | Path,
        *,
        allow_external: bool,
    ) -> FileHistoryPathResolver:
        return FileHistoryPathResolver(
            workspace_root,
            workspace_scopes=self.workspace_scopes,
            allow_external=allow_external,
        )


class FileHistoryPathResolver:
    """Resolve file paths into stable workspace/external resource identities."""

    def __init__(
        self,
        workspace_root: str | Path,
        *,
        workspace_scopes: Iterable[FileResourceScope | tuple[str, str | Path, str]] = (),
        allow_external: bool = False,
    ) -> None:
        cwd = Path(workspace_root).expanduser().resolve(strict=True)
        provided: list[FileResourceScope] = []
        for item in workspace_scopes:
            scope = item if isinstance(item, FileResourceScope) else self._workspace_scope(*item)
            if all(scope.identity != current.identity for current in provided):
                provided.append(scope)
        primary = next(
            (
                item
                for item in sorted(provided, key=lambda value: len(value.root.parts), reverse=True)
                if is_relative_to(cwd, item.root)
            ),
            None,
        ) or self._workspace_scope("", cwd, "当前项目")
        scopes = [primary, *(item for item in provided if item.identity != primary.identity)]
        self.workspace_scopes = tuple(sorted(scopes, key=lambda item: len(item.root.parts), reverse=True))
        self.allow_external = bool(allow_external)
        self.cwd = cwd
        self.workspace_root = primary.root
        self.workspace_identity = primary.identity

    @staticmethod
    def _workspace_scope(identity: str, root: str | Path, label: str) -> FileResourceScope:
        raw_root = Path(root).expanduser()
        try:
            resolved = raw_root.resolve(strict=True)
        except (OSError, RuntimeError) as exc:
            raise FileHistoryPathError(
                "workspace_not_found", "文件回溯工作区不存在或无法解析", path=str(root)
            ) from exc
        if not resolved.is_dir():
            raise FileHistoryPathError(
                "workspace_not_directory", "文件回溯工作区不是目录", path=str(root)
            )
        normalized = identity.strip() or normalize_workspace_root_for_storage(resolved)
        return FileResourceScope(FileResourceScopeKind.WORKSPACE, normalized, resolved, label)

    def resolve(self, raw_path: str | Path) -> FileHistoryPath:
        raw_text = str(raw_path)
        if not raw_text.strip():
            raise FileHistoryPathError("path_empty", "文件回溯路径不能为空")
        candidate = Path(raw_path).expanduser()
        if not candidate.is_absolute():
            candidate = self.cwd / candidate
        if os.name == "nt":
            self._reject_windows_segments(candidate)
        try:
            # Reparse points are rejected explicitly below, so lexical
            # normalization avoids resolving the same Windows components twice.
            absolute = Path(os.path.abspath(candidate))
        except (OSError, RuntimeError) as exc:
            raise FileHistoryPathError(
                "path_unresolvable", "文件回溯路径无法解析", path=raw_text
            ) from exc
        scope = next(
            (item for item in self.workspace_scopes if is_relative_to(absolute, item.root)),
            None,
        )
        if scope is None:
            if not self.allow_external:
                raise FileHistoryPathError(
                    "path_outside_workspace", "文件回溯路径不在工作区内", path=raw_text
                )
            scope = self._external_scope(absolute)
        self._reject_reparse_components(candidate, scope.root)
        relative = absolute.relative_to(scope.root)
        display = relative.as_posix() or "."
        return FileHistoryPath(
            absolute_path=absolute,
            scope_root=scope.root,
            scope_kind=scope.kind,
            scope_identity=scope.identity,
            canonical_path=_normalize_canonical(display),
            display_path=display,
            scope_label=scope.label,
        )

    def resolve_stored(
        self,
        display_path: str,
        canonical_path: str,
        *,
        scope_kind: str | FileResourceScopeKind = FileResourceScopeKind.WORKSPACE,
        scope_identity: str | None = None,
        scope_root: str | Path | None = None,
        scope_label: str | None = None,
    ) -> FileHistoryPath:
        kind = FileResourceScopeKind(scope_kind)
        expected_identity = _normalize_identity(scope_identity or self.workspace_identity)
        known_scope = next(
            (
                item
                for item in self.workspace_scopes
                if item.kind == kind and item.identity == expected_identity
            ),
            None,
        )
        if known_scope is not None and (
            scope_root is None
            or os.path.normcase(os.path.abspath(str(scope_root)))
            == os.path.normcase(str(known_scope.root))
        ):
            scope = known_scope
        elif scope_root is None and kind == FileResourceScopeKind.WORKSPACE:
            scope = None
            if scope is None:
                raise FileHistoryPathError("scope_unavailable", "文件资源作用域当前不可用")
        elif scope_root is not None:
            root = Path(scope_root).expanduser().resolve(strict=False)
            identity = scope_identity or normalize_workspace_root_for_storage(root)
            scope = FileResourceScope(kind, identity, root, scope_label or str(root))
        else:
            raise FileHistoryPathError("scope_root_missing", "外部文件资源缺少作用域根路径")
        candidate = scope.root / display_path
        if kind == FileResourceScopeKind.EXTERNAL:
            resolver = FileHistoryPathResolver(
                self.workspace_root,
                workspace_scopes=self.workspace_scopes,
                allow_external=True,
            )
            resolved = resolver.resolve(candidate)
        else:
            resolved = self.resolve(candidate)
        expected = FileResourceIdentity(kind, scope.identity, canonical_path)
        if resolved.identity != expected:
            raise FileHistoryPathError(
                "canonical_path_mismatch",
                "文件回溯路径身份与已存记录不一致",
                path=display_path,
            )
        return resolved

    def revalidate(self, path: FileHistoryPath) -> FileHistoryPath:
        return self.resolve_stored(
            path.display_path,
            path.canonical_path,
            scope_kind=path.scope_kind,
            scope_identity=path.scope_identity,
            scope_root=path.scope_root,
            scope_label=path.scope_label,
        )

    @staticmethod
    def _external_scope(path: Path) -> FileResourceScope:
        anchor = path.anchor
        if not anchor:
            raise FileHistoryPathError("external_anchor_missing", "无法确定外部文件作用域")
        root = Path(anchor).resolve(strict=False)
        return FileResourceScope(
            FileResourceScopeKind.EXTERNAL,
            normalize_workspace_root_for_storage(root),
            root,
            f"外部位置 {anchor}",
        )

    @staticmethod
    def _reject_reparse_components(candidate: Path, root: Path) -> None:
        try:
            lexical = candidate.absolute()
            relative = lexical.relative_to(root)
        except (OSError, ValueError) as exc:
            raise FileHistoryPathError(
                "path_outside_scope", "文件回溯路径不在资源作用域内", path=str(candidate)
            ) from exc
        current = root
        for part in relative.parts:
            current = current / part
            try:
                metadata = current.lstat()
            except FileNotFoundError:
                continue
            except OSError as exc:
                raise FileHistoryPathError(
                    "path_metadata_unreadable", "文件回溯路径元数据无法读取", path=str(current)
                ) from exc
            is_reparse = bool(int(getattr(metadata, "st_file_attributes", 0) or 0) & 0x400)
            if stat.S_ISLNK(metadata.st_mode) or is_reparse:
                raise FileHistoryPathError(
                    "path_link_unsafe", "文件回溯不支持符号链接或 Junction 路径", path=str(current)
                )

    @staticmethod
    def _reject_windows_segments(candidate: Path) -> None:
        reserved_names = {
            "con", "prn", "aux", "nul", "clock$",
            *(f"com{index}" for index in range(1, 10)),
            *(f"lpt{index}" for index in range(1, 10)),
        }
        invalid_characters = set('<>:"/\\|?*')
        for segment in candidate.parts[1:]:
            base_name = segment.split(".", 1)[0].casefold()
            if (
                segment.endswith((" ", "."))
                or base_name in reserved_names
                or any(character in invalid_characters or ord(character) < 32 for character in segment)
            ):
                raise FileHistoryPathError(
                    "path_invalid_windows_name", "文件回溯路径包含 Windows 不允许的名称", path=str(candidate)
                )
