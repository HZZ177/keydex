from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from backend.app.services.archive_lifecycle_service import ArchiveLifecycleError
from backend.app.services.purge_service import (
    LifecycleQuarantine,
    PurgeAsset,
    PurgeDatabaseExecutor,
    PurgePlan,
    PurgePlanner,
    PurgeService,
)
from backend.app.storage import StorageRepositories, init_database


def _repositories(tmp_path) -> StorageRepositories:
    return StorageRepositories(init_database(tmp_path / "app.db"))


def _session(repositories, session_id: str, workspace_id: str | None = None):
    return repositories.sessions.create(
        session_id=session_id,
        user_id="local-user",
        scene_id="desktop-agent",
        workspace_id=workspace_id,
        title=f"Title {session_id}",
        source_active_session_id=None,
    )


def _archive_session(repositories, session_id: str, origin="manual") -> None:
    with repositories.db.transaction() as conn:
        conn.execute(
            """
            update sessions
            set archived_at = '2026-07-14T08:00:00Z', archive_origin = ?
            where id = ?
            """,
            (origin, session_id),
        )


def _workspace(repositories, tmp_path, workspace_id: str):
    root = tmp_path / workspace_id
    root.mkdir()
    return repositories.workspaces.create(
        workspace_id=workspace_id,
        root_path=root,
        name=f"Project {workspace_id}",
    )


def _record_attachment(
    repositories,
    *,
    attachment_id: str,
    session_id: str,
    path: Path,
):
    return repositories.attachments.create(
        attachment_id=attachment_id,
        session_id=session_id,
        user_id="local-user",
        type="image",
        source="pasted",
        name=path.name,
        path=str(path),
        mime_type="image/png",
        size=path.stat().st_size,
    )


def _insert_all_session_relation_rows(conn, *, session_id: str, prefix: str) -> None:
    """Insert one valid row in every table owned by a session purge."""

    now = "2026-07-14T00:00:00Z"
    server_id = "mcp-purge-inventory"
    conn.execute(
        """
        insert or ignore into mcp_servers (
          id, name, transport, created_at, updated_at
        ) values (?, 'Purge inventory', 'stdio', ?, ?)
        """,
        (server_id, now, now),
    )
    conn.execute(
        """
        insert into mcp_session_tool_usage (
          session_id, server_id, raw_tool_name, model_name, last_success_at
        ) values (?, ?, ?, 'test-model', ?)
        """,
        (session_id, server_id, f"tool-{prefix}", now),
    )
    conn.execute(
        """
        insert into mcp_trust_rules (
          id, server_id, raw_tool_name, rule_kind, scope, session_id,
          approval_mode, created_at, updated_at
        ) values (?, ?, ?, 'tool', 'session', ?, 'approve', ?, ?)
        """,
        (f"trust-{prefix}", server_id, f"tool-{prefix}", session_id, now, now),
    )
    conn.execute(
        """
        insert into mcp_session_tool_overrides (
          id, session_id, server_id, raw_tool_name, enabled, created_at
        ) values (?, ?, ?, ?, 1, ?)
        """,
        (f"override-{prefix}", session_id, server_id, f"tool-{prefix}", now),
    )
    conn.execute(
        """
        insert into mcp_runtime_snapshots (
          id, session_id, tool_inventory_revision, visible_tools_json,
          server_status_json, policy_summary_json, created_at
        ) values (?, ?, 1, '[]', '{}', '{}', ?)
        """,
        (f"runtime-{prefix}", session_id, now),
    )
    conn.execute(
        """
        insert into mcp_audit_log (id, event_type, session_id, created_at)
        values (?, 'tool_call', ?, ?)
        """,
        (f"mcp-audit-{prefix}", session_id, now),
    )

    task_id = f"task-{prefix}"
    conn.execute(
        """
        insert into thread_tasks (
          id, session_id, type, objective, status, created_at, updated_at
        ) values (?, ?, 'goal', 'inventory', 'complete', ?, ?)
        """,
        (task_id, session_id, now, now),
    )
    conn.execute(
        """
        insert into thread_task_runs (
          id, task_id, session_id, status, started_at, created_at, updated_at
        ) values (?, ?, ?, 'succeeded', ?, ?, ?)
        """,
        (f"task-run-{prefix}", task_id, session_id, now, now, now),
    )
    conn.execute(
        """
        insert into session_forks (
          id, source_session_id, target_session_id,
          source_message_event_id, target_message_event_id,
          source_turn_index, target_turn_index, created_at, updated_at
        ) values (?, ?, ?, ?, ?, 1, 1, ?, ?)
        """,
        (
            f"fork-{prefix}",
            session_id,
            session_id,
            f"source-event-{prefix}",
            f"target-event-{prefix}",
            now,
            now,
        ),
    )
    conn.execute(
        """
        insert into attachments (
          id, session_id, user_id, type, source, name, path, mime_type,
          size, created_at, updated_at
        ) values (?, ?, 'local-user', 'file', 'test', ?, ?,
                  'application/octet-stream', 0, ?, ?)
        """,
        (
            f"attachment-{prefix}",
            session_id,
            f"{prefix}.bin",
            f"X:/external/{prefix}.bin",
            now,
            now,
        ),
    )
    conn.execute(
        """
        insert into message_events (
          id, session_id, seq, turn_index, action, created_at, updated_at
        ) values (?, ?, 1, 1, 'completed', ?, ?)
        """,
        (f"message-{prefix}", session_id, now, now),
    )
    conn.execute(
        """
        insert into session_pending_inputs (
          id, session_id, mode, status, message, created_at, updated_at
        ) values (?, ?, 'queue', 'queued', 'inventory', ?, ?)
        """,
        (f"pending-{prefix}", session_id, now, now),
    )
    conn.execute(
        """
        insert into a2ui_interactions (
          id, session_id, active_session_id, stream_id, render_key, mode,
          created_at, updated_at
        ) values (?, ?, ?, ?, ?, 'render', ?, ?)
        """,
        (
            f"a2ui-{prefix}",
            session_id,
            session_id,
            f"stream-{prefix}",
            f"render-{prefix}",
            now,
            now,
        ),
    )
    conn.execute(
        """
        insert into compression_staging (
          original_session_id, active_session_id, target_session_id,
          generation, created_at, updated_at
        ) values (?, ?, ?, 1, ?, ?)
        """,
        (session_id, session_id, session_id, now, now),
    )

    approval_id = f"approval-{prefix}"
    conn.execute(
        """
        insert into command_approval_requests (
          id, session_id, title, command, status, created_at, updated_at
        ) values (?, ?, 'Inventory', 'echo inventory', 'approved', ?, ?)
        """,
        (approval_id, session_id, now, now),
    )
    conn.execute(
        """
        insert into command_approval_audit (
          id, approval_id, session_id, command, decision, created_at
        ) values (?, ?, ?, 'echo inventory', 'approved', ?)
        """,
        (f"approval-audit-{prefix}", approval_id, session_id, now),
    )

    trace_id = f"trace-{prefix}"
    conn.execute(
        """
        insert into trace_record (
          trace_id, session_id, active_session_id, scene_id, user_id,
          turn_index, root_node_id, status, start_time, created_at, updated_at
        ) values (?, ?, ?, 'desktop-agent', 'local-user', 1, ?,
                  'completed', ?, ?, ?)
        """,
        (trace_id, session_id, session_id, f"root-{prefix}", now, now, now),
    )
    conn.execute(
        """
        insert into llm_request_logs (
          id, trace_id, trace_record_id, session_id, active_session_id,
          model, status, start_time, created_at, updated_at
        ) values (?, ?, ?, ?, ?, 'test-model', 'completed', ?, ?, ?)
        """,
        (
            f"llm-{prefix}",
            trace_id,
            trace_id,
            session_id,
            session_id,
            now,
            now,
            now,
        ),
    )
    conn.execute(
        """
        insert into trace_event_log (
          trace_id, trace_record_id, event_type, source, idempotency_key,
          original_session_id, active_session_id, timestamp_ms, occurred_at,
          payload_json, created_at, updated_at
        ) values (?, ?, 'completed', 'test', ?, ?, ?, 1, ?, '{}', ?, ?)
        """,
        (
            trace_id,
            trace_id,
            f"trace-event-{prefix}",
            session_id,
            session_id,
            now,
            now,
            now,
        ),
    )

    snapshot_id = f"snapshot-{prefix}"
    workspace_identity = f"workspace-{prefix}"
    canonical_path = f"/{prefix}.txt"
    conn.execute(
        """
        insert into file_history_snapshots (
          id, session_id, active_session_id, kind, sequence, workspace_root,
          workspace_identity, status, created_at, updated_at
        ) values (?, ?, ?, 'input', 1, 'D:/inventory', ?, 'ready', ?, ?)
        """,
        (snapshot_id, session_id, session_id, workspace_identity, now, now),
    )
    conn.execute(
        """
        insert into file_history_session_state (
          session_id, active_snapshot_id, created_at, updated_at
        ) values (?, ?, ?, ?)
        """,
        (session_id, snapshot_id, now, now),
    )
    conn.execute(
        """
        insert into file_history_snapshot_scopes (
          snapshot_id, scope_kind, scope_identity, scope_root, scope_label
        ) values (?, 'workspace', ?, 'D:/inventory', 'inventory')
        """,
        (snapshot_id, workspace_identity),
    )
    conn.execute(
        """
        insert into file_history_snapshot_entries (
          snapshot_id, scope_kind, scope_identity, scope_root, scope_label,
          canonical_path, display_path, state, version, backup_time
        ) values (?, 'workspace', ?, 'D:/inventory', 'inventory', ?, ?, 'missing', 1, ?)
        """,
        (snapshot_id, workspace_identity, canonical_path, canonical_path, now),
    )
    conn.execute(
        """
        insert into file_history_tracked_files (
          session_id, scope_kind, scope_identity, scope_root, scope_label,
          canonical_path, display_path, latest_version,
          first_snapshot_id, last_snapshot_id, last_observed_state,
          created_at, updated_at
        ) values (?, 'workspace', ?, 'D:/inventory', 'inventory', ?, ?, 1, ?, ?, 'missing', ?, ?)
        """,
        (
            session_id,
            workspace_identity,
            canonical_path,
            canonical_path,
            snapshot_id,
            snapshot_id,
            now,
            now,
        ),
    )
    mutation_id = f"mutation-{prefix}"
    conn.execute(
        """
        insert into file_history_mutations (
          id, session_id, active_session_id, snapshot_id, workspace_identity,
          scope_kind, scope_identity, scope_root, scope_label,
          canonical_path, display_path, mutation_kind, before_state,
          after_state, status, created_at, updated_at
        ) values (?, ?, ?, ?, ?, 'workspace', ?, 'D:/inventory', 'inventory', ?, ?, 'update', 'missing', 'missing',
                  'committed', ?, ?)
        """,
        (
            mutation_id,
            session_id,
            session_id,
            snapshot_id,
            workspace_identity,
            workspace_identity,
            canonical_path,
            canonical_path,
            now,
            now,
        ),
    )
    conn.execute(
        """
        insert into file_history_path_heads (
          workspace_identity, scope_kind, scope_identity, scope_root, scope_label,
          canonical_path, display_path, session_id,
          mutation_id, state, updated_at
        ) values (?, 'workspace', ?, 'D:/inventory', 'inventory', ?, ?, ?, ?, 'missing', ?)
        """,
        (
            workspace_identity,
            workspace_identity,
            canonical_path,
            canonical_path,
            session_id,
            mutation_id,
            now,
        ),
    )
    operation_id = f"file-operation-{prefix}"
    conn.execute(
        """
        insert into file_history_operations (
          id, request_id, session_id, active_session_id, target_snapshot_id,
          workspace_identity, mode, decision, state, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, 'both', 'full', 'full', ?, ?)
        """,
        (
            operation_id,
            f"file-request-{prefix}",
            session_id,
            session_id,
            snapshot_id,
            workspace_identity,
            now,
            now,
        ),
    )
    conn.execute(
        """
        insert into file_history_operation_files (
          operation_id, scope_kind, scope_identity, scope_root, scope_label,
          canonical_path, display_path, preview_current_state,
          target_state, classification, writer_session_id, updated_at
        ) values (?, 'workspace', ?, 'D:/inventory', 'inventory', ?, ?, 'missing', 'missing', 'ready', ?, ?)
        """,
        (
            operation_id,
            workspace_identity,
            canonical_path,
            canonical_path,
            session_id,
            now,
        ),
    )
    conn.execute(
        """
        insert into file_history_locks (
          lock_key, owner_operation_id, acquired_at, expires_at
        ) values (?, ?, ?, '2026-07-14T00:05:00Z')
        """,
        (f"file-lock-{prefix}", operation_id, now),
    )
    conn.execute(
        """
        insert into checkpoints_v2 (
          thread_id, checkpoint_ns, checkpoint_id, created_at,
          checkpoint_blob, metadata
        ) values (?, '', ?, ?, x'00', '{}')
        """,
        (session_id, f"checkpoint-{prefix}", now),
    )
    conn.execute(
        """
        insert into checkpoint_writes_v2 (
          thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel,
          created_at
        ) values (?, '', ?, ?, 0, 'messages', ?)
        """,
        (session_id, f"checkpoint-{prefix}", f"checkpoint-task-{prefix}", now),
    )


def _schema_session_owned_tables(conn) -> set[str]:
    tables = {
        str(row["name"])
        for row in conn.execute(
            "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'"
        )
    }
    owned = {"sessions", *PurgePlanner.SESSION_THREAD_RELATIONS}
    for table in tables:
        columns = {
            str(row["name"])
            for row in conn.execute(f'pragma table_info("{table}")')
        }
        if any(column == "session_id" or column.endswith("_session_id") for column in columns):
            owned.add(table)

    changed = True
    while changed:
        changed = False
        for table in tables - owned:
            foreign_keys = conn.execute(f'pragma foreign_key_list("{table}")').fetchall()
            if any(
                str(row["table"]) in owned
                and str(row["on_delete"]).upper() != "SET NULL"
                for row in foreign_keys
            ):
                owned.add(table)
                changed = True
    return owned


def test_purge_inventory_matches_every_current_session_owned_table(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    handled = {
        "sessions",
        *(table for table, _ in PurgePlanner.SESSION_RELATIONS),
        *(relation[0] for relation in PurgePlanner.SESSION_INDIRECT_RELATIONS),
        *PurgePlanner.SESSION_THREAD_RELATIONS,
    }

    with repositories.db.connect() as conn:
        discovered = _schema_session_owned_tables(conn)

    assert discovered == handled


def test_session_database_purge_covers_complete_inventory_and_preserves_neighbor(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    target_workspace = _workspace(repositories, tmp_path, "ws-inventory-target")
    neighbor_workspace = _workspace(repositories, tmp_path, "ws-inventory-neighbor")
    target = _session(repositories, "ses-inventory-target", target_workspace.id)
    neighbor = _session(repositories, "ses-inventory-neighbor", neighbor_workspace.id)
    _archive_session(repositories, target.id)
    with repositories.db.transaction() as conn:
        _insert_all_session_relation_rows(conn, session_id=target.id, prefix="target")
        _insert_all_session_relation_rows(conn, session_id=neighbor.id, prefix="neighbor")

    planner = PurgePlanner(repositories, data_dir=tmp_path / "data")
    plan = planner.plan_session(target.id)
    with repositories.db.connect() as conn:
        target_before = PurgePlanner._relation_counts(conn, (target.id,))
        neighbor_before = PurgePlanner._relation_counts(conn, (neighbor.id,))

    assert set(plan.database_counts) >= set(target_before)
    # An ordinary main-agent session has no subagent run. The dedicated
    # lifecycle tests below cover that relation with a parent/child fixture;
    # every legacy direct and indirect relation remains populated here.
    assert target_before["subagent_run"] == 0
    assert neighbor_before["subagent_run"] == 0
    assert all(
        total == 1
        for table, total in target_before.items()
        if table != "subagent_run"
    )
    assert all(
        total == 1
        for table, total in neighbor_before.items()
        if table != "subagent_run"
    )

    deleted = PurgeDatabaseExecutor(repositories).execute(plan)

    with repositories.db.connect() as conn:
        target_after = PurgePlanner._relation_counts(conn, (target.id,))
        neighbor_after = PurgePlanner._relation_counts(conn, (neighbor.id,))
        foreign_key_errors = conn.execute("pragma foreign_key_check").fetchall()
        integrity = conn.execute("pragma integrity_check").fetchone()[0]
    assert all(total == 0 for total in target_after.values())
    assert neighbor_after == neighbor_before
    assert all(deleted[table] == total for table, total in target_before.items())
    assert repositories.sessions.get_archived(target.id) is None
    assert repositories.sessions.get(neighbor.id) is not None
    assert repositories.workspaces.get(target_workspace.id) is not None
    assert repositories.workspaces.get(neighbor_workspace.id) is not None
    assert foreign_key_errors == []
    assert integrity == "ok"


def test_session_purge_removes_secondary_active_session_and_trace_relations(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    target = _session(repositories, "ses-secondary-target")
    neighbor = _session(repositories, "ses-secondary-neighbor")
    _archive_session(repositories, target.id)
    now = "2026-07-14T00:00:00Z"
    with repositories.db.transaction() as conn:
        conn.execute(
            """
            insert into a2ui_interactions (
              id, session_id, active_session_id, stream_id, render_key, mode,
              created_at, updated_at
            ) values ('a2ui-secondary', ?, ?, 'stream', 'render', 'render', ?, ?)
            """,
            (neighbor.id, target.id, now, now),
        )
        conn.execute(
            """
            insert into file_history_snapshots (
              id, session_id, active_session_id, kind, sequence, workspace_root,
              workspace_identity, status, created_at, updated_at
            ) values ('snapshot-secondary', ?, ?, 'input', 1, 'D:/secondary',
                      'secondary', 'ready', ?, ?)
            """,
            (neighbor.id, target.id, now, now),
        )
        conn.execute(
            """
            insert into file_history_snapshot_entries (
              snapshot_id, canonical_path, display_path, state, version, backup_time
            ) values ('snapshot-secondary', '/secondary.txt', '/secondary.txt',
                      'missing', 1, ?)
            """,
            (now,),
        )
        conn.execute(
            """
            insert into file_history_mutations (
              id, session_id, active_session_id, workspace_identity, canonical_path,
              display_path, mutation_kind, before_state, after_state, status,
              created_at, updated_at
            ) values ('mutation-secondary', ?, ?, 'secondary', '/mutation.txt',
                      '/mutation.txt', 'update', 'missing', 'missing', 'committed', ?, ?)
            """,
            (neighbor.id, target.id, now, now),
        )
        conn.execute(
            """
            insert into file_history_operations (
              id, request_id, session_id, active_session_id, workspace_identity,
              mode, decision, state, created_at, updated_at
            ) values ('operation-secondary', 'request-secondary', ?, ?, 'secondary',
                      'both', 'full', 'full', ?, ?)
            """,
            (neighbor.id, target.id, now, now),
        )
        conn.execute(
            """
            insert into file_history_operation_files (
              operation_id, canonical_path, display_path, preview_current_state,
              target_state, classification, writer_session_id, updated_at
            ) values ('operation-secondary', '/operation.txt', '/operation.txt',
                      'missing', 'missing', 'ready', ?, ?)
            """,
            (target.id, now),
        )
        conn.execute(
            """
            insert into file_history_locks (
              lock_key, owner_operation_id, acquired_at, expires_at
            ) values ('lock-secondary', 'operation-secondary', ?, '2026-07-14T00:05:00Z')
            """,
            (now,),
        )
        conn.execute(
            """
            insert into trace_record (
              trace_id, session_id, scene_id, user_id, turn_index, root_node_id,
              status, start_time, created_at, updated_at
            ) values ('trace-secondary', ?, 'desktop-agent', 'local-user', 1,
                      'root-secondary', 'completed', ?, ?, ?)
            """,
            (target.id, now, now, now),
        )
        conn.execute(
            """
            insert into trace_event_log (
              trace_id, trace_record_id, event_type, source, idempotency_key,
              timestamp_ms, occurred_at, payload_json, created_at, updated_at
            ) values ('trace-secondary', 'trace-secondary', 'completed', 'test',
                      'event-secondary', 1, ?, '{}', ?, ?)
            """,
            (now, now, now),
        )

    plan = PurgePlanner(repositories, data_dir=tmp_path / "data").plan_session(target.id)

    assert plan.database_counts.items() >= {
        "a2ui_interactions": 1,
        "file_history_snapshots": 1,
        "file_history_snapshot_entries": 1,
        "file_history_mutations": 1,
        "file_history_operations": 1,
        "file_history_operation_files": 1,
        "file_history_locks": 1,
        "trace_record": 1,
        "trace_event_log": 1,
    }.items()

    deleted = PurgeDatabaseExecutor(repositories).execute(plan)

    for table in (
        "a2ui_interactions",
        "file_history_snapshots",
        "file_history_snapshot_entries",
        "file_history_mutations",
        "file_history_operations",
        "file_history_operation_files",
        "file_history_locks",
        "trace_record",
        "trace_event_log",
    ):
        assert deleted[table] == 1
    assert repositories.sessions.get(neighbor.id) is not None
    with repositories.db.connect() as conn:
        assert conn.execute("pragma foreign_key_check").fetchall() == []


def test_purge_planner_counts_dependencies_and_classifies_asset_ownership(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    data_dir = tmp_path / "data"
    session = _session(repositories, "ses-plan")
    _archive_session(repositories, session.id)
    managed = data_dir / "attachments" / "att-managed" / "managed.png"
    managed.parent.mkdir(parents=True)
    managed.write_bytes(b"managed")
    external = tmp_path / "external.png"
    external.write_bytes(b"external")
    _record_attachment(
        repositories,
        attachment_id="att-managed",
        session_id=session.id,
        path=managed,
    )
    _record_attachment(
        repositories,
        attachment_id="att-external",
        session_id=session.id,
        path=external,
    )
    with repositories.db.transaction() as conn:
        conn.execute(
            """
            insert into message_events (
              id, session_id, seq, turn_index, action, created_at, updated_at
            ) values ('event-plan', ?, 1, 1, 'completed', 'now', 'now')
            """,
            (session.id,),
        )
        conn.execute(
            """
            insert into checkpoints_v2 (
              thread_id, checkpoint_ns, checkpoint_id, created_at,
              checkpoint_blob, metadata
            ) values (?, '', 'checkpoint-plan', 'now', x'00', '{}')
            """,
            (session.id,),
        )

    plan = PurgePlanner(repositories, data_dir=data_dir).plan_session(session.id)

    assert plan.database_counts["sessions"] == 1
    assert plan.database_counts["attachments"] == 2
    assert plan.database_counts["message_events"] == 1
    assert plan.database_counts["checkpoints_v2"] == 1
    classifications = {asset.path: asset.classification for asset in plan.assets}
    assert classifications[managed] == "managed_delete"
    assert classifications[external] == "external_reference_only"
    assert repositories.sessions.get_archived(session.id) is not None
    assert managed.read_bytes() == b"managed"
    assert external.read_bytes() == b"external"


def test_purge_planner_rejects_active_targets_and_inconsistent_workspace_children(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    session = _session(repositories, "ses-active-refused")
    workspace = _workspace(repositories, tmp_path, "ws-active-refused")
    _session(repositories, "ses-active-child", workspace.id)
    planner = PurgePlanner(repositories, data_dir=tmp_path / "data")

    with pytest.raises(ArchiveLifecycleError) as active_session:
        planner.plan_session(session.id)
    with pytest.raises(ArchiveLifecycleError) as active_workspace:
        planner.plan_workspace(workspace.id)
    with repositories.db.transaction() as conn:
        conn.execute(
            "update workspaces set archived_at = '2026-07-14T08:00:00Z' where id = ?",
            (workspace.id,),
        )
    with pytest.raises(ArchiveLifecycleError) as inconsistent:
        planner.plan_workspace(workspace.id)

    assert active_session.value.code == "not_archived"
    assert active_workspace.value.code == "not_archived"
    assert inconsistent.value.code == "workspace_archive_inconsistent"


def test_purge_assets_delete_only_owned_roots_and_reject_links_or_prefix_traps(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    data_dir = tmp_path / "data"
    session = _session(repositories, "ses-assets")
    _archive_session(repositories, session.id)
    file_history = data_dir / "file-history" / session.id
    checkpoints = data_dir / "checkpoints" / session.id
    file_history.mkdir(parents=True)
    checkpoints.mkdir(parents=True)
    (file_history / "snapshot.bin").write_bytes(b"history")
    (checkpoints / "checkpoint.bin").write_bytes(b"checkpoint")

    managed = data_dir / "attachments" / "att-assets" / "managed.bin"
    managed.parent.mkdir(parents=True)
    managed.write_bytes(b"managed")
    prefix_trap = tmp_path / "data-sibling" / "attachments" / "att-prefix" / "keep.bin"
    prefix_trap.parent.mkdir(parents=True)
    prefix_trap.write_bytes(b"prefix")
    _record_attachment(
        repositories,
        attachment_id="att-assets",
        session_id=session.id,
        path=managed,
    )
    _record_attachment(
        repositories,
        attachment_id="att-prefix",
        session_id=session.id,
        path=prefix_trap,
    )

    link_target = data_dir / "link-target"
    link_target.mkdir(parents=True)
    (link_target / "keep.bin").write_bytes(b"link-target")
    link = data_dir / "attachments" / "att-link" / "linked.bin"
    link.parent.mkdir(parents=True)
    try:
        link.symlink_to(link_target / "keep.bin")
    except OSError:
        link = None
    if link is not None:
        _record_attachment(
            repositories,
            attachment_id="att-link",
            session_id=session.id,
            path=link,
        )

    service = PurgeService(repositories, data_dir=data_dir)
    plan = PurgePlanner(repositories, data_dir=data_dir).plan_session(session.id)
    classifications = {asset.path: asset.classification for asset in plan.assets}

    assert classifications[file_history] == "managed_delete"
    assert classifications[checkpoints] == "managed_delete"
    assert classifications[managed] == "managed_delete"
    assert classifications[prefix_trap] == "external_reference_only"
    if link is not None:
        assert classifications[link] == "invalid"

    result = service.purge_session(session.id, request_id="req-assets", confirmed=True)

    assert result["state"] == "completed"
    assert not file_history.exists()
    assert not checkpoints.exists()
    assert not managed.exists()
    assert prefix_trap.read_bytes() == b"prefix"
    assert (link_target / "keep.bin").read_bytes() == b"link-target"


def test_purge_executor_rejects_stale_plan_without_writes(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    session = _session(repositories, "ses-stale")
    _archive_session(repositories, session.id)
    planner = PurgePlanner(repositories, data_dir=tmp_path / "data")
    plan = planner.plan_session(session.id)
    with repositories.db.transaction() as conn:
        conn.execute(
            """
            insert into message_events (
              id, session_id, seq, action, created_at, updated_at
            ) values ('event-drift', ?, 1, 'completed', 'now', 'now')
            """,
            (session.id,),
        )

    with pytest.raises(ArchiveLifecycleError) as stale:
        PurgeDatabaseExecutor(repositories).execute(plan)

    assert stale.value.code == "purge_plan_stale"
    assert repositories.sessions.get_archived(session.id) is not None
    with repositories.db.connect() as conn:
        assert conn.execute(
            "select count(*) as total from message_events where session_id = ?",
            (session.id,),
        ).fetchone()["total"] == 1


def test_workspace_purge_rejects_annotation_drift_without_deleting_project(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    workspace = _workspace(repositories, tmp_path, "ws-stale-annotation")
    session = _session(repositories, "ses-stale-annotation", workspace.id)
    _archive_session(repositories, session.id, "project")
    with repositories.db.transaction() as conn:
        conn.execute(
            "update workspaces set archived_at = '2026-07-14T08:00:00Z' where id = ?",
            (workspace.id,),
        )
    planner = PurgePlanner(repositories, data_dir=tmp_path / "data")
    plan = planner.plan_workspace(workspace.id)
    with repositories.db.transaction() as conn:
        conn.execute(
            """
            insert into workspace_annotations (
              id, workspace_id, document_path, target_type, body, created_at, updated_at
            ) values ('annotation-drift', ?, 'drift.txt', 'document', 'note', 'now', 'now')
            """,
            (workspace.id,),
        )

    with pytest.raises(ArchiveLifecycleError) as stale:
        PurgeDatabaseExecutor(repositories).execute(plan)

    assert stale.value.code == "purge_plan_stale"
    assert repositories.workspaces.get_archived(workspace.id) is not None
    assert repositories.sessions.get_archived(session.id) is not None


def test_session_database_purge_removes_forks_and_keeps_surviving_target(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    source = _session(repositories, "ses-source")
    target = repositories.sessions.create(
        session_id="ses-target",
        user_id="local-user",
        scene_id="desktop-agent",
        source_active_session_id=source.id,
        source_trace_id="trace-source",
        source_checkpoint_id="checkpoint-source",
    )
    _archive_session(repositories, source.id)
    with repositories.db.transaction() as conn:
        conn.execute(
            """
            insert into session_forks (
              id, source_session_id, target_session_id,
              source_message_event_id, target_message_event_id,
              source_turn_index, target_turn_index, created_at, updated_at
            ) values ('fork-source', ?, ?, 'source-event', 'target-event', 1, 1, 'now', 'now')
            """,
            (source.id, target.id),
        )
    plan = PurgePlanner(repositories, data_dir=tmp_path / "data").plan_session(source.id)

    counts = PurgeDatabaseExecutor(repositories).execute(plan)

    assert counts["sessions"] == 1
    assert counts["session_forks"] == 1
    assert repositories.sessions.get_archived(source.id) is None
    surviving = repositories.sessions.get(target.id)
    assert surviving is not None
    assert surviving.source_active_session_id is None
    assert surviving.source_trace_id is None
    assert surviving.source_checkpoint_id is None
    assert repositories.session_forks.get_by_target(target.id) is None


@pytest.mark.parametrize("purged_role", ["source", "target"])
@pytest.mark.parametrize("workspace_relation", ["same", "cross"])
def test_session_purge_preserves_fork_neighbor_for_all_endpoint_and_workspace_relations(
    tmp_path,
    purged_role: str,
    workspace_relation: str,
) -> None:
    repositories = _repositories(tmp_path)
    source_workspace = _workspace(repositories, tmp_path, "ws-fork-source")
    target_workspace = (
        source_workspace
        if workspace_relation == "same"
        else _workspace(repositories, tmp_path, "ws-fork-target")
    )
    source = _session(repositories, "ses-fork-source", source_workspace.id)
    target = repositories.sessions.create(
        session_id="ses-fork-target",
        user_id="local-user",
        scene_id="desktop-agent",
        workspace_id=target_workspace.id,
        source_active_session_id=source.id,
        source_trace_id="trace-source",
        source_checkpoint_id="checkpoint-source",
    )
    purged = source if purged_role == "source" else target
    survivor = target if purged_role == "source" else source
    _archive_session(repositories, purged.id)
    with repositories.db.transaction() as conn:
        conn.execute(
            """
            insert into session_forks (
              id, source_session_id, target_session_id,
              source_message_event_id, target_message_event_id,
              source_turn_index, target_turn_index, created_at, updated_at
            ) values ('fork-matrix', ?, ?, 'source-event', 'target-event', 1, 1, 'now', 'now')
            """,
            (source.id, target.id),
        )

    plan = PurgePlanner(repositories, data_dir=tmp_path / "data").plan_session(purged.id)
    PurgeDatabaseExecutor(repositories).execute(plan)

    assert repositories.sessions.get_archived(purged.id) is None
    surviving = repositories.sessions.get(survivor.id)
    assert surviving is not None
    assert repositories.session_forks.get_by_target(target.id) is None
    if purged_role == "source":
        assert surviving.source_active_session_id is None
        assert surviving.source_trace_id is None
        assert surviving.source_checkpoint_id is None


def test_project_database_purge_is_set_based_and_never_deletes_workspace_root(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    workspace = _workspace(repositories, tmp_path, "ws-project-purge")
    neighbor_workspace = _workspace(repositories, tmp_path, "ws-project-neighbor")
    local_file = Path(workspace.root_path) / "keep.txt"
    local_file.write_text("keep", encoding="utf-8")
    first = _session(repositories, "ses-project-1", workspace.id)
    second = _session(repositories, "ses-project-2", workspace.id)
    _archive_session(repositories, first.id, "manual")
    _archive_session(repositories, second.id, "project")
    with repositories.db.transaction() as conn:
        conn.execute(
            "update workspaces set archived_at = '2026-07-14T08:00:00Z' where id = ?",
            (workspace.id,),
        )
        conn.execute(
            """
            insert into workspace_annotations (
              id, workspace_id, document_path, target_type, body, created_at, updated_at
            ) values ('annotation-neighbor', ?, 'neighbor.txt', 'document', 'note', 'now', 'now')
            """,
            (neighbor_workspace.id,),
        )
        conn.execute(
            """
            insert into workspace_annotations (
              id, workspace_id, document_path, target_type, body, created_at, updated_at
            ) values ('annotation-purge', ?, 'keep.txt', 'document', 'note', 'now', 'now')
            """,
            (workspace.id,),
        )
    plan = PurgePlanner(repositories, data_dir=tmp_path / "data").plan_workspace(workspace.id)

    counts = PurgeDatabaseExecutor(repositories).execute(plan)

    assert counts["sessions"] == 2
    assert counts["workspace_annotations"] == 1
    assert counts["workspaces"] == 1
    assert repositories.workspaces.get_archived(workspace.id) is None
    assert repositories.workspaces.get(neighbor_workspace.id) is not None
    with repositories.db.connect() as conn:
        assert conn.execute(
            "select count(*) as total from workspace_annotations where workspace_id = ?",
            (neighbor_workspace.id,),
        ).fetchone()["total"] == 1
        assert conn.execute("pragma foreign_key_check").fetchall() == []
    assert local_file.read_text(encoding="utf-8") == "keep"


def test_workspace_session_purge_removes_only_archived_sessions_and_keeps_project(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    workspace = _workspace(repositories, tmp_path, "ws-session-batch-purge")
    active = _session(repositories, "ses-batch-active", workspace.id)
    first = _session(repositories, "ses-batch-archived-1", workspace.id)
    second = _session(repositories, "ses-batch-archived-2", workspace.id)
    _archive_session(repositories, first.id, "manual")
    _archive_session(repositories, second.id, "project")
    local_file = Path(workspace.root_path) / "keep.txt"
    local_file.write_text("keep", encoding="utf-8")
    service = PurgeService(repositories, data_dir=tmp_path / "data")

    with pytest.raises(ArchiveLifecycleError) as mismatch:
        service.purge_workspace_sessions(
            workspace.id,
            request_id="req-workspace-sessions-mismatch",
            confirmation_name="wrong project",
        )
    result = service.purge_workspace_sessions(
        workspace.id,
        request_id="req-workspace-sessions-purge",
        confirmation_name=workspace.name,
    )
    replay = service.purge_workspace_sessions(
        workspace.id,
        request_id="req-workspace-sessions-purge",
        confirmation_name=workspace.name,
    )

    assert mismatch.value.code == "confirmation_mismatch"
    assert result["entity_type"] == "workspace_sessions"
    assert result["counts"]["sessions"] == 2
    assert result["event"]["type"] == "workspace_sessions_purged"
    assert result["event"]["workspace_id"] == workspace.id
    assert replay["replayed"] is True
    assert repositories.workspaces.get(workspace.id) is not None
    assert repositories.sessions.get(active.id) is not None
    assert repositories.sessions.get_archived(first.id) is None
    assert repositories.sessions.get_archived(second.id) is None
    assert local_file.read_text(encoding="utf-8") == "keep"


def test_quarantine_can_rollback_and_finalize_exact_operation_directory(tmp_path) -> None:
    data_dir = tmp_path / "data"
    managed = data_dir / "attachments" / "att-one" / "file.bin"
    managed.parent.mkdir(parents=True)
    managed.write_bytes(b"content")
    digest = hashlib.sha256(b"content").hexdigest()
    plan = PurgePlan(
        entity_type="session",
        entity_id="ses-quarantine",
        workspace_id=None,
        session_ids=("ses-quarantine",),
        session_signatures=(),
        database_counts={},
        assets=(PurgeAsset(managed, "managed_delete", "asset", 7),),
        snapshot_hash="snapshot",
    )
    quarantine = LifecycleQuarantine(data_dir)

    token = quarantine.quarantine(plan, "operation-one")
    assert not managed.exists()
    quarantine.rollback(token)
    assert managed.read_bytes() == b"content"
    assert hashlib.sha256(managed.read_bytes()).hexdigest() == digest

    token = quarantine.quarantine(plan, "operation-two")
    quarantine.finalize(token)
    assert not managed.exists()
    assert not (data_dir / "lifecycle-quarantine" / token).exists()


def test_purge_service_success_preserves_external_file_and_replays_anonymous_audit(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    data_dir = tmp_path / "data"
    session = _session(repositories, "ses-purge-success")
    _archive_session(repositories, session.id)
    managed = data_dir / "attachments" / "att-success" / "managed.png"
    managed.parent.mkdir(parents=True)
    managed.write_bytes(b"managed")
    external = tmp_path / "external-success.png"
    external.write_bytes(b"external")
    _record_attachment(
        repositories,
        attachment_id="att-success",
        session_id=session.id,
        path=managed,
    )
    _record_attachment(
        repositories,
        attachment_id="att-success-external",
        session_id=session.id,
        path=external,
    )
    service = PurgeService(repositories, data_dir=data_dir)

    result = service.purge_session(
        session.id,
        request_id="req-purge-success",
        confirmed=True,
    )
    replay = service.purge_session(
        session.id,
        request_id="req-purge-success",
        confirmed=True,
    )

    assert result["state"] == "completed"
    assert result["event"]["type"] == "session_purged"
    assert replay["replayed"] is True
    assert replay["event"] is None
    assert repositories.sessions.get_archived(session.id) is None
    assert not managed.exists()
    assert external.read_bytes() == b"external"
    operation = repositories.lifecycle_operations.get(result["operation_id"])
    assert operation is not None
    assert operation.entity_id is None
    assert operation.result == {}


def test_purge_database_failure_rolls_back_quarantine_and_keeps_archived_object(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    data_dir = tmp_path / "data"
    session = _session(repositories, "ses-purge-db-failure")
    _archive_session(repositories, session.id)
    managed = data_dir / "attachments" / "att-db-failure" / "managed.png"
    managed.parent.mkdir(parents=True)
    managed.write_bytes(b"managed")
    _record_attachment(
        repositories,
        attachment_id="att-db-failure",
        session_id=session.id,
        path=managed,
    )

    def fail_database(phase: str) -> None:
        if phase == "database":
            raise RuntimeError("injected database failure")

    service = PurgeService(repositories, data_dir=data_dir, fault_injector=fail_database)

    with pytest.raises(RuntimeError, match="injected database failure"):
        service.purge_session(
            session.id,
            request_id="req-purge-db-failure",
            confirmed=True,
        )

    assert repositories.sessions.get_archived(session.id) is not None
    assert managed.read_bytes() == b"managed"
    operation = repositories.lifecycle_operations.get_by_request(
        entity_type="session",
        entity_id=session.id,
        request_id="req-purge-db-failure",
    )
    assert operation is not None
    assert operation.state == "rolled_back"


def test_plan_and_operation_persist_failures_are_retryable_without_asset_moves(
    tmp_path,
    monkeypatch,
) -> None:
    repositories = _repositories(tmp_path)
    data_dir = tmp_path / "data"
    session = _session(repositories, "ses-plan-retry")
    _archive_session(repositories, session.id)
    managed = data_dir / "attachments" / "att-plan-retry" / "managed.png"
    managed.parent.mkdir(parents=True)
    managed.write_bytes(b"managed")
    _record_attachment(
        repositories,
        attachment_id="att-plan-retry",
        session_id=session.id,
        path=managed,
    )

    plan_failures = 0

    def fail_plan_once(phase: str) -> None:
        nonlocal plan_failures
        if phase == "plan" and plan_failures == 0:
            plan_failures += 1
            raise RuntimeError("injected plan failure")

    service = PurgeService(repositories, data_dir=data_dir, fault_injector=fail_plan_once)
    with pytest.raises(RuntimeError, match="injected plan failure"):
        service.purge_session(session.id, request_id="req-plan-retry", confirmed=True)
    assert managed.read_bytes() == b"managed"
    planned = repositories.lifecycle_operations.get_by_request(
        entity_type="session",
        entity_id=session.id,
        request_id="req-plan-retry",
    )
    assert planned is not None
    assert planned.state == "planned"

    original_update = repositories.lifecycle_operations.update
    monkeypatch.setattr(repositories.lifecycle_operations, "update", lambda *args, **kwargs: None)
    with pytest.raises(ArchiveLifecycleError) as persist_failure:
        service.purge_session(session.id, request_id="req-plan-retry", confirmed=True)
    assert persist_failure.value.code == "operation_conflict"
    assert managed.read_bytes() == b"managed"

    monkeypatch.setattr(repositories.lifecycle_operations, "update", original_update)
    completed = service.purge_session(
        session.id,
        request_id="req-plan-retry",
        confirmed=True,
    )
    assert completed["state"] == "completed"
    assert completed["replayed"] is False
    assert not managed.exists()


def test_database_failure_with_rollback_failure_enters_compensation_failed(
    tmp_path,
    monkeypatch,
) -> None:
    repositories = _repositories(tmp_path)
    data_dir = tmp_path / "data"
    session = _session(repositories, "ses-compensation-failed")
    _archive_session(repositories, session.id)
    managed = data_dir / "attachments" / "att-compensation" / "managed.png"
    managed.parent.mkdir(parents=True)
    managed.write_bytes(b"managed")
    _record_attachment(
        repositories,
        attachment_id="att-compensation",
        session_id=session.id,
        path=managed,
    )

    def fail_database(phase: str) -> None:
        if phase == "database":
            raise RuntimeError("injected database failure")

    def fail_rollback(self, token: str) -> None:
        raise OSError(f"injected rollback failure: {token}")

    monkeypatch.setattr(LifecycleQuarantine, "rollback", fail_rollback)
    service = PurgeService(repositories, data_dir=data_dir, fault_injector=fail_database)

    with pytest.raises(ArchiveLifecycleError) as failed:
        service.purge_session(
            session.id,
            request_id="req-compensation-failed",
            confirmed=True,
        )

    assert failed.value.code == "compensation_failed"
    assert repositories.sessions.get_archived(session.id) is not None
    assert not managed.exists()
    operation = repositories.lifecycle_operations.get_by_request(
        entity_type="session",
        entity_id=session.id,
        request_id="req-compensation-failed",
    )
    assert operation is not None
    assert operation.state == "compensation_failed"
    assert (data_dir / "lifecycle-quarantine" / operation.id).is_dir()


def test_cleanup_failed_requires_manual_same_request_retry_after_restart(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    data_dir = tmp_path / "data"
    session = _session(repositories, "ses-cleanup-manual")
    _archive_session(repositories, session.id)
    managed = data_dir / "attachments" / "att-cleanup" / "managed.png"
    managed.parent.mkdir(parents=True)
    managed.write_bytes(b"managed")
    _record_attachment(
        repositories,
        attachment_id="att-cleanup",
        session_id=session.id,
        path=managed,
    )

    def fail_finalize(phase: str) -> None:
        if phase == "finalize":
            raise OSError("injected occupied file")

    failing = PurgeService(repositories, data_dir=data_dir, fault_injector=fail_finalize)
    with pytest.raises(ArchiveLifecycleError) as cleanup:
        failing.purge_session(
            session.id,
            request_id="req-cleanup-manual",
            confirmed=True,
        )
    assert cleanup.value.code == "cleanup_failed"
    cleanup_event = cleanup.value.details["_lifecycle_event"]
    assert cleanup_event["type"] == "session_purged"
    assert cleanup_event["session_id"] == session.id
    assert cleanup_event["cleanup_state"] == "cleanup_failed"
    assert cleanup_event["request_id"] == "req-cleanup-manual"
    assert repositories.sessions.get_archived(session.id) is None

    restarted = StorageRepositories(init_database(tmp_path / "app.db"))
    completed = PurgeService(restarted, data_dir=data_dir).purge_session(
        session.id,
        request_id="req-cleanup-manual",
        confirmed=True,
    )

    assert completed["state"] == "completed"
    assert completed["replayed"] is True
    operation = restarted.lifecycle_operations.get(completed["operation_id"])
    assert operation is not None
    assert operation.state == "completed"
    assert operation.entity_id is None
