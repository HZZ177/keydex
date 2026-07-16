from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from backend.app.core.config import AppSettings
from backend.app.keydex import KeydexCapabilityRuntimeCache
from backend.app.main import create_app


class RecordingCapabilityRuntimeCache(KeydexCapabilityRuntimeCache):
    def __init__(self, *, system_root: Path, builtin_root: Path) -> None:
        super().__init__(system_root=system_root, builtin_root=builtin_root)
        self.system_force_reloads: list[bool] = []
        self.workspace_force_reloads: list[bool] = []

    def get_system_snapshot(self, *, force_reload: bool = False):
        self.system_force_reloads.append(force_reload)
        return super().get_system_snapshot(force_reload=force_reload)

    def get_workspace_snapshot(self, workspace_root, *, force_reload: bool = False):
        self.workspace_force_reloads.append(force_reload)
        return super().get_workspace_snapshot(
            workspace_root,
            force_reload=force_reload,
        )


def _app(tmp_path: Path, cache: KeydexCapabilityRuntimeCache):
    app = create_app(
        AppSettings(data_dir=tmp_path / "data", workspace_root=tmp_path),
        keydex_system_root_for_testing=tmp_path / "system-keydex",
        keydex_builtin_root_for_testing=tmp_path / "builtin-keydex",
    )
    app.state.keydex_runtime_cache = cache
    return app


def _cache(tmp_path: Path) -> RecordingCapabilityRuntimeCache:
    builtin = tmp_path / "builtin-keydex"
    system = tmp_path / "system-keydex"
    builtin.mkdir(exist_ok=True)
    system.mkdir(exist_ok=True)
    return RecordingCapabilityRuntimeCache(system_root=system, builtin_root=builtin)


def _create_workspace(client: TestClient, root: Path) -> dict:
    return client.post(
        "/api/workspaces",
        json={"root_path": str(root), "name": root.name},
    ).json()["workspace"]


def _create_session(client: TestClient, *, workspace_id: str | None = None) -> dict:
    payload = (
        {"session_type": "workspace", "workspace_id": workspace_id}
        if workspace_id is not None
        else {"session_type": "chat"}
    )
    return client.post("/api/sessions", json=payload).json()["session"]


def test_km32_system_runtime_overview_has_counts_and_no_private_content(
    tmp_path: Path,
) -> None:
    cache = _cache(tmp_path)
    private_marker = "PRIVATE-SYSTEM-GUIDANCE"
    (cache.system_root / "keydex.md").write_text(private_marker, encoding="utf-8")
    skill = cache.system_root / "skills" / "review"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text(
        "---\nname: review\ndescription: Review.\n---\n\nPRIVATE-SKILL-BODY",
        encoding="utf-8",
    )

    with TestClient(_app(tmp_path, cache)) as client:
        response = client.get("/api/keydex/runtime")

    assert response.status_code == 200
    payload = response.json()
    assert payload["mode"] == "system_only"
    assert [layer["scope"] for layer in payload["layers"]] == ["builtin", "system"]
    assert payload["capabilities"]["skills"]["count"] == 1
    markdown = payload["capabilities"]["keydex_markdown"]
    assert markdown["document_count"] == 1
    assert markdown["total_bytes"] == len(private_marker.encode("utf-8"))
    assert markdown["sources"] == ["system:keydex.md"]
    serialized = json.dumps(payload, ensure_ascii=False)
    assert private_marker not in serialized
    assert "PRIVATE-SKILL-BODY" not in serialized
    assert str(cache.system_root) not in serialized
    assert "workspace_root" not in payload


def test_workspace_and_session_runtime_overview_use_bound_project(
    tmp_path: Path,
) -> None:
    cache = _cache(tmp_path)
    (cache.system_root / "keydex.md").write_text("SYSTEM", encoding="utf-8")
    project = tmp_path / "project-a"
    keydex = project / ".keydex"
    keydex.mkdir(parents=True)
    (keydex / "keydex.md").write_text("WORKSPACE-A", encoding="utf-8")
    other = tmp_path / "project-b" / ".keydex"
    other.mkdir(parents=True)
    (other / "keydex.md").write_text("WORKSPACE-B-SECRET", encoding="utf-8")

    with TestClient(_app(tmp_path, cache)) as client:
        workspace = _create_workspace(client, project)
        session = _create_session(client, workspace_id=workspace["id"])
        workspace_response = client.get(
            f"/api/workspaces/{workspace['id']}/keydex/runtime"
        )
        session_response = client.get(
            f"/api/sessions/{session['id']}/keydex/runtime"
        )

    assert workspace_response.status_code == 200
    assert session_response.status_code == 200
    workspace_payload = workspace_response.json()
    session_payload = session_response.json()
    assert workspace_payload["mode"] == "workspace_effective"
    assert workspace_payload["fingerprint"] == session_payload["fingerprint"]
    assert [layer["scope"] for layer in workspace_payload["layers"]] == [
        "builtin",
        "system",
        "workspace",
    ]
    markdown = workspace_payload["capabilities"]["keydex_markdown"]
    assert markdown["document_count"] == 2
    assert markdown["sources"] == [
        "system:keydex.md",
        "workspace:.keydex/keydex.md",
    ]
    serialized = json.dumps(workspace_payload, ensure_ascii=False)
    assert "SYSTEM" not in serialized
    assert "WORKSPACE-A" not in serialized
    assert "WORKSPACE-B-SECRET" not in serialized
    assert str(project) not in serialized


def test_invalid_system_markdown_keeps_workspace_status_and_safe_diagnostic(
    tmp_path: Path,
) -> None:
    cache = _cache(tmp_path)
    (cache.system_root / "keydex.md").write_bytes(b"\xff\xfe")
    project = tmp_path / "project"
    keydex = project / ".keydex"
    keydex.mkdir(parents=True)
    (keydex / "keydex.md").write_text("VALID-WORKSPACE", encoding="utf-8")

    with TestClient(_app(tmp_path, cache)) as client:
        workspace = _create_workspace(client, project)
        response = client.get(
            f"/api/workspaces/{workspace['id']}/keydex/runtime"
        )

    assert response.status_code == 200
    payload = response.json()
    markdown = payload["capabilities"]["keydex_markdown"]
    assert markdown["available"] is True
    assert markdown["document_count"] == 1
    assert markdown["sources"] == ["workspace:.keydex/keydex.md"]
    assert markdown["diagnostics"][0] == {
        "code": "keydex_markdown_not_text",
        "reason": "keydex.md must be valid UTF-8 text.",
        "severity": "error",
        "details": {},
        "capability_id": "keydex_markdown",
        "scope": "system",
        "logical_path": "system:keydex.md",
    }
    assert "VALID-WORKSPACE" not in json.dumps(payload, ensure_ascii=False)


def test_runtime_overview_force_reload_and_chat_session_scope(tmp_path: Path) -> None:
    cache = _cache(tmp_path)
    with TestClient(_app(tmp_path, cache)) as client:
        session = _create_session(client)
        system = client.get("/api/keydex/runtime?force_reload=true")
        chat = client.get(
            f"/api/sessions/{session['id']}/keydex/runtime?force_reload=true"
        )

    assert system.status_code == 200 and chat.status_code == 200
    assert system.json()["mode"] == "system_only"
    assert chat.json()["mode"] == "system_only"
    assert cache.system_force_reloads == [True, True]


def test_runtime_overview_missing_scope_and_openapi_contract(tmp_path: Path) -> None:
    cache = _cache(tmp_path)
    with TestClient(_app(tmp_path, cache)) as client:
        missing_session = client.get("/api/sessions/missing/keydex/runtime")
        missing_workspace = client.get("/api/workspaces/missing/keydex/runtime")
        schema = client.get("/openapi.json").json()

    assert missing_session.status_code == 404
    assert missing_workspace.status_code == 404
    paths = schema["paths"]
    assert "/api/keydex/runtime" in paths
    assert "/api/workspaces/{workspace_id}/keydex/runtime" in paths
    assert "/api/sessions/{session_id}/keydex/runtime" in paths
