from __future__ import annotations

import asyncio
import sys

from backend.app.command_approval import (
    ApprovalService,
    CommandApprovalDecision,
    CommandApprovalError,
    find_trusted_command_rule,
)
from backend.app.storage import StorageRepositories, init_database
from backend.app.tools import ToolExecutionContext, ToolRegistry
from backend.app.tools.command_runtime.discovery import ShellDiscoveryResult
from backend.app.tools.command_runtime.models import CommandSettings
from backend.app.tools.command_runtime.providers import CommandSpawnSpec
from backend.app.tools.command_runtime.tools import register_command_tools


class PythonProvider:
    def build(self, runtime, command: str) -> CommandSpawnSpec:
        return CommandSpawnSpec(
            executable=sys.executable,
            argv=[sys.executable, "-c", command],
            shell_label="Python",
            shell_path=sys.executable,
        )


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
    repositories.settings.set(
        "command_settings",
        CommandSettings(
            command_enabled=True,
            selected_shell="cmd",
            shell_path=str(tmp_path / "cmd.exe"),
            shell_label="Windows CMD",
            require_approval_for_untrusted=True,
            output_file_max_bytes=1024 * 1024,
        ).model_dump(mode="json"),
    )
    return repositories


def _context(tmp_path, repositories: StorageRepositories) -> ToolExecutionContext:
    return ToolExecutionContext(
        session_id="ses-command",
        user_id="local-user",
        workspace_root=tmp_path,
        turn_index=1,
        trace_id="trace-command",
        metadata={
            "repositories": repositories,
            "approval_wait_seconds": 2,
            "data_dir": str(tmp_path / "data"),
            "tool_name": "run_cmd",
            "run_id": "run-command",
            "tool_call_id": "tool-call-command",
        },
    )


def _registry(repositories: StorageRepositories) -> ToolRegistry:
    settings = CommandSettings(**repositories.settings.get("command_settings"))
    return register_command_tools(ToolRegistry(), settings)


def _write_file_command(filename: str) -> str:
    code = f"from pathlib import Path; Path({filename!r}).write_text('ok', encoding='utf-8')"
    return code


async def _wait_for_pending(repositories: StorageRepositories):
    for _ in range(30):
        pending = repositories.command_approvals.list_pending(session_id="ses-command")
        if pending:
            return pending[0]
        await asyncio.sleep(0.05)
    raise AssertionError("没有创建 pending 审批")


def _mock_runtime(monkeypatch) -> None:
    monkeypatch.setattr(
        "backend.app.tools.command_runtime.tools.validate_shell_executable",
        lambda shell, path: ShellDiscoveryResult(
            shell=shell,
            found=True,
            path=str(path),
            label="Windows CMD",
        ),
    )
    monkeypatch.setattr(
        "backend.app.tools.command_runtime.runner.provider_for_runtime",
        lambda runtime: PythonProvider(),
    )


async def test_command_waits_for_approval_before_execution(tmp_path, monkeypatch) -> None:
    _mock_runtime(monkeypatch)
    repositories = _repositories(tmp_path)
    command = _write_file_command("approved.txt")
    tool = _registry(repositories).require("run_cmd")
    task = asyncio.create_task(tool.run({"command": command}, _context(tmp_path, repositories)))

    approval = await _wait_for_pending(repositories)
    assert approval.tool_name == "run_cmd"
    assert approval.details["shell_path"].endswith("cmd.exe")
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


async def test_command_rejects_without_execution_or_output_path(tmp_path, monkeypatch) -> None:
    _mock_runtime(monkeypatch)
    repositories = _repositories(tmp_path)
    command = _write_file_command("rejected.txt")
    tool = _registry(repositories).require("run_cmd")
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
    assert result.result["output_path"] is None
    assert "只读命令" in result.result["approval"]["reject_message"]
    assert not (tmp_path / "rejected.txt").exists()


async def test_persistent_exact_trust_includes_tool_shell_path(tmp_path, monkeypatch) -> None:
    _mock_runtime(monkeypatch)
    repositories = _repositories(tmp_path)
    command = _write_file_command("trusted.txt")
    tool = _registry(repositories).require("run_cmd")
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
        shell="cmd",
        shell_path=str((tmp_path / "cmd.exe").resolve()),
        tool_name="run_cmd",
        workspace_root=str(tmp_path),
    )
    assert (
        find_trusted_command_rule(
            repositories,
            command=command,
            cwd=".",
            shell="cmd",
            shell_path=str((tmp_path / "other-cmd.exe").resolve()),
            tool_name="run_cmd",
            workspace_root=str(tmp_path),
        )
        is None
    )

    second = await tool.run({"command": command}, _context(tmp_path, repositories))

    assert second.ok is True
    assert second.result["status"] == "completed"
    assert second.result["approval"]["trusted"] is True
    assert repositories.command_approvals.list_pending(session_id="ses-command") == []


async def test_command_approval_rejects_mcp_only_trust_scope(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    approval = repositories.command_approvals.create(
        approval_id="approval-command-scope",
        session_id="ses-command",
        command="pnpm test",
        cwd=".",
        title="是否允许执行命令？",
        tool_name="run_cmd",
        shell="cmd",
    )

    try:
        await ApprovalService(repositories=repositories).resolve(
            approval.id,
            CommandApprovalDecision(decision="approved", trust_scope="session"),
        )
    except CommandApprovalError as exc:
        assert "once 或 persistent" in str(exc)
    else:
        raise AssertionError("命令审批不应接受 MCP-only trust_scope")

    assert repositories.command_approvals.get(approval.id).status == "pending"


async def test_command_runtime_unavailable_returns_clear_result(tmp_path, monkeypatch) -> None:
    repositories = _repositories(tmp_path)
    monkeypatch.setattr(
        "backend.app.tools.command_runtime.tools.validate_shell_executable",
        lambda shell, path: ShellDiscoveryResult(shell=shell, found=False, error="missing cmd"),
    )

    result = await _registry(repositories).require("run_cmd").run(
        {"command": "print('x')"},
        _context(tmp_path, repositories),
    )

    assert result.ok is True
    assert result.result["status"] == "shell_not_available"
    assert "missing cmd" in result.result["stderr"]
