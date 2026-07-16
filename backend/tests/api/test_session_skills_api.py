from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from backend.app.core.config import AppSettings
from backend.app.main import create_app


def test_t30_t31_system_bootstrap_and_chat_session_return_system_only(tmp_path: Path) -> None:
    system_root = tmp_path / "system"
    write_skill(system_root / "skills" / "global", "global")
    with TestClient(make_app(tmp_path, system_root)) as client:
        bootstrap = client.get("/api/keydex/skills")
        session = client.post("/api/sessions", json={}).json()["session"]
        session_response = client.get(f"/api/sessions/{session['id']}/skills")

    assert bootstrap.status_code == 200
    assert session_response.status_code == 200
    assert bootstrap.json() == session_response.json()
    payload = bootstrap.json()
    assert payload["mode"] == "system_only"
    assert payload["workspace_root"] is None
    assert [(item["name"], item["source"]) for item in payload["skills"]] == [
        ("global", "system"),
        ("keydex-guide", "builtin"),
    ]


def test_t58_t60_workspace_api_returns_effective_winners_and_inheritance(tmp_path: Path) -> None:
    system_root = tmp_path / "system"
    workspace_root = tmp_path / "workspace"
    write_skill(system_root / "skills" / "shared", "shared", body="system")
    write_skill(system_root / "skills" / "global", "global")
    write_skill(workspace_root / ".keydex" / "skills" / "shared", "shared", body="workspace")
    with TestClient(make_app(tmp_path, system_root)) as client:
        workspace = create_workspace(client, workspace_root)
        response = client.get(f"/api/workspaces/{workspace['id']}/skills")

    assert response.status_code == 200
    payload = response.json()
    assert payload["mode"] == "workspace_effective"
    assert [(item["name"], item["source"]) for item in payload["skills"]] == [
        ("global", "system"),
        ("keydex-guide", "builtin"),
        ("shared", "workspace"),
    ]


def test_removed_manifest_file_is_ignored_and_system_inheritance_is_fixed(
    tmp_path: Path,
) -> None:
    system_root = tmp_path / "system"
    workspace_root = tmp_path / "workspace"
    write_skill(system_root / "skills" / "global", "global")
    keydex_root = workspace_root / ".keydex"
    keydex_root.mkdir(parents=True)
    (keydex_root / "keydex.md").write_text("not-json", encoding="utf-8")
    with TestClient(make_app(tmp_path, system_root)) as client:
        workspace = create_workspace(client, workspace_root)
        response = client.get(f"/api/workspaces/{workspace['id']}/skills")

    payload = response.json()
    assert response.status_code == 200
    assert [(item["name"], item["source"]) for item in payload["skills"]] == [
        ("global", "system"),
        ("keydex-guide", "builtin"),
    ]
    assert payload["diagnostics"] == []


def test_t62_t63_session_scope_and_force_reload_are_stable(tmp_path: Path) -> None:
    system_root = tmp_path / "system"
    workspace_root = tmp_path / "workspace"
    write_skill(workspace_root / ".keydex" / "skills" / "local", "local", body="v1")
    with TestClient(make_app(tmp_path, system_root)) as client:
        workspace = create_workspace(client, workspace_root)
        session = client.post(
            "/api/sessions",
            json={"session_type": "workspace", "workspace_id": workspace["id"]},
        ).json()["session"]
        first = client.get(f"/api/sessions/{session['id']}/skills").json()
        entry = workspace_root / ".keydex" / "skills" / "local" / "SKILL.md"
        entry.write_text(skill_text("local", body="v2"), encoding="utf-8")
        second = client.get(
            f"/api/sessions/{session['id']}/skills", params={"force_reload": "true"}
        ).json()

    assert first["fingerprint"] != second["fingerprint"]
    local = next(item for item in second["skills"] if item["name"] == "local")
    assert local["source"] == "workspace"


def test_t85_t87_errors_and_payloads_do_not_leak_system_absolute_path(tmp_path: Path) -> None:
    system_root = tmp_path / "private-system"
    broken = system_root / "skills" / "broken"
    broken.mkdir(parents=True)
    (broken / "SKILL.md").write_text("---\nname: broken\n---\n", encoding="utf-8")
    with TestClient(make_app(tmp_path, system_root)) as client:
        missing = client.get("/api/sessions/missing/skills")
        payload = client.get("/api/keydex/skills").json()

    assert missing.status_code == 404
    assert missing.json()["detail"]["code"] == "session_not_found"
    assert str(system_root.resolve()) not in json.dumps(payload)
    assert payload["diagnostics"][0]["path"] == ".keydex/skills/broken/SKILL.md"


def test_t87_chat_and_two_workspaces_keep_same_name_winners_isolated(
    tmp_path: Path,
) -> None:
    system_root = tmp_path / "system"
    workspace_invalid = tmp_path / "workspace-invalid"
    workspace_override = tmp_path / "workspace-override"
    system_skill = system_root / "skills" / "shared"
    write_skill(system_skill, "shared", body="system body")
    (system_skill / "guide.md").write_text("system guide", encoding="utf-8")
    (workspace_invalid / ".keydex" / "skills" / "shared").mkdir(parents=True)
    workspace_skill = workspace_override / ".keydex" / "skills" / "shared"
    write_skill(workspace_skill, "shared", body="workspace body")
    (workspace_skill / "guide.md").write_text("workspace guide", encoding="utf-8")

    with TestClient(make_app(tmp_path, system_root)) as client:
        invalid_workspace = create_workspace(client, workspace_invalid)
        override_workspace = create_workspace(client, workspace_override)
        chat = client.post("/api/sessions", json={}).json()["session"]
        invalid_session = client.post(
            "/api/sessions",
            json={
                "session_type": "workspace",
                "workspace_id": invalid_workspace["id"],
            },
        ).json()["session"]
        override_session = client.post(
            "/api/sessions",
            json={
                "session_type": "workspace",
                "workspace_id": override_workspace["id"],
            },
        ).json()["session"]

        chat_list = client.get(f"/api/sessions/{chat['id']}/skills")
        invalid_list = client.get(f"/api/sessions/{invalid_session['id']}/skills")
        override_list = client.get(f"/api/sessions/{override_session['id']}/skills")
        chat_read = client.post(
            f"/api/sessions/{chat['id']}/skills/read",
            json={"skill_name": "shared", "source": "system", "resource_path": "guide.md"},
        )
        invalid_read = client.post(
            f"/api/sessions/{invalid_session['id']}/skills/read",
            json={"skill_name": "shared", "source": "system", "resource_path": "guide.md"},
        )
        override_read = client.post(
            f"/api/sessions/{override_session['id']}/skills/read",
            json={
                "skill_name": "shared",
                "source": "workspace",
                "resource_path": "guide.md",
            },
        )

    assert [(item["name"], item["source"]) for item in chat_list.json()["skills"]] == [
        ("keydex-guide", "builtin"),
        ("shared", "system"),
    ]
    assert [(item["name"], item["source"]) for item in invalid_list.json()["skills"]] == [
        ("keydex-guide", "builtin")
    ]
    assert invalid_list.json()["diagnostics"][-1]["code"] == "skill_shadow_barrier"
    assert [
        (item["name"], item["source"])
        for item in override_list.json()["skills"]
    ] == [("keydex-guide", "builtin"), ("shared", "workspace")]
    assert chat_read.json()["content"] == "system guide"
    assert invalid_read.status_code == 404
    assert invalid_read.json()["detail"]["code"] == "skill_not_found"
    assert override_read.json()["content"] == "workspace guide"
    assert len(
        {
            chat_list.json()["fingerprint"],
            invalid_list.json()["fingerprint"],
            override_list.json()["fingerprint"],
        }
    ) == 3


def test_t58_t59_openapi_exposes_all_generic_list_and_read_contracts(
    tmp_path: Path,
) -> None:
    with TestClient(make_app(tmp_path, tmp_path / "system")) as client:
        paths = client.get("/openapi.json").json()["paths"]

    assert {
        "/api/keydex/skills",
        "/api/keydex/skills/read",
        "/api/workspaces/{workspace_id}/skills",
        "/api/workspaces/{workspace_id}/skills/read",
        "/api/sessions/{session_id}/skills",
        "/api/sessions/{session_id}/skills/read",
    } <= set(paths)


def make_app(tmp_path: Path, system_root: Path):
    return create_app(
        AppSettings(data_dir=tmp_path / "data", workspace_root=tmp_path),
        keydex_system_root_for_testing=system_root,
    )


def create_workspace(client: TestClient, root: Path) -> dict:
    root.mkdir(parents=True, exist_ok=True)
    return client.post(
        "/api/workspaces", json={"root_path": str(root), "name": root.name}
    ).json()["workspace"]


def write_skill(root: Path, name: str, *, body: str = "body") -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "SKILL.md").write_text(skill_text(name, body=body), encoding="utf-8")


def skill_text(name: str, *, body: str) -> str:
    return f"---\nname: {name}\ndescription: {name} skill\n---\n\n{body}\n"
