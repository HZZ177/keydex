from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.app.core.request_context import reset_request_context, set_request_context
from backend.app.keydex.models import KeydexWorkspaceProfile
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
    catalog = _catalog(tmp_path)
    token = set_request_context(skill_catalog=catalog)

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
async def test_load_skill_reads_updated_entry_with_existing_catalog(tmp_path: Path) -> None:
    skill_md = _write_skill(tmp_path)
    catalog = _catalog(tmp_path)
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
    token = set_request_context(skill_catalog=catalog)

    try:
        command = await run_load_skill(skill_name="dev-plan", tool_call_id="call_1")
    finally:
        reset_request_context(token)

    pending = command.update["pending_skill_activations"]
    assert "Updated marker 1215215." in pending[0]["content"]
    assert "Follow the project planning workflow." not in pending[0]["content"]


@pytest.mark.asyncio
async def test_load_skill_activation_failure_returns_loaded_not_injected(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_skill(tmp_path)
    catalog = _catalog(tmp_path)

    def fail_activation(*args, **kwargs):
        raise RuntimeError("activation build failed")

    monkeypatch.setattr(skill_tool_module, "_build_activation_content", fail_activation)
    token = set_request_context(skill_catalog=catalog)

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
    catalog = _catalog(tmp_path)
    token = set_request_context(skill_catalog=catalog)

    try:
        command = await run_load_skill(skill_name="dev-plan", tool_call_id="call_1")
    finally:
        reset_request_context(token)

    payload = _tool_payload(command)
    assert payload["code"] == "skill_not_found"
    assert payload["found"] is False
    assert "pending_skill_activations" not in command.update


@pytest.mark.asyncio
async def test_load_skill_missing_entry_returns_failure(tmp_path: Path) -> None:
    skill_md = _write_skill(tmp_path)
    catalog = _catalog(tmp_path)
    skill_md.unlink()
    token = set_request_context(skill_catalog=catalog)

    try:
        command = await run_load_skill(skill_name="dev-plan", tool_call_id="call_1")
    finally:
        reset_request_context(token)

    payload = _tool_payload(command)
    assert payload["code"] == "skill_entry_missing"
    assert payload["found"] is True
    assert payload["loaded"] is False
    assert "pending_skill_activations" not in command.update
