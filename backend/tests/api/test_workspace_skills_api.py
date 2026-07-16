from pathlib import Path

from fastapi.testclient import TestClient

from backend.app.core.config import AppSettings
from backend.app.keydex import KeydexCapabilityRuntimeCache, KeydexRuntimeCache
from backend.app.keydex.capabilities.skills import SkillsCapability
from backend.app.keydex.registry import KeydexCapabilityRegistry
from backend.app.main import create_app


class RecordingRuntimeCache(KeydexRuntimeCache):
    def __init__(self, system_root: Path) -> None:
        super().__init__(system_root=system_root)
        self.force_reload_values: list[bool] = []

    def get_workspace_snapshot(self, workspace_root, *, force_reload: bool = False):
        self.force_reload_values.append(force_reload)
        return super().get_workspace_snapshot(workspace_root, force_reload=force_reload)


def _app(tmp_path, *, runtime_cache=None):
    app = create_app(
        AppSettings(data_dir=tmp_path / "data", workspace_root=tmp_path),
        keydex_system_root_for_testing=tmp_path / "system-keydex",
    )
    if runtime_cache is not None:
        app.state.keydex_runtime_cache = runtime_cache
    return app


def _create_workspace_session(client: TestClient, root: Path) -> dict:
    workspace = _create_workspace(client, root)
    return client.post(
        "/api/sessions",
        json={"session_type": "workspace", "workspace_id": workspace["id"]},
    ).json()["session"]


def _create_workspace(client: TestClient, root: Path) -> dict:
    return client.post(
        "/api/workspaces",
        json={"root_path": str(root), "name": root.name},
    ).json()["workspace"]


def _write_skill(skill_dir: Path, *, name: str, description: str = "Use this skill.") -> None:
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        f"""---
name: {name}
description: {description}
---

# {name}
""",
        encoding="utf-8",
    )


def test_workspace_skills_api_returns_snapshot_skills(tmp_path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    _write_skill(root / ".keydex" / "skills" / "dev-plan", name="dev-plan")

    with TestClient(_app(tmp_path)) as client:
        session = _create_workspace_session(client, root)
        response = client.get(f"/api/sessions/{session['id']}/skills")

    assert response.status_code == 200
    payload = response.json()
    assert payload["mode"] == "workspace_effective"
    assert payload["workspace_root"] == root.resolve().as_posix()
    assert len(payload["fingerprint"]) == 64
    assert payload["skills"][0] == (
        {
            "name": "dev-plan",
            "description": "Use this skill.",
            "source": "workspace",
            "label": "/dev-plan",
            "locator": ".keydex/skills/dev-plan/SKILL.md",
        }
    )
    assert [(item["name"], item["source"]) for item in payload["skills"]] == [
        ("dev-plan", "workspace"),
        ("keydex-guide", "builtin"),
    ]
    assert payload["diagnostics"] == []


def test_workspace_skills_api_returns_snapshot_skills_by_workspace_id(tmp_path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    _write_skill(root / ".keydex" / "skills" / "dev-plan", name="dev-plan")

    with TestClient(_app(tmp_path)) as client:
        workspace = _create_workspace(client, root)
        response = client.get(f"/api/workspaces/{workspace['id']}/skills")

    assert response.status_code == 200
    payload = response.json()
    assert payload["workspace_root"] == root.resolve().as_posix()
    assert payload["skills"][0]["name"] == "dev-plan"


def test_workspace_skills_api_passes_force_reload_to_cache(tmp_path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    cache = RecordingRuntimeCache(tmp_path / "system-keydex")

    with TestClient(_app(tmp_path, runtime_cache=cache)) as client:
        session = _create_workspace_session(client, root)
        response = client.get(
            f"/api/sessions/{session['id']}/skills",
            params={"force_reload": "true"},
        )

    assert response.status_code == 200
    assert cache.force_reload_values == [True]


def test_session_skills_api_returns_system_only_for_chat_session(tmp_path) -> None:
    with TestClient(_app(tmp_path)) as client:
        session = client.post("/api/sessions", json={"session_type": "chat"}).json()["session"]
        response = client.get(f"/api/sessions/{session['id']}/skills")

    assert response.status_code == 200
    assert response.json()["mode"] == "system_only"
    assert response.json()["workspace_root"] is None
    assert [(item["name"], item["source"]) for item in response.json()["skills"]] == [
        ("keydex-guide", "builtin")
    ]


def test_workspace_skills_api_returns_diagnostics(tmp_path) -> None:
    root = tmp_path / "workspace"
    skill_dir = root / ".keydex" / "skills" / "broken"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text("---\nname: broken\n---\n", encoding="utf-8")

    with TestClient(_app(tmp_path)) as client:
        session = _create_workspace_session(client, root)
        response = client.get(f"/api/sessions/{session['id']}/skills")

    assert response.status_code == 200
    payload = response.json()
    assert [(item["name"], item["source"]) for item in payload["skills"]] == [
        ("keydex-guide", "builtin")
    ]
    assert payload["diagnostics"][0]["code"] == "skill_frontmatter_missing_description"
    assert payload["diagnostics"][0]["path"] == ".keydex/skills/broken/SKILL.md"


def test_generic_runtime_preserves_list_and_resource_api_contracts(tmp_path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    skill_root = root / ".keydex" / "skills" / "typed-skill"
    _write_skill(skill_root, name="typed-skill")
    (skill_root / "guide.md").write_text("typed guide", encoding="utf-8")
    cache = KeydexCapabilityRuntimeCache(
        system_root=tmp_path / "generic-system",
        registry=KeydexCapabilityRegistry((SkillsCapability(),)),
    )

    with TestClient(_app(tmp_path, runtime_cache=cache)) as client:
        session = _create_workspace_session(client, root)
        listed = client.get(f"/api/sessions/{session['id']}/skills")
        resource = client.post(
            f"/api/sessions/{session['id']}/skills/read",
            json={
                "skill_name": "typed-skill",
                "source": "workspace",
                "resource_path": "guide.md",
            },
        )

    assert listed.status_code == 200
    payload = listed.json()
    assert set(payload) == {
        "mode",
        "workspace_root",
        "fingerprint",
        "loaded_at",
        "skills",
        "diagnostics",
    }
    typed = next(item for item in payload["skills"] if item["name"] == "typed-skill")
    assert typed == {
        "name": "typed-skill",
        "description": "Use this skill.",
        "source": "workspace",
        "label": "/typed-skill",
        "locator": ".keydex/skills/typed-skill/SKILL.md",
    }
    assert resource.status_code == 200
    resource_payload = resource.json()
    assert set(resource_payload) == {
        "skill_name",
        "source",
        "resource_path",
        "locator",
        "content",
        "encoding",
        "revision",
        "fingerprint",
    }
    assert resource_payload["content"] == "typed guide"
    assert resource_payload["fingerprint"] == payload["fingerprint"]
