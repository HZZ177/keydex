from __future__ import annotations

import subprocess
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app.api.git import router
from backend.app.git.access import GitAncestorGrantStore
from backend.app.git.models import GitDiscoveryRequest, GitRepositoryRequest
from backend.app.git.query_service import GitQueryService
from backend.app.git.runner import GitCommandResult
from backend.tests.git.conftest import GitRepoFactory


def _has_lfs() -> bool:
    return (
        subprocess.run(["git", "lfs", "version"], capture_output=True, check=False).returncode == 0
    )


@pytest.mark.skipif(not _has_lfs(), reason="git-lfs is not installed")
def test_lfs_status_patterns_and_offline_fetch_pull_push(tmp_path: Path) -> None:
    factory = GitRepoFactory(tmp_path)
    remote = factory.create_bare("lfs-remote")
    repo = factory.create("lfs-parent")
    repo.run("lfs", "install", "--local")
    repo.run("lfs", "track", "*.bin")
    repo.write("asset.bin", "large binary fixture\n")
    repo.commit("add lfs asset", ".gitattributes", "asset.bin")
    repo.run("remote", "add", "origin", str(remote))
    repo.run("push", "--set-upstream", "origin", "main")

    with _client(tmp_path / "lfs-data") as client:
        repository_id, scope = _discover(client, repo)
        state = _state(client, repository_id, scope)
        assert state["available"] is True
        assert state["tracked_patterns"] == ["*.bin"]
        assert state["files"][0]["path"] == "asset.bin"
        assert state["files"][0]["status"] == "tracked"
        assert state["locks_available"] is True

        for action, refspec in (("fetch", "main"), ("pull", None), ("push", "main")):
            payload = {
                **scope,
                "repository_id": repository_id,
                "idempotency_key": f"lfs-{action}-key",
                "action": action,
                "remote": "origin",
                "refspec": refspec,
            }
            result = _action(client, repository_id, payload)
            assert result["state"] == "succeeded", result


@pytest.mark.asyncio
async def test_lfs_unavailable_is_a_stable_disabled_snapshot(tmp_path: Path) -> None:
    repo = GitRepoFactory(tmp_path).create("no-lfs")
    (repo.path / ".gitattributes").write_text(
        "*.zip filter=lfs diff=lfs merge=lfs -text\n", encoding="utf-8"
    )
    service = GitQueryService(
        grants=GitAncestorGrantStore(tmp_path / "grants.json"),
        runner=_UnavailableLfsRunner(),
    )
    discovery = service.discover(
        GitDiscoveryRequest(workspace_id="workspace-lfs", project_root=str(repo.path))
    )
    state = await service.lfs(
        GitRepositoryRequest(
            workspace_id="workspace-lfs",
            project_root=str(repo.path),
            repository_id=discovery.repositories[0].id,
        )
    )
    assert state.available is False
    assert state.tracked_patterns == ["*.zip"]
    assert "not installed" in (state.reason or "")


class _UnavailableLfsRunner:
    async def run(self, args, *, cwd, **_kwargs) -> GitCommandResult:
        return GitCommandResult(
            argv=("git", *args),
            cwd=Path(cwd),
            returncode=1,
            stdout="",
            stderr="git: 'lfs' is not a git command",
            duration_ms=1,
        )


def _client(data_dir: Path) -> TestClient:
    app = FastAPI()
    app.state.settings = SimpleNamespace(data_dir=data_dir)
    app.include_router(router)
    return TestClient(app)


def _discover(client: TestClient, repo) -> tuple[str, dict[str, str]]:
    scope = {"workspace_id": "workspace-lfs", "project_root": str(repo.path)}
    response = client.post("/api/git/repositories/discover", json=scope)
    assert response.status_code == 200, response.text
    return response.json()["repositories"][0]["id"], scope


def _state(client: TestClient, repository_id: str, scope: dict[str, str]) -> dict:
    response = client.get(f"/api/git/repositories/{repository_id}/lfs", params=scope)
    assert response.status_code == 200, response.text
    return response.json()


def _action(client: TestClient, repository_id: str, payload: dict) -> dict:
    response = client.post(f"/api/git/repositories/{repository_id}/lfs/action", json=payload)
    assert response.status_code == 200, response.text
    operation_id = response.json()["operation_id"]
    for _ in range(1200):
        result = client.get(f"/api/git/operations/{operation_id}").json()
        if result["state"] in {"succeeded", "failed", "cancelled"}:
            return result
        time.sleep(0.01)
    raise AssertionError("Git LFS action did not finish")
