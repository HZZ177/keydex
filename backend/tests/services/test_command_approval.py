from __future__ import annotations

import asyncio
import sys

from backend.app.command_approval import (
    ApprovalService,
    CommandApprovalDecision,
    find_trusted_command_rule,
)
from backend.app.storage import StorageRepositories, init_database
from backend.app.tools import ToolExecutionContext, ToolRegistry
from backend.app.tools.shell import register_shell_tools


def _repositories(tmp_path) -> StorageRepositories:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.sessions.create(
        session_id="ses-command",
        user_id="local-user",
        scene_id="desktop-agent",
        title="命令审批",
        session_type="workspace",
        cwd=str(tmp_path),
        workspace_roots=[str(tmp_path)],
    )
    return repositories


def _context(tmp_path, repositories: StorageRepositories) -> ToolExecutionContext:
    return ToolExecutionContext(
        session_id="ses-command",
        user_id="local-user",
        workspace_root=tmp_path,
        turn_index=1,
        metadata={
            "repositories": repositories,
            "approval_wait_seconds": 2,
        },
    )


def _registry() -> ToolRegistry:
    return register_shell_tools(ToolRegistry())


def _write_file_command(filename: str) -> str:
    code = f"from pathlib import Path; Path({filename!r}).write_text('ok', encoding='utf-8')"
    return f'"{sys.executable}" -c "{code}"'


async def _wait_for_pending(repositories: StorageRepositories):
    for _ in range(30):
        pending = repositories.command_approvals.list_pending(session_id="ses-command")
        if pending:
            return pending[0]
        await asyncio.sleep(0.05)
    raise AssertionError("没有创建 pending 审批")


async def test_run_command_waits_for_approval_before_execution(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    command = _write_file_command("approved.txt")
    tool = _registry().require("run_command")
    task = asyncio.create_task(tool.run({"command": command}, _context(tmp_path, repositories)))

    approval = await _wait_for_pending(repositories)
    assert not (tmp_path / "approved.txt").exists()

    await ApprovalService(repositories=repositories).resolve(
        approval.id,
        CommandApprovalDecision(decision="approved", trust_scope="once"),
    )
    result = await task

    assert result.ok is True
    assert result.result["status"] == "completed"
    assert result.result["approval"]["decision"] == "approved"
    assert (tmp_path / "approved.txt").read_text(encoding="utf-8") == "ok"


async def test_run_command_rejects_without_execution(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    command = _write_file_command("rejected.txt")
    tool = _registry().require("run_command")
    task = asyncio.create_task(tool.run({"command": command}, _context(tmp_path, repositories)))

    approval = await _wait_for_pending(repositories)
    await ApprovalService(repositories=repositories).resolve(
        approval.id,
        CommandApprovalDecision(
            decision="rejected",
            trust_scope="once",
            reject_message="请先改成只读命令",
        ),
    )
    result = await task

    assert result.ok is True
    assert result.result["status"] == "rejected"
    assert "只读命令" in result.result["approval"]["reject_message"]
    assert not (tmp_path / "rejected.txt").exists()


async def test_run_command_preserves_approval_when_executor_fails(tmp_path, monkeypatch) -> None:
    repositories = _repositories(tmp_path)

    async def raise_not_implemented(*args, **kwargs):
        raise NotImplementedError()

    monkeypatch.setattr(asyncio, "create_subprocess_shell", raise_not_implemented)
    tool = _registry().require("run_command")
    task = asyncio.create_task(
        tool.run({"command": "echo approved-before-executor-failure"}, _context(tmp_path, repositories))
    )

    approval = await _wait_for_pending(repositories)
    await ApprovalService(repositories=repositories).resolve(
        approval.id,
        CommandApprovalDecision(decision="approved", trust_scope="once"),
    )
    result = await task

    assert result.ok is True
    assert result.result["status"] == "failed"
    assert result.result["approval"]["required"] is True
    assert result.result["approval"]["status"] == "approved"
    assert result.result["approval"]["decision"] == "approved"
    assert "用户已批准执行" in result.result["approval_summary"]
    assert result.result["execution_error"]["type"] == "NotImplementedError"
    assert "失败发生在命令执行器阶段" in result.result["tool_summary"]


async def test_persistent_exact_trust_skips_second_approval(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    command = _write_file_command("trusted.txt")
    tool = _registry().require("run_command")
    first_task = asyncio.create_task(
        tool.run({"command": command}, _context(tmp_path, repositories))
    )

    approval = await _wait_for_pending(repositories)
    await ApprovalService(repositories=repositories).resolve(
        approval.id,
        CommandApprovalDecision(
            decision="approved",
            trust_scope="persistent",
            rule_match_type="exact",
        ),
    )
    first = await first_task

    assert first.result["approval"]["trusted_rule_id"]
    assert find_trusted_command_rule(
        repositories,
        command=command,
        cwd=".",
        shell="shell",
        workspace_root=str(tmp_path),
    )

    second = await tool.run({"command": command}, _context(tmp_path, repositories))

    assert second.ok is True
    assert second.result["status"] == "completed"
    assert second.result["approval"]["trusted"] is True
    assert repositories.command_approvals.list_pending(session_id="ses-command") == []


async def test_command_disabled_returns_disabled_result(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repositories.settings.set("command_settings", {"command_enabled": False})

    result = await _registry().require("run_command").run(
        {"command": _write_file_command("disabled.txt")},
        _context(tmp_path, repositories),
    )

    assert result.ok is True
    assert result.result["status"] == "disabled"
    assert not (tmp_path / "disabled.txt").exists()


async def test_command_settings_limit_captured_output(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repositories.settings.set(
        "command_settings",
        {
            "require_approval_for_untrusted": False,
            "max_output_chars": 4,
        },
    )

    result = await _registry().require("run_command").run(
        {"command": f'"{sys.executable}" -c "print(\'abcdef\')"'},
        _context(tmp_path, repositories),
    )

    assert result.ok is True
    assert result.result["status"] == "completed"
    assert result.result["stdout"].startswith("abcd")
    assert "输出已截断" in result.result["stdout"]
    assert result.result["truncated"] is True


async def test_command_settings_clamp_timeout_seconds(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repositories.settings.set(
        "command_settings",
        {
            "require_approval_for_untrusted": False,
            "default_timeout_seconds": 0.1,
            "max_timeout_seconds": 0.2,
        },
    )

    result = await _registry().require("run_command").run(
        {"command": f'"{sys.executable}" -c "import time; time.sleep(1)"', "timeout_seconds": 5},
        _context(tmp_path, repositories),
    )

    assert result.ok is True
    assert result.result["status"] == "timed_out"
    assert result.result["timed_out"] is True
    assert result.result["timeout_seconds"] == 0.2
