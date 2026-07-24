from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from backend.app.core.data_path import resolve_data_path
from backend.app.services.archive_lifecycle_service import ArchiveLifecycleError
from backend.app.storage import LifecycleOperationRecord, StorageRepositories


@dataclass(frozen=True)
class PurgeAsset:
    path: Path
    classification: str
    token: str
    size: int


@dataclass(frozen=True)
class PurgePlan:
    entity_type: str
    entity_id: str
    workspace_id: str | None
    session_ids: tuple[str, ...]
    session_signatures: tuple[tuple[str, str, str, str], ...]
    database_counts: dict[str, int]
    assets: tuple[PurgeAsset, ...]
    snapshot_hash: str
    artifact_ids: tuple[str, ...] = ()


class PurgePlanner:
    """Read-only inventory for lifecycle purge."""

    SESSION_RELATIONS: tuple[tuple[str, tuple[str, ...]], ...] = (
        ("tool_result_artifact_grants", ("session_id",)),
        ("tool_result_artifacts", ("source_session_id",)),
        ("mcp_session_tool_usage", ("session_id",)),
        ("mcp_trust_rules", ("session_id",)),
        ("mcp_session_tool_overrides", ("session_id",)),
        ("mcp_runtime_snapshots", ("session_id",)),
        ("mcp_audit_log", ("session_id",)),
        ("thread_tasks", ("session_id",)),
        ("thread_task_runs", ("session_id",)),
        ("subagent_run", ("parent_session_id", "child_session_id")),
        ("session_forks", ("source_session_id", "target_session_id")),
        ("right_sidebar_scope_states", ("session_id",)),
        ("right_sidebar_scope_promotions", ("target_session_id",)),
        ("web_annotation_resources", ("session_id",)),
        ("web_annotation_attachment_clones", ("session_id",)),
        ("attachments", ("session_id",)),
        ("message_events", ("session_id",)),
        ("session_pending_inputs", ("session_id",)),
        ("a2ui_interactions", ("session_id", "active_session_id")),
        (
            "compression_staging",
            ("original_session_id", "active_session_id", "target_session_id"),
        ),
        ("command_approval_requests", ("session_id",)),
        ("command_approval_audit", ("session_id",)),
        ("trace_record", ("session_id", "active_session_id")),
        ("llm_request_logs", ("session_id", "active_session_id")),
        ("trace_event_log", ("original_session_id", "active_session_id")),
        ("file_history_session_state", ("session_id",)),
        ("file_history_snapshots", ("session_id", "active_session_id")),
        ("file_history_tracked_files", ("session_id",)),
        ("file_history_mutations", ("session_id", "active_session_id")),
        ("file_history_path_heads", ("session_id",)),
        ("file_history_operations", ("session_id", "active_session_id")),
    )

    # These tables are session-owned through a parent row rather than a direct
    # session id. Keeping them in the immutable purge snapshot prevents a child
    # row inserted between plan and execute from bypassing stale-plan checks.
    SESSION_INDIRECT_RELATIONS: tuple[tuple[str, str, str, str, tuple[str, ...]], ...] = (
        (
            "file_history_snapshot_entries",
            "snapshot_id",
            "file_history_snapshots",
            "id",
            ("session_id", "active_session_id"),
        ),
        (
            "file_history_snapshot_scopes",
            "snapshot_id",
            "file_history_snapshots",
            "id",
            ("session_id", "active_session_id"),
        ),
        (
            "file_history_operation_files",
            "operation_id",
            "file_history_operations",
            "id",
            ("session_id", "active_session_id"),
        ),
        (
            "file_history_locks",
            "owner_operation_id",
            "file_history_operations",
            "id",
            ("session_id", "active_session_id"),
        ),
        (
            "web_annotations",
            "resource_id",
            "web_annotation_resources",
            "id",
            ("session_id",),
        ),
        (
            "web_annotation_assets",
            "resource_id",
            "web_annotation_resources",
            "id",
            ("session_id",),
        ),
    )

    SESSION_TRANSITIVE_RELATIONS: tuple[str, ...] = ("web_annotation_target_history",)

    SESSION_THREAD_RELATIONS: tuple[str, ...] = (
        "checkpoints_v2",
        "checkpoint_writes_v2",
    )

    def __init__(self, repositories: StorageRepositories, *, data_dir: str | Path) -> None:
        self._repositories = repositories
        self.data_dir = Path(data_dir).expanduser().resolve()

    def plan_session(self, session_id: str) -> PurgePlan:
        active = self._repositories.sessions.get(session_id)
        archived = self._repositories.sessions.get_archived(session_id)
        if active is not None:
            raise ArchiveLifecycleError(
                "not_archived",
                "只有已归档会话可以彻底删除",
                {"session_id": session_id},
            )
        if archived is None:
            raise ArchiveLifecycleError("not_found", "会话不存在", {"session_id": session_id})
        with self._repositories.db.connect() as conn:
            child_rows = conn.execute(
                """
                select id
                from sessions
                where parent_session_id = ?
                  and agent_kind = 'subagent'
                  and visibility = 'internal'
                order by id
                """,
                (session_id,),
            ).fetchall()
        return self._build_plan(
            entity_type="session",
            entity_id=session_id,
            workspace_id=archived.workspace_id,
            session_ids=(session_id, *(str(row["id"]) for row in child_rows)),
        )

    def plan_workspace(self, workspace_id: str) -> PurgePlan:
        active = self._repositories.workspaces.get(workspace_id)
        archived = self._repositories.workspaces.get_archived(workspace_id)
        if active is not None:
            raise ArchiveLifecycleError(
                "not_archived",
                "只有已归档项目可以彻底删除",
                {"workspace_id": workspace_id},
            )
        if archived is None:
            raise ArchiveLifecycleError("not_found", "项目不存在", {"workspace_id": workspace_id})
        with self._repositories.db.connect() as conn:
            rows = conn.execute(
                "select id, archived_at from sessions where workspace_id = ? order by id asc",
                (workspace_id,),
            ).fetchall()
        active_children = [str(row["id"]) for row in rows if row["archived_at"] is None]
        if active_children:
            raise ArchiveLifecycleError(
                "workspace_archive_inconsistent",
                "归档项目仍包含活动会话，无法彻底删除",
                {"active_session_count": len(active_children)},
            )
        return self._build_plan(
            entity_type="workspace",
            entity_id=workspace_id,
            workspace_id=workspace_id,
            session_ids=tuple(str(row["id"]) for row in rows),
        )

    def plan_workspace_sessions(self, workspace_id: str) -> PurgePlan:
        workspace = self._repositories.workspaces.get(
            workspace_id
        ) or self._repositories.workspaces.get_archived(workspace_id)
        if workspace is None:
            raise ArchiveLifecycleError(
                "not_found",
                "项目不存在",
                {"workspace_id": workspace_id},
            )
        with self._repositories.db.connect() as conn:
            rows = conn.execute(
                """
                select id from sessions
                where workspace_id = ? and archived_at is not null
                order by id asc
                """,
                (workspace_id,),
            ).fetchall()
        if not rows:
            raise ArchiveLifecycleError(
                "not_found",
                "该项目没有可彻底删除的归档会话",
                {"workspace_id": workspace_id},
            )
        return self._build_plan(
            entity_type="workspace_sessions",
            entity_id=workspace_id,
            workspace_id=workspace_id,
            session_ids=tuple(str(row["id"]) for row in rows),
        )

    def _build_plan(
        self,
        *,
        entity_type: str,
        entity_id: str,
        workspace_id: str | None,
        session_ids: tuple[str, ...],
    ) -> PurgePlan:
        with self._repositories.db.connect() as conn:
            signatures = self._session_signatures(conn, session_ids)
            counts = self._relation_counts(conn, session_ids)
            artifact_rows = self._artifact_rows_for_purge(conn, session_ids)
            web_asset_rows = self._web_annotation_asset_rows_for_purge(
                conn,
                session_ids=session_ids,
                workspace_id=entity_id if entity_type == "workspace" else None,
            )
            if entity_type == "workspace":
                for table, total in self._workspace_scope_counts(conn, entity_id).items():
                    counts[table] = counts.get(table, 0) + total
                counts["workspace_annotations"] = int(
                    conn.execute(
                        "select count(*) as total from workspace_annotations "
                        "where workspace_id = ?",
                        (entity_id,),
                    ).fetchone()["total"]
                )
                counts["workspaces"] = 1
            counts["sessions"] = len(session_ids)
            attachments = (
                conn.execute(
                    self._select_for_sessions(
                        "select id, path from attachments where {predicate}",
                        "session_id",
                        session_ids,
                    )[0],
                    self._select_for_sessions("", "session_id", session_ids)[1],
                ).fetchall()
                if session_ids
                else []
            )
        assets: list[PurgeAsset] = []
        for session_id in session_ids:
            for relative in (
                Path("file-history") / session_id,
                Path("checkpoints") / session_id,
            ):
                candidate = self.data_dir / relative
                assets.append(self._classify(candidate, registered_root=candidate))
        for row in attachments:
            candidate = resolve_data_path(self.data_dir, str(row["path"]))
            registered_root = self.data_dir / "attachments" / str(row["id"])
            assets.append(self._classify(candidate, registered_root=registered_root))
        for row in web_asset_rows:
            relative = Path(str(row["storage_path"]))
            candidate = self.data_dir / relative.parent
            registered_root = self.data_dir / "browser" / "captures" / "staged" / str(row["id"])
            assets.append(self._classify(candidate, registered_root=registered_root))
        seen_artifact_paths: set[Path] = set()
        for row in artifact_rows:
            candidate = self.data_dir / Path(str(row["relative_path"]))
            lexical = Path(os.path.abspath(candidate))
            if lexical in seen_artifact_paths:
                continue
            seen_artifact_paths.add(lexical)
            assets.append(self._classify(candidate, registered_root=candidate))
        artifact_ids = tuple(str(row["id"]) for row in artifact_rows)
        snapshot_payload = {
            "entity_type": entity_type,
            "entity_id": entity_id,
            "workspace_id": workspace_id,
            "signatures": signatures,
            "counts": counts,
            "artifact_ids": artifact_ids,
            "assets": [
                {
                    "classification": asset.classification,
                    "token": asset.token,
                    "size": asset.size,
                }
                for asset in assets
            ],
        }
        snapshot_hash = hashlib.sha256(
            json.dumps(snapshot_payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        return PurgePlan(
            entity_type=entity_type,
            entity_id=entity_id,
            workspace_id=workspace_id,
            session_ids=session_ids,
            session_signatures=tuple(signatures),
            database_counts=counts,
            assets=tuple(assets),
            snapshot_hash=snapshot_hash,
            artifact_ids=artifact_ids,
        )

    @staticmethod
    def _artifact_rows_for_purge(conn, session_ids: tuple[str, ...]):
        if not session_ids:
            return []
        placeholders = ", ".join("?" for _ in session_ids)
        return conn.execute(
            f"""
            select a.*
              from tool_result_artifacts a
             where (
               a.source_session_id in ({placeholders})
               or exists (
                 select 1 from tool_result_artifact_grants owned
                  where owned.artifact_id = a.id
                    and owned.session_id in ({placeholders})
               )
             )
               and not exists (
               select 1 from tool_result_artifact_grants retained
                where retained.artifact_id = a.id
                  and retained.session_id not in ({placeholders})
             )
             order by a.created_at, a.id
            """,
            [*session_ids, *session_ids, *session_ids],
        ).fetchall()

    @staticmethod
    def _web_annotation_asset_rows_for_purge(
        conn,
        *,
        session_ids: tuple[str, ...],
        workspace_id: str | None,
    ):
        predicates: list[str] = []
        params: list[str] = []
        if session_ids:
            placeholders = ", ".join("?" for _ in session_ids)
            predicates.append(
                f"(resource.scope_kind = 'session' and resource.session_id in ({placeholders}))"
            )
            params.extend(session_ids)
        if workspace_id is not None:
            predicates.append("(resource.scope_kind = 'workspace' and resource.workspace_id = ?)")
            params.append(workspace_id)
        if not predicates:
            return []
        return conn.execute(
            f"""
            select asset.id, asset.storage_path, asset.size_bytes
            from web_annotation_assets asset
            join web_annotation_resources resource on resource.id = asset.resource_id
            where {" or ".join(predicates)}
            order by asset.created_at asc, asset.id asc
            """,
            params,
        ).fetchall()

    @staticmethod
    def _workspace_scope_counts(conn, workspace_id: str) -> dict[str, int]:
        rows = conn.execute(
            """
            select
              (select count(*) from right_sidebar_scope_states
                where scope_kind = 'workspace' and workspace_id = ?) as sidebar_total,
              (select count(*) from web_annotation_resources
                where scope_kind = 'workspace' and workspace_id = ?) as resource_total,
              (select count(*) from web_annotations annotation
                join web_annotation_resources resource on resource.id = annotation.resource_id
                where resource.scope_kind = 'workspace' and resource.workspace_id = ?)
                as annotation_total,
              (select count(*) from web_annotation_target_history history
                join web_annotations annotation on annotation.id = history.annotation_id
                join web_annotation_resources resource on resource.id = annotation.resource_id
                where resource.scope_kind = 'workspace' and resource.workspace_id = ?)
                as history_total,
              (select count(*) from web_annotation_assets asset
                join web_annotation_resources resource on resource.id = asset.resource_id
                where resource.scope_kind = 'workspace' and resource.workspace_id = ?)
                as asset_total
            """,
            (workspace_id, workspace_id, workspace_id, workspace_id, workspace_id),
        ).fetchone()
        return {
            "right_sidebar_scope_states": int(rows["sidebar_total"]),
            "web_annotation_resources": int(rows["resource_total"]),
            "web_annotations": int(rows["annotation_total"]),
            "web_annotation_target_history": int(rows["history_total"]),
            "web_annotation_assets": int(rows["asset_total"]),
        }

    def _classify(self, candidate: Path, *, registered_root: Path) -> PurgeAsset:
        token = hashlib.sha256(str(candidate).encode("utf-8")).hexdigest()[:16]
        try:
            lexical_candidate = Path(os.path.abspath(candidate))
            lexical_data_dir = Path(os.path.abspath(self.data_dir))
        except OSError:
            return PurgeAsset(candidate, "invalid", token, 0)
        if not lexical_candidate.is_relative_to(lexical_data_dir):
            return PurgeAsset(
                candidate,
                "external_reference_only",
                token,
                self._safe_size(candidate),
            )
        if lexical_candidate == lexical_data_dir or self._has_link_or_reparse(lexical_candidate):
            return PurgeAsset(candidate, "invalid", token, self._safe_size(candidate))
        try:
            resolved = candidate.resolve(strict=False)
            allowed = registered_root.resolve(strict=False)
        except OSError:
            return PurgeAsset(candidate, "invalid", token, 0)
        if not resolved.is_relative_to(self.data_dir):
            return PurgeAsset(candidate, "invalid", token, self._safe_size(candidate))
        if resolved == self.data_dir or not resolved.is_relative_to(allowed):
            return PurgeAsset(candidate, "invalid", token, self._safe_size(candidate))
        return PurgeAsset(candidate, "managed_delete", token, self._safe_size(candidate))

    @classmethod
    def _relation_counts(cls, conn, session_ids: tuple[str, ...]) -> dict[str, int]:
        if not session_ids:
            return {
                table: 0
                for table in (
                    *(table for table, _ in cls.SESSION_RELATIONS),
                    *(relation[0] for relation in cls.SESSION_INDIRECT_RELATIONS),
                    *cls.SESSION_TRANSITIVE_RELATIONS,
                    *cls.SESSION_THREAD_RELATIONS,
                )
            }
        counts: dict[str, int] = {}
        for table, columns in cls.SESSION_RELATIONS:
            predicates: list[str] = []
            params: list[str] = []
            for column in columns:
                placeholders = ", ".join("?" for _ in session_ids)
                predicates.append(f"{column} in ({placeholders})")
                params.extend(session_ids)
            row = conn.execute(
                f"select count(*) as total from {table} where {' or '.join(predicates)}",
                params,
            ).fetchone()
            counts[table] = int(row["total"])
        placeholders = ", ".join("?" for _ in session_ids)
        trace_event = conn.execute(
            f"""
            select count(*) as total
            from trace_event_log
            where original_session_id in ({placeholders})
               or active_session_id in ({placeholders})
               or trace_record_id in (
                 select trace_id from trace_record
                 where session_id in ({placeholders})
                    or active_session_id in ({placeholders})
               )
            """,
            [*session_ids, *session_ids, *session_ids, *session_ids],
        ).fetchone()
        counts["trace_event_log"] = int(trace_event["total"])
        for (
            table,
            child_column,
            parent_table,
            parent_column,
            parent_session_columns,
        ) in cls.SESSION_INDIRECT_RELATIONS:
            parent_predicates: list[str] = []
            params = []
            for column in parent_session_columns:
                placeholders = ", ".join("?" for _ in session_ids)
                parent_predicates.append(f"{column} in ({placeholders})")
                params.extend(session_ids)
            row = conn.execute(
                f"""
                select count(*) as total
                from {table}
                where {child_column} in (
                  select {parent_column}
                  from {parent_table}
                  where {" or ".join(parent_predicates)}
                )
                """,
                params,
            ).fetchone()
            counts[table] = int(row["total"])
        history_row = conn.execute(
            f"""
            select count(*) as total
            from web_annotation_target_history history
            join web_annotations annotation on annotation.id = history.annotation_id
            join web_annotation_resources resource on resource.id = annotation.resource_id
            where resource.scope_kind = 'session'
              and resource.session_id in ({placeholders})
            """,
            session_ids,
        ).fetchone()
        counts["web_annotation_target_history"] = int(history_row["total"])
        thread_placeholders = ", ".join("?" for _ in session_ids)
        for table in cls.SESSION_THREAD_RELATIONS:
            row = conn.execute(
                f"select count(*) as total from {table} where thread_id in ({thread_placeholders})",
                session_ids,
            ).fetchone()
            counts[table] = int(row["total"])
        return counts

    @staticmethod
    def _session_signatures(conn, session_ids: tuple[str, ...]) -> list[tuple[str, str, str, str]]:
        if not session_ids:
            return []
        placeholders = ", ".join("?" for _ in session_ids)
        rows = conn.execute(
            f"""
            select id, updated_at, archived_at, archive_origin
            from sessions where id in ({placeholders}) order by id asc
            """,
            session_ids,
        ).fetchall()
        return [
            (
                str(row["id"]),
                str(row["updated_at"]),
                str(row["archived_at"] or ""),
                str(row["archive_origin"] or ""),
            )
            for row in rows
        ]

    @staticmethod
    def _select_for_sessions(
        template: str,
        column: str,
        session_ids: tuple[str, ...],
    ) -> tuple[str, list[str]]:
        placeholders = ", ".join("?" for _ in session_ids)
        return template.format(predicate=f"{column} in ({placeholders})"), list(session_ids)

    @staticmethod
    def _safe_size(path: Path) -> int:
        try:
            if path.is_file():
                return int(path.stat().st_size)
            if path.is_dir():
                return sum(
                    int(item.stat().st_size)
                    for item in path.rglob("*")
                    if item.is_file() and not item.is_symlink()
                )
        except OSError:
            return 0
        return 0

    def _has_link_or_reparse(self, path: Path) -> bool:
        try:
            relative = Path(os.path.abspath(path)).relative_to(Path(os.path.abspath(self.data_dir)))
        except (OSError, ValueError):
            return True
        current = self.data_dir
        for component in relative.parts:
            current = current / component
            try:
                metadata = current.lstat()
            except FileNotFoundError:
                continue
            except OSError:
                return True
            if stat.S_ISLNK(metadata.st_mode):
                return True
            attributes = getattr(metadata, "st_file_attributes", 0)
            reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
            if attributes & reparse_flag:
                return True
        return False


class LifecycleQuarantine:
    def __init__(self, data_dir: str | Path) -> None:
        self.data_dir = Path(data_dir).expanduser().resolve()
        self.root = self.data_dir / "lifecycle-quarantine"

    def quarantine(self, plan: PurgePlan, operation_id: str) -> str:
        operation_dir = self._operation_dir(operation_id)
        manifest_path = operation_dir / "manifest.json"
        if manifest_path.exists():
            return operation_id
        operation_dir.mkdir(parents=True, exist_ok=False)
        manifest: dict[str, Any] = {"version": 1, "assets": []}
        self._write_manifest(manifest_path, manifest)
        for index, asset in enumerate(plan.assets):
            if asset.classification != "managed_delete" or not asset.path.exists():
                continue
            source = self._validate_source(asset.path)
            digest, size = self._hash_path(source)
            target_name = f"asset-{index}"
            target = operation_dir / target_name
            os.replace(source, target)
            manifest["assets"].append(
                {
                    "original": source.relative_to(self.data_dir).as_posix(),
                    "quarantined": target_name,
                    "hash": digest,
                    "size": size,
                }
            )
            self._write_manifest(manifest_path, manifest)
        return operation_id

    def rollback(self, token: str) -> None:
        operation_dir = self._operation_dir(token)
        manifest = self._read_manifest(operation_dir / "manifest.json")
        for item in reversed(manifest["assets"]):
            source = operation_dir / item["quarantined"]
            destination = (self.data_dir / Path(item["original"])).resolve(strict=False)
            if not destination.is_relative_to(self.data_dir) or destination == self.data_dir:
                raise ArchiveLifecycleError("quarantine_manifest_invalid", "隔离清单越界")
            destination.parent.mkdir(parents=True, exist_ok=True)
            if source.exists():
                os.replace(source, destination)
            digest, size = self._hash_path(destination)
            if digest != item["hash"] or size != int(item["size"]):
                raise ArchiveLifecycleError("quarantine_restore_corrupt", "隔离文件恢复校验失败")
        self.finalize(token)

    def finalize(self, token: str) -> None:
        operation_dir = self._operation_dir(token)
        if not operation_dir.exists():
            return
        resolved = operation_dir.resolve(strict=True)
        root = self.root.resolve(strict=False)
        if resolved.parent != root or resolved == root or self._is_link_or_reparse(resolved):
            raise ArchiveLifecycleError("quarantine_path_invalid", "隔离目录不安全")
        shutil.rmtree(resolved)

    def _validate_source(self, path: Path) -> Path:
        resolved = path.resolve(strict=True)
        if not resolved.is_relative_to(self.data_dir) or resolved == self.data_dir:
            raise ArchiveLifecycleError("managed_path_invalid", "受管文件路径越界")
        quarantine_root = self.root.resolve(strict=False)
        if resolved.is_relative_to(quarantine_root) or self._is_link_or_reparse(path):
            raise ArchiveLifecycleError("managed_path_invalid", "受管文件路径不安全")
        return resolved

    def _operation_dir(self, token: str) -> Path:
        if not token or any(
            character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"
            for character in token
        ):
            raise ArchiveLifecycleError("quarantine_token_invalid", "隔离 token 无效")
        candidate = (self.root / token).resolve(strict=False)
        if candidate.parent != self.root.resolve(strict=False):
            raise ArchiveLifecycleError("quarantine_token_invalid", "隔离 token 越界")
        return candidate

    @staticmethod
    def _write_manifest(path: Path, manifest: dict[str, Any]) -> None:
        temporary = path.with_suffix(".tmp")
        temporary.write_text(
            json.dumps(manifest, ensure_ascii=True, sort_keys=True, separators=(",", ":")),
            encoding="utf-8",
        )
        os.replace(temporary, path)

    @staticmethod
    def _read_manifest(path: Path) -> dict[str, Any]:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ArchiveLifecycleError("quarantine_manifest_invalid", "隔离清单不可读") from exc
        if not isinstance(value, dict) or not isinstance(value.get("assets"), list):
            raise ArchiveLifecycleError("quarantine_manifest_invalid", "隔离清单无效")
        return value

    @classmethod
    def _hash_path(cls, path: Path) -> tuple[str, int]:
        digest = hashlib.sha256()
        if path.is_file():
            size = cls._hash_file_into(digest, path)
            return digest.hexdigest(), size
        if not path.is_dir():
            raise ArchiveLifecycleError("managed_path_invalid", "受管资产不是文件或目录")
        size = 0
        for item in sorted(path.rglob("*"), key=lambda value: value.as_posix()):
            if item.is_symlink() or cls._is_link_or_reparse(item):
                raise ArchiveLifecycleError("managed_path_invalid", "受管资产包含链接")
            relative = item.relative_to(path).as_posix().encode("utf-8")
            digest.update(relative)
            if item.is_file():
                size += cls._hash_file_into(digest, item)
        return digest.hexdigest(), size

    @staticmethod
    def _hash_file_into(digest, path: Path) -> int:
        size = 0
        with path.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
                size += len(chunk)
        return size

    @staticmethod
    def _is_link_or_reparse(path: Path) -> bool:
        try:
            metadata = path.lstat()
        except OSError:
            return True
        attributes = getattr(metadata, "st_file_attributes", 0)
        reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
        return stat.S_ISLNK(metadata.st_mode) or bool(attributes & reparse_flag)


class PurgeDatabaseExecutor:
    def __init__(self, repositories: StorageRepositories) -> None:
        self._repositories = repositories

    def execute(self, plan: PurgePlan) -> dict[str, int]:
        with self._repositories.db.transaction(immediate=True) as conn:
            self._validate_plan(conn, plan)
            counts = self._delete_session_relations(conn, plan)
            if plan.entity_type == "workspace":
                workspace_scope_counts = self._delete_workspace_scope_relations(
                    conn,
                    plan.entity_id,
                )
                for table, total in workspace_scope_counts.items():
                    counts[table] = counts.get(table, 0) + total
                counts["workspace_annotations"] = conn.execute(
                    "delete from workspace_annotations where workspace_id = ?",
                    (plan.entity_id,),
                ).rowcount
                counts["workspaces"] = conn.execute(
                    "delete from workspaces where id = ? and archived_at is not null",
                    (plan.entity_id,),
                ).rowcount
            return {key: int(value or 0) for key, value in counts.items()}

    def _validate_plan(self, conn, plan: PurgePlan) -> None:
        signatures = PurgePlanner._session_signatures(conn, plan.session_ids)
        if tuple(signatures) != plan.session_signatures:
            raise ArchiveLifecycleError("purge_plan_stale", "彻底删除计划已过期，请重试")
        if any(not signature[2] for signature in signatures):
            raise ArchiveLifecycleError("not_archived", "目标中存在未归档会话")
        if plan.entity_type in {"workspace", "workspace_sessions"}:
            workspace = conn.execute(
                "select archived_at from workspaces where id = ?",
                (plan.entity_id,),
            ).fetchone()
            if workspace is None:
                raise ArchiveLifecycleError("not_found", "项目不存在")
            if plan.entity_type == "workspace" and workspace["archived_at"] is None:
                raise ArchiveLifecycleError("not_archived", "项目不再处于归档状态")
            archived_only = (
                " and archived_at is not null" if plan.entity_type == "workspace_sessions" else ""
            )
            sessions_query = (
                f"select id from sessions where workspace_id = ?{archived_only} order by id asc"
            )
            current_ids = tuple(
                str(row["id"])
                for row in conn.execute(
                    sessions_query,
                    (plan.entity_id,),
                ).fetchall()
            )
            if current_ids != plan.session_ids:
                raise ArchiveLifecycleError("purge_plan_stale", "项目归档会话集合已变化，请重试")
        if plan.entity_type == "workspace":
            annotation_total = int(
                conn.execute(
                    "select count(*) as total from workspace_annotations where workspace_id = ?",
                    (plan.entity_id,),
                ).fetchone()["total"]
            )
            if int(plan.database_counts.get("workspace_annotations", 0)) != annotation_total:
                raise ArchiveLifecycleError("purge_plan_stale", "项目关联数据已变化，请重试")
        current_counts = PurgePlanner._relation_counts(conn, plan.session_ids)
        if plan.entity_type == "workspace":
            for table, total in PurgePlanner._workspace_scope_counts(
                conn,
                plan.entity_id,
            ).items():
                current_counts[table] = current_counts.get(table, 0) + total
        for table, total in current_counts.items():
            if int(plan.database_counts.get(table, 0)) != total:
                raise ArchiveLifecycleError("purge_plan_stale", "彻底删除依赖已变化，请重试")
        current_artifact_ids = tuple(
            str(row["id"]) for row in PurgePlanner._artifact_rows_for_purge(conn, plan.session_ids)
        )
        if current_artifact_ids != plan.artifact_ids:
            raise ArchiveLifecycleError("purge_plan_stale", "工具结果引用已变化，请重试")

    def _delete_session_relations(self, conn, plan: PurgePlan) -> dict[str, int]:
        predicate, params = self._session_predicate(plan, "session_id")
        active_predicate, active_params = self._session_predicate(plan, "active_session_id")
        counts: dict[str, int] = {}

        counts.update(self._delete_session_web_annotation_relations(conn, plan))

        counts["tool_result_artifact_grants"] = conn.execute(
            f"delete from tool_result_artifact_grants where {predicate}",
            params,
        ).rowcount
        if plan.artifact_ids:
            artifact_placeholders = ", ".join("?" for _ in plan.artifact_ids)
            counts["tool_result_artifacts"] = conn.execute(
                f"""
                delete from tool_result_artifacts
                 where id in ({artifact_placeholders})
                   and not exists (
                     select 1 from tool_result_artifact_grants grants
                      where grants.artifact_id = tool_result_artifacts.id
                   )
                """,
                plan.artifact_ids,
            ).rowcount
        else:
            counts["tool_result_artifacts"] = 0

        operation_predicate, operation_params = self._session_predicate(plan, "session_id")
        operation_active_predicate, operation_active_params = self._session_predicate(
            plan,
            "active_session_id",
        )
        counts["file_history_locks"] = conn.execute(
            f"""
            delete from file_history_locks
            where owner_operation_id in (
              select id from file_history_operations
              where {operation_predicate} or {operation_active_predicate}
            )
            """,
            [*operation_params, *operation_active_params],
        ).rowcount
        counts["file_history_operation_files"] = conn.execute(
            f"""
            delete from file_history_operation_files
            where operation_id in (
              select id from file_history_operations
              where {operation_predicate} or {operation_active_predicate}
            )
            """,
            [*operation_params, *operation_active_params],
        ).rowcount
        counts["file_history_operations"] = conn.execute(
            f"delete from file_history_operations where {predicate} or {active_predicate}",
            [*params, *active_params],
        ).rowcount
        for table in (
            "file_history_path_heads",
            "file_history_tracked_files",
            "file_history_session_state",
        ):
            counts[table] = conn.execute(
                f"delete from {table} where {predicate}",
                params,
            ).rowcount
        counts["file_history_mutations"] = conn.execute(
            f"delete from file_history_mutations where {predicate} or {active_predicate}",
            [*params, *active_params],
        ).rowcount
        snapshot_predicate, snapshot_params = self._session_predicate(plan, "session_id")
        snapshot_active_predicate, snapshot_active_params = self._session_predicate(
            plan,
            "active_session_id",
        )
        counts["file_history_snapshot_entries"] = conn.execute(
            f"""
            delete from file_history_snapshot_entries
            where snapshot_id in (
              select id from file_history_snapshots
              where {snapshot_predicate} or {snapshot_active_predicate}
            )
            """,
            [*snapshot_params, *snapshot_active_params],
        ).rowcount
        counts["file_history_snapshot_scopes"] = conn.execute(
            f"""
            delete from file_history_snapshot_scopes
            where snapshot_id in (
              select id from file_history_snapshots
              where {snapshot_predicate} or {snapshot_active_predicate}
            )
            """,
            [*snapshot_params, *snapshot_active_params],
        ).rowcount
        counts["file_history_snapshots"] = conn.execute(
            "delete from file_history_snapshots "
            f"where {snapshot_predicate} or {snapshot_active_predicate}",
            [*snapshot_params, *snapshot_active_params],
        ).rowcount

        for table in ("thread_task_runs", "thread_tasks"):
            counts[table] = conn.execute(
                f"delete from {table} where {predicate}",
                params,
            ).rowcount
        run_parent_predicate, run_parent_params = self._session_predicate(plan, "parent_session_id")
        run_child_predicate, run_child_params = self._session_predicate(plan, "child_session_id")
        counts["subagent_run"] = conn.execute(
            f"delete from subagent_run where {run_parent_predicate} or {run_child_predicate}",
            [*run_parent_params, *run_child_params],
        ).rowcount
        source_predicate, source_params = self._session_predicate(plan, "source_session_id")
        target_predicate, target_params = self._session_predicate(plan, "target_session_id")
        counts["session_forks"] = conn.execute(
            f"delete from session_forks where {source_predicate} or {target_predicate}",
            [*source_params, *target_params],
        ).rowcount
        counts["command_approval_audit"] = conn.execute(
            f"delete from command_approval_audit where {predicate}",
            params,
        ).rowcount
        counts["command_approval_requests"] = conn.execute(
            f"delete from command_approval_requests where {predicate}",
            params,
        ).rowcount
        counts["a2ui_interactions"] = conn.execute(
            f"delete from a2ui_interactions where {predicate} or {active_predicate}",
            [*params, *active_params],
        ).rowcount
        promotion_predicate, promotion_params = self._session_predicate(
            plan,
            "target_session_id",
        )
        counts["right_sidebar_scope_promotions"] = conn.execute(
            f"delete from right_sidebar_scope_promotions where {promotion_predicate}",
            promotion_params,
        ).rowcount
        counts["right_sidebar_scope_states"] = conn.execute(
            f"delete from right_sidebar_scope_states where {predicate}",
            params,
        ).rowcount
        for table in (
            "session_pending_inputs",
            "message_events",
            "web_annotation_attachment_clones",
            "attachments",
            "mcp_session_tool_usage",
            "mcp_trust_rules",
            "mcp_session_tool_overrides",
            "mcp_runtime_snapshots",
            "mcp_audit_log",
        ):
            counts[table] = conn.execute(
                f"delete from {table} where {predicate}",
                params,
            ).rowcount
        original_predicate, original_params = self._session_predicate(plan, "original_session_id")
        target_predicate, target_params = self._session_predicate(plan, "target_session_id")
        counts["compression_staging"] = conn.execute(
            f"""
            delete from compression_staging
            where {original_predicate} or {active_predicate} or {target_predicate}
            """,
            [*original_params, *active_params, *target_params],
        ).rowcount
        counts["trace_event_log"] = conn.execute(
            f"""
            delete from trace_event_log
            where {original_predicate} or {active_predicate}
               or trace_record_id in (select trace_id from trace_record where {predicate})
            """,
            [*original_params, *active_params, *params],
        ).rowcount
        counts["llm_request_logs"] = conn.execute(
            f"delete from llm_request_logs where {predicate} or {active_predicate}",
            [*params, *active_params],
        ).rowcount
        counts["trace_record"] = conn.execute(
            f"delete from trace_record where {predicate} or {active_predicate}",
            [*params, *active_params],
        ).rowcount

        thread_predicate, thread_params = self._session_predicate(plan, "thread_id")
        counts["checkpoint_writes_v2"] = conn.execute(
            f"delete from checkpoint_writes_v2 where {thread_predicate}",
            thread_params,
        ).rowcount
        counts["checkpoints_v2"] = conn.execute(
            f"delete from checkpoints_v2 where {thread_predicate}",
            thread_params,
        ).rowcount

        source_active_predicate, source_active_params = self._session_predicate(
            plan,
            "source_active_session_id",
        )
        parent_predicate, parent_params = self._session_predicate(plan, "parent_session_id")
        child_predicate, child_params = self._session_predicate(plan, "child_session_id")
        session_id_predicate, session_id_params = self._session_predicate(plan, "id")
        conn.execute(
            f"""
            update sessions
            set parent_session_id = case
                  when {parent_predicate} then null else parent_session_id end,
                child_session_id = case
                  when {child_predicate} then null else child_session_id end,
                source_trace_id = case
                  when {source_active_predicate} then null else source_trace_id end,
                source_active_session_id = case
                  when {source_active_predicate} then null else source_active_session_id end,
                source_checkpoint_id = case
                  when {source_active_predicate} then null else source_checkpoint_id end,
                source_checkpoint_ns = case
                  when {source_active_predicate} then null else source_checkpoint_ns end
            where ({parent_predicate} or {child_predicate} or {source_active_predicate})
              and not ({session_id_predicate})
              and agent_kind != 'subagent'
            """,
            [
                *parent_params,
                *child_params,
                *source_active_params,
                *source_active_params,
                *source_active_params,
                *source_active_params,
                *parent_params,
                *child_params,
                *source_active_params,
                *session_id_params,
            ],
        )
        internal_deleted = conn.execute(
            f"""
            delete from sessions
            where {session_id_predicate}
              and archived_at is not null
              and agent_kind = 'subagent'
            """,
            session_id_params,
        ).rowcount
        visible_deleted = conn.execute(
            f"delete from sessions where {session_id_predicate} and archived_at is not null",
            session_id_params,
        ).rowcount
        counts["sessions"] = int(internal_deleted or 0) + int(visible_deleted or 0)
        return counts

    def _delete_session_web_annotation_relations(
        self,
        conn,
        plan: PurgePlan,
    ) -> dict[str, int]:
        predicate, params = self._session_predicate(plan, "session_id")
        resource_filter = f"scope_kind = 'session' and {predicate}"
        annotation_ids = (
            "select id from web_annotations where resource_id in "
            f"(select id from web_annotation_resources where {resource_filter})"
        )
        resource_ids = f"select id from web_annotation_resources where {resource_filter}"
        counts = {
            "web_annotation_target_history": conn.execute(
                "delete from web_annotation_target_history "
                f"where annotation_id in ({annotation_ids})",
                params,
            ).rowcount,
            "web_annotation_assets": conn.execute(
                f"delete from web_annotation_assets where resource_id in ({resource_ids})",
                params,
            ).rowcount,
            "web_annotations": conn.execute(
                f"delete from web_annotations where resource_id in ({resource_ids})",
                params,
            ).rowcount,
            "web_annotation_resources": conn.execute(
                f"delete from web_annotation_resources where {resource_filter}",
                params,
            ).rowcount,
        }
        return {key: int(value or 0) for key, value in counts.items()}

    @staticmethod
    def _delete_workspace_scope_relations(conn, workspace_id: str) -> dict[str, int]:
        resource_filter = "scope_kind = 'workspace' and workspace_id = ?"
        annotation_ids = (
            "select id from web_annotations where resource_id in "
            f"(select id from web_annotation_resources where {resource_filter})"
        )
        resource_ids = f"select id from web_annotation_resources where {resource_filter}"
        counts = {
            "right_sidebar_scope_states": conn.execute(
                "delete from right_sidebar_scope_states "
                "where scope_kind = 'workspace' and workspace_id = ?",
                (workspace_id,),
            ).rowcount,
            "web_annotation_target_history": conn.execute(
                "delete from web_annotation_target_history "
                f"where annotation_id in ({annotation_ids})",
                (workspace_id,),
            ).rowcount,
            "web_annotation_assets": conn.execute(
                f"delete from web_annotation_assets where resource_id in ({resource_ids})",
                (workspace_id,),
            ).rowcount,
            "web_annotations": conn.execute(
                f"delete from web_annotations where resource_id in ({resource_ids})",
                (workspace_id,),
            ).rowcount,
            "web_annotation_resources": conn.execute(
                f"delete from web_annotation_resources where {resource_filter}",
                (workspace_id,),
            ).rowcount,
        }
        return {key: int(value or 0) for key, value in counts.items()}

    @staticmethod
    def _session_predicate(plan: PurgePlan, column: str) -> tuple[str, list[str]]:
        if plan.entity_type == "workspace":
            return (
                f"{column} in (select id from sessions where workspace_id = ?)",
                [plan.entity_id],
            )
        if plan.entity_type == "workspace_sessions":
            return (
                f"{column} in (select id from sessions "
                "where workspace_id = ? and archived_at is not null)",
                [plan.entity_id],
            )
        placeholders = ", ".join("?" for _ in plan.session_ids)
        return f"{column} in ({placeholders})", list(plan.session_ids)


class PurgeService:
    def __init__(
        self,
        repositories: StorageRepositories,
        *,
        data_dir: str | Path,
        fault_injector: Callable[[str], None] | None = None,
    ) -> None:
        self._repositories = repositories
        self._operations = repositories.lifecycle_operations
        self._planner = PurgePlanner(repositories, data_dir=data_dir)
        self._quarantine = LifecycleQuarantine(data_dir)
        self._database = PurgeDatabaseExecutor(repositories)
        self._fault_injector = fault_injector

    def purge_session(
        self,
        session_id: str,
        *,
        request_id: str,
        confirmed: bool,
    ) -> dict[str, Any]:
        if not confirmed:
            raise ArchiveLifecycleError("purge_confirmation_required", "需要确认彻底删除会话")
        return self._purge(
            entity_type="session",
            entity_id=session_id,
            request_id=request_id,
            payload={"confirmed": True},
            planner=lambda: self._planner.plan_session(session_id),
            scopes=[("session", session_id)],
        )

    def purge_workspace(
        self,
        workspace_id: str,
        *,
        request_id: str,
        confirmation_name: str,
    ) -> dict[str, Any]:
        workspace = self._repositories.workspaces.get_archived(workspace_id)
        if workspace is None:
            if self._repositories.workspaces.get(workspace_id) is not None:
                raise ArchiveLifecycleError("not_archived", "只有已归档项目可以彻底删除")
        elif unicodedata.normalize("NFC", confirmation_name) != unicodedata.normalize(
            "NFC", workspace.name
        ):
            raise ArchiveLifecycleError("confirmation_mismatch", "输入的项目名称不匹配")
        return self._purge(
            entity_type="workspace",
            entity_id=workspace_id,
            request_id=request_id,
            payload={
                "confirmation_name_hash": hashlib.sha256(
                    unicodedata.normalize("NFC", confirmation_name).encode()
                ).hexdigest()
            },
            planner=lambda: self._planner.plan_workspace(workspace_id),
            scopes=[("workspace", workspace_id)],
        )

    def purge_workspace_sessions(
        self,
        workspace_id: str,
        *,
        request_id: str,
        confirmation_name: str,
    ) -> dict[str, Any]:
        workspace = self._repositories.workspaces.get(
            workspace_id
        ) or self._repositories.workspaces.get_archived(workspace_id)
        if workspace is not None and unicodedata.normalize(
            "NFC", confirmation_name
        ) != unicodedata.normalize("NFC", workspace.name):
            raise ArchiveLifecycleError("confirmation_mismatch", "输入的项目名称不匹配")
        return self._purge(
            entity_type="workspace",
            result_entity_type="workspace_sessions",
            entity_id=workspace_id,
            request_id=request_id,
            payload={
                "scope": "archived_sessions",
                "confirmation_name_hash": hashlib.sha256(
                    unicodedata.normalize("NFC", confirmation_name).encode()
                ).hexdigest(),
            },
            planner=lambda: self._planner.plan_workspace_sessions(workspace_id),
            scopes=[("workspace", workspace_id)],
        )

    def _purge(
        self,
        *,
        entity_type: str,
        result_entity_type: str | None = None,
        entity_id: str,
        request_id: str,
        payload: dict[str, Any],
        planner: Callable[[], PurgePlan],
        scopes: list[tuple[str, str]],
    ) -> dict[str, Any]:
        resolved_result_entity_type = result_entity_type or entity_type
        try:
            created = self._operations.create_or_replay(
                request_id=request_id,
                entity_type=entity_type,
                entity_id=entity_id,
                action="purge",
                payload=payload,
            )
        except ValueError as exc:
            raise ArchiveLifecycleError("request_id_conflict", "request_id 已用于不同请求") from exc
        operation = created.operation
        if not created.created and operation.state == "completed":
            return self._result(
                operation,
                entity_type=resolved_result_entity_type,
                replayed=True,
            )
        self._acquire(operation, scopes)
        try:
            latest = self._operations.get(operation.id) or operation
            if latest.state in {"cleanup_failed", "db_committed"}:
                return self._retry_finalize(
                    latest,
                    entity_type=resolved_result_entity_type,
                )
            self._inject("plan")
            plan = planner()
            latest = self._advance(
                latest,
                state="running",
                counts={"planned_sessions": len(plan.session_ids)},
            )
            token: str | None = None
            try:
                self._inject("quarantine")
                token = self._quarantine.quarantine(plan, operation.id)
                latest = self._advance(latest, state="quarantined", quarantine_token=token)
                self._inject("database")
                deleted_counts = self._database.execute(plan)
            except Exception:
                if token is not None:
                    try:
                        self._quarantine.rollback(token)
                    except Exception as rollback_error:
                        self._advance(
                            latest,
                            state="compensation_failed",
                            error_code="quarantine_rollback_failed",
                        )
                        raise ArchiveLifecycleError(
                            "compensation_failed",
                            "数据库删除失败且隔离资产恢复失败，需要人工处理",
                            {"operation_id": operation.id},
                        ) from rollback_error
                self._advance(latest, state="rolled_back", error_code="purge_failed")
                raise
            latest = self._advance(
                latest,
                state="db_committed",
                counts=deleted_counts,
                result={"entity_type": entity_type, "state": "db_committed"},
            )
            try:
                self._inject("finalize")
                self._quarantine.finalize(operation.id)
            except Exception as exc:
                failed = self._advance(
                    latest,
                    state="cleanup_failed",
                    error_code="quarantine_cleanup_failed",
                    error_detail={"retryable": True, "phase": "finalize"},
                )
                raise ArchiveLifecycleError(
                    "cleanup_failed",
                    "Keydex 数据已删除，但受管隔离区清理失败，可手动重试",
                    {
                        "operation_id": failed.id,
                        "request_id": failed.request_id,
                        "retryable": True,
                        "_lifecycle_event": self._purged_event(
                            failed,
                            entity_type=resolved_result_entity_type,
                            cleanup_state="cleanup_failed",
                        ),
                    },
                ) from exc
            completed = self._advance(latest, state="completed", completed=True)
            result = self._result(
                completed,
                entity_type=resolved_result_entity_type,
                replayed=False,
            )
            self._operations.scrub_completed_purge(operation.id)
            return result
        finally:
            self._operations.release_locks(operation.id)

    def _retry_finalize(
        self,
        operation: LifecycleOperationRecord,
        *,
        entity_type: str,
    ) -> dict[str, Any]:
        token = operation.quarantine_token or operation.id
        try:
            self._inject("finalize")
            self._quarantine.finalize(token)
        except Exception as exc:
            if operation.state != "cleanup_failed":
                operation = self._advance(
                    operation,
                    state="cleanup_failed",
                    error_code="quarantine_cleanup_failed",
                    error_detail={"retryable": True, "phase": "finalize"},
                )
            raise ArchiveLifecycleError(
                "cleanup_failed",
                "隔离区仍未清理完成，可再次手动重试",
                {"operation_id": operation.id, "retryable": True},
            ) from exc
        completed = self._advance(
            operation,
            state="completed",
            error_code=None,
            error_detail={"retryable": False, "phase": "completed"},
            completed=True,
        )
        result = self._result(completed, entity_type=entity_type, replayed=True)
        self._operations.scrub_completed_purge(operation.id)
        return result

    def _acquire(
        self,
        operation: LifecycleOperationRecord,
        scopes: list[tuple[str, str]],
    ) -> None:
        for entity_type, entity_id in sorted(
            scopes, key=lambda item: (item[0] != "workspace", item[1])
        ):
            if not self._operations.acquire_lock(
                operation_id=operation.id,
                entity_type=entity_type,
                entity_id=entity_id,
                ttl_seconds=120,
            ):
                self._operations.release_locks(operation.id)
                raise ArchiveLifecycleError("lifecycle_locked", "对象正在执行其他生命周期操作")

    def _advance(
        self,
        operation: LifecycleOperationRecord,
        *,
        state: str,
        counts: dict[str, int] | None = None,
        result: dict[str, Any] | None = None,
        error_code: str | None | object = None,
        error_detail: dict[str, Any] | None = None,
        quarantine_token: str | None | object = None,
        completed: bool = False,
    ) -> LifecycleOperationRecord:
        kwargs: dict[str, Any] = {
            "expected_revision": operation.revision,
            "state": state,
            "counts": counts,
            "result": result,
            "completed": completed,
        }
        if error_code is not None or state == "completed":
            kwargs["error_code"] = error_code
        if error_detail is not None:
            kwargs["error_detail"] = error_detail
        if quarantine_token is not None:
            kwargs["quarantine_token"] = quarantine_token
        updated = self._operations.update(operation.id, **kwargs)
        if updated is None:
            raise ArchiveLifecycleError("operation_conflict", "生命周期操作状态发生变化")
        return updated

    @staticmethod
    def _result(
        operation: LifecycleOperationRecord,
        *,
        entity_type: str,
        replayed: bool,
    ) -> dict[str, Any]:
        return {
            "operation_id": operation.id,
            "state": "completed",
            "entity_type": entity_type,
            "counts": operation.counts,
            "replayed": replayed,
            "event": PurgeService._purged_event(
                operation,
                entity_type=entity_type,
                cleanup_state="completed",
            )
            if not replayed
            else None,
        }

    @staticmethod
    def _purged_event(
        operation: LifecycleOperationRecord,
        *,
        entity_type: str,
        cleanup_state: str,
    ) -> dict[str, Any]:
        entity_key = "session_id" if entity_type == "session" else "workspace_id"
        return {
            "type": f"{entity_type}_purged",
            "operation_id": operation.id,
            "request_id": operation.request_id,
            entity_key: operation.entity_id,
            "counts": operation.counts,
            "cleanup_state": cleanup_state,
            "changed": True,
            "revision": operation.revision,
            "occurred_at": operation.completed_at or operation.updated_at,
        }

    def _inject(self, phase: str) -> None:
        if self._fault_injector is not None:
            self._fault_injector(phase)
