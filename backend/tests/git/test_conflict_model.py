from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app.api.git import router
from backend.app.git.conflicts import (
    classify_conflict,
    decode_conflict_content,
    parse_unmerged_index,
    resolution_actions,
)
from backend.tests.git.conftest import GitRepoFactory


def test_parses_stage_records_and_maps_conflict_action_matrix() -> None:
    parsed = parse_unmerged_index(
        f"100644 {'a' * 40} 1\tconflict.txt\0"
        f"100644 {'b' * 40} 2\tconflict.txt\0"
        f"100644 {'c' * 40} 3\tconflict.txt\0"
    )
    assert [(entry.stage, entry.path) for entry in parsed] == [
        (1, "conflict.txt"),
        (2, "conflict.txt"),
        (3, "conflict.txt"),
    ]
    assert classify_conflict({1, 2, 3}, binary=False, submodule=False, rename=False) == (
        "both_modified"
    )
    assert classify_conflict({2, 3}, binary=False, submodule=False, rename=False) == "add_add"
    assert classify_conflict({1, 2}, binary=False, submodule=False, rename=False) == (
        "delete_modify"
    )
    assert classify_conflict({1, 2, 3}, binary=True, submodule=False, rename=False) == "binary"
    assert classify_conflict({1, 2, 3}, binary=False, submodule=True, rename=False) == (
        "submodule"
    )
    assert resolution_actions("delete_modify") == ("keep_modified", "accept_delete")
    assert decode_conflict_content(b"a\r\nb\n") == ("a\r\nb\n", False, "utf-8", "mixed")
    assert decode_conflict_content(b"\x00binary")[1:] == (True, "binary", "none")


def test_returns_three_stage_text_content_for_both_modified_conflict(tmp_path: Path) -> None:
    repo = GitRepoFactory(tmp_path).create("conflict-both")
    repo.create_conflict("both.txt")
    payload = _conflicts(tmp_path / "both-data", repo, "workspace-both")

    assert len(payload["files"]) == 1
    conflict = payload["files"][0]
    assert conflict["kind"] == "both_modified"
    assert [stage["label"] for stage in conflict["stages"]] == ["base", "ours", "theirs"]
    assert [stage["content"] for stage in conflict["stages"]] == [
        "base\n",
        "main\n",
        "feature\n",
    ]
    assert conflict["editable"] is True
    assert len(conflict["result_revision"]) == 64
    assert "take_both" in conflict["allowed_actions"]


def test_saves_crlf_bom_result_without_resolving_index(tmp_path: Path) -> None:
    repo = GitRepoFactory(tmp_path).create("conflict-save")
    repo.create_conflict("both.txt")
    app = FastAPI()
    app.state.settings = SimpleNamespace(data_dir=tmp_path / "save-data")
    app.include_router(router)
    with TestClient(app) as client:
        repository_id = _discover(client, repo, "workspace-save")
        conflict = _get_conflicts(client, repo, "workspace-save", repository_id)["files"][0]
        response = client.post(
            f"/api/git/repositories/{repository_id}/conflicts/result",
            json=_save_payload(repo, "workspace-save", repository_id, conflict),
        )

    assert response.status_code == 200, response.text
    assert (repo.path / "both.txt").read_bytes() == b"\xef\xbb\xbfmanual\r\nresult\r\n"
    assert response.json()["bytes_written"] == len(b"\xef\xbb\xbfmanual\r\nresult\r\n")
    assert repo.run("ls-files", "-u", "--", "both.txt").stdout


def test_rejects_stale_result_and_stage_revisions(tmp_path: Path) -> None:
    repo = GitRepoFactory(tmp_path).create("conflict-stale")
    repo.create_conflict("both.txt")
    app = FastAPI()
    app.state.settings = SimpleNamespace(data_dir=tmp_path / "stale-data")
    app.include_router(router)
    with TestClient(app) as client:
        repository_id = _discover(client, repo, "workspace-stale")
        conflict = _get_conflicts(client, repo, "workspace-stale", repository_id)["files"][0]
        payload = _save_payload(repo, "workspace-stale", repository_id, conflict)
        (repo.path / "both.txt").write_text("changed elsewhere\n", encoding="utf-8")
        stale_result = client.post(
            f"/api/git/repositories/{repository_id}/conflicts/result", json=payload
        )
        refreshed = _get_conflicts(client, repo, "workspace-stale", repository_id)["files"][0]
        stale_stage_payload = _save_payload(
            repo, "workspace-stale", repository_id, refreshed
        )
        stale_stage_payload["expected_stages"][0]["object_id"] = "f" * 40
        stale_stage = client.post(
            f"/api/git/repositories/{repository_id}/conflicts/result",
            json=stale_stage_payload,
        )

    assert stale_result.status_code == 409
    assert stale_result.json()["detail"]["code"] == "git_operation_conflict"
    assert stale_stage.status_code == 409


def test_rejects_binary_conflict_result_and_path_traversal(tmp_path: Path) -> None:
    repo = _binary_conflict(GitRepoFactory(tmp_path))
    app = FastAPI()
    app.state.settings = SimpleNamespace(data_dir=tmp_path / "binary-save-data")
    app.include_router(router)
    with TestClient(app) as client:
        repository_id = _discover(client, repo, "workspace-binary-save")
        conflict = _get_conflicts(
            client, repo, "workspace-binary-save", repository_id
        )["files"][0]
        binary = client.post(
            f"/api/git/repositories/{repository_id}/conflicts/result",
            json=_save_payload(
                repo, "workspace-binary-save", repository_id, conflict
            ),
        )
        traversal_payload = _save_payload(
            repo, "workspace-binary-save", repository_id, conflict
        )
        traversal_payload["path"] = "../outside.txt"
        traversal = client.post(
            f"/api/git/repositories/{repository_id}/conflicts/result",
            json=traversal_payload,
        )

    assert binary.status_code == 422
    assert traversal.status_code == 422


def test_classifies_add_add_delete_modify_and_binary_real_conflicts(tmp_path: Path) -> None:
    factory = GitRepoFactory(tmp_path)
    add_add = _add_add_conflict(factory)
    delete_modify = _delete_modify_conflict(factory)
    binary = _binary_conflict(factory)

    add_payload = _conflicts(tmp_path / "add-data", add_add, "workspace-add")
    delete_payload = _conflicts(tmp_path / "delete-data", delete_modify, "workspace-delete")
    binary_payload = _conflicts(tmp_path / "binary-data", binary, "workspace-binary")
    assert add_payload["files"][0]["kind"] == "add_add"
    assert {stage["stage"] for stage in add_payload["files"][0]["stages"]} == {2, 3}
    assert delete_payload["files"][0]["kind"] == "delete_modify"
    assert delete_payload["files"][0]["allowed_actions"] == [
        "keep_modified",
        "accept_delete",
    ]
    assert binary_payload["files"][0]["kind"] == "binary"
    assert binary_payload["files"][0]["editable"] is False
    assert any(stage["binary"] for stage in binary_payload["files"][0]["stages"])


def test_classifies_rename_conflict_and_relates_all_index_paths(tmp_path: Path) -> None:
    repo = GitRepoFactory(tmp_path).create("conflict-rename")
    repo.write("old.txt", "base\n")
    repo.commit("rename base", "old.txt")
    repo.run("switch", "-c", "side")
    repo.run("mv", "old.txt", "side.txt")
    repo.run("commit", "-m", "side rename")
    repo.run("switch", "main")
    repo.run("mv", "old.txt", "main.txt")
    repo.run("commit", "-m", "main rename")
    assert repo.run("merge", "side", check=False).returncode != 0

    payload = _conflicts(tmp_path / "rename-data", repo, "workspace-rename")
    assert {file["kind"] for file in payload["files"]} == {"rename"}
    assert {file["path"] for file in payload["files"]} == {"old.txt", "main.txt", "side.txt"}
    for file in payload["files"]:
        assert file["related_paths"] == ["main.txt", "old.txt", "side.txt"]


def test_large_conflict_content_is_bounded_and_not_editable(tmp_path: Path) -> None:
    repo = GitRepoFactory(tmp_path).create("conflict-large")
    repo.write("large.txt", f"base\n{'x' * (1024 * 1024)}\n")
    repo.commit("large base", "large.txt")
    repo.run("switch", "-c", "side")
    repo.write("large.txt", f"side\n{'x' * (1024 * 1024)}\n")
    repo.commit("large side", "large.txt")
    repo.run("switch", "main")
    repo.write("large.txt", f"main\n{'x' * (1024 * 1024)}\n")
    repo.commit("large main", "large.txt")
    assert repo.run("merge", "side", check=False).returncode != 0

    conflict = _conflicts(tmp_path / "large-data", repo, "workspace-large")["files"][0]
    assert conflict["editable"] is False
    assert conflict["result_too_large"] is True
    assert conflict["result_content"] is None
    assert all(stage["too_large"] for stage in conflict["stages"])
    assert all(stage["content"] is None for stage in conflict["stages"])


def _add_add_conflict(factory: GitRepoFactory):
    repo = factory.create("conflict-add-add")
    repo.run("switch", "-c", "side")
    repo.write("added.txt", "side\n")
    repo.commit("side add", "added.txt")
    repo.run("switch", "main")
    repo.write("added.txt", "main\n")
    repo.commit("main add", "added.txt")
    assert repo.run("merge", "side", check=False).returncode != 0
    return repo


def _delete_modify_conflict(factory: GitRepoFactory):
    repo = factory.create("conflict-delete-modify")
    repo.write("deleted.txt", "base\n")
    repo.commit("delete base", "deleted.txt")
    repo.run("switch", "-c", "side")
    repo.write("deleted.txt", "side modified\n")
    repo.commit("side modify", "deleted.txt")
    repo.run("switch", "main")
    repo.run("rm", "deleted.txt")
    repo.run("commit", "-m", "main delete")
    assert repo.run("merge", "side", check=False).returncode != 0
    return repo


def _binary_conflict(factory: GitRepoFactory):
    repo = factory.create("conflict-binary")
    (repo.path / "binary.dat").write_bytes(b"\x00base")
    repo.commit("binary base", "binary.dat")
    repo.run("switch", "-c", "side")
    (repo.path / "binary.dat").write_bytes(b"\x00side")
    repo.commit("binary side", "binary.dat")
    repo.run("switch", "main")
    (repo.path / "binary.dat").write_bytes(b"\x00main")
    repo.commit("binary main", "binary.dat")
    assert repo.run("merge", "side", check=False).returncode != 0
    return repo


def _conflicts(data_dir: Path, repo, workspace_id: str) -> dict:
    app = FastAPI()
    app.state.settings = SimpleNamespace(data_dir=data_dir)
    app.include_router(router)
    with TestClient(app) as client:
        discovery = client.post(
            "/api/git/repositories/discover",
            json={"workspace_id": workspace_id, "project_root": str(repo.path)},
        ).json()
        repository_id = discovery["repositories"][0]["id"]
        response = client.get(
            f"/api/git/repositories/{repository_id}/conflicts",
            params={"workspace_id": workspace_id, "project_root": str(repo.path)},
        )
        assert response.status_code == 200, response.text
        return response.json()


def _discover(client: TestClient, repo, workspace_id: str) -> str:
    response = client.post(
        "/api/git/repositories/discover",
        json={"workspace_id": workspace_id, "project_root": str(repo.path)},
    )
    assert response.status_code == 200, response.text
    return response.json()["repositories"][0]["id"]


def _get_conflicts(client: TestClient, repo, workspace_id: str, repository_id: str) -> dict:
    response = client.get(
        f"/api/git/repositories/{repository_id}/conflicts",
        params={"workspace_id": workspace_id, "project_root": str(repo.path)},
    )
    assert response.status_code == 200, response.text
    return response.json()


def _save_payload(repo, workspace_id: str, repository_id: str, conflict: dict) -> dict:
    return {
        "workspace_id": workspace_id,
        "project_root": str(repo.path),
        "repository_id": repository_id,
        "path": conflict["path"],
        "content": "manual\nresult\n",
        "encoding": "utf-8-bom",
        "eol": "crlf",
        "expected_result_revision": conflict["result_revision"],
        "expected_stages": [
            {"stage": stage["stage"], "object_id": stage["object_id"]}
            for stage in conflict["stages"]
        ],
    }
