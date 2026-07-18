from __future__ import annotations

import inspect

from fastapi.testclient import TestClient

from backend.app.core.config import AppSettings
from backend.app.main import create_app
from backend.app.subagents.models import SubagentInitiator
from backend.app.subagents.runtime import (
    SessionBackedSubagentRuntime,
    SubagentRuntimeProtocol,
)


class ContractFakeRuntime:
    async def spawn(self, request): ...

    async def get_run(self, run_id, *, parent_session_id=None): ...

    async def wait_terminal(self, run_id, *, cancellation=None): ...

    async def steer(self, run_id, child_session_id, message): ...

    async def cancel(self, run_id, *, reason=None): ...

    async def cancel_by_parent_trace(
        self,
        parent_session_id,
        parent_trace_id,
        *,
        reason=None,
    ): ...

    async def resume(
        self,
        subagent_id,
        task,
        *,
        initiated_by=SubagentInitiator.USER,
    ): ...

    async def subscribe(self, run_id, listener): ...

    async def list_by_parent(self, parent_session_id): ...

    async def close(self, subagent_id): ...

    async def reconcile_interrupted_runs(self): ...

    async def shutdown(self): ...


def test_runtime_protocol_is_async_replaceable_and_wait_policy_free() -> None:
    fake = ContractFakeRuntime()
    assert isinstance(fake, SubagentRuntimeProtocol)
    for method_name in (
        "spawn",
        "get_run",
        "wait_terminal",
        "steer",
        "cancel",
        "cancel_by_parent_trace",
        "resume",
        "subscribe",
        "list_by_parent",
        "close",
        "reconcile_interrupted_runs",
        "shutdown",
    ):
        assert inspect.iscoroutinefunction(
            getattr(SessionBackedSubagentRuntime, method_name)
        )
    assert not hasattr(SessionBackedSubagentRuntime, "wait_policy")


def test_create_app_injects_session_backed_subagent_runtime(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    runtime = app.state.subagent_runtime
    assert isinstance(runtime, SessionBackedSubagentRuntime)
    assert isinstance(runtime, SubagentRuntimeProtocol)
    assert runtime.repositories is app.state.repositories
    assert runtime.chat_stream_manager is app.state.chat_stream_manager


def test_application_lifespan_shuts_down_subagent_runtime(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    calls: list[str] = []

    async def shutdown() -> None:
        calls.append("shutdown")

    app.state.subagent_runtime.shutdown = shutdown
    with TestClient(app) as client:
        assert client.get("/api/health").status_code == 200
    assert calls == ["shutdown"]
