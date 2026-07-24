import pytest

from backend.app.git.command_service import GitCommandRisk
from backend.app.git.default_commands import create_default_git_command_registry
from backend.app.git.models import (
    GitApiError,
    GitBisectControlCommandRequest,
    GitBisectStartCommandRequest,
    GitBranchCommandRequest,
    GitBranchDeleteCommandRequest,
    GitBranchRenameCommandRequest,
    GitCheckoutCommandRequest,
    GitCherryPickControlCommandRequest,
    GitCommitCommandRequest,
    GitConflictActionCommandRequest,
    GitConflictIndexStage,
    GitFetchCommandRequest,
    GitLfsCommandRequest,
    GitMergeAbortCommandRequest,
    GitPatchCommandRequest,
    GitPushCommandRequest,
    GitRebaseControlCommandRequest,
    GitRemoteAddCommandRequest,
    GitRemoteRemoveCommandRequest,
    GitRemoteRenameCommandRequest,
    GitRemoteSetUrlCommandRequest,
    GitRevertControlCommandRequest,
    GitStashBranchCommandRequest,
    GitStashClearCommandRequest,
    GitStashEntryCommandRequest,
    GitStashPushCommandRequest,
    GitSubmoduleCommandRequest,
    GitTagCreateCommandRequest,
    GitTagDeleteCommandRequest,
    GitUpdateCommandRequest,
    GitUpstreamCommandRequest,
    GitWorktreeCommandRequest,
)


def test_commit_command_runs_hooks_and_collects_full_oid() -> None:
    definition = create_default_git_command_registry().get("commit")
    prepared = definition.prepare(
        GitCommitCommandRequest(
            workspace_id="workspace-1",
            project_root="D:/repo",
            repository_id="repo-1",
            idempotency_key="commit-key",
            message="feat: Git commit result",
        )
    )

    assert prepared.argv == ("commit", "--file=-")
    assert "--no-verify" not in prepared.argv
    assert prepared.input_text == "feat: Git commit result"
    assert prepared.result_queries == (("oid", ("rev-parse", "HEAD")),)
    ordinary = GitCommitCommandRequest(
        workspace_id="workspace-1",
        project_root="D:/repo",
        repository_id="repo-1",
        idempotency_key="ordinary-key",
        message="ordinary commit",
    )
    assert definition.risk_for(ordinary) is GitCommandRisk.WRITE
    assert (
        definition.risk_for(ordinary.model_copy(update={"amend": True}))
        is GitCommandRisk.HISTORY_REWRITE
    )


def test_commit_command_scopes_selected_paths_and_prepares_untracked_files() -> None:
    definition = create_default_git_command_registry().get("commit")
    prepared = definition.prepare(
        GitCommitCommandRequest(
            workspace_id="workspace-1",
            project_root="D:/repo",
            repository_id="repo-1",
            idempotency_key="selected-commit-key",
            message="feat: selected files",
            paths=["src/renamed.ts", "src/old.ts", "new.txt"],
            untracked_paths=["new.txt"],
        )
    )

    assert prepared.argv == (
        "commit",
        "--file=-",
        "--only",
        "--",
        "src/renamed.ts",
        "src/old.ts",
        "new.txt",
    )
    assert prepared.setup_commands == (("add", "--intent-to-add", "--", "new.txt"),)
    assert prepared.failure_commands == (("reset", "--", "new.txt"),)

    with pytest.raises(ValueError, match="must also be selected"):
        GitCommitCommandRequest(
            workspace_id="workspace-1",
            project_root="D:/repo",
            repository_id="repo-1",
            idempotency_key="invalid-untracked-key",
            message="invalid selection",
            paths=["tracked.txt"],
            untracked_paths=["new.txt"],
        )


def test_checkout_can_explicitly_enter_detached_head() -> None:
    definition = create_default_git_command_registry().get("checkout")
    request = GitCheckoutCommandRequest(
        workspace_id="workspace-1",
        project_root="D:/repo",
        repository_id="repo-1",
        idempotency_key="checkout-key",
        ref="v1.0.0",
        detach=True,
    )
    assert definition.prepare(request).argv == ("switch", "--detach", "v1.0.0")
    assert definition.prepare(request.model_copy(update={"detach": False})).argv == (
        "switch",
        "v1.0.0",
    )


def test_create_branch_can_explicitly_track_remote_start_point() -> None:
    definition = create_default_git_command_registry().get("create_branch")
    request = GitBranchCommandRequest(
        workspace_id="workspace-1",
        project_root="D:/repo",
        repository_id="repo-1",
        idempotency_key="tracking-branch-key",
        branch_name="release/next",
        start_point="origin/release/next",
        track=True,
    )

    assert definition.prepare(request).argv == (
        "switch",
        "-c",
        "release/next",
        "--track",
        "origin/release/next",
    )


def test_conflict_actions_validate_stages_risk_and_reopen_index_payload() -> None:
    definition = create_default_git_command_registry().get("conflict_action")
    base = {
        "workspace_id": "workspace-1",
        "project_root": "D:/repo",
        "repository_id": "repo-1",
        "idempotency_key": "conflict-action-key",
        "path": "src/conflict.txt",
        "expected_stages": [
            GitConflictIndexStage(stage=1, object_id="a" * 40, mode="100644"),
            GitConflictIndexStage(stage=2, object_id="b" * 40, mode="100644"),
            GitConflictIndexStage(stage=3, object_id="c" * 40, mode="100644"),
        ],
    }
    ours = GitConflictActionCommandRequest(**base, action="accept_ours")
    prepared = definition.prepare(ours)
    assert prepared.argv == ("checkout", "--ours", "--", "src/conflict.txt")
    assert prepared.identity_checks[0][0] == (
        "ls-files",
        "-u",
        "--",
        "src/conflict.txt",
    )
    assert definition.risk_for(ours) is GitCommandRisk.DESTRUCTIVE

    resolved = ours.model_copy(update={"action": "mark_resolved"})
    assert definition.prepare(resolved).argv == ("add", "--", "src/conflict.txt")
    assert definition.risk_for(resolved) is GitCommandRisk.WRITE
    reopened = resolved.model_copy(
        update={
            "action": "reopen",
            "resolved_index_entry": f"100644 {'d' * 40} 0\tsrc/conflict.txt",
        }
    )
    reopen = definition.prepare(reopened)
    assert reopen.argv == ("update-index", "--index-info")
    assert reopen.input_text is not None
    assert reopen.input_text.startswith(f"0 {'0' * 40} 0\tsrc/conflict.txt\n")
    assert f"100644 {'c' * 40} 3\tsrc/conflict.txt\n" in reopen.input_text


def test_operation_control_risk_matrix_requires_confirmation_for_skip_and_abort() -> None:
    registry = create_default_git_command_registry()
    base = {
        "workspace_id": "workspace-1",
        "project_root": "D:/repo",
        "repository_id": "repo-1",
        "idempotency_key": "operation-control-key",
    }
    for name, model in (
        ("rebase_control", GitRebaseControlCommandRequest),
        ("cherry_pick_control", GitCherryPickControlCommandRequest),
        ("revert_control", GitRevertControlCommandRequest),
    ):
        definition = registry.get(name)
        assert definition.risk_for(model(**base, action="continue")) is GitCommandRisk.WRITE
        assert definition.risk_for(model(**base, action="skip")) is GitCommandRisk.DESTRUCTIVE
        assert definition.risk_for(model(**base, action="abort")) is GitCommandRisk.DESTRUCTIVE
    merge_abort = GitMergeAbortCommandRequest(**base)
    assert registry.get("merge_abort").risk_for(merge_abort) is GitCommandRisk.DESTRUCTIVE


def test_bisect_commands_validate_range_and_expose_explicit_manual_actions() -> None:
    registry = create_default_git_command_registry()
    base = {
        "workspace_id": "workspace-1",
        "project_root": "D:/repo",
        "repository_id": "repo-1",
        "idempotency_key": "bisect-command-key",
    }
    start = GitBisectStartCommandRequest(
        **base,
        good_revision="a" * 40,
        bad_revision="b" * 40,
    )
    prepared = registry.get("bisect_start").prepare(start)
    assert prepared.argv == ("bisect", "start", "b" * 40, "a" * 40)
    for action in ("good", "bad", "skip", "reset"):
        control = GitBisectControlCommandRequest(**base, action=action)
        assert registry.get("bisect_control").prepare(control).argv == (
            "bisect",
            action,
        )
    with pytest.raises(GitApiError, match="must differ"):
        registry.get("bisect_start").prepare(start.model_copy(update={"bad_revision": "a" * 40}))


def test_submodule_commands_route_paths_and_classify_recursive_or_deinit_risk() -> None:
    definition = create_default_git_command_registry().get("submodule_action")
    base = {
        "workspace_id": "workspace-1",
        "project_root": "D:/repo",
        "repository_id": "repo-1",
        "idempotency_key": "submodule-command-key",
        "paths": ["modules/core"],
    }
    update = GitSubmoduleCommandRequest(**base, action="update")
    assert definition.prepare(update).argv == (
        "submodule",
        "update",
        "--",
        "modules/core",
    )
    recursive = update.model_copy(update={"recursive": True})
    assert definition.prepare(recursive).argv == (
        "submodule",
        "update",
        "--recursive",
        "--",
        "modules/core",
    )
    assert definition.risk_for(update) is GitCommandRisk.WRITE
    assert definition.risk_for(recursive) is GitCommandRisk.DESTRUCTIVE
    deinit = update.model_copy(update={"action": "deinit", "force": True})
    assert definition.prepare(deinit).argv == (
        "submodule",
        "deinit",
        "--force",
        "--",
        "modules/core",
    )
    assert definition.risk_for(deinit) is GitCommandRisk.DESTRUCTIVE


def test_worktree_commands_cover_add_lock_remove_and_prune_risk() -> None:
    definition = create_default_git_command_registry().get("worktree_action")
    base = {
        "workspace_id": "workspace-1",
        "project_root": "D:/repo",
        "repository_id": "repo-1",
        "idempotency_key": "worktree-command-key",
    }
    add = GitWorktreeCommandRequest(
        **base,
        action="add",
        worktree_path="D:/worktrees/topic",
        new_branch="topic/worktree",
        revision="HEAD",
    )
    assert definition.prepare(add).argv == (
        "worktree",
        "add",
        "-b",
        "topic/worktree",
        "D:\\worktrees\\topic",
        "HEAD",
    )
    lock = add.model_copy(
        update={"action": "lock", "new_branch": None, "lock_reason": "in use\nlocally"}
    )
    assert definition.prepare(lock).argv == (
        "worktree",
        "lock",
        "--reason",
        "in use locally",
        "D:\\worktrees\\topic",
    )
    remove = add.model_copy(update={"action": "remove", "new_branch": None, "force": True})
    assert definition.risk_for(remove) is GitCommandRisk.DESTRUCTIVE
    assert "--force" in definition.prepare(remove).argv
    prune = GitWorktreeCommandRequest(**base, action="prune")
    assert definition.prepare(prune).argv == ("worktree", "prune")
    assert definition.risk_for(prune) is GitCommandRisk.DESTRUCTIVE


def test_lfs_commands_are_typed_and_never_install_the_plugin() -> None:
    definition = create_default_git_command_registry().get("lfs_action")
    base = {
        "workspace_id": "workspace-1",
        "project_root": "D:/repo",
        "repository_id": "repo-1",
        "idempotency_key": "lfs-command-key",
    }
    assert definition.prepare(GitLfsCommandRequest(**base, action="fetch")).argv == (
        "lfs",
        "fetch",
    )
    push = GitLfsCommandRequest(**base, action="push", remote="origin", refspec="main")
    assert definition.prepare(push).argv == ("lfs", "push", "origin", "main")
    assert definition.risk_for(push) is GitCommandRisk.WRITE
    with pytest.raises(ValueError, match="requires both remote and refspec"):
        GitLfsCommandRequest(**base, action="push", remote="origin")


def test_branch_rename_and_delete_commands_preserve_risk_levels() -> None:
    registry = create_default_git_command_registry()
    rename = GitBranchRenameCommandRequest(
        workspace_id="workspace-1",
        project_root="D:/repo",
        repository_id="repo-1",
        idempotency_key="rename-key",
        old_name="feature/old",
        new_name="feature/new",
    )
    assert registry.get("rename_branch").prepare(rename).argv == (
        "branch",
        "--move",
        "feature/old",
        "feature/new",
    )
    delete = GitBranchDeleteCommandRequest(
        workspace_id="workspace-1",
        project_root="D:/repo",
        repository_id="repo-1",
        idempotency_key="delete-key",
        branch_name="feature/new",
    )
    definition = registry.get("delete_branch")
    assert definition.prepare(delete).argv == ("branch", "-d", "feature/new")
    assert definition.risk_for(delete) is GitCommandRisk.DESTRUCTIVE
    forced = delete.model_copy(update={"force": True})
    assert definition.prepare(forced).argv == ("branch", "-D", "feature/new")
    assert definition.risk_for(forced) is GitCommandRisk.HISTORY_REWRITE
    remote = delete.model_copy(update={"remote": "origin"})
    assert definition.prepare(remote).argv == ("push", "origin", "--delete", "feature/new")
    assert definition.risk_for(remote) is GitCommandRisk.REMOTE_DESTRUCTIVE


def test_tag_commands_cover_lightweight_annotated_signed_and_remote_delete() -> None:
    registry = create_default_git_command_registry()
    create = registry.get("create_tag")
    lightweight = GitTagCreateCommandRequest(
        workspace_id="workspace-1",
        project_root="D:/repo",
        repository_id="repo-1",
        idempotency_key="tag-create-key",
        tag_name="v1.0.0",
        target="HEAD",
    )
    assert create.prepare(lightweight).argv == ("tag", "v1.0.0", "HEAD")
    annotated = lightweight.model_copy(update={"annotated": True, "message": "Version one"})
    assert create.prepare(annotated).argv == (
        "tag",
        "--annotate",
        "--message",
        "Version one",
        "v1.0.0",
        "HEAD",
    )
    assert "--sign" in create.prepare(annotated.model_copy(update={"sign": True})).argv

    delete = registry.get("delete_tag")
    local = GitTagDeleteCommandRequest(
        workspace_id="workspace-1",
        project_root="D:/repo",
        repository_id="repo-1",
        idempotency_key="tag-delete-key",
        tag_name="v1.0.0",
    )
    assert delete.prepare(local).argv == ("tag", "--delete", "v1.0.0")
    remote = local.model_copy(update={"remote": "origin"})
    assert delete.prepare(remote).argv == (
        "push",
        "origin",
        "--delete",
        "refs/tags/v1.0.0",
    )
    assert delete.risk_for(remote) is GitCommandRisk.REMOTE_DESTRUCTIVE


def test_remote_crud_commands_are_typed_and_remove_requires_confirmation() -> None:
    registry = create_default_git_command_registry()
    base = {
        "workspace_id": "workspace-1",
        "project_root": "D:/repo",
        "repository_id": "repo-1",
        "idempotency_key": "remote-command-key",
    }
    add = GitRemoteAddCommandRequest(**base, remote_name="origin", url="D:/origin.git")
    assert registry.get("add_remote").prepare(add).argv == (
        "remote",
        "add",
        "origin",
        "D:/origin.git",
    )
    rename = GitRemoteRenameCommandRequest(**base, old_name="origin", new_name="upstream")
    assert registry.get("rename_remote").prepare(rename).argv == (
        "remote",
        "rename",
        "origin",
        "upstream",
    )
    set_url = GitRemoteSetUrlCommandRequest(
        **base,
        remote_name="upstream",
        url="D:/push.git",
        push=True,
    )
    assert registry.get("set_remote_url").prepare(set_url).argv == (
        "remote",
        "set-url",
        "--push",
        "upstream",
        "D:/push.git",
    )
    remove = GitRemoteRemoveCommandRequest(**base, remote_name="upstream")
    assert registry.get("remove_remote").prepare(remove).argv == (
        "remote",
        "remove",
        "upstream",
    )
    assert registry.get("remove_remote").risk is GitCommandRisk.DESTRUCTIVE


def test_upstream_command_requires_an_explicit_tracking_ref_or_unsets_it() -> None:
    definition = create_default_git_command_registry().get("set_upstream")
    base = {
        "workspace_id": "workspace-1",
        "project_root": "D:/repo",
        "repository_id": "repo-1",
        "idempotency_key": "upstream-key",
        "branch_name": "main",
    }
    set_request = GitUpstreamCommandRequest(**base, upstream="origin/main")
    assert definition.prepare(set_request).argv == (
        "branch",
        "--set-upstream-to=origin/main",
        "main",
    )
    assert definition.refresh_domains == {"status", "refs"}

    unset_request = set_request.model_copy(
        update={"idempotency_key": "upstream-unset-key", "upstream": None}
    )
    assert definition.prepare(unset_request).argv == (
        "branch",
        "--unset-upstream",
        "main",
    )


def test_fetch_options_are_explicit_and_prune_is_off_by_default() -> None:
    definition = create_default_git_command_registry().get("fetch")
    base = {
        "workspace_id": "workspace-1",
        "project_root": "D:/repo",
        "repository_id": "repo-1",
        "idempotency_key": "fetch-key",
    }
    ordinary = GitFetchCommandRequest(**base, remote="origin")
    assert definition.prepare(ordinary).argv == (
        "fetch",
        "origin",
        "--no-prune",
        "--progress",
    )
    assert "--prune" not in definition.prepare(ordinary).argv
    explicit = ordinary.model_copy(update={"prune": True, "tags": True})
    assert definition.prepare(explicit).argv == (
        "fetch",
        "origin",
        "--prune",
        "--tags",
        "--progress",
    )
    all_remotes = ordinary.model_copy(update={"remote": None, "all_remotes": True})
    assert definition.prepare(all_remotes).argv == (
        "fetch",
        "--all",
        "--no-prune",
        "--progress",
    )
    branch_update = ordinary.model_copy(update={
        "refspec": "refs/heads/feature:refs/heads/feature",
    })
    assert definition.prepare(branch_update).argv == (
        "fetch",
        "origin",
        "--no-prune",
        "--progress",
        "refs/heads/feature:refs/heads/feature",
    )

    with pytest.raises(GitApiError, match="remote or all remotes"):
        definition.prepare(ordinary.model_copy(update={"remote": None}))


def test_update_command_uses_fast_forward_only_pull_and_refreshes_all_views() -> None:
    definition = create_default_git_command_registry().get("update")
    prepared = definition.prepare(
        GitUpdateCommandRequest(
            workspace_id="workspace-1",
            project_root="D:/repo",
            repository_id="repo-1",
            idempotency_key="update-1",
            remote="origin",
            refspec="main",
        )
    )

    assert definition.risk is GitCommandRisk.WRITE
    assert definition.refresh_domains == {"status", "refs", "history", "diff"}
    assert prepared.argv == ("pull", "--ff-only", "origin", "main")
    assert prepared.timeout_seconds == 300
    assert definition.prepare(
        GitUpdateCommandRequest(
            workspace_id="workspace-1",
            project_root="D:/repo",
            repository_id="repo-1",
            idempotency_key="update-merge",
            remote="origin",
            refspec="main",
            strategy="merge",
        )
    ).argv == ("pull", "--no-rebase", "origin", "main")
    assert definition.prepare(
        GitUpdateCommandRequest(
            workspace_id="workspace-1",
            project_root="D:/repo",
            repository_id="repo-1",
            idempotency_key="update-rebase",
            remote="origin",
            refspec="main",
            strategy="rebase",
        )
    ).argv == ("pull", "--rebase", "origin", "main")


def test_push_uses_explicit_source_target_and_never_bare_force() -> None:
    definition = create_default_git_command_registry().get("push")
    request = GitPushCommandRequest(
        workspace_id="workspace-1",
        project_root="D:/repo",
        repository_id="repo-1",
        idempotency_key="push-key",
        remote="origin",
        source="feature/demo",
        target="review/demo",
        set_upstream=True,
        tags=True,
    )
    prepared = definition.prepare(request)
    assert prepared.argv == (
        "push",
        "--set-upstream",
        "--tags",
        "origin",
        "feature/demo:refs/heads/review/demo",
    )
    assert "--force" not in prepared.argv
    assert "--force-with-lease" not in prepared.argv
    current_branch_tags = request.model_copy(
        update={"idempotency_key": "push-follow-tags-key", "tags": False, "follow_tags": True}
    )
    assert definition.prepare(current_branch_tags).argv == (
        "push",
        "--set-upstream",
        "--follow-tags",
        "origin",
        "feature/demo:refs/heads/review/demo",
    )
    with pytest.raises(GitApiError, match="mutually exclusive"):
        definition.prepare(request.model_copy(update={"follow_tags": True}))
    forced = request.model_copy(
        update={"idempotency_key": "push-force-key", "force_with_lease": True}
    )
    assert definition.prepare(forced).argv[1] == "--force-with-lease"
    assert "--force" not in definition.prepare(forced).argv
    assert definition.risk_for(forced) is GitCommandRisk.REMOTE_DESTRUCTIVE
    protected = forced.model_copy(update={"target": "main"})
    with pytest.raises(GitApiError, match="protected branch main"):
        assert definition.preflight is not None
        definition.preflight(protected)


def test_push_can_publish_one_explicit_tag_without_branch_options() -> None:
    definition = create_default_git_command_registry().get("push")
    request = GitPushCommandRequest(
        workspace_id="workspace-1",
        project_root="D:/repo",
        repository_id="repo-1",
        idempotency_key="push-tag-key",
        remote="origin",
        source="HEAD",
        target="main",
        tag_name="v1.0.0",
    )

    assert definition.prepare(request).argv == (
        "push",
        "origin",
        "refs/tags/v1.0.0:refs/tags/v1.0.0",
    )
    with pytest.raises(GitApiError, match="cannot be combined"):
        definition.prepare(request.model_copy(update={"tags": True}))


def test_stash_commands_cover_options_identity_checks_and_destructive_risk() -> None:
    registry = create_default_git_command_registry()
    base = {
        "workspace_id": "workspace-1",
        "project_root": "D:/repo",
        "repository_id": "repo-1",
        "idempotency_key": "stash-command-key",
    }
    push = GitStashPushCommandRequest(
        **base,
        message="save work",
        include_untracked=True,
    )
    assert registry.get("stash_push").prepare(push).argv == (
        "stash",
        "push",
        "--include-untracked",
        "--message",
        "save work",
    )
    with pytest.raises(GitApiError, match="cannot be combined"):
        registry.get("stash_push").prepare(push.model_copy(update={"staged": True}))

    entry = GitStashEntryCommandRequest(
        **base,
        selector="stash@{2}",
        object_id="a" * 40,
        reinstate_index=True,
    )
    apply = registry.get("stash_apply").prepare(entry)
    assert apply.argv == ("stash", "apply", "--index", "a" * 40)
    assert apply.identity_checks == ((("rev-parse", "--verify", "stash@{2}"), "a" * 40),)
    assert registry.get("stash_pop").prepare(entry).argv == (
        "stash",
        "pop",
        "--index",
        "stash@{2}",
    )
    branch = GitStashBranchCommandRequest(
        **base,
        selector="stash@{2}",
        object_id="a" * 40,
        branch_name="stash/recovery",
    )
    assert registry.get("stash_branch").prepare(branch).argv == (
        "stash",
        "branch",
        "stash/recovery",
        "stash@{2}",
    )
    assert registry.get("stash_drop").risk is GitCommandRisk.DESTRUCTIVE
    clear = GitStashClearCommandRequest(**base)
    assert registry.get("stash_clear").prepare(clear).argv == ("stash", "clear")
    assert registry.get("stash_clear").risk is GitCommandRisk.DESTRUCTIVE


def test_apply_patch_command_is_typed_index_only_and_rejects_traversal() -> None:
    definition = create_default_git_command_registry().get("apply_patch")
    base = {
        "workspace_id": "workspace-1",
        "project_root": "D:/repo",
        "repository_id": "repo-1",
        "idempotency_key": "patch-key-1",
    }
    prepared = definition.prepare(
        GitPatchCommandRequest(
            **base,
            patch=(
                "diff --git a/src/a.ts b/src/a.ts\n"
                "--- a/src/a.ts\n+++ b/src/a.ts\n"
                "@@ -1,1 +1,1 @@\n-old\n+new\n"
            ),
        )
    )
    assert prepared.argv == (
        "apply",
        "--unidiff-zero",
        "--whitespace=nowarn",
        "--cached",
        "-",
    )
    assert prepared.input_text.endswith("+new\n")

    source_patch = (
        "diff --git a/src/a.ts b/src/a.ts\n"
        "--- a/src/a.ts\n+++ b/src/a.ts\n"
        "@@ -1,1 +1,1 @@\n-old\n+new\n"
    )
    guarded = definition.prepare(
        GitPatchCommandRequest(
            **base,
            patch=source_patch,
            expected_source_version="diff-source:v1:test",
            expected_source_patch=source_patch,
            source_kind="working_tree",
            source_paths=["src/a.ts", "src/a.ts"],
        )
    )
    assert guarded.identity_checks == ((
        ("diff", "--no-ext-diff", "--binary", "--find-renames", "--", "src/a.ts"),
        source_patch.strip(),
    ),)

    with pytest.raises(ValueError, match="requires version"):
        GitPatchCommandRequest(
            **base,
            patch=source_patch,
            expected_source_version="diff-source:v1:test",
        )

    with pytest.raises(GitApiError, match="inside the repository"):
        definition.prepare(
            GitPatchCommandRequest(
                **base,
                patch=(
                    "diff --git a/../secret b/../secret\n"
                    "--- a/../secret\n+++ b/../secret\n"
                    "@@ -1 +1 @@\n-old\n+new\n"
                ),
            )
        )
