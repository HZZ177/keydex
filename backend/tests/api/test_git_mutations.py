from __future__ import annotations

import time
from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app.api.git import router
from backend.app.git.access import GitAncestorGrantStore
from backend.app.git.query_service import GitQueryService
from backend.tests.git.conftest import GitRepoFactory


def _payload(repo, repository_id: str, key: str, **values) -> dict:
    return {
        "workspace_id": "workspace-mutation",
        "project_root": str(repo.path),
        "repository_id": repository_id,
        "idempotency_key": key,
        **values,
    }


def _wait(client: TestClient, operation_id: str) -> dict:
    for _ in range(100):
        response = client.get(f"/api/git/operations/{operation_id}")
        payload = response.json()
        if payload["state"] in {"succeeded", "failed", "cancelled"}:
            return payload
        time.sleep(0.01)
    raise AssertionError("Git operation did not finish")


def test_explicit_mutation_routes_are_idempotent_and_mutate_real_repository(tmp_path: Path) -> None:
    repo = GitRepoFactory(tmp_path).create("api-mutation")
    repo.write("change.txt", "change\n")
    app = FastAPI()
    app.state.settings = SimpleNamespace(data_dir=tmp_path)
    app.state.git_query_service = GitQueryService(
        grants=GitAncestorGrantStore(tmp_path / "grants.json")
    )
    app.include_router(router)
    with TestClient(app) as client:
        repository_id = client.post(
            "/api/git/repositories/discover",
            json={"workspace_id": "workspace-mutation", "project_root": str(repo.path)},
        ).json()["repositories"][0]["id"]
        stage_payload = _payload(repo, repository_id, "stage-key", paths=["change.txt"])
        first = client.post(f"/api/git/repositories/{repository_id}/stage", json=stage_payload)
        duplicate = client.post(f"/api/git/repositories/{repository_id}/stage", json=stage_payload)
        assert first.status_code == duplicate.status_code == 200
        assert first.json()["operation_id"] == duplicate.json()["operation_id"]
        assert _wait(client, first.json()["operation_id"])["state"] == "succeeded"

        commit = client.post(
            f"/api/git/repositories/{repository_id}/commit",
            json=_payload(repo, repository_id, "commit-key", message="api commit"),
        )
        result = _wait(client, commit.json()["operation_id"])
        assert result["state"] == "succeeded"
        assert result["summary"] == "Created commit"
        assert result["result"]["status"] == "committed"
        assert result["result"]["oid"] == repo.run("rev-parse", "HEAD").stdout.strip()
        assert repo.run("log", "-1", "--format=%s").stdout.strip() == "api commit"


def test_commit_hook_failure_is_readable_and_preserves_staged_state(tmp_path: Path) -> None:
    repo = GitRepoFactory(tmp_path).create("api-hook-failure")
    repo.write("blocked.txt", "staged content\n")
    repo.run("add", "--", "blocked.txt")
    hook = repo.path / ".git" / "hooks" / "pre-commit"
    hook.write_text(
        "#!/bin/sh\necho 'Keydex policy rejected this commit' >&2\nexit 1\n",
        encoding="utf-8",
        newline="",
    )
    hook.chmod(0o755)
    app = FastAPI()
    app.state.settings = SimpleNamespace(data_dir=tmp_path)
    app.include_router(router)
    with TestClient(app) as client:
        repository_id = client.post(
            "/api/git/repositories/discover",
            json={"workspace_id": "workspace-hook", "project_root": str(repo.path)},
        ).json()["repositories"][0]["id"]
        submitted = client.post(
            f"/api/git/repositories/{repository_id}/commit",
            json={
                **_payload(repo, repository_id, "hook-failure-key"),
                "workspace_id": "workspace-hook",
                "message": "blocked commit",
            },
        )
        result = _wait(client, submitted.json()["operation_id"])
        assert result["state"] == "failed"
        assert "Keydex policy rejected this commit" in result["result"]["error"]
        assert repo.run("diff", "--cached", "--name-only").stdout.strip() == "blocked.txt"


def test_amend_requires_payload_bound_confirmation_and_returns_new_oid(tmp_path: Path) -> None:
    repo = GitRepoFactory(tmp_path).create("api-amend")
    previous_oid = repo.run("rev-parse", "HEAD").stdout.strip()
    app = FastAPI()
    app.state.settings = SimpleNamespace(data_dir=tmp_path)
    app.include_router(router)
    with TestClient(app) as client:
        repository_id = client.post(
            "/api/git/repositories/discover",
            json={"workspace_id": "workspace-amend", "project_root": str(repo.path)},
        ).json()["repositories"][0]["id"]
        payload = {
            **_payload(repo, repository_id, "amend-confirm-key"),
            "workspace_id": "workspace-amend",
            "message": "amended fixture commit",
            "amend": True,
        }
        rejected = client.post(f"/api/git/repositories/{repository_id}/commit", json=payload)
        assert rejected.status_code == 409

        confirmation = client.post(
            "/api/git/confirmations",
            json={"command": "commit", "payload": payload},
        )
        assert confirmation.status_code == 200
        assert confirmation.json()["risk"] == "history_rewrite"
        payload["confirmation_token"] = confirmation.json()["token"]
        amended = client.post(f"/api/git/repositories/{repository_id}/commit", json=payload)
        result = _wait(client, amended.json()["operation_id"])
        assert result["state"] == "succeeded"
        assert result["summary"] == "Amended commit"
        assert result["result"]["oid"] != previous_oid
        assert repo.run("log", "-1", "--format=%s").stdout.strip() == "amended fixture commit"


def test_signing_failure_is_diagnostic_and_preserves_index(tmp_path: Path) -> None:
    repo = GitRepoFactory(tmp_path).create("api-signing-failure")
    fake_gpg = repo.path / "fake-gpg.sh"
    fake_gpg.write_text(
        "#!/bin/sh\necho 'Keydex signing helper rejected the key' >&2\nexit 2\n",
        encoding="utf-8",
        newline="",
    )
    fake_gpg.chmod(0o755)
    repo.run("config", "gpg.program", fake_gpg.as_posix())
    repo.run("config", "user.signingkey", "KEYDEX_TEST_KEY")
    repo.write("signed.txt", "requires signing\n")
    repo.run("add", "--", "signed.txt")
    app = FastAPI()
    app.state.settings = SimpleNamespace(data_dir=tmp_path)
    app.include_router(router)
    with TestClient(app) as client:
        repository_id = client.post(
            "/api/git/repositories/discover",
            json={"workspace_id": "workspace-signing", "project_root": str(repo.path)},
        ).json()["repositories"][0]["id"]
        submitted = client.post(
            f"/api/git/repositories/{repository_id}/commit",
            json={
                **_payload(repo, repository_id, "signing-failure-key"),
                "workspace_id": "workspace-signing",
                "message": "signed commit",
                "sign": True,
            },
        )
        result = _wait(client, submitted.json()["operation_id"])
        assert result["state"] == "failed"
        assert result["result"]["error"].strip()
        assert repo.run("diff", "--cached", "--name-only").stdout.strip() == "signed.txt"


def test_destructive_route_requires_token_bound_to_exact_payload(tmp_path: Path) -> None:
    repo = GitRepoFactory(tmp_path).create("api-confirm")
    repo.write("README.md", "changed\n")
    app = FastAPI()
    app.state.settings = SimpleNamespace(data_dir=tmp_path)
    app.include_router(router)
    with TestClient(app) as client:
        repository_id = client.post(
            "/api/git/repositories/discover",
            json={"workspace_id": "workspace-mutation", "project_root": str(repo.path)},
        ).json()["repositories"][0]["id"]
        payload = _payload(repo, repository_id, "discard-key", paths=["README.md"])
        rejected = client.post(f"/api/git/repositories/{repository_id}/discard", json=payload)
        assert rejected.status_code == 409

        confirmation = client.post(
            "/api/git/confirmations",
            json={"command": "discard", "payload": payload},
        )
        assert confirmation.status_code == 200
        payload["confirmation_token"] = confirmation.json()["token"]
        accepted = client.post(f"/api/git/repositories/{repository_id}/discard", json=payload)
        assert accepted.status_code == 200
        assert _wait(client, accepted.json()["operation_id"])["state"] == "succeeded"
        assert repo.path.joinpath("README.md").read_text(encoding="utf-8").startswith("# e2e-git")

        repo.write("temporary.txt", "remove me\n")
        clean_payload = _payload(repo, repository_id, "clean-key", paths=["temporary.txt"])
        clean_confirmation = client.post(
            "/api/git/confirmations",
            json={"command": "clean", "payload": clean_payload},
        ).json()
        clean_payload["confirmation_token"] = clean_confirmation["token"]
        clean = client.post(f"/api/git/repositories/{repository_id}/clean", json=clean_payload)
        assert _wait(client, clean.json()["operation_id"])["state"] == "succeeded"
        assert not repo.path.joinpath("temporary.txt").exists()

        repo.write("local.env", "SECRET=placeholder\n")
        ignored = client.post(
            f"/api/git/repositories/{repository_id}/ignore",
            json=_payload(repo, repository_id, "ignore-key", paths=["local.env"]),
        )
        assert ignored.status_code == 200
        assert "/local.env" in repo.path.joinpath(".gitignore").read_text(encoding="utf-8")


def test_init_and_ancestor_grant_routes_keep_scope_explicit(tmp_path: Path) -> None:
    app = FastAPI()
    app.state.settings = SimpleNamespace(data_dir=tmp_path / "data")
    app.include_router(router)
    with TestClient(app) as client:
        plain_project = tmp_path / "plain-project"
        plain_project.mkdir()
        initialized = client.post(
            "/api/git/repositories/init",
            json={"workspace_id": "plain", "project_root": str(plain_project)},
        )
        assert initialized.status_code == 200
        assert initialized.json()["repositories"][0]["root_path"] == str(plain_project)
        assert plain_project.joinpath(".git").is_dir()

        ancestor = GitRepoFactory(tmp_path).create("ancestor")
        nested_project = ancestor.path / "packages" / "app"
        nested_project.mkdir(parents=True)
        discovery = client.post(
            "/api/git/repositories/discover",
            json={"workspace_id": "nested", "project_root": str(nested_project)},
        ).json()
        candidate = discovery["ancestor_candidate"]
        assert candidate["ancestor_authorization"] == "pending"

        granted = client.post(
            "/api/git/repositories/ancestor-grants",
            json={
                "workspace_id": "nested",
                "project_root": str(nested_project),
                "repository_id": candidate["id"],
                "repository_root": candidate["root_path"],
            },
        )
        assert granted.status_code == 200
        assert granted.json()["scope"] == "git_only"
        rediscovered = client.post(
            "/api/git/repositories/discover",
            json={"workspace_id": "nested", "project_root": str(nested_project)},
        ).json()
        assert rediscovered["ancestor_candidate"]["ancestor_authorization"] == "granted"
        status = client.get(
            f"/api/git/repositories/{candidate['id']}/status",
            params={"workspace_id": "nested", "project_root": str(nested_project)},
        )
        assert status.status_code == 200


def test_repository_identity_is_read_and_written_in_local_config(tmp_path: Path) -> None:
    repo = GitRepoFactory(tmp_path).create("api-identity")
    app = FastAPI()
    app.state.settings = SimpleNamespace(data_dir=tmp_path)
    app.include_router(router)
    with TestClient(app) as client:
        repository_id = client.post(
            "/api/git/repositories/discover",
            json={"workspace_id": "workspace-identity", "project_root": str(repo.path)},
        ).json()["repositories"][0]["id"]
        params = {"workspace_id": "workspace-identity", "project_root": str(repo.path)}

        current = client.get(
            f"/api/git/repositories/{repository_id}/identity",
            params=params,
        )
        assert current.status_code == 200
        assert current.json()["name"] == repo.run("config", "--get", "user.name").stdout.strip()
        assert current.json()["email"] == repo.run("config", "--get", "user.email").stdout.strip()

        updated = client.put(
            f"/api/git/repositories/{repository_id}/identity",
            json={
                **params,
                "repository_id": repository_id,
                "name": "Keydex User",
                "email": "keydex@example.com",
                "sign_by_default": True,
            },
        )
        assert updated.status_code == 200
        assert updated.json() == {
            "repository_id": repository_id,
            "name": "Keydex User",
            "email": "keydex@example.com",
            "sign_by_default": True,
        }
        assert repo.run("config", "--local", "--get", "user.name").stdout.strip() == "Keydex User"
        assert (
            repo.run("config", "--local", "--get", "user.email").stdout.strip()
            == "keydex@example.com"
        )
        assert repo.run("config", "--local", "--get", "commit.gpgsign").stdout.strip() == "true"


def test_commit_then_push_reaches_local_bare_remote_without_rolling_back_commit(
    tmp_path: Path,
) -> None:
    factory = GitRepoFactory(tmp_path)
    repo = factory.create("api-commit-push")
    remote = factory.create_bare("api-commit-push-remote")
    repo.run("remote", "add", "origin", str(remote))
    repo.run("push", "--set-upstream", "origin", "main")
    repo.write("published.txt", "published by Keydex\n")
    repo.run("add", "--", "published.txt")
    app = FastAPI()
    app.state.settings = SimpleNamespace(data_dir=tmp_path)
    app.include_router(router)
    with TestClient(app) as client:
        repository_id = client.post(
            "/api/git/repositories/discover",
            json={"workspace_id": "workspace-publish", "project_root": str(repo.path)},
        ).json()["repositories"][0]["id"]
        committed = client.post(
            f"/api/git/repositories/{repository_id}/commit",
            json={
                **_payload(repo, repository_id, "commit-push-commit-key"),
                "workspace_id": "workspace-publish",
                "message": "publish from Keydex",
            },
        )
        commit_result = _wait(client, committed.json()["operation_id"])
        assert commit_result["state"] == "succeeded"
        repo.run("tag", "v-published")

        pushed = client.post(
            f"/api/git/repositories/{repository_id}/push",
            json={
                **_payload(repo, repository_id, "commit-push-push-key"),
                "workspace_id": "workspace-publish",
                "remote": "origin",
                "source": "main",
                "target": "main",
                "tags": True,
            },
        )
        push_result = _wait(client, pushed.json()["operation_id"])
        assert push_result["state"] == "succeeded"
        assert push_result["result"]["status"] == "pushed"
        assert (
            repo.run("--git-dir", str(remote), "rev-parse", "refs/heads/main").stdout.strip()
            == commit_result["result"]["oid"]
        )
        assert (
            repo.run("--git-dir", str(remote), "rev-parse", "refs/tags/v-published").returncode == 0
        )

        published_head = repo.run("rev-parse", "HEAD").stdout.strip()
        repo.write("remote-only.txt", "remote side\n")
        remote_head = repo.commit("remote only", "remote-only.txt")
        repo.run("push", "origin", "main")
        repo.run("reset", "--hard", published_head)
        repo.write("local-only.txt", "local side\n")
        repo.commit("local only", "local-only.txt")
        rejected = client.post(
            f"/api/git/repositories/{repository_id}/push",
            json={
                **_payload(repo, repository_id, "push-rejected-key"),
                "workspace_id": "workspace-publish",
                "remote": "origin",
                "source": "main",
                "target": "main",
            },
        )
        rejected_result = _wait(client, rejected.json()["operation_id"])
        assert rejected_result["state"] == "failed"
        assert "rejected" in rejected_result["result"]["error"].casefold()
        assert (
            repo.run("--git-dir", str(remote), "rev-parse", "refs/heads/main").stdout.strip()
            == remote_head
        )

        repo.run("switch", "-c", "feature/first-push")
        first_push = client.post(
            f"/api/git/repositories/{repository_id}/push",
            json={
                **_payload(repo, repository_id, "push-first-key"),
                "workspace_id": "workspace-publish",
                "remote": "origin",
                "source": "feature/first-push",
                "target": "feature/first-push",
                "set_upstream": True,
            },
        )
        assert _wait(client, first_push.json()["operation_id"])["state"] == "succeeded"
        assert repo.run("config", "branch.feature/first-push.remote").stdout.strip() == "origin"


def test_force_push_with_lease_succeeds_rejects_stale_and_blocks_protected(
    tmp_path: Path,
) -> None:
    factory = GitRepoFactory(tmp_path)
    repo = factory.create("api-force-lease")
    remote = factory.create_bare("api-force-lease-remote")
    repo.run("remote", "add", "origin", str(remote))
    repo.run("switch", "-c", "feature/lease")
    repo.run("push", "--set-upstream", "origin", "feature/lease")
    base = repo.run("rev-parse", "HEAD").stdout.strip()
    repo.write("remote-b.txt", "remote B\n")
    repo.commit("remote B", "remote-b.txt")
    repo.run("push", "origin", "feature/lease")
    repo.run("reset", "--hard", base)
    repo.write("local-c.txt", "local C\n")
    local_c = repo.commit("local C", "local-c.txt")

    app = FastAPI()
    app.state.settings = SimpleNamespace(data_dir=tmp_path)
    app.include_router(router)
    with TestClient(app) as client:
        repository_id = client.post(
            "/api/git/repositories/discover",
            json={"workspace_id": "workspace-force", "project_root": str(repo.path)},
        ).json()["repositories"][0]["id"]

        def confirmed_push(key: str, target: str = "feature/lease"):
            payload = {
                **_payload(repo, repository_id, key),
                "workspace_id": "workspace-force",
                "remote": "origin",
                "source": "feature/lease",
                "target": target,
                "force_with_lease": True,
            }
            payload["confirmation_token"] = client.post(
                "/api/git/confirmations",
                json={"command": "push", "payload": payload},
            ).json()["token"]
            return client.post(f"/api/git/repositories/{repository_id}/push", json=payload)

        protected = confirmed_push("force-protected-key", "main")
        assert protected.status_code == 409
        assert "protected branch main" in protected.json()["detail"]["message"]

        succeeded = confirmed_push("force-success-key")
        assert _wait(client, succeeded.json()["operation_id"])["state"] == "succeeded"
        assert (
            repo.run(
                "--git-dir", str(remote), "rev-parse", "refs/heads/feature/lease"
            ).stdout.strip()
            == local_c
        )

        known_remote = local_c
        repo.write("remote-d.txt", "remote D\n")
        repo.commit("remote D", "remote-d.txt")
        repo.run("push", "origin", "feature/lease")
        repo.run("reset", "--hard", known_remote)
        repo.write("local-e.txt", "local E\n")
        repo.commit("local E", "local-e.txt")
        repo.run("update-ref", "refs/remotes/origin/feature/lease", known_remote)

        stale = confirmed_push("force-stale-key")
        stale_result = _wait(client, stale.json()["operation_id"])
        assert stale_result["state"] == "failed"
        assert "stale info" in stale_result["result"]["error"].casefold()


def test_branch_create_switch_detached_and_dirty_preflight_on_real_repo(tmp_path: Path) -> None:
    repo = GitRepoFactory(tmp_path).create("api-branch-flow")
    app = FastAPI()
    app.state.settings = SimpleNamespace(data_dir=tmp_path)
    app.include_router(router)
    with TestClient(app) as client:
        repository_id = client.post(
            "/api/git/repositories/discover",
            json={"workspace_id": "workspace-branch", "project_root": str(repo.path)},
        ).json()["repositories"][0]["id"]
        created = client.post(
            f"/api/git/repositories/{repository_id}/branches",
            json={
                **_payload(repo, repository_id, "branch-create-key"),
                "workspace_id": "workspace-branch",
                "branch_name": "feature/api-branch",
                "start_point": "HEAD",
            },
        )
        assert _wait(client, created.json()["operation_id"])["state"] == "succeeded"
        assert repo.run("branch", "--show-current").stdout.strip() == "feature/api-branch"

        repo.write("README.md", "feature branch content\n")
        repo.commit("feature branch content", "README.md")
        feature_oid = repo.run("rev-parse", "HEAD").stdout.strip()
        repo.run("switch", "main")
        repo.write("README.md", "uncommitted local content\n")
        blocked = client.post(
            f"/api/git/repositories/{repository_id}/checkout",
            json={
                **_payload(repo, repository_id, "branch-dirty-key"),
                "workspace_id": "workspace-branch",
                "ref": "feature/api-branch",
            },
        )
        blocked_result = _wait(client, blocked.json()["operation_id"])
        assert blocked_result["state"] == "failed"
        assert blocked_result["result"]["error"].strip()
        assert repo.run("branch", "--show-current").stdout.strip() == "main"

        repo.run("restore", "--", "README.md")
        detached = client.post(
            f"/api/git/repositories/{repository_id}/checkout",
            json={
                **_payload(repo, repository_id, "branch-detach-key"),
                "workspace_id": "workspace-branch",
                "ref": feature_oid,
                "detach": True,
            },
        )
        assert _wait(client, detached.json()["operation_id"])["state"] == "succeeded"
        assert repo.run("rev-parse", "HEAD").stdout.strip() == feature_oid
        assert repo.run("branch", "--show-current").stdout.strip() == ""


def test_branch_rename_safe_force_and_remote_delete_on_real_repo(tmp_path: Path) -> None:
    factory = GitRepoFactory(tmp_path)
    repo = factory.create("api-branch-delete")
    repo.run("switch", "-c", "feature/unmerged")
    repo.write("unmerged.txt", "unique commit\n")
    repo.commit("unmerged branch commit", "unmerged.txt")
    repo.run("switch", "main")
    remote = factory.create_bare("api-branch-delete-remote")
    repo.run("remote", "add", "origin", str(remote))
    repo.run("push", "origin", "feature/unmerged:refs/heads/remote/delete-me")
    app = FastAPI()
    app.state.settings = SimpleNamespace(data_dir=tmp_path)
    app.include_router(router)
    with TestClient(app) as client:
        repository_id = client.post(
            "/api/git/repositories/discover",
            json={"workspace_id": "workspace-branch-delete", "project_root": str(repo.path)},
        ).json()["repositories"][0]["id"]
        renamed = client.post(
            f"/api/git/repositories/{repository_id}/branches/rename",
            json={
                **_payload(repo, repository_id, "branch-rename-key"),
                "workspace_id": "workspace-branch-delete",
                "old_name": "feature/unmerged",
                "new_name": "feature/renamed",
            },
        )
        assert _wait(client, renamed.json()["operation_id"])["state"] == "succeeded"
        assert repo.run("branch", "--list", "feature/renamed").stdout.strip()

        safe_payload = {
            **_payload(repo, repository_id, "branch-safe-delete-key"),
            "workspace_id": "workspace-branch-delete",
            "branch_name": "feature/renamed",
            "force": False,
        }
        safe_payload["confirmation_token"] = client.post(
            "/api/git/confirmations",
            json={"command": "delete_branch", "payload": safe_payload},
        ).json()["token"]
        safe_delete = client.post(
            f"/api/git/repositories/{repository_id}/branches/delete",
            json=safe_payload,
        )
        safe_result = _wait(client, safe_delete.json()["operation_id"])
        assert safe_result["state"] == "failed"
        assert repo.run("branch", "--list", "feature/renamed").stdout.strip()

        force_payload = {
            **_payload(repo, repository_id, "branch-force-delete-key"),
            "workspace_id": "workspace-branch-delete",
            "branch_name": "feature/renamed",
            "force": True,
        }
        assert (
            client.post(
                f"/api/git/repositories/{repository_id}/branches/delete",
                json=force_payload,
            ).status_code
            == 409
        )
        force_payload["confirmation_token"] = client.post(
            "/api/git/confirmations",
            json={"command": "delete_branch", "payload": force_payload},
        ).json()["token"]
        forced = client.post(
            f"/api/git/repositories/{repository_id}/branches/delete",
            json=force_payload,
        )
        assert _wait(client, forced.json()["operation_id"])["state"] == "succeeded"
        assert not repo.run("branch", "--list", "feature/renamed").stdout.strip()

        remote_payload = {
            **_payload(repo, repository_id, "branch-remote-delete-key"),
            "workspace_id": "workspace-branch-delete",
            "branch_name": "remote/delete-me",
            "remote": "origin",
        }
        remote_payload["confirmation_token"] = client.post(
            "/api/git/confirmations",
            json={"command": "delete_branch", "payload": remote_payload},
        ).json()["token"]
        deleted_remote = client.post(
            f"/api/git/repositories/{repository_id}/branches/delete",
            json=remote_payload,
        )
        assert _wait(client, deleted_remote.json()["operation_id"])["state"] == "succeeded"
        assert repo.run("ls-remote", "--heads", "origin", "remote/delete-me").stdout.strip() == ""


def test_tag_create_details_detached_checkout_and_delete_on_real_repo(tmp_path: Path) -> None:
    factory = GitRepoFactory(tmp_path)
    repo = factory.create("api-tags")
    remote = factory.create_bare("api-tags-remote")
    repo.run("remote", "add", "origin", str(remote))
    app = FastAPI()
    app.state.settings = SimpleNamespace(data_dir=tmp_path)
    app.include_router(router)
    with TestClient(app) as client:
        repository_id = client.post(
            "/api/git/repositories/discover",
            json={"workspace_id": "workspace-tags", "project_root": str(repo.path)},
        ).json()["repositories"][0]["id"]
        for key, name, annotated, message in (
            ("tag-light-key", "v-light", False, None),
            ("tag-annotated-key", "v-annotated", True, "Annotated release"),
        ):
            created = client.post(
                f"/api/git/repositories/{repository_id}/tags",
                json={
                    **_payload(repo, repository_id, key),
                    "workspace_id": "workspace-tags",
                    "tag_name": name,
                    "target": "HEAD",
                    "annotated": annotated,
                    "message": message,
                },
            )
            assert _wait(client, created.json()["operation_id"])["state"] == "succeeded"
        refs = client.get(
            f"/api/git/repositories/{repository_id}/refs",
            params={"workspace_id": "workspace-tags", "project_root": str(repo.path)},
        ).json()["refs"]
        by_name = {ref["short_name"]: ref for ref in refs}
        assert by_name["v-light"]["annotated"] is False
        assert by_name["v-annotated"]["annotated"] is True
        assert by_name["v-annotated"]["annotation"] == "Annotated release"

        detached = client.post(
            f"/api/git/repositories/{repository_id}/checkout",
            json={
                **_payload(repo, repository_id, "tag-checkout-key"),
                "workspace_id": "workspace-tags",
                "ref": "v-annotated",
                "detach": True,
            },
        )
        assert _wait(client, detached.json()["operation_id"])["state"] == "succeeded"
        assert repo.run("branch", "--show-current").stdout.strip() == ""
        repo.run("switch", "main")
        repo.run("push", "origin", "refs/tags/v-annotated")

        delete_cases = (
            ("tag-local-delete-key", None),
            ("tag-remote-delete-key", "origin"),
        )
        for key, remote_name in delete_cases:
            payload = {
                **_payload(repo, repository_id, key),
                "workspace_id": "workspace-tags",
                "tag_name": "v-annotated",
                "remote": remote_name,
            }
            payload["confirmation_token"] = client.post(
                "/api/git/confirmations",
                json={"command": "delete_tag", "payload": payload},
            ).json()["token"]
            deleted = client.post(
                f"/api/git/repositories/{repository_id}/tags/delete",
                json=payload,
            )
            assert _wait(client, deleted.json()["operation_id"])["state"] == "succeeded"
        assert repo.run("tag", "--list", "v-annotated").stdout.strip() == ""
        assert repo.run("ls-remote", "--tags", "origin", "v-annotated").stdout.strip() == ""


def test_remote_crud_reports_tracking_impact_and_redacts_credentials(tmp_path: Path) -> None:
    factory = GitRepoFactory(tmp_path)
    repo = factory.create("api-remotes")
    fetch_remote = factory.create_bare("api-remotes-fetch")
    push_remote = factory.create_bare("api-remotes-push")
    app = FastAPI()
    app.state.settings = SimpleNamespace(data_dir=tmp_path)
    app.include_router(router)
    with TestClient(app) as client:
        repository_id = client.post(
            "/api/git/repositories/discover",
            json={"workspace_id": "workspace-remotes", "project_root": str(repo.path)},
        ).json()["repositories"][0]["id"]
        added = client.post(
            f"/api/git/repositories/{repository_id}/remotes",
            json={
                **_payload(repo, repository_id, "remote-add-key"),
                "workspace_id": "workspace-remotes",
                "remote_name": "origin",
                "url": str(fetch_remote),
            },
        )
        assert _wait(client, added.json()["operation_id"])["state"] == "succeeded"
        duplicate = client.post(
            f"/api/git/repositories/{repository_id}/remotes",
            json={
                **_payload(repo, repository_id, "remote-duplicate-key"),
                "workspace_id": "workspace-remotes",
                "remote_name": "origin",
                "url": str(fetch_remote),
            },
        )
        assert _wait(client, duplicate.json()["operation_id"])["state"] == "failed"

        push_url = client.post(
            f"/api/git/repositories/{repository_id}/remotes/url",
            json={
                **_payload(repo, repository_id, "remote-push-url-key"),
                "workspace_id": "workspace-remotes",
                "remote_name": "origin",
                "url": str(push_remote),
                "push": True,
            },
        )
        assert _wait(client, push_url.json()["operation_id"])["state"] == "succeeded"
        repo.run("push", "--set-upstream", str(fetch_remote), "main")
        repo.run("config", "branch.main.remote", "origin")
        repo.run("config", "branch.main.merge", "refs/heads/main")
        remotes = client.get(
            f"/api/git/repositories/{repository_id}/remotes",
            params={"workspace_id": "workspace-remotes", "project_root": str(repo.path)},
        ).json()["remotes"]
        assert remotes[0]["fetch_url"] == str(fetch_remote)
        assert remotes[0]["push_url"] == str(push_remote)
        assert remotes[0]["tracking_branches"] == ["main"]

        renamed = client.post(
            f"/api/git/repositories/{repository_id}/remotes/rename",
            json={
                **_payload(repo, repository_id, "remote-rename-key"),
                "workspace_id": "workspace-remotes",
                "old_name": "origin",
                "new_name": "upstream",
            },
        )
        assert _wait(client, renamed.json()["operation_id"])["state"] == "succeeded"
        assert repo.run("config", "branch.main.remote").stdout.strip() == "upstream"

        repo.run("remote", "set-url", "upstream", "https://user:secret@example.invalid/repo.git")
        redacted = client.get(
            f"/api/git/repositories/{repository_id}/remotes",
            params={"workspace_id": "workspace-remotes", "project_root": str(repo.path)},
        ).json()["remotes"][0]["fetch_url"]
        assert redacted == "https://***:***@example.invalid/repo.git"

        remove_payload = {
            **_payload(repo, repository_id, "remote-remove-key"),
            "workspace_id": "workspace-remotes",
            "remote_name": "upstream",
        }
        assert (
            client.post(
                f"/api/git/repositories/{repository_id}/remotes/remove",
                json=remove_payload,
            ).status_code
            == 409
        )
        remove_payload["confirmation_token"] = client.post(
            "/api/git/confirmations",
            json={"command": "remove_remote", "payload": remove_payload},
        ).json()["token"]
        removed = client.post(
            f"/api/git/repositories/{repository_id}/remotes/remove",
            json=remove_payload,
        )
        assert _wait(client, removed.json()["operation_id"])["state"] == "succeeded"
        assert repo.run("remote").stdout.strip() == ""
        assert repo.run("config", "--get", "branch.main.remote", check=False).returncode == 1


def test_upstream_set_and_unset_refreshes_status_and_refs(tmp_path: Path) -> None:
    factory = GitRepoFactory(tmp_path)
    repo = factory.create("api-upstream")
    remote = factory.create_bare("api-upstream-remote")
    repo.run("remote", "add", "origin", str(remote))
    repo.run("push", "origin", "main")
    app = FastAPI()
    app.state.settings = SimpleNamespace(data_dir=tmp_path)
    app.include_router(router)
    with TestClient(app) as client:
        repository_id = client.post(
            "/api/git/repositories/discover",
            json={"workspace_id": "workspace-upstream", "project_root": str(repo.path)},
        ).json()["repositories"][0]["id"]
        set_response = client.post(
            f"/api/git/repositories/{repository_id}/upstream",
            json={
                **_payload(repo, repository_id, "upstream-set-key"),
                "workspace_id": "workspace-upstream",
                "branch_name": "main",
                "upstream": "origin/main",
            },
        )
        set_result = _wait(client, set_response.json()["operation_id"])
        assert set_result["state"] == "succeeded"
        assert set_result["result"]["refresh_domains"] == ["refs", "status"]
        assert repo.run("config", "branch.main.remote").stdout.strip() == "origin"

        status = client.get(
            f"/api/git/repositories/{repository_id}/status",
            params={"workspace_id": "workspace-upstream", "project_root": str(repo.path)},
        ).json()
        refs = client.get(
            f"/api/git/repositories/{repository_id}/refs",
            params={"workspace_id": "workspace-upstream", "project_root": str(repo.path)},
        ).json()["refs"]
        assert status["branch"]["upstream"] == "origin/main"
        assert (
            next(ref for ref in refs if ref["full_name"] == "refs/heads/main")["upstream"]
            == "refs/remotes/origin/main"
        )

        unset_response = client.post(
            f"/api/git/repositories/{repository_id}/upstream",
            json={
                **_payload(repo, repository_id, "upstream-unset-key"),
                "workspace_id": "workspace-upstream",
                "branch_name": "main",
                "upstream": None,
            },
        )
        assert _wait(client, unset_response.json()["operation_id"])["state"] == "succeeded"
        assert repo.run("config", "--get", "branch.main.remote", check=False).returncode == 1
        refreshed = client.get(
            f"/api/git/repositories/{repository_id}/status",
            params={"workspace_id": "workspace-upstream", "project_root": str(repo.path)},
        ).json()
        assert refreshed["branch"]["upstream"] is None


def test_fetch_updates_refs_tags_and_prunes_only_when_requested(tmp_path: Path) -> None:
    factory = GitRepoFactory(tmp_path)
    repo = factory.create("api-fetch")
    remote = factory.create_bare("api-fetch-remote")
    repo.run("remote", "add", "origin", str(remote))
    repo.run("switch", "-c", "stale")
    repo.write("remote.txt", "remote branch\n")
    repo.commit("remote branch", "remote.txt")
    repo.run("tag", "v-fetch")
    repo.run("push", "origin", "stale", "refs/tags/v-fetch")
    repo.run("switch", "main")
    repo.run("update-ref", "-d", "refs/remotes/origin/stale")
    repo.run("tag", "-d", "v-fetch")
    repo.run("config", "fetch.prune", "true")

    app = FastAPI()
    app.state.settings = SimpleNamespace(data_dir=tmp_path)
    app.include_router(router)
    with TestClient(app) as client:
        repository_id = client.post(
            "/api/git/repositories/discover",
            json={"workspace_id": "workspace-fetch", "project_root": str(repo.path)},
        ).json()["repositories"][0]["id"]
        fetched = client.post(
            f"/api/git/repositories/{repository_id}/fetch",
            json={
                **_payload(repo, repository_id, "fetch-default-key"),
                "workspace_id": "workspace-fetch",
                "remote": "origin",
                "tags": True,
            },
        )
        result = _wait(client, fetched.json()["operation_id"])
        assert result["state"] == "succeeded"
        assert result["result"]["status"] == "fetched"
        assert isinstance(result["result"]["progress_lines"], list)
        assert repo.run("rev-parse", "refs/remotes/origin/stale").returncode == 0
        assert repo.run("rev-parse", "refs/tags/v-fetch").returncode == 0

        # Delete the remote ref out-of-band.  `git push --delete` would also
        # remove the caller's remote-tracking ref and could not distinguish
        # Fetch prune behavior.
        repo.run("--git-dir", str(remote), "update-ref", "-d", "refs/heads/stale")
        retained = client.post(
            f"/api/git/repositories/{repository_id}/fetch",
            json={
                **_payload(repo, repository_id, "fetch-retain-key"),
                "workspace_id": "workspace-fetch",
                "remote": "origin",
            },
        )
        assert _wait(client, retained.json()["operation_id"])["state"] == "succeeded"
        assert repo.run("rev-parse", "refs/remotes/origin/stale").returncode == 0

        pruned = client.post(
            f"/api/git/repositories/{repository_id}/fetch",
            json={
                **_payload(repo, repository_id, "fetch-prune-key"),
                "workspace_id": "workspace-fetch",
                "remote": "origin",
                "prune": True,
            },
        )
        assert _wait(client, pruned.json()["operation_id"])["state"] == "succeeded"
        assert repo.run("rev-parse", "refs/remotes/origin/stale", check=False).returncode != 0


def test_update_project_keeps_strategy_explicit_and_never_falls_back(tmp_path: Path) -> None:
    factory = GitRepoFactory(tmp_path)
    repo = factory.create("api-update")
    remote = factory.create_bare("api-update-remote")
    repo.run("remote", "add", "origin", str(remote))
    repo.run("push", "--set-upstream", "origin", "main")
    initial = repo.run("rev-parse", "HEAD").stdout.strip()
    repo.write("remote-fast-forward.txt", "remote\n")
    remote_fast_forward = repo.commit("remote fast forward", "remote-fast-forward.txt")
    repo.run("push", "origin", "main")
    repo.run("reset", "--hard", initial)

    app = FastAPI()
    app.state.settings = SimpleNamespace(data_dir=tmp_path)
    app.include_router(router)
    with TestClient(app) as client:
        repository_id = client.post(
            "/api/git/repositories/discover",
            json={"workspace_id": "workspace-update", "project_root": str(repo.path)},
        ).json()["repositories"][0]["id"]

        def update(key: str, strategy: str = "ff_only") -> dict:
            submitted = client.post(
                f"/api/git/repositories/{repository_id}/update",
                json={
                    **_payload(repo, repository_id, key),
                    "workspace_id": "workspace-update",
                    "remote": "origin",
                    "refspec": "main",
                    "strategy": strategy,
                },
            )
            return _wait(client, submitted.json()["operation_id"])

        fast_forward = update("update-ff-key")
        assert fast_forward["state"] == "succeeded"
        assert fast_forward["result"]["status"] == "updated"
        assert repo.run("rev-parse", "HEAD").stdout.strip() == remote_fast_forward
        assert update("update-current-key")["result"]["status"] == "up_to_date"

        divergence_base = repo.run("rev-parse", "HEAD").stdout.strip()
        repo.write("remote-diverged.txt", "remote side\n")
        repo.commit("remote diverged", "remote-diverged.txt")
        repo.run("push", "origin", "main")
        repo.run("reset", "--hard", divergence_base)
        repo.write("local-diverged.txt", "local side\n")
        local_head = repo.commit("local diverged", "local-diverged.txt")

        rejected = update("update-diverged-ff-key")
        assert rejected["state"] == "failed"
        assert "fast-forward" in rejected["result"]["error"].casefold()
        assert repo.run("rev-parse", "HEAD").stdout.strip() == local_head
        assert repo.run("rev-parse", "HEAD^2", check=False).returncode != 0

        merged = update("update-diverged-merge-key", "merge")
        assert merged["state"] == "succeeded"
        assert merged["result"]["status"] == "updated"
        assert repo.run("rev-parse", "HEAD^2").returncode == 0


def test_stash_actions_create_apply_pop_branch_drop_and_clear(tmp_path: Path) -> None:
    factory = GitRepoFactory(tmp_path)
    repo = factory.create("api-stash-actions")
    app = FastAPI()
    app.state.settings = SimpleNamespace(data_dir=tmp_path)
    app.include_router(router)
    with TestClient(app) as client:
        repository_id = client.post(
            "/api/git/repositories/discover",
            json={"workspace_id": "workspace-stash-actions", "project_root": str(repo.path)},
        ).json()["repositories"][0]["id"]

        def payload(key: str, **values) -> dict:
            return {
                **_payload(repo, repository_id, key),
                "workspace_id": "workspace-stash-actions",
                **values,
            }

        def entry() -> tuple[str, str]:
            line = repo.run("stash", "list", "--max-count=1", "--format=%gd%x00%H").stdout
            selector, object_id = line.strip().split("\x00")
            return selector, object_id

        repo.write("staged.txt", "staged\n")
        repo.run("add", "--", "staged.txt")
        repo.write("untracked.txt", "untracked\n")
        created = client.post(
            f"/api/git/repositories/{repository_id}/stash",
            json=payload(
                "stash-create-key",
                message="save staged and untracked",
                include_untracked=True,
            ),
        )
        assert _wait(client, created.json()["operation_id"])["state"] == "succeeded"
        selector, object_id = entry()
        assert "save staged and untracked" in repo.run("stash", "list", "-1").stdout
        assert repo.run("status", "--porcelain").stdout.strip() == ""

        applied = client.post(
            f"/api/git/repositories/{repository_id}/stash/apply",
            json=payload(
                "stash-apply-key",
                selector=selector,
                object_id=object_id,
                reinstate_index=True,
            ),
        )
        assert _wait(client, applied.json()["operation_id"])["state"] == "succeeded"
        assert repo.run("stash", "list").stdout.strip()
        assert repo.run("diff", "--cached", "--name-only").stdout.strip() == "staged.txt"
        assert (repo.path / "untracked.txt").is_file()
        repo.run("reset", "--hard")
        repo.run("clean", "-fd")

        popped = client.post(
            f"/api/git/repositories/{repository_id}/stash/pop",
            json=payload("stash-pop-key", selector=selector, object_id=object_id),
        )
        assert _wait(client, popped.json()["operation_id"])["state"] == "succeeded"
        assert repo.run("stash", "list").stdout.strip() == ""
        repo.run("reset", "--hard")
        repo.run("clean", "-fd")

        repo.write("README.md", "branch from stash\n")
        repo.run("stash", "push", "--message", "branch stash")
        selector, object_id = entry()
        branched = client.post(
            f"/api/git/repositories/{repository_id}/stash/branch",
            json=payload(
                "stash-branch-key",
                selector=selector,
                object_id=object_id,
                branch_name="stash/recovery",
            ),
        )
        assert _wait(client, branched.json()["operation_id"])["state"] == "succeeded"
        assert repo.run("branch", "--show-current").stdout.strip() == "stash/recovery"
        assert repo.run("stash", "list").stdout.strip() == ""
        repo.run("reset", "--hard")
        repo.run("switch", "main")

        repo.write("drop.txt", "old stash\n")
        repo.run("stash", "push", "--include-untracked", "--message", "old stash")
        old_selector, old_oid = entry()
        repo.write("new.txt", "new stash\n")
        repo.run("stash", "push", "--include-untracked", "--message", "new stash")
        stale_payload = payload(
            "stash-stale-drop-key",
            selector=old_selector,
            object_id=old_oid,
        )
        stale_payload["confirmation_token"] = client.post(
            "/api/git/confirmations",
            json={"command": "stash_drop", "payload": stale_payload},
        ).json()["token"]
        stale = client.post(
            f"/api/git/repositories/{repository_id}/stash/drop",
            json=stale_payload,
        )
        stale_result = _wait(client, stale.json()["operation_id"])
        assert stale_result["state"] == "failed"
        assert "reference changed" in stale_result["result"]["error"].casefold()

        current_selector, current_oid = entry()
        drop_payload = payload(
            "stash-drop-key",
            selector=current_selector,
            object_id=current_oid,
        )
        drop_payload["confirmation_token"] = client.post(
            "/api/git/confirmations",
            json={"command": "stash_drop", "payload": drop_payload},
        ).json()["token"]
        dropped = client.post(
            f"/api/git/repositories/{repository_id}/stash/drop",
            json=drop_payload,
        )
        assert _wait(client, dropped.json()["operation_id"])["state"] == "succeeded"
        assert "new stash" not in repo.run("stash", "list").stdout

        clear_payload = payload("stash-clear-key")
        clear_payload["confirmation_token"] = client.post(
            "/api/git/confirmations",
            json={"command": "stash_clear", "payload": clear_payload},
        ).json()["token"]
        cleared = client.post(
            f"/api/git/repositories/{repository_id}/stash/clear",
            json=clear_payload,
        )
        assert _wait(client, cleared.json()["operation_id"])["state"] == "succeeded"
        assert repo.run("stash", "list").stdout.strip() == ""


def test_stash_apply_conflict_refreshes_unified_conflict_state(tmp_path: Path) -> None:
    repo = GitRepoFactory(tmp_path).create("api-stash-conflict")
    repo.write("conflict.txt", "base\n")
    repo.commit("stash conflict base", "conflict.txt")
    repo.write("conflict.txt", "stash\n")
    repo.run("stash", "push", "--message", "conflicting stash")
    selector, object_id = (
        repo.run("stash", "list", "--max-count=1", "--format=%gd%x00%H")
        .stdout.strip()
        .split("\x00")
    )
    repo.write("conflict.txt", "current\n")
    repo.commit("current conflict", "conflict.txt")
    app = FastAPI()
    app.state.settings = SimpleNamespace(data_dir=tmp_path)
    app.include_router(router)
    with TestClient(app) as client:
        repository_id = client.post(
            "/api/git/repositories/discover",
            json={"workspace_id": "workspace-stash-conflict", "project_root": str(repo.path)},
        ).json()["repositories"][0]["id"]
        submitted = client.post(
            f"/api/git/repositories/{repository_id}/stash/apply",
            json={
                **_payload(repo, repository_id, "stash-conflict-key"),
                "workspace_id": "workspace-stash-conflict",
                "selector": selector,
                "object_id": object_id,
            },
        )
        result = _wait(client, submitted.json()["operation_id"])
        assert result["state"] == "failed"
        assert result["result"]["refresh_domains"] == ["diff", "stash", "status"]
        status = client.get(
            f"/api/git/repositories/{repository_id}/status",
            params={
                "workspace_id": "workspace-stash-conflict",
                "project_root": str(repo.path),
            },
        ).json()
        assert status["files"][0]["conflicted"] is True
        assert status["operation"]["kind"] == "stash_apply"
        assert status["operation"]["state"] == "conflicted"
