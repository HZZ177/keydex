from __future__ import annotations

import asyncio
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app.api.git import discover_repositories, router
from backend.app.git.access import GitAncestorGrantStore
from backend.app.git.models import GitCapabilityResponse, GitDiscoveryRequest, GitDiscoveryResponse
from backend.app.git.query_service import GitQueryService
from backend.tests.git.conftest import GitRepoFactory


def client_for(tmp_path: Path) -> TestClient:
    app = FastAPI()
    app.state.settings = SimpleNamespace(data_dir=tmp_path)
    app.state.git_query_service = GitQueryService(
        grants=GitAncestorGrantStore(tmp_path / "grants.json")
    )
    app.include_router(router)
    return TestClient(app)


@pytest.mark.asyncio
async def test_git_discovery_does_not_block_the_api_event_loop(tmp_path: Path) -> None:
    response = GitDiscoveryResponse(capability=GitCapabilityResponse(available=False))

    class SlowDiscoveryService:
        def discover(self, _payload: GitDiscoveryRequest) -> GitDiscoveryResponse:
            time.sleep(0.5)
            return response

    async def event_loop_pulse() -> float:
        started = time.monotonic()
        await asyncio.sleep(0.01)
        return time.monotonic() - started

    pulse_task = asyncio.create_task(event_loop_pulse())
    discovery_task = asyncio.create_task(
        discover_repositories(
            GitDiscoveryRequest(workspace_id="workspace-api", project_root=str(tmp_path)),
            SlowDiscoveryService(),  # type: ignore[arg-type]
        )
    )
    pulse_latency, discovery = await asyncio.gather(pulse_task, discovery_task)

    assert pulse_latency < 0.25
    assert discovery is response


def test_git_read_api_exposes_discovery_and_all_query_routes(tmp_path: Path) -> None:
    repo = GitRepoFactory(tmp_path).create("api-read")
    repo.write("README.md", "# api changed\n")
    client = client_for(tmp_path)
    discovery = client.post(
        "/api/git/repositories/discover",
        json={"workspace_id": "workspace-api", "project_root": str(repo.path)},
    )
    assert discovery.status_code == 200
    repository_id = discovery.json()["repositories"][0]["id"]
    params = {"workspace_id": "workspace-api", "project_root": str(repo.path)}

    status = client.get(f"/api/git/repositories/{repository_id}/status", params=params)
    refs = client.get(f"/api/git/repositories/{repository_id}/refs", params=params)
    history = client.get(
        f"/api/git/repositories/{repository_id}/history",
        params={**params, "limit": 1},
    )
    commit = client.get(
        f"/api/git/repositories/{repository_id}/commits/HEAD",
        params=params,
    )
    diff = client.get(f"/api/git/repositories/{repository_id}/diff", params=params)
    compare = client.get(
        f"/api/git/repositories/{repository_id}/compare",
        params={**params, "mode": "working_tree", "left": "HEAD"},
    )
    blame = client.get(
        f"/api/git/repositories/{repository_id}/blame",
        params={**params, "path": "README.md"},
    )
    reflog = client.get(f"/api/git/repositories/{repository_id}/reflog", params=params)

    assert status.status_code == refs.status_code == history.status_code == 200
    assert commit.status_code == diff.status_code == compare.status_code == 200
    assert blame.status_code == reflog.status_code == 200
    assert status.json()["files"][0]["path"] == "README.md"
    assert refs.json()["refs"][0]["kind"] == "local"
    assert history.json()["commits"][0]["object_id"] == commit.json()["commit"]["object_id"]
    assert commit.json()["files"][0]["new_path"] == "README.md"
    assert diff.json()["files"][0]["new_path"] == "README.md"
    assert compare.json()["right_label"] == "Working tree"
    assert blame.json()["lines"][0]["filename"] == "README.md"
    assert reflog.json()["entries"]


def test_git_read_api_maps_scope_and_validation_errors(tmp_path: Path) -> None:
    repo = GitRepoFactory(tmp_path).create("api-errors")
    client = client_for(tmp_path)
    discovery = client.post(
        "/api/git/repositories/discover",
        json={"workspace_id": "workspace-api", "project_root": str(repo.path)},
    ).json()
    repository_id = discovery["repositories"][0]["id"]

    wrong_scope = client.get(
        f"/api/git/repositories/{repository_id}/status",
        params={"workspace_id": "workspace-api", "project_root": str(tmp_path)},
    )
    invalid_limit = client.get(
        f"/api/git/repositories/{repository_id}/history",
        params={"workspace_id": "workspace-api", "project_root": str(repo.path), "limit": 0},
    )

    assert wrong_scope.status_code in {403, 404}
    assert wrong_scope.json()["detail"]["code"].startswith("git_")
    assert invalid_limit.status_code == 422


def test_git_worktree_path_filter_hides_ignored_paths_from_refreshes(tmp_path: Path) -> None:
    repo = GitRepoFactory(tmp_path).create("api-worktree-paths")
    repo.write(".gitignore", "*.log\n")
    repo.run("add", "--", ".gitignore")
    repo.run("commit", "-m", "add ignore rule")
    repo.write("ignored.log", "ignored\n")
    client = client_for(tmp_path)
    repository_id = client.post(
        "/api/git/repositories/discover",
        json={"workspace_id": "workspace-api", "project_root": str(repo.path)},
    ).json()["repositories"][0]["id"]

    response = client.post(
        f"/api/git/repositories/{repository_id}/worktree-paths",
        json={
            "workspace_id": "workspace-api",
            "project_root": str(repo.path),
            "repository_id": repository_id,
            "paths": ["README.md", "ignored.log"],
        },
    )

    assert response.status_code == 200
    assert response.json() == {"repository_id": repository_id, "paths": ["README.md"]}


def test_git_status_returns_a_diagnostic_error_for_a_damaged_head(tmp_path: Path) -> None:
    repo = GitRepoFactory(tmp_path).create("api-damaged-head")
    client = client_for(tmp_path)
    discovery = client.post(
        "/api/git/repositories/discover",
        json={"workspace_id": "workspace-api", "project_root": str(repo.path)},
    ).json()
    repository_id = discovery["repositories"][0]["id"]
    (repo.path / ".git" / "HEAD").write_text("ref: refs/heads/\n", encoding="utf-8")

    response = client.get(
        f"/api/git/repositories/{repository_id}/status",
        params={"workspace_id": "workspace-api", "project_root": str(repo.path)},
    )

    assert response.status_code == 500
    assert response.json()["detail"]["code"] in {"git_failed", "git_parse_failed"}
    assert "HEAD" in response.json()["detail"]["message"]


def test_stash_api_pages_entries_and_guards_selector_identity(tmp_path: Path) -> None:
    repo = GitRepoFactory(tmp_path).create("api-stash")
    repo.write("staged.txt", "staged stash\n")
    repo.run("add", "--", "staged.txt")
    repo.write("untracked.txt", "untracked stash\n")
    repo.run("stash", "push", "--include-untracked", "--message", "first stash")
    repo.write("README.md", "second stash\n")
    repo.run("stash", "push", "--message", "second stash")

    client = client_for(tmp_path)
    repository_id = client.post(
        "/api/git/repositories/discover",
        json={"workspace_id": "workspace-stash", "project_root": str(repo.path)},
    ).json()["repositories"][0]["id"]
    scope = {"workspace_id": "workspace-stash", "project_root": str(repo.path)}
    first_page = client.get(
        f"/api/git/repositories/{repository_id}/stash",
        params={**scope, "limit": 1},
    )
    assert first_page.status_code == 200
    first_entry = first_page.json()["entries"][0]
    assert first_entry["selector"] == "stash@{0}"
    assert first_entry["message"].endswith("second stash")
    assert first_entry["base_object_id"]
    assert first_page.json()["next_cursor"]

    second_page = client.get(
        f"/api/git/repositories/{repository_id}/stash",
        params={
            **scope,
            "limit": 1,
            "cursor": first_page.json()["next_cursor"],
        },
    )
    assert second_page.json()["entries"][0]["selector"] == "stash@{1}"

    detail = client.get(
        f"/api/git/repositories/{repository_id}/stash-detail",
        params={
            **scope,
            "selector": first_entry["selector"],
            "object_id": first_entry["object_id"],
        },
    )
    assert detail.status_code == 200
    assert detail.json()["entry"]["object_id"] == first_entry["object_id"]
    assert detail.json()["files"][0]["new_path"] == "README.md"
    assert detail.json()["files"][0]["raw_patch"]

    repo.write("newer.txt", "newer stash\n")
    repo.run("stash", "push", "--include-untracked", "--message", "newer stash")
    stale = client.get(
        f"/api/git/repositories/{repository_id}/stash-detail",
        params={
            **scope,
            "selector": first_entry["selector"],
            "object_id": first_entry["object_id"],
        },
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "git_operation_conflict"


def test_history_cursor_pages_without_duplicates_and_rejects_stale_version(tmp_path: Path) -> None:
    repo = GitRepoFactory(tmp_path).create("api-history-pages")
    for index in range(4):
        repo.write(f"history-{index}.txt", f"{index}\n")
        repo.commit(f"history {index}", f"history-{index}.txt")
    client = client_for(tmp_path)
    repository_id = client.post(
        "/api/git/repositories/discover",
        json={"workspace_id": "workspace-history", "project_root": str(repo.path)},
    ).json()["repositories"][0]["id"]
    scope = {"workspace_id": "workspace-history", "project_root": str(repo.path), "limit": 2}
    first = client.get(f"/api/git/repositories/{repository_id}/history", params=scope)
    second = client.get(
        f"/api/git/repositories/{repository_id}/history",
        params={**scope, "cursor": first.json()["next_cursor"]},
    )
    first_ids = {commit["object_id"] for commit in first.json()["commits"]}
    second_ids = {commit["object_id"] for commit in second.json()["commits"]}
    assert len(first_ids) == len(second_ids) == 2
    assert first_ids.isdisjoint(second_ids)

    repo.write("history-new.txt", "new\n")
    repo.commit("history new", "history-new.txt")
    stale = client.get(
        f"/api/git/repositories/{repository_id}/history",
        params={**scope, "cursor": first.json()["next_cursor"]},
    )
    assert stale.status_code == 422
    assert stale.json()["detail"]["message"] == "Git cursor is invalid or stale"
