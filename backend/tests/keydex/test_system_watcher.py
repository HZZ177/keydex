from __future__ import annotations

import asyncio
import json
import shutil
from pathlib import Path
from typing import Any

import pytest

from backend.app.keydex import KeydexRuntimeCache
from backend.app.keydex.runtime import build_keydex_layer_fingerprint
from backend.app.keydex.watcher import KeydexSkillsWatcher, is_keydex_layer_watch_target


@pytest.mark.asyncio
async def test_t50_t55_system_change_notifies_chat_and_inheriting_workspace_only(
    tmp_path: Path,
) -> None:
    system_root = tmp_path / "system"
    workspace_inherit = tmp_path / "inherit"
    workspace_closed = tmp_path / "closed"
    write_workspace_manifest(workspace_closed, inherit_system=False)
    events: list[tuple[str, dict[str, Any]]] = []

    async def notify(session_id: str, payload: dict[str, Any]) -> bool:
        events.append((session_id, payload))
        return True

    watcher = KeydexSkillsWatcher(
        runtime_cache=KeydexRuntimeCache(system_root=system_root),
        notifier=notify,
        start_tasks=False,
    )
    await watcher.register_session("chat", None)
    await watcher.register_session("inherit", workspace_inherit)
    await watcher.register_session("closed", workspace_closed)
    entry = write_skill(system_root / "skills" / "global", "global", body="v1")

    handled = await watcher.handle_system_path_change(entry)

    assert handled is True
    assert [session_id for session_id, _ in events] == ["chat", "inherit"]
    for _, payload in events:
        assert payload["changed_scope"] == "system"
        assert payload["changed_path"] == "skills/global/SKILL.md"
        assert str(system_root.resolve()) not in json.dumps(payload)
        assert len(payload["effective_fingerprint"]) == 64


@pytest.mark.asyncio
async def test_t51_t52_workspace_resource_change_is_isolated_and_duplicate_is_ignored(
    tmp_path: Path,
) -> None:
    system_root = tmp_path / "system"
    workspace_a = tmp_path / "a"
    workspace_b = tmp_path / "b"
    resource = write_skill(
        workspace_a / ".keydex" / "skills" / "local",
        "local",
        resource="one",
    ).parent / "notes.txt"
    events: list[tuple[str, dict[str, Any]]] = []

    async def notify(session_id: str, payload: dict[str, Any]) -> bool:
        events.append((session_id, payload))
        return True

    watcher = KeydexSkillsWatcher(
        runtime_cache=KeydexRuntimeCache(system_root=system_root),
        notifier=notify,
        start_tasks=False,
    )
    await watcher.register_session("a", workspace_a)
    await watcher.register_session("b", workspace_b)
    resource.write_text("two", encoding="utf-8")

    first = await watcher.handle_workspace_path_change(workspace_a, resource)
    second = await watcher.handle_workspace_path_change(workspace_a, resource)

    assert first is True
    assert second is False
    assert [session_id for session_id, _ in events] == ["a"]
    assert events[0][1]["changed_path"] == ".keydex/skills/local/notes.txt"


@pytest.mark.asyncio
async def test_t52_system_manifest_skill_and_resource_add_rename_delete_refresh(
    tmp_path: Path,
) -> None:
    system_root = tmp_path / "system"
    events: list[dict[str, Any]] = []

    async def notify(_session_id: str, payload: dict[str, Any]) -> bool:
        events.append(payload)
        return True

    watcher = KeydexSkillsWatcher(
        runtime_cache=KeydexRuntimeCache(system_root=system_root),
        notifier=notify,
        start_tasks=False,
    )
    await watcher.register_session("chat", None)

    system_root.mkdir()
    manifest = system_root / "keydex.json"
    manifest.write_text('{"schema_version": 1}', encoding="utf-8")
    assert await watcher.handle_system_path_change(manifest) is True

    entry = write_skill(system_root / "skills" / "global", "global", body="v1")
    assert await watcher.handle_system_path_change(entry) is True

    resource = entry.parent / "notes.txt"
    resource.write_text("one", encoding="utf-8")
    assert await watcher.handle_system_path_change(resource) is True
    renamed_resource = resource.with_name("guide.txt")
    resource.rename(renamed_resource)
    assert await watcher.handle_system_path_change(renamed_resource) is True
    renamed_resource.unlink()
    assert await watcher.handle_system_path_change(renamed_resource) is True

    shutil.rmtree(entry.parent)
    assert await watcher.handle_system_path_change(entry) is True

    assert [event["changed_path"] for event in events] == [
        "keydex.json",
        "skills/global/SKILL.md",
        "skills/global/notes.txt",
        "skills/global/guide.txt",
        "skills/global/guide.txt",
        "skills/global/SKILL.md",
    ]
    assert all(event["changed_scope"] == "system" for event in events)


@pytest.mark.asyncio
async def test_t55_transient_invalid_system_skill_recovers_without_partial_snapshot(
    tmp_path: Path,
) -> None:
    system_root = tmp_path / "system"
    entry = write_skill(system_root / "skills" / "global", "global", body="v1")
    events: list[dict[str, Any]] = []

    async def notify(_session_id: str, payload: dict[str, Any]) -> bool:
        events.append(payload)
        return True

    cache = KeydexRuntimeCache(system_root=system_root)
    watcher = KeydexSkillsWatcher(runtime_cache=cache, notifier=notify, start_tasks=False)
    await watcher.register_session("chat", None)

    entry.write_text("---\nname: [\n---\npartial", encoding="utf-8")
    assert await watcher.handle_system_path_change(entry) is True
    invalid_snapshot = cache.get_system_snapshot()
    assert "global" not in invalid_snapshot.skill_catalog.skills
    assert invalid_snapshot.diagnostics

    entry.write_text(skill_text("global", body="v2"), encoding="utf-8")
    assert await watcher.handle_system_path_change(entry) is True
    recovered_snapshot = cache.get_system_snapshot()
    assert recovered_snapshot.skill_catalog.skills["global"].source == "system"
    assert "v2" in recovered_snapshot.read_skill_text_resource(
        recovered_snapshot.skill_catalog.skills["global"], "SKILL.md"
    ).content
    assert len(events) == 2


@pytest.mark.asyncio
async def test_t43_watcher_refresh_keeps_current_request_snapshot_pinned(
    tmp_path: Path,
) -> None:
    system_root = tmp_path / "system"
    entry = write_skill(system_root / "skills" / "global", "global", body="old turn")
    events: list[dict[str, Any]] = []

    async def notify(_session_id: str, payload: dict[str, Any]) -> bool:
        events.append(payload)
        return True

    cache = KeydexRuntimeCache(system_root=system_root)
    current_request_snapshot = cache.get_system_snapshot()
    current_request_skill = current_request_snapshot.skill_catalog.skills["global"]
    watcher = KeydexSkillsWatcher(runtime_cache=cache, notifier=notify, start_tasks=False)
    await watcher.register_session("chat", None)

    entry.write_text(skill_text("global", body="next turn"), encoding="utf-8")
    assert await watcher.handle_system_path_change(entry) is True
    next_request_snapshot = cache.get_system_snapshot()

    assert current_request_snapshot is not next_request_snapshot
    assert "old turn" in current_request_snapshot.read_skill_text_resource(
        current_request_skill, "SKILL.md"
    ).content
    assert "next turn" in next_request_snapshot.read_skill_text_resource(
        next_request_snapshot.skill_catalog.skills["global"], "SKILL.md"
    ).content
    assert len(events) == 1


@pytest.mark.asyncio
async def test_t56_concurrent_duplicate_system_events_rebuild_and_notify_once(
    tmp_path: Path,
) -> None:
    system_root = tmp_path / "system"
    entry = write_skill(system_root / "skills" / "global", "global", body="v1")
    events: list[dict[str, Any]] = []

    async def notify(_session_id: str, payload: dict[str, Any]) -> bool:
        events.append(payload)
        return True

    watcher = KeydexSkillsWatcher(
        runtime_cache=KeydexRuntimeCache(system_root=system_root),
        notifier=notify,
        start_tasks=False,
    )
    await watcher.register_session("chat", None)
    entry.write_text(skill_text("global", body="v2"), encoding="utf-8")
    observed = build_keydex_layer_fingerprint("system", system_root).digest()

    results = await asyncio.gather(
        *(
            watcher.handle_system_path_change(entry, observed_fingerprint=observed)
            for _ in range(8)
        )
    )

    assert results.count(True) == 1
    assert results.count(False) == 7
    assert len(events) == 1


@pytest.mark.asyncio
async def test_watcher_close_cancels_system_and_workspace_tasks(tmp_path: Path) -> None:
    watcher = KeydexSkillsWatcher(
        runtime_cache=KeydexRuntimeCache(system_root=tmp_path / "system"),
        notifier=lambda _session_id, _payload: asyncio.sleep(0, result=True),
        poll_interval_seconds=60,
    )
    await watcher.register_session("chat", None)
    await watcher.register_session("workspace", tmp_path / "workspace")
    tasks = [
        watcher._system_task,
        *(watched.task for watched in watcher._watched_workspaces.values()),
    ]

    await watcher.close()

    assert all(task is not None and task.done() for task in tasks)
    assert watcher._sessions == {}
    assert watcher._watched_workspaces == {}
    assert watcher._system_task is None


@pytest.mark.asyncio
async def test_t24_t25_invalid_override_repair_and_delete_restore_system_winner(
    tmp_path: Path,
) -> None:
    system_root = tmp_path / "system"
    workspace = tmp_path / "workspace"
    write_skill(system_root / "skills" / "shared", "shared", body="system")
    invalid_entry = write_skill(
        workspace / ".keydex" / "skills" / "shared",
        "other",
        body="invalid",
    )
    events: list[dict[str, Any]] = []

    async def notify(_session_id: str, payload: dict[str, Any]) -> bool:
        events.append(payload)
        return True

    cache = KeydexRuntimeCache(system_root=system_root)
    watcher = KeydexSkillsWatcher(runtime_cache=cache, notifier=notify, start_tasks=False)
    await watcher.register_session("workspace", workspace)
    assert "shared" not in cache.get_workspace_snapshot(workspace).skill_catalog.skills

    invalid_entry.write_text(skill_text("shared", body="workspace"), encoding="utf-8")
    assert await watcher.handle_workspace_path_change(workspace, invalid_entry) is True
    winner = cache.get_workspace_snapshot(workspace).skill_catalog.skills["shared"]
    assert winner.source == "workspace"

    shutil.rmtree(invalid_entry.parent)
    assert await watcher.handle_workspace_path_change(workspace, invalid_entry) is True
    assert cache.get_workspace_snapshot(workspace).skill_catalog.skills["shared"].source == "system"
    assert len(events) == 2


@pytest.mark.asyncio
async def test_t56_session_switch_unregisters_old_workspace_dependency(tmp_path: Path) -> None:
    cache = KeydexRuntimeCache(system_root=tmp_path / "system")
    workspace_a = tmp_path / "a"
    workspace_b = tmp_path / "b"
    events: list[str] = []

    async def notify(session_id: str, _payload: dict[str, Any]) -> bool:
        events.append(session_id)
        return True

    watcher = KeydexSkillsWatcher(runtime_cache=cache, notifier=notify, start_tasks=False)
    await watcher.register_session("session", workspace_a)
    await watcher.register_session("session", workspace_b)
    entry_a = write_skill(workspace_a / ".keydex" / "skills" / "a", "a")
    entry_b = write_skill(workspace_b / ".keydex" / "skills" / "b", "b")

    assert await watcher.handle_workspace_path_change(workspace_a, entry_a) is True
    assert events == []
    assert await watcher.handle_workspace_path_change(workspace_b, entry_b) is True
    assert events == ["session"]


def test_t53_watch_targets_include_system_and_workspace_resource_trees(tmp_path: Path) -> None:
    system_root = tmp_path / "system"
    workspace_root = tmp_path / "workspace"

    assert is_keydex_layer_watch_target("system", system_root, "keydex.json")
    assert is_keydex_layer_watch_target("system", system_root, "skills/a/assets/icon.png")
    assert is_keydex_layer_watch_target(
        "workspace", workspace_root, ".keydex/skills/a/references/guide.md"
    )
    assert not is_keydex_layer_watch_target(
        "workspace", workspace_root, ".agents/skills/a/SKILL.md"
    )


def write_workspace_manifest(workspace_root: Path, *, inherit_system: bool) -> None:
    keydex_root = workspace_root / ".keydex"
    keydex_root.mkdir(parents=True)
    (keydex_root / "keydex.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "skills": {"enabled": True, "inherit_system": inherit_system},
            }
        ),
        encoding="utf-8",
    )


def write_skill(
    root: Path,
    name: str,
    *,
    body: str = "body",
    resource: str | None = None,
) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    entry = root / "SKILL.md"
    entry.write_text(skill_text(name, body=body), encoding="utf-8")
    if resource is not None:
        (root / "notes.txt").write_text(resource, encoding="utf-8")
    return entry


def skill_text(name: str, *, body: str) -> str:
    return f"---\nname: {name}\ndescription: {name} skill\n---\n\n{body}\n"
