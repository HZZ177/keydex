from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from backend.app.core.config import AppSettings
from backend.app.keydex.skills import KEYDEX_SKILL_MAX_RESOURCE_BYTES
from backend.app.main import create_app


def test_t12_t32_system_and_chat_read_current_system_winner(tmp_path: Path) -> None:
    system_root = tmp_path / "system"
    skill_root = write_skill(system_root / "skills" / "global", "global")
    (skill_root / "references").mkdir()
    (skill_root / "references" / "guide.md").write_text("system guide", encoding="utf-8")
    with TestClient(make_app(tmp_path, system_root)) as client:
        request = read_request("global", "system", "references/guide.md")
        bootstrap = client.post("/api/keydex/skills/read", json=request)
        session = client.post("/api/sessions", json={}).json()["session"]
        session_read = client.post(
            f"/api/sessions/{session['id']}/skills/read", json=request
        )

    assert bootstrap.status_code == 200
    assert bootstrap.json() == session_read.json()
    payload = bootstrap.json()
    assert payload["content"] == "system guide"
    assert payload["encoding"] == "utf-8"
    assert payload["locator"].endswith("references/guide.md")
    assert len(payload["revision"]) == 64
    assert str(system_root.resolve()) not in json.dumps(payload)


def test_builtin_guide_resource_is_readable_from_chat_scope(tmp_path: Path) -> None:
    with TestClient(make_app(tmp_path, tmp_path / "missing-system")) as client:
        listed = client.get("/api/keydex/skills")
        response = client.post(
            "/api/keydex/skills/read",
            json=read_request(
                "keydex-guide",
                "builtin",
                "references/keydex-scope-priority-and-config.md",
            ),
        )

    assert listed.status_code == 200
    assert [(item["name"], item["source"]) for item in listed.json()["skills"]] == [
        ("keydex-guide", "builtin")
    ]
    assert response.status_code == 200
    assert response.json()["source"] == "builtin"
    assert response.json()["locator"] == (
        "builtin/skills/keydex-guide/references/keydex-scope-priority-and-config.md"
    )
    assert "# 内置、系统级、项目级 Skill" in response.json()["content"]
    assert "项目级：`<项目目录>\\.keydex\\skills`" in response.json()["content"]


def test_system_override_rejects_stale_builtin_resource_source(tmp_path: Path) -> None:
    system_root = tmp_path / "system"
    write_skill(system_root / "skills" / "keydex-guide", "keydex-guide")
    with TestClient(make_app(tmp_path, system_root)) as client:
        response = client.post(
            "/api/keydex/skills/read",
            json=read_request("keydex-guide", "builtin", "SKILL.md"),
        )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "skill_source_stale"


def test_t75_workspace_read_uses_effective_winner_and_rejects_stale_source(
    tmp_path: Path,
) -> None:
    system_root = tmp_path / "system"
    workspace_root = tmp_path / "workspace"
    system_skill = write_skill(system_root / "skills" / "shared", "shared")
    (system_skill / "guide.md").write_text("system", encoding="utf-8")
    workspace_skill = write_skill(
        workspace_root / ".keydex" / "skills" / "shared", "shared"
    )
    (workspace_skill / "guide.md").write_text("workspace", encoding="utf-8")
    with TestClient(make_app(tmp_path, system_root)) as client:
        workspace = create_workspace(client, workspace_root)
        good = client.post(
            f"/api/workspaces/{workspace['id']}/skills/read",
            json=read_request("shared", "workspace", "guide.md"),
        )
        stale = client.post(
            f"/api/workspaces/{workspace['id']}/skills/read",
            json=read_request("shared", "system", "guide.md"),
        )

    assert good.json()["content"] == "workspace"
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "skill_source_stale"


def test_t76_t77_rejects_cross_skill_parent_and_absolute_paths(tmp_path: Path) -> None:
    system_root = tmp_path / "system"
    write_skill(system_root / "skills" / "one", "one")
    other = write_skill(system_root / "skills" / "other", "other")
    secret = other / "secret.md"
    secret.write_text("secret", encoding="utf-8")
    with TestClient(make_app(tmp_path, system_root)) as client:
        cross = client.post(
            "/api/keydex/skills/read",
            json=read_request("one", "system", "../other/secret.md"),
        )
        absolute = client.post(
            "/api/keydex/skills/read",
            json=read_request("one", "system", str(secret.resolve())),
        )

    assert cross.status_code == 400
    assert cross.json()["detail"]["code"] == "skill_resource_forbidden"
    assert absolute.status_code == 400
    assert absolute.json()["detail"]["code"] == "skill_resource_forbidden"


def test_t78_rejects_link_like_resource_component(monkeypatch, tmp_path: Path) -> None:
    from backend.app.keydex.skills import security

    system_root = tmp_path / "system"
    skill = write_skill(system_root / "skills" / "one", "one")
    resource = skill / "linked" / "guide.md"
    resource.parent.mkdir()
    resource.write_text("guide", encoding="utf-8")
    original = security._is_link_like
    monkeypatch.setattr(
        security,
        "_is_link_like",
        lambda path: path == resource.parent or original(path),
    )
    with TestClient(make_app(tmp_path, system_root)) as client:
        response = client.post(
            "/api/keydex/skills/read",
            json=read_request("one", "system", "linked/guide.md"),
        )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "skill_resource_forbidden"


def test_t79_t84_rejects_directory_missing_binary_and_oversized_content(tmp_path: Path) -> None:
    system_root = tmp_path / "system"
    skill = write_skill(system_root / "skills" / "one", "one")
    (skill / "directory").mkdir()
    (skill / "binary.bin").write_bytes(b"text\0binary")
    (skill / "large.txt").write_bytes(b"x" * (KEYDEX_SKILL_MAX_RESOURCE_BYTES + 1))
    with TestClient(make_app(tmp_path, system_root)) as client:
        responses = {
            path: client.post(
                "/api/keydex/skills/read",
                json=read_request("one", "system", path),
            )
            for path in ("directory", "missing.md", "binary.bin", "large.txt")
        }

    expected = {
        "directory": (400, "skill_resource_not_file"),
        "missing.md": (404, "skill_resource_not_found"),
        "binary.bin": (400, "skill_resource_not_text"),
        "large.txt": (400, "skill_resource_too_large"),
    }
    for path, response in responses.items():
        assert response.status_code == expected[path][0]
        assert response.json()["detail"]["code"] == expected[path][1]


def test_t82_scripts_are_read_only_and_never_executed(tmp_path: Path) -> None:
    system_root = tmp_path / "system"
    marker = tmp_path / "marker"
    skill = write_skill(system_root / "skills" / "one", "one")
    script = skill / "scripts" / "run.py"
    script.parent.mkdir()
    script.write_text(
        f"from pathlib import Path\nPath({str(marker)!r}).write_text('ran')\n",
        encoding="utf-8",
    )
    with TestClient(make_app(tmp_path, system_root)) as client:
        response = client.post(
            "/api/keydex/skills/read",
            json=read_request("one", "system", "scripts/run.py"),
        )

    assert response.status_code == 200
    assert "Path" in response.json()["content"]
    assert not marker.exists()


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


def write_skill(root: Path, name: str) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {name} skill\n---\n\nbody\n",
        encoding="utf-8",
    )
    return root


def read_request(name: str, source: str, resource_path: str) -> dict:
    return {"skill_name": name, "source": source, "resource_path": resource_path}
