from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from backend.app.core.config import AppSettings
from backend.app.main import create_app


class FakeFileChangeHub:
    def __init__(self) -> None:
        self.workspace_binds: list[tuple[str, Path, Any]] = []
        self.workspace_unbinds: list[tuple[str, Any]] = []
        self.local_binds: list[tuple[str, Path, Any]] = []
        self.local_unbinds: list[tuple[str, Any]] = []
        self.unsubscribe_all_calls: list[Any] = []
        self.closed = 0

    async def subscribe_workspace(self, workspace_id, workspace_root, subscriber) -> int:
        self.workspace_binds.append((workspace_id, Path(workspace_root).resolve(), subscriber))
        return 7

    async def unsubscribe_workspace(self, workspace_id, subscriber) -> None:
        self.workspace_unbinds.append((workspace_id, subscriber))

    async def subscribe_local_file(self, watch_id, path, subscriber):
        target = Path(path).resolve()
        self.local_binds.append((watch_id, target, subscriber))
        return target, 3

    async def unsubscribe_local_file(self, watch_id, subscriber) -> None:
        self.local_unbinds.append((watch_id, subscriber))

    async def unsubscribe_all(self, subscriber) -> None:
        self.unsubscribe_all_calls.append(subscriber)

    async def close(self) -> None:
        self.closed += 1


def _client(tmp_path: Path) -> tuple[TestClient, FakeFileChangeHub]:
    app = create_app(
        AppSettings(data_dir=tmp_path / "data", workspace_root=tmp_path),
        keydex_system_root_for_testing=tmp_path / "system-keydex",
    )
    hub = FakeFileChangeHub()
    app.state.file_change_hub = hub
    return TestClient(app), hub


def _workspace(client: TestClient, root: Path) -> dict[str, Any]:
    root.mkdir(parents=True, exist_ok=True)
    response = client.post(
        "/api/workspaces",
        json={"root_path": str(root), "name": "E2E Watch Workspace"},
    )
    assert response.status_code == 200
    return response.json()["workspace"]


def test_websocket_binds_workspace_watch_and_acknowledges(tmp_path: Path) -> None:
    client, hub = _client(tmp_path)
    workspace = _workspace(client, tmp_path / "workspace")

    with client.websocket_connect("/agent-base/ws/chat") as ws:
        ws.send_json(
            {"action": "bind_workspace_watch", "workspace_id": workspace["id"]}
        )
        response = ws.receive_json()

    assert response == {
        "action": "workspaceWatchBound",
        "data": {
            "workspace_id": workspace["id"],
            "sequence": 7,
            "resync_required": True,
        },
    }
    assert hub.workspace_binds[0][:2] == (
        workspace["id"],
        (tmp_path / "workspace").resolve(),
    )


@pytest.mark.parametrize("workspace_id", ["", "missing-workspace"])
def test_websocket_rejects_unknown_workspace_watch(
    tmp_path: Path,
    workspace_id: str,
) -> None:
    client, hub = _client(tmp_path)

    with client.websocket_connect("/agent-base/ws/chat") as ws:
        ws.send_json(
            {"action": "bind_workspace_watch", "workspace_id": workspace_id}
        )
        response = ws.receive_json()

    assert response["action"] == "error"
    assert response["data"]["error"]["code"] in {
        "missing_workspace",
        "workspace_not_found",
    }
    assert hub.workspace_binds == []


def test_websocket_unbinds_workspace_watch(tmp_path: Path) -> None:
    client, hub = _client(tmp_path)
    workspace = _workspace(client, tmp_path / "workspace")

    with client.websocket_connect("/agent-base/ws/chat") as ws:
        ws.send_json(
            {"action": "bind_workspace_watch", "workspace_id": workspace["id"]}
        )
        ws.receive_json()
        ws.send_json(
            {"action": "unbind_workspace_watch", "workspace_id": workspace["id"]}
        )
        response = ws.receive_json()

    assert response == {
        "action": "workspaceWatchUnbound",
        "data": {"workspace_id": workspace["id"]},
    }
    assert hub.workspace_unbinds[0][0] == workspace["id"]


def test_websocket_disconnect_releases_all_file_watches(tmp_path: Path) -> None:
    client, hub = _client(tmp_path)
    workspace = _workspace(client, tmp_path / "workspace")
    local_file = tmp_path / "local.md"
    local_file.write_text("local", encoding="utf-8")

    with client.websocket_connect("/agent-base/ws/chat") as ws:
        ws.send_json(
            {"action": "bind_workspace_watch", "workspace_id": workspace["id"]}
        )
        ws.receive_json()
        ws.send_json(
            {
                "action": "bind_local_file_watch",
                "watch_id": "watch-1",
                "path": str(local_file),
            }
        )
        ws.receive_json()

    assert len(hub.unsubscribe_all_calls) == 1


def test_websocket_keeps_session_stream_and_workspace_watch_on_same_connection(
    tmp_path: Path,
) -> None:
    client, hub = _client(tmp_path)
    workspace = _workspace(client, tmp_path / "workspace")

    with client.websocket_connect("/agent-base/ws/chat") as ws:
        ws.send_json(
            {
                "action": "create_session",
                "session_type": "workspace",
                "workspace_id": workspace["id"],
            }
        )
        created = ws.receive_json()
        ws.send_json(
            {"action": "bind_workspace_watch", "workspace_id": workspace["id"]}
        )
        bound = ws.receive_json()
        ws.send_json({"action": "ping"})
        pong = ws.receive_json()

    assert created["action"] == "session_created"
    assert bound["action"] == "workspaceWatchBound"
    assert pong["action"] == "pong"
    assert len(hub.workspace_binds) == 1


def test_websocket_binds_local_file_watch_and_acknowledges(tmp_path: Path) -> None:
    client, hub = _client(tmp_path)
    target = tmp_path / "local.md"
    target.write_text("local", encoding="utf-8")

    with client.websocket_connect("/agent-base/ws/chat") as ws:
        ws.send_json(
            {
                "action": "bind_local_file_watch",
                "watch_id": "watch-1",
                "path": str(target),
            }
        )
        response = ws.receive_json()

    assert response == {
        "action": "localFileWatchBound",
        "data": {
            "watch_id": "watch-1",
            "path": str(target.resolve()),
            "sequence": 3,
            "resync_required": True,
        },
    }
    assert hub.local_binds[0][:2] == ("watch-1", target.resolve())


@pytest.mark.parametrize("path_kind", ["empty", "relative", "directory", "missing"])
def test_websocket_rejects_invalid_local_file_watch_path(
    tmp_path: Path,
    path_kind: str,
) -> None:
    client, hub = _client(tmp_path)
    raw_path = {
        "empty": "",
        "relative": "relative.md",
        "directory": str(tmp_path),
        "missing": str(tmp_path / "missing.md"),
    }[path_kind]

    with client.websocket_connect("/agent-base/ws/chat") as ws:
        ws.send_json(
            {
                "action": "bind_local_file_watch",
                "watch_id": "watch-1",
                "path": raw_path,
            }
        )
        response = ws.receive_json()

    assert response["action"] == "error"
    assert response["data"]["error"]["code"] == "invalid_local_file_watch"
    assert hub.local_binds == []


def test_websocket_unbinds_local_file_watch(tmp_path: Path) -> None:
    client, hub = _client(tmp_path)
    target = tmp_path / "local.md"
    target.write_text("local", encoding="utf-8")

    with client.websocket_connect("/agent-base/ws/chat") as ws:
        ws.send_json(
            {
                "action": "bind_local_file_watch",
                "watch_id": "watch-1",
                "path": str(target),
            }
        )
        ws.receive_json()
        ws.send_json(
            {"action": "unbind_local_file_watch", "watch_id": "watch-1"}
        )
        response = ws.receive_json()

    assert response == {
        "action": "localFileWatchUnbound",
        "data": {"watch_id": "watch-1"},
    }
    assert hub.local_unbinds[0][0] == "watch-1"


def test_file_watch_events_are_not_persisted_to_chat_history(tmp_path: Path) -> None:
    client, _hub = _client(tmp_path)
    workspace = _workspace(client, tmp_path / "workspace")

    def fail_if_persisted(*_args, **_kwargs):
        raise AssertionError("file watch control/events must not be persisted")

    client.app.state.repositories.message_events.append = fail_if_persisted

    with client.websocket_connect("/agent-base/ws/chat") as ws:
        ws.send_json(
            {"action": "bind_workspace_watch", "workspace_id": workspace["id"]}
        )
        assert ws.receive_json()["action"] == "workspaceWatchBound"
        ws.send_json(
            {"action": "unbind_workspace_watch", "workspace_id": workspace["id"]}
        )
        assert ws.receive_json()["action"] == "workspaceWatchUnbound"
