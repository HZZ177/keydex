from __future__ import annotations

import asyncio
import sys

from backend.app.tools import ToolExecutionContext, ToolRegistry
from backend.app.tools.shell import register_shell_tools


def _context(tmp_path) -> ToolExecutionContext:
    return ToolExecutionContext(
        session_id="ses_shell",
        user_id="local-user",
        workspace_root=tmp_path,
        turn_index=1,
    )


def _registry() -> ToolRegistry:
    return register_shell_tools(ToolRegistry())


async def _run(args: dict, tmp_path):
    return await _registry().require("run_command").run(args, _context(tmp_path))


def _python_command(source: str) -> str:
    return f'"{sys.executable}" -c "{source}"'


async def test_shell_tool_runs_successful_command(tmp_path) -> None:
    result = await _run({"command": _python_command("print('ok')")}, tmp_path)

    assert result.ok is True
    assert result.result["exit_code"] == 0
    assert result.result["stdout"].strip() == "ok"
    assert result.result["cwd"] == "."


async def test_shell_tool_does_not_depend_on_asyncio_subprocess_support(
    tmp_path,
    monkeypatch,
) -> None:
    async def raise_not_implemented(*args, **kwargs):
        raise NotImplementedError()

    monkeypatch.setattr(asyncio, "create_subprocess_shell", raise_not_implemented)

    result = await _run({"command": _python_command("print('ok')")}, tmp_path)

    assert result.ok is True
    assert result.result["status"] == "completed"
    assert result.result["stdout"].strip() == "ok"


async def test_shell_tool_returns_nonzero_exit_as_completed_result(tmp_path) -> None:
    result = await _run(
        {"command": _python_command("import sys; print('bad', file=sys.stderr); sys.exit(3)")},
        tmp_path,
    )

    assert result.ok is True
    assert result.result["status"] == "completed"
    assert result.result["exit_code"] == 3
    assert "bad" in result.result["stderr"]


async def test_shell_tool_times_out(tmp_path) -> None:
    result = await _run(
        {
            "command": _python_command("import time; time.sleep(2)"),
            "timeout_seconds": 0.1,
        },
        tmp_path,
    )

    assert result.ok is True
    assert result.result["status"] == "timed_out"
    assert result.result["timed_out"] is True


async def test_shell_tool_rejects_cwd_outside_workspace(tmp_path) -> None:
    result = await _run(
        {"command": _python_command("print('x')"), "cwd": str(tmp_path.parent)},
        tmp_path,
    )

    assert result.ok is False
    assert result.error["code"] == "workspace_path_forbidden"


async def test_shell_tool_captures_chinese_output(tmp_path) -> None:
    result = await _run({"command": _python_command("print('你好')")}, tmp_path)

    assert result.ok is True
    assert "你好" in result.result["stdout"]
