from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.app.core.request_context import reset_request_context, set_request_context
from backend.app.keydex import KeydexRuntimeCache
from backend.app.keydex.capabilities.skills import SkillsCapability
from backend.app.keydex.models import KeydexWorkspaceProfile
from backend.app.keydex.registry import KeydexCapabilityRegistry
from backend.app.keydex.runtime_cache import KeydexCapabilityRuntimeCache
from backend.app.keydex.skills import discover_workspace_skills
from backend.app.tools import skill as skill_tool_module
from backend.app.tools.skill import load_skill, run_load_skill


def _write_skill(workspace: Path, name: str = "dev-plan") -> Path:
    skill_dir = workspace / ".keydex" / "skills" / name
    skill_dir.mkdir(parents=True)
    skill_md = skill_dir / "SKILL.md"
    skill_md.write_text(
        "\n".join(
            [
                "---",
                f"name: {name}",
                "description: Build a structured development plan.",
                "---",
                "",
                "# Dev Plan",
                "Follow the project planning workflow.",
            ]
        ),
        encoding="utf-8",
    )
    return skill_md


def _catalog(workspace: Path):
    profile = KeydexWorkspaceProfile(
        workspace_root=workspace,
        keydex_root=workspace / ".keydex",
        skills_root=workspace / ".keydex" / "skills",
    )
    return discover_workspace_skills(profile)


def _snapshot(workspace: Path):
    return KeydexRuntimeCache(
        system_root=workspace / "missing-system",
    ).get_workspace_snapshot(workspace)


def _tool_payload(command) -> dict:
    tool_message = command.update["messages"][0]
    return json.loads(tool_message.content)


@pytest.mark.asyncio
async def test_load_skill_native_tool_name() -> None:
    assert load_skill.name == "load_skill"


@pytest.mark.asyncio
async def test_load_skill_activation_writes_pending_skill_activation(tmp_path: Path) -> None:
    skill_md = _write_skill(tmp_path)
    skill_dir = skill_md.parent
    (skill_dir / "references").mkdir()
    (skill_dir / "references" / "guide.md").write_text("guide", encoding="utf-8")
    (skill_dir / "scripts").mkdir()
    (skill_dir / "scripts" / "run.ps1").write_text("Write-Output ok", encoding="utf-8")
    snapshot = _snapshot(tmp_path)
    token = set_request_context(keydex_snapshot=snapshot)

    try:
        command = await run_load_skill(skill_name="dev-plan", tool_call_id="call_1")
    finally:
        reset_request_context(token)

    payload = _tool_payload(command)
    assert payload == {
        "skill_name": "dev-plan",
        "source": "workspace",
        "locator": ".keydex/skills/dev-plan/SKILL.md",
        "found": True,
        "loaded": True,
        "injected": True,
        "message": "skill 已激活。",
    }
    pending = command.update["pending_skill_activations"]
    assert pending[0]["id"] == "skill:workspace:dev-plan"
    assert pending[0]["skill_name"] == "dev-plan"
    assert pending[0]["source"] == "workspace"
    assert pending[0]["locator"] == ".keydex/skills/dev-plan/SKILL.md"
    assert "# Dev Plan" in pending[0]["content"]
    assert "你现在已激活 Keydex Skill：dev-plan（来源：workspace）。" in pending[0]["content"]
    assert "技能上下文：" in pending[0]["content"]
    assert "资源访问说明：" in pending[0]["content"]
    assert '"id": "skill:workspace:dev-plan"' in pending[0]["content"]
    assert '"locator": ".keydex/skills/dev-plan/SKILL.md"' in pending[0]["content"]
    assert (
        '"resources": [\n    "references/guide.md",\n    "scripts/run.ps1"\n  ]'
        in pending[0]["content"]
    )
    assert '"mode": "keydex_read_only"' in pending[0]["content"]
    assert "scripts/ 下资源也只能作为文本读取，禁止执行" in pending[0]["content"]
    assert "以下是 Skill 的正文内容，请结合该 Skill 完成用户需求：" in pending[0]["content"]
    assert '"read_text":' in pending[0]["content"]
    assert "<相对路径>" in pending[0]["content"]
    assert "如需读取 Skill 附录文件，调用" not in pending[0]["content"]
    assert "You are now using the workspace skill" not in pending[0]["content"]
    assert "Skill metadata:" not in pending[0]["content"]
    assert command.update["messages"][0].tool_call_id == "call_1"
    assert command.update["messages"][0].name == "load_skill"


@pytest.mark.asyncio
async def test_load_skill_rejects_activation_over_32kb_without_pending_state(
    tmp_path: Path,
) -> None:
    skill_md = _write_skill(tmp_path)
    skill_md.write_text(
        skill_md.read_text(encoding="utf-8") + "\n" + ("完整规则😀\n" * 5000),
        encoding="utf-8",
    )
    token = set_request_context(keydex_snapshot=_snapshot(tmp_path))
    try:
        command = await run_load_skill(skill_name="dev-plan", tool_call_id="call-large")
    finally:
        reset_request_context(token)

    payload = _tool_payload(command)
    assert payload["code"] == "skill_content_too_large_for_model"
    assert payload["loaded"] is False
    assert payload["injected"] is False
    assert "pending_skill_activations" not in command.update
    assert "完整规则" not in command.update["messages"][0].content


@pytest.mark.asyncio
async def test_load_skill_keeps_frozen_entry_after_disk_update(tmp_path: Path) -> None:
    skill_md = _write_skill(tmp_path)
    snapshot = _snapshot(tmp_path)
    skill_md.write_text(
        "\n".join(
            [
                "---",
                "name: dev-plan",
                "description: Build a structured development plan.",
                "---",
                "",
                "# Dev Plan",
                "Updated marker 1215215.",
            ]
        ),
        encoding="utf-8",
    )
    token = set_request_context(keydex_snapshot=snapshot)

    try:
        command = await run_load_skill(skill_name="dev-plan", tool_call_id="call_1")
    finally:
        reset_request_context(token)

    pending = command.update["pending_skill_activations"]
    assert "Updated marker 1215215." not in pending[0]["content"]
    assert "Follow the project planning workflow." in pending[0]["content"]


@pytest.mark.asyncio
async def test_load_skill_uses_generic_typed_snapshot_without_filesystem_fallback(
    tmp_path: Path,
) -> None:
    skill_md = _write_skill(tmp_path)
    resource = skill_md.parent / "guide.md"
    resource.write_text("RESOURCE V1", encoding="utf-8")
    registry = KeydexCapabilityRegistry((SkillsCapability(),))
    snapshot = KeydexCapabilityRuntimeCache(
        system_root=tmp_path / "missing-system",
        registry=registry,
    ).get_workspace_snapshot(tmp_path)
    skill_md.write_text(
        "---\nname: dev-plan\ndescription: changed\n---\n\nENTRY V2\n",
        encoding="utf-8",
    )
    resource.write_text("RESOURCE V2", encoding="utf-8")
    token = set_request_context(keydex_snapshot=snapshot)

    try:
        activation = await run_load_skill(
            skill_name="dev-plan",
            tool_call_id="call-entry",
        )
        loaded_resource = await run_load_skill(
            skill_name="dev-plan",
            resource_path="guide.md",
            tool_call_id="call-resource",
        )
    finally:
        reset_request_context(token)

    assert "Follow the project planning workflow." in activation.update[
        "pending_skill_activations"
    ][0]["content"]
    assert "ENTRY V2" not in activation.update["pending_skill_activations"][0]["content"]
    assert _tool_payload(loaded_resource)["content"] == "RESOURCE V1"


@pytest.mark.asyncio
async def test_load_skill_activation_failure_returns_loaded_not_injected(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_skill(tmp_path)
    snapshot = _snapshot(tmp_path)

    def fail_activation(*args, **kwargs):
        raise RuntimeError("activation build failed")

    monkeypatch.setattr(skill_tool_module, "_build_activation_content", fail_activation)
    token = set_request_context(keydex_snapshot=snapshot)

    try:
        command = await run_load_skill(skill_name="dev-plan", tool_call_id="call_1")
    finally:
        reset_request_context(token)

    payload = _tool_payload(command)
    assert payload == {
        "skill_name": "dev-plan",
        "source": "workspace",
        "locator": ".keydex/skills/dev-plan/SKILL.md",
        "found": True,
        "loaded": True,
        "injected": False,
        "code": "skill_activation_failed",
        "message": "skill 已加载，但激活未完成。",
    }
    assert "pending_skill_activations" not in command.update


@pytest.mark.asyncio
async def test_load_skill_without_catalog_returns_failure() -> None:
    command = await run_load_skill(skill_name="dev-plan", tool_call_id="call_1")

    payload = _tool_payload(command)
    assert payload["code"] == "skill_catalog_missing"
    assert payload["found"] is False
    assert "pending_skill_activations" not in command.update


@pytest.mark.asyncio
async def test_load_skill_not_found_returns_failure(tmp_path: Path) -> None:
    _write_skill(tmp_path, "other-skill")
    snapshot = _snapshot(tmp_path)
    token = set_request_context(keydex_snapshot=snapshot)

    try:
        command = await run_load_skill(skill_name="dev-plan", tool_call_id="call_1")
    finally:
        reset_request_context(token)

    payload = _tool_payload(command)
    assert payload["code"] == "skill_not_found"
    assert payload["found"] is False
    assert "pending_skill_activations" not in command.update


@pytest.mark.asyncio
async def test_load_skill_raw_catalog_without_snapshot_never_reads_entry(
    tmp_path: Path,
) -> None:
    skill_md = _write_skill(tmp_path)
    catalog = _catalog(tmp_path)
    skill_md.unlink()
    token = set_request_context(skill_catalog=catalog)

    try:
        command = await run_load_skill(skill_name="dev-plan", tool_call_id="call_1")
    finally:
        reset_request_context(token)

    payload = _tool_payload(command)
    assert payload["code"] == "skill_snapshot_missing"
    assert payload["found"] is False
    assert payload["loaded"] is False
    assert "pending_skill_activations" not in command.update
