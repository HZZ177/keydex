from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.app.core.request_context import reset_request_context, set_request_context
from backend.app.keydex import KeydexRuntimeCache
from backend.app.keydex.skills import EffectiveSkillCatalog, SkillDefinition
from backend.app.keydex.watcher import KeydexSkillsWatcher
from backend.app.tools.skill import run_load_skill


def _skill(root: Path, name: str, source: str, marker: str) -> SkillDefinition:
    skill_root = root / source / "skills" / name
    skill_root.mkdir(parents=True)
    entry_file = skill_root / "SKILL.md"
    entry_file.write_text(
        "\n".join(
            [
                "---",
                f"name: {name}",
                f"description: {source} test skill.",
                "---",
                "",
                f"# {name}",
                marker,
            ]
        ),
        encoding="utf-8",
    )
    return SkillDefinition(
        name=name,
        description=f"{source} test skill.",
        source=source,  # type: ignore[arg-type]
        root_dir=skill_root,
        entry_file=entry_file,
        relative_entry=f".keydex/skills/{name}/SKILL.md",
    )


def _payload(command) -> dict:
    return json.loads(command.update["messages"][0].content)


def _write_runtime_skill(root: Path, name: str, description: str, marker: str) -> None:
    skill_root = root / "skills" / name
    skill_root.mkdir(parents=True, exist_ok=True)
    (skill_root / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {description}\n---\n\n{marker}",
        encoding="utf-8",
    )


@pytest.mark.asyncio
async def test_t32_t37_t84_system_winner_uses_safe_source_aware_context(
    tmp_path: Path,
) -> None:
    system = _skill(tmp_path, "shared", "system", "SYSTEM WINNER")
    catalog = EffectiveSkillCatalog(mode="system_only", skills={"shared": system})
    token = set_request_context(skill_catalog=catalog)

    try:
        command = await run_load_skill(skill_name="shared", tool_call_id="call-system")
    finally:
        reset_request_context(token)

    payload = _payload(command)
    assert payload["source"] == "system"
    assert payload["locator"] == ".keydex/skills/shared/SKILL.md"
    pending = command.update["pending_skill_activations"][0]
    assert pending["id"] == "skill:system:shared"
    assert pending["source"] == "system"
    assert pending["locator"] == ".keydex/skills/shared/SKILL.md"
    assert "SYSTEM WINNER" in pending["content"]
    assert str(tmp_path) not in json.dumps(payload)
    assert str(system.root_dir) not in pending["content"]
    assert '"mode": "keydex_read_only"' in pending["content"]
    assert "禁止执行" in pending["content"]


@pytest.mark.asyncio
async def test_workspace_override_is_the_only_loadable_same_name_winner(
    tmp_path: Path,
) -> None:
    system_root = tmp_path / "system-keydex"
    workspace_root = tmp_path / "workspace"
    _write_runtime_skill(system_root, "shared", "system test skill", "HIDDEN SYSTEM BODY")
    _write_runtime_skill(
        workspace_root / ".keydex",
        "shared",
        "workspace test skill",
        "WORKSPACE WINNER BODY",
    )
    snapshot = KeydexRuntimeCache(system_root=system_root).get_workspace_snapshot(workspace_root)
    token = set_request_context(
        skill_catalog=snapshot.skill_catalog,
        keydex_snapshot=snapshot,
    )

    try:
        command = await run_load_skill(skill_name="shared", tool_call_id="call-workspace")
    finally:
        reset_request_context(token)

    payload = _payload(command)
    assert payload["source"] == "workspace"
    pending = command.update["pending_skill_activations"][0]
    assert pending["id"] == "skill:workspace:shared"
    assert "WORKSPACE WINNER BODY" in pending["content"]
    assert "HIDDEN SYSTEM BODY" not in pending["content"]


@pytest.mark.asyncio
async def test_builtin_guide_can_activate_and_read_packaged_resources(tmp_path: Path) -> None:
    snapshot = KeydexRuntimeCache(
        system_root=tmp_path / "missing-system"
    ).get_system_snapshot()
    token = set_request_context(
        skill_catalog=snapshot.skill_catalog,
        keydex_snapshot=snapshot,
    )

    try:
        activation = await run_load_skill(
            skill_name="keydex-guide",
            source="builtin",
            tool_call_id="call-builtin",
        )
        resource = await run_load_skill(
            skill_name="keydex-guide",
            source="builtin",
            resource_path="references/keydex-scope-priority-and-config.md",
            tool_call_id="call-builtin-resource",
        )
    finally:
        reset_request_context(token)

    activation_payload = _payload(activation)
    pending = activation.update["pending_skill_activations"][0]
    assert activation_payload["source"] == "builtin"
    assert activation_payload["locator"] == "builtin/skills/keydex-guide/SKILL.md"
    assert pending["id"] == "skill:builtin:keydex-guide"
    assert "# Keydex 产品使用指南" in pending["content"]
    resource_payload = _payload(resource)
    assert resource_payload["source"] == "builtin"
    assert "# 内置、系统级、项目级 Skill" in resource_payload["content"]


@pytest.mark.asyncio
async def test_shadow_barrier_cannot_be_bypassed_by_direct_tool_call(
    tmp_path: Path,
) -> None:
    system_root = tmp_path / "system-keydex"
    workspace_root = tmp_path / "workspace"
    _write_runtime_skill(system_root, "shared", "system test skill", "HIDDEN SYSTEM BODY")
    (workspace_root / ".keydex" / "skills" / "shared").mkdir(parents=True)
    snapshot = KeydexRuntimeCache(system_root=system_root).get_workspace_snapshot(workspace_root)
    token = set_request_context(
        skill_catalog=snapshot.skill_catalog,
        keydex_snapshot=snapshot,
    )

    try:
        command = await run_load_skill(skill_name="shared", tool_call_id="call-blocked")
    finally:
        reset_request_context(token)

    payload = _payload(command)
    assert payload["code"] == "skill_not_found"
    assert payload["found"] is False
    assert "pending_skill_activations" not in command.update


@pytest.mark.asyncio
async def test_expected_source_cannot_select_a_hidden_non_winner(tmp_path: Path) -> None:
    system_root = tmp_path / "system-keydex"
    workspace_root = tmp_path / "workspace"
    _write_runtime_skill(system_root, "shared", "system test skill", "SYSTEM HIDDEN")
    _write_runtime_skill(
        workspace_root / ".keydex",
        "shared",
        "workspace test skill",
        "WORKSPACE WINNER",
    )
    snapshot = KeydexRuntimeCache(system_root=system_root).get_workspace_snapshot(workspace_root)
    token = set_request_context(
        skill_catalog=snapshot.skill_catalog,
        keydex_snapshot=snapshot,
    )

    try:
        command = await run_load_skill(
            skill_name="shared",
            source="system",
            tool_call_id="call-stale",
        )
    finally:
        reset_request_context(token)

    payload = _payload(command)
    assert payload == {
        "skill_name": "shared",
        "requested_source": "system",
        "winner_source": "workspace",
        "found": True,
        "loaded": False,
        "injected": False,
        "code": "skill_source_stale",
        "message": "Skill source no longer matches the effective winner.",
    }
    assert "pending_skill_activations" not in command.update


@pytest.mark.asyncio
async def test_t43_watcher_during_turn_keeps_entry_and_resource_snapshot_pinned(
    tmp_path: Path,
) -> None:
    system_root = tmp_path / "system-keydex"
    skill_root = system_root / "skills" / "shared"
    skill_root.mkdir(parents=True)
    entry_file = skill_root / "SKILL.md"
    entry_file.write_text(
        "---\nname: shared\ndescription: shared system skill.\n---\n\nOLD ENTRY",
        encoding="utf-8",
    )
    resource_file = skill_root / "guide.md"
    resource_file.write_text("OLD RESOURCE", encoding="utf-8")
    cache = KeydexRuntimeCache(system_root=system_root)
    first = cache.get_system_snapshot()
    events: list[dict] = []

    async def notify(_session_id: str, payload: dict) -> bool:
        events.append(payload)
        return True

    watcher = KeydexSkillsWatcher(runtime_cache=cache, notifier=notify, start_tasks=False)
    await watcher.register_session("chat", None)
    token = set_request_context(
        skill_catalog=first.skill_catalog,
        keydex_snapshot=first,
    )
    entry_file.write_text(
        "---\nname: shared\ndescription: shared system skill.\n---\n\nNEW ENTRY",
        encoding="utf-8",
    )
    resource_file.write_text("NEW RESOURCE", encoding="utf-8")

    try:
        assert await watcher.handle_system_path_change(entry_file) is True
        activation = await run_load_skill(
            skill_name="shared",
            source="system",
            tool_call_id="call-entry",
        )
        resource = await run_load_skill(
            skill_name="shared",
            source="system",
            resource_path="guide.md",
            tool_call_id="call-resource",
        )
    finally:
        reset_request_context(token)

    assert "OLD ENTRY" in activation.update["pending_skill_activations"][0]["content"]
    assert "NEW ENTRY" not in activation.update["pending_skill_activations"][0]["content"]
    assert _payload(resource)["content"] == "OLD RESOURCE"
    assert len(events) == 1

    second = cache.get_system_snapshot()
    assert second.fingerprint != first.fingerprint
    token = set_request_context(
        skill_catalog=second.skill_catalog,
        keydex_snapshot=second,
    )
    try:
        refreshed = await run_load_skill(
            skill_name="shared",
            source="system",
            resource_path="guide.md",
            tool_call_id="call-refreshed",
        )
    finally:
        reset_request_context(token)
    assert _payload(refreshed)["content"] == "NEW RESOURCE"
