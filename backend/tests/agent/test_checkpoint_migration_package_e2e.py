from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from langchain_core.messages import AIMessage, HumanMessage

from backend.app.agent.checkpoint import LegacySQLiteCheckpointSaver
from backend.app.storage import init_database
from backend.tests.agent.test_checkpoint_legacy import _checkpoint
from backend.tests.agent.test_checkpoint_migration_collapse import (
    _seed_visible_session,
)
from backend.tests.agent.test_checkpoint_migration_state import (
    _seed_legacy,
    _seed_session,
)

ROOT_ID = "00000000-0000-0000-0000-000000000001"
HEAD_ID = "00000000-0000-0000-0000-000000000002"
BRANCH_ID = "00000000-0000-0000-0000-000000000009"
SECOND_THREAD_ID = "00000000-0000-0000-0000-000000000003"


def _message_checkpoint(
    checkpoint_id: str,
    messages: list[HumanMessage | AIMessage],
):
    value = _checkpoint(checkpoint_id)
    value["channel_values"]["messages"] = messages
    return value


def _seed_rootless_visible_session(database) -> None:
    with database.transaction() as connection:
        _seed_session(
            connection,
            "rootless-session",
            active_session_id="rootless-thread",
        )
        connection.executemany(
            """
            insert into message_events (
              id, session_id, seq, turn_index, action, data_json,
              created_at, updated_at
            ) values (
              ?, 'rootless-session', ?, 0, ?, '{}',
              '2026-01-01', '2026-01-01'
            )
            """,
            [
                ("rootless-user", 1, "user_message"),
                ("rootless-cancelled", 2, "cancelled"),
            ],
        )


_MIGRATE_PROCESS = r'''
import json
import sys
import time
from pathlib import Path
from fastapi.testclient import TestClient
from backend.app.core.config import AppSettings
from backend.app.main import create_app

data_dir = Path(sys.argv[1])
app = create_app(AppSettings(data_dir=data_dir))
with TestClient(app) as client:
    required = client.get("/api/checkpoint-migration").json()
    first = client.post("/api/checkpoint-migration/start").json()
    repeated = client.post("/api/checkpoint-migration/start").json()
    percentages = []
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        payload = client.get("/api/checkpoint-migration").json()
        percentages.append(payload["percent"])
        if payload["state"] == "completed":
            break
        time.sleep(0.1)
    else:
        raise RuntimeError("migration timeout")
    serialized = json.dumps(payload, ensure_ascii=False)
    print("PACKAGE_RESULT=" + json.dumps({
        "required": required,
        "first_state": first["state"],
        "repeated_state": repeated["state"],
        "percentages": percentages,
        "completed": payload,
        "public_keys": sorted(payload),
        "leaked_detail": any(
            marker in serialized.lower()
            for marker in ("phase", "namespace", "table", "row", "byte", "ratio", "eta")
        ),
    }, ensure_ascii=False))
'''

_ACKNOWLEDGE_AND_CONTINUE_PROCESS = r'''
import json
import sqlite3
import sys
from pathlib import Path
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage, HumanMessage
from backend.app.agent.state import CHECKPOINT_STATE_UPDATE_NODE, build_checkpoint_state_graph
from backend.app.core.config import AppSettings
from backend.app.main import create_app

data_dir = Path(sys.argv[1])
app = create_app(AppSettings(data_dir=data_dir))
with TestClient(app) as client:
    before_ack = client.get("/api/checkpoint-migration").json()
    acknowledged = client.post("/api/checkpoint-migration/acknowledge").json()
    repeated = client.post("/api/checkpoint-migration/acknowledge").json()

    async def continue_collapsed_thread():
        graph = build_checkpoint_state_graph(
            app.state.checkpoint_runtime.require_store()
        )
        config = {
            "configurable": {
                "thread_id": "thread-a",
                "checkpoint_ns": "",
            }
        }
        before = await graph.aget_state(config)
        updated = await graph.aupdate_state(
            before.config,
            {
                "messages": [
                    HumanMessage(content="post-migration request", id="post-user"),
                    AIMessage(content="post-migration answer", id="post-answer"),
                ]
            },
            as_node=CHECKPOINT_STATE_UPDATE_NODE,
        )
        after = await graph.aget_state(updated)
        return {
            "before": [
                str(getattr(item, "content", item))
                for item in before.values["messages"]
            ],
            "after": [
                str(getattr(item, "content", item))
                for item in after.values["messages"]
            ],
            "new_checkpoint_id": updated["configurable"]["checkpoint_id"],
        }

    continued = client.portal.call(continue_collapsed_thread)
    with sqlite3.connect(data_dir / "app.db") as connection:
        root_count_before_continue = connection.execute(
            """
            select count(*) from checkpoints
            where parent_checkpoint_id is null
            """
        ).fetchone()[0]
        namespace_count = connection.execute(
            """
            select count(*) from (
              select thread_id, checkpoint_ns from checkpoints
              group by thread_id, checkpoint_ns
            )
            """
        ).fetchone()[0]
    print("PACKAGE_RESULT=" + json.dumps({
        "before_ack": before_ack,
        "acknowledged": acknowledged,
        "repeated": repeated,
        "continued": continued,
        "root_count": root_count_before_continue,
        "namespace_count": namespace_count,
    }, ensure_ascii=False))
'''

_VERIFY_RESTART_PROCESS = r'''
import json
import sqlite3
import sys
from pathlib import Path
from fastapi.testclient import TestClient
from backend.app.agent.state import build_checkpoint_state_graph
from backend.app.core.config import AppSettings
from backend.app.main import create_app

data_dir = Path(sys.argv[1])
database_path = data_dir / "app.db"
app = create_app(AppSettings(data_dir=data_dir))
with TestClient(app) as client:
    status = client.get("/api/checkpoint-migration").json()

    async def read_state():
        graph = build_checkpoint_state_graph(
            app.state.checkpoint_runtime.require_store()
        )
        snapshot = await graph.aget_state({
            "configurable": {
                "thread_id": "thread-a",
                "checkpoint_ns": "",
            }
        })
        return [
            str(getattr(item, "content", item))
            for item in snapshot.values["messages"]
        ]

    messages = client.portal.call(read_state)

with sqlite3.connect(database_path) as connection:
    tables = {
        row[0]
        for row in connection.execute(
            "select name from sqlite_master where type = 'table'"
        )
    }
    visible_events = connection.execute(
        "select count(*) from message_events where session_id = 'session-1'"
    ).fetchone()[0]
    lineage = connection.execute(
        """
        select checkpoint_lineage_epoch,
               checkpoint_history_floor_turn_index,
               checkpoint_root_id
        from sessions where id = 'session-1'
        """
    ).fetchone()
    rootless_visible_events = connection.execute(
        "select count(*) from message_events where session_id = 'rootless-session'"
    ).fetchone()[0]
    rootless_lineage = connection.execute(
        """
        select checkpoint_lineage_epoch,
               checkpoint_history_floor_turn_index,
               checkpoint_root_id
        from sessions where id = 'rootless-session'
        """
    ).fetchone()
    rootless_checkpoint_count = connection.execute(
        """
        select count(*) from checkpoints
        where thread_id = 'rootless-thread' and checkpoint_ns = ''
        """
    ).fetchone()[0]

print("PACKAGE_RESULT=" + json.dumps({
    "status": status,
    "messages": messages,
    "visible_events": visible_events,
    "lineage": list(lineage),
    "rootless_visible_events": rootless_visible_events,
    "rootless_lineage": list(rootless_lineage),
    "rootless_checkpoint_count": rootless_checkpoint_count,
    "has_legacy_payload": bool(
        connection.execute("select count(*) from checkpoints_v2").fetchone()[0]
        or connection.execute("select count(*) from checkpoint_writes_v2").fetchone()[0]
    ),
    "has_downgrade_guard": "checkpoint_backend_guard" in tables,
    "temporary_files": {
        suffix: Path(str(database_path) + suffix).exists()
        for suffix in (
            ".checkpoint-collapse-v1.tmp",
            ".checkpoint-collapse-v1.backup",
            ".checkpoint-collapse-v1.swap.json",
        )
    },
}, ensure_ascii=False))
'''

_CRASH_PROCESS = r'''
import asyncio
import os
import sys
from pathlib import Path
from backend.app.agent.checkpoint_migration import (
    CheckpointMigrationCoordinator,
    MigrationStatus,
)
from backend.app.agent.checkpoint_migration_collapse import NamespaceCollapseMigrator
from backend.app.agent.checkpoint_migration_copy import CompactTargetBuilder
from backend.app.agent.checkpoint_migration_swap import (
    AtomicCheckpointDatabaseSwap,
    InjectedSwapCrash,
)
from backend.app.storage.db import Database

database = Database(Path(sys.argv[1]) / "app.db")
stage = sys.argv[2]
coordinator = CheckpointMigrationCoordinator(database)
coordinator.start()
if stage == "preflight":
    os._exit(91)
if stage == "business_copy":
    coordinator.repository.update_progress(
        1_500,
        status=MigrationStatus.COPYING_BUSINESS_DATA,
    )
    os._exit(91)

asyncio.run(CompactTargetBuilder(database).build())
if stage == "collapse":
    os._exit(91)

NamespaceCollapseMigrator(database).collapse()
if stage == "verify":
    os._exit(91)

try:
    asyncio.run(
        AtomicCheckpointDatabaseSwap(database).swap(crash_after_phase=stage)
    )
except InjectedSwapCrash:
    os._exit(91)
raise RuntimeError("requested crash stage was not reached")
'''

_RESUME_AFTER_CRASH_PROCESS = r'''
import json
import sys
import time
from pathlib import Path
from fastapi.testclient import TestClient
from backend.app.core.config import AppSettings
from backend.app.main import create_app

data_dir = Path(sys.argv[1])
app = create_app(AppSettings(data_dir=data_dir))
with TestClient(app) as client:
    percentages = []
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        payload = client.get("/api/checkpoint-migration").json()
        percentages.append(payload["percent"])
        if payload["state"] == "completed":
            break
        time.sleep(0.02)
    else:
        raise RuntimeError("interrupted migration did not resume")

database_path = data_dir / "app.db"
print("PACKAGE_RESULT=" + json.dumps({
    "state": payload["state"],
    "percentages": percentages,
    "files": {
        suffix: Path(str(database_path) + suffix).exists()
        for suffix in (
            ".checkpoint-collapse-v1.tmp",
            ".checkpoint-collapse-v1.backup",
            ".checkpoint-collapse-v1.swap.json",
        )
    },
}, ensure_ascii=False))
'''


def _run_process(script: str, data_dir: Path) -> dict:
    environment = os.environ.copy()
    environment["PYTHONIOENCODING"] = "utf-8"
    completed = subprocess.run(
        [sys.executable, "-c", script, str(data_dir)],
        cwd=Path(__file__).resolve().parents[3],
        env=environment,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=90,
    )
    return _extract_process_result(completed.stdout)


def _extract_process_result(stdout: str) -> dict:
    result_line = next(
        line
        for line in stdout.splitlines()
        if line.startswith("PACKAGE_RESULT=")
    )
    return json.loads(result_line.removeprefix("PACKAGE_RESULT="))


def _crash_process(script: str, data_dir: Path, stage: str) -> int:
    environment = os.environ.copy()
    environment["PYTHONIOENCODING"] = "utf-8"
    completed = subprocess.run(
        [sys.executable, "-c", script, str(data_dir), stage],
        cwd=Path(__file__).resolve().parents[3],
        env=environment,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=90,
    )
    return completed.returncode


def test_package_upgrade_requires_acknowledgement_and_continues_after_restarts(
    tmp_path: Path,
) -> None:
    data_dir = tmp_path / "data"
    database = init_database(data_dir / "app.db")
    saver = LegacySQLiteCheckpointSaver(database)
    root = saver.put(
        {"configurable": {"thread_id": "thread-a", "checkpoint_ns": ""}},
        _message_checkpoint(
            ROOT_ID,
            [HumanMessage(content="legacy request", id="legacy-user")],
        ),
        {"source": "input"},
        {},
    )
    saver.put(
        root,
        _message_checkpoint(
            HEAD_ID,
            [
                HumanMessage(content="legacy request", id="legacy-user"),
                AIMessage(content="legacy answer", id="legacy-answer"),
            ],
        ),
        {"source": "loop"},
        {},
    )
    saver.put(
        {"configurable": {"thread_id": "thread-a", "checkpoint_ns": "branch"}},
        _message_checkpoint(
            BRANCH_ID,
            [HumanMessage(content="branch request", id="branch-user")],
        ),
        {"source": "fork"},
        {},
    )
    saver.put(
        {"configurable": {"thread_id": "thread-b", "checkpoint_ns": ""}},
        _message_checkpoint(
            SECOND_THREAD_ID,
            [HumanMessage(content="second thread", id="second-user")],
        ),
        {"source": "input"},
        {},
    )
    _seed_visible_session(database)
    _seed_rootless_visible_session(database)
    latest = saver.get_tuple(
        {"configurable": {"thread_id": "thread-a", "checkpoint_ns": ""}}
    )
    assert latest is not None
    saver.put_writes(
        latest.config,
        [("pending_tool_call_preset", {"pending": "head"})],
        "task-head",
    )

    migrated = _run_process(_MIGRATE_PROCESS, data_dir)
    assert migrated["required"] == {
        "state": "required",
        "percent": 0,
        "can_start": True,
        "can_retry": False,
        "can_acknowledge": False,
        "error": None,
    }
    assert migrated["first_state"] in {"running", "completed"}
    assert migrated["repeated_state"] in {"running", "completed"}
    assert migrated["percentages"] == sorted(migrated["percentages"])
    assert all(value <= 99 for value in migrated["percentages"][:-1])
    assert migrated["percentages"][-1] == 100
    assert migrated["completed"]["state"] == "completed"
    assert migrated["completed"]["can_acknowledge"] is True
    assert migrated["public_keys"] == [
        "can_acknowledge",
        "can_retry",
        "can_start",
        "error",
        "percent",
        "state",
    ]
    assert migrated["leaked_detail"] is False

    continued = _run_process(_ACKNOWLEDGE_AND_CONTINUE_PROCESS, data_dir)
    assert continued["before_ack"]["state"] == "completed"
    assert continued["acknowledged"]["state"] == "ready"
    assert continued["repeated"]["state"] == "ready"
    assert continued["continued"]["before"] == [
        "legacy request",
        "legacy answer",
    ]
    assert continued["continued"]["after"][-2:] == [
        "post-migration request",
        "post-migration answer",
    ]
    assert continued["continued"]["new_checkpoint_id"] != HEAD_ID
    assert continued["root_count"] == continued["namespace_count"] == 3

    restarted = _run_process(_VERIFY_RESTART_PROCESS, data_dir)
    assert restarted["status"]["state"] == "ready"
    assert restarted["messages"][-2:] == [
        "post-migration request",
        "post-migration answer",
    ]
    assert restarted["visible_events"] == 2
    assert restarted["lineage"] == [1, 4, HEAD_ID]
    assert restarted["rootless_visible_events"] == 2
    assert restarted["rootless_lineage"] == [1, 1, None]
    assert restarted["rootless_checkpoint_count"] == 0
    assert restarted["has_legacy_payload"] is False
    assert restarted["has_downgrade_guard"] is True
    assert set(restarted["temporary_files"].values()) == {False}


@pytest.mark.parametrize(
    "stage",
    [
        "preflight",
        "business_copy",
        "collapse",
        "verify",
        "prepared",
        "source_backed_up",
        "target_active",
    ],
)
def test_package_restart_recovers_each_forced_migration_crash(
    tmp_path: Path,
    stage: str,
) -> None:
    data_dir = tmp_path / stage
    database, _saver = _seed_legacy(data_dir / "app.db")
    _seed_visible_session(database)

    assert _crash_process(_CRASH_PROCESS, data_dir, stage) == 91
    recovered = _run_process(_RESUME_AFTER_CRASH_PROCESS, data_dir)

    assert recovered["state"] == "completed"
    assert recovered["percentages"] == sorted(recovered["percentages"])
    assert recovered["percentages"][-1] == 100
    assert set(recovered["files"].values()) == {False}


def test_two_package_processes_share_one_idempotent_migration(
    tmp_path: Path,
) -> None:
    data_dir = tmp_path / "two-processes"
    database, _saver = _seed_legacy(data_dir / "app.db")
    _seed_visible_session(database)
    environment = os.environ.copy()
    environment["PYTHONIOENCODING"] = "utf-8"
    command = [sys.executable, "-c", _MIGRATE_PROCESS, str(data_dir)]

    first = subprocess.Popen(
        command,
        cwd=Path(__file__).resolve().parents[3],
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )
    second = subprocess.Popen(
        command,
        cwd=Path(__file__).resolve().parents[3],
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )
    first_stdout, first_stderr = first.communicate(timeout=90)
    second_stdout, second_stderr = second.communicate(timeout=90)

    assert first.returncode == 0, first_stdout + first_stderr
    assert second.returncode == 0, second_stdout + second_stderr
    first_result = _extract_process_result(first_stdout)
    second_result = _extract_process_result(second_stdout)
    assert first_result["completed"]["state"] == "completed"
    assert second_result["completed"]["state"] == "completed"

    with database.connect() as connection:
        state_count = connection.execute(
            "select count(*) from checkpoint_migration_state"
        ).fetchone()[0]
        namespace_count = connection.execute(
            "select count(*) from checkpoint_migration_namespaces"
        ).fetchone()[0]
    assert state_count == 1
    assert namespace_count == 3
