import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend.app.api.thread_tasks import CreateThreadTaskRequest
from backend.app.core.config import AppSettings
from backend.app.main import create_app


def test_create_thread_task_request_only_accepts_goal_type() -> None:
    assert CreateThreadTaskRequest(type="goal", objective="完成目标").type == "goal"

    with pytest.raises(ValidationError):
        CreateThreadTaskRequest(type="research", objective="调研")


def test_thread_tasks_api_crud_and_runs(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    with TestClient(app) as client:
        session = client.post("/api/sessions", json={"title": "目标会话"}).json()["session"]
        session_id = session["id"]

        assert client.get(f"/api/sessions/{session_id}/tasks").json()["list"] == []

        invalid_type = client.post(
            f"/api/sessions/{session_id}/tasks",
            json={"type": "research", "objective": "调研"},
        )
        assert invalid_type.status_code == 422

        created = client.post(
            f"/api/sessions/{session_id}/tasks",
            json={
                "type": "goal",
                "title": "长程目标",
                "objective": " 完成 API 验收 ",
                "metadata": {"source": "menu"},
            },
        )
        task = created.json()["task"]
        assert created.status_code == 200
        assert task["type"] == "goal"
        assert task["type_label"] == "目标"
        assert task["objective"] == "完成 API 验收"
        assert task["metadata"] == {"source": "menu"}

        conflict = client.post(
            f"/api/sessions/{session_id}/tasks",
            json={"type": "goal", "objective": "第二个目标"},
        )
        assert conflict.status_code == 409
        assert conflict.json()["detail"]["code"] == "task_already_open"

        app.state.repositories.thread_task_runs.create_running(
            run_id="run-api",
            task_id=task["id"],
            session_id=session_id,
            summary={"reason": "test"},
        )
        runs = client.get(f"/api/sessions/{session_id}/tasks/{task['id']}/runs")
        assert runs.status_code == 200
        assert runs.json()["list"][0]["id"] == "run-api"

        paused = client.patch(
            f"/api/sessions/{session_id}/tasks/{task['id']}",
            json={"status": "paused"},
        )
        assert paused.status_code == 200
        assert paused.json()["task"]["status"] == "paused"

        continue_calls: list[dict[str, str]] = []

        async def fake_continue_if_idle(
            continued_session_id: str,
            *,
            reason: str = "auto_continue",
        ) -> dict[str, str]:
            continue_calls.append({"session_id": continued_session_id, "reason": reason})
            return {"status": "started"}

        app.state.thread_task_runtime.continue_if_idle = fake_continue_if_idle

        edited = client.patch(
            f"/api/sessions/{session_id}/tasks/{task['id']}",
            json={"status": "active", "objective": "更新后的 API 目标"},
        )
        assert edited.status_code == 200
        assert edited.json()["task"]["status"] == "active"
        assert edited.json()["task"]["objective"] == "更新后的 API 目标"
        assert continue_calls == [{"session_id": session_id, "reason": "user_resume"}]

        deleted = client.delete(f"/api/sessions/{session_id}/tasks/{task['id']}")
        assert deleted.status_code == 200
        assert deleted.json()["task"]["deleted_at"] is not None
        assert client.get(f"/api/sessions/{session_id}/tasks").json()["list"] == []
