from __future__ import annotations

import base64
import json
import os
import shlex
import subprocess
import sys
from pathlib import Path

from .command_service import (
    GitCommandDefinition,
    GitCommandRegistry,
    GitCommandRisk,
    GitPreparedCommand,
)
from .models import (
    GitApiError,
    GitBisectControlCommandRequest,
    GitBisectStartCommandRequest,
    GitBranchCommandRequest,
    GitBranchDeleteCommandRequest,
    GitBranchRenameCommandRequest,
    GitCheckoutCommandRequest,
    GitCherryPickCommandRequest,
    GitCherryPickControlCommandRequest,
    GitCommitCommandRequest,
    GitConflictActionCommandRequest,
    GitFetchCommandRequest,
    GitLfsCommandRequest,
    GitMergeAbortCommandRequest,
    GitMergeCommandRequest,
    GitPatchCommandRequest,
    GitPathsCommandRequest,
    GitPushCommandRequest,
    GitRebaseCommandRequest,
    GitRebaseControlCommandRequest,
    GitRemoteAddCommandRequest,
    GitRemoteRemoveCommandRequest,
    GitRemoteRenameCommandRequest,
    GitRemoteSetUrlCommandRequest,
    GitResetCommandRequest,
    GitRestoreCommandRequest,
    GitRevertCommandRequest,
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
from .runner import GitCommandResult
from .security import (
    validate_ref_name,
    validate_remote_name,
    validate_remote_url,
    validate_repo_relative_path,
    validate_revision,
)


def create_default_git_command_registry() -> GitCommandRegistry:
    return GitCommandRegistry(
        (
            GitCommandDefinition(
                name="stage",
                request_model=GitPathsCommandRequest,
                risk=GitCommandRisk.WRITE,
                refresh_domains=frozenset({"status", "diff"}),
                prepare=lambda request: GitPreparedCommand(
                    argv=("add", "--", *request.paths),
                    summary=f"Staged {len(request.paths)} path(s)",
                ),
            ),
            GitCommandDefinition(
                name="unstage",
                request_model=GitPathsCommandRequest,
                risk=GitCommandRisk.WRITE,
                refresh_domains=frozenset({"status", "diff"}),
                prepare=lambda request: GitPreparedCommand(
                    argv=("restore", "--staged", "--", *request.paths),
                    summary=f"Unstaged {len(request.paths)} path(s)",
                ),
            ),
            GitCommandDefinition(
                name="apply_patch",
                request_model=GitPatchCommandRequest,
                risk=GitCommandRisk.WRITE,
                risk_resolver=lambda request: (
                    GitCommandRisk.SAFE if request.check_only else GitCommandRisk.WRITE
                ),
                refresh_domains=frozenset({"status", "diff"}),
                prepare=_prepare_apply_patch,
            ),
            GitCommandDefinition(
                name="discard",
                request_model=GitPathsCommandRequest,
                risk=GitCommandRisk.DESTRUCTIVE,
                refresh_domains=frozenset({"status", "diff"}),
                prepare=lambda request: GitPreparedCommand(
                    argv=("restore", "--worktree", "--", *request.paths),
                    summary=f"Discarded {len(request.paths)} path(s)",
                ),
            ),
            GitCommandDefinition(
                name="clean",
                request_model=GitPathsCommandRequest,
                risk=GitCommandRisk.DESTRUCTIVE,
                refresh_domains=frozenset({"status", "diff"}),
                prepare=lambda request: GitPreparedCommand(
                    argv=("clean", "-f", "-d", "--", *request.paths),
                    summary=f"Deleted {len(request.paths)} untracked path(s)",
                ),
            ),
            GitCommandDefinition(
                name="commit",
                request_model=GitCommitCommandRequest,
                risk=GitCommandRisk.WRITE,
                refresh_domains=frozenset({"status", "history", "refs"}),
                prepare=_prepare_commit,
                parse_result=lambda result: {
                    "status": "committed",
                    "output": result.safe_stdout.strip(),
                },
                risk_resolver=lambda request: (
                    GitCommandRisk.HISTORY_REWRITE if request.amend else GitCommandRisk.WRITE
                ),
            ),
            GitCommandDefinition(
                name="create_branch",
                request_model=GitBranchCommandRequest,
                risk=GitCommandRisk.WRITE,
                refresh_domains=frozenset({"status", "refs", "history"}),
                prepare=_prepare_create_branch,
            ),
            GitCommandDefinition(
                name="rename_branch",
                request_model=GitBranchRenameCommandRequest,
                risk=GitCommandRisk.WRITE,
                refresh_domains=frozenset({"status", "refs", "history"}),
                prepare=_prepare_rename_branch,
            ),
            GitCommandDefinition(
                name="delete_branch",
                request_model=GitBranchDeleteCommandRequest,
                risk=GitCommandRisk.DESTRUCTIVE,
                refresh_domains=frozenset({"status", "refs", "history"}),
                prepare=_prepare_delete_branch,
                risk_resolver=lambda request: (
                    GitCommandRisk.REMOTE_DESTRUCTIVE
                    if request.remote
                    else GitCommandRisk.HISTORY_REWRITE
                    if request.force
                    else GitCommandRisk.DESTRUCTIVE
                ),
            ),
            GitCommandDefinition(
                name="create_tag",
                request_model=GitTagCreateCommandRequest,
                risk=GitCommandRisk.WRITE,
                refresh_domains=frozenset({"refs", "history"}),
                prepare=_prepare_create_tag,
            ),
            GitCommandDefinition(
                name="delete_tag",
                request_model=GitTagDeleteCommandRequest,
                risk=GitCommandRisk.DESTRUCTIVE,
                refresh_domains=frozenset({"refs", "history"}),
                prepare=_prepare_delete_tag,
                risk_resolver=lambda request: (
                    GitCommandRisk.REMOTE_DESTRUCTIVE
                    if request.remote
                    else GitCommandRisk.DESTRUCTIVE
                ),
            ),
            GitCommandDefinition(
                name="checkout",
                request_model=GitCheckoutCommandRequest,
                risk=GitCommandRisk.WRITE,
                refresh_domains=frozenset({"status", "refs", "history", "diff"}),
                prepare=_prepare_checkout,
            ),
            GitCommandDefinition(
                name="fetch",
                request_model=GitFetchCommandRequest,
                risk=GitCommandRisk.WRITE,
                refresh_domains=frozenset({"refs", "history"}),
                prepare=_prepare_fetch,
                parse_result=_parse_fetch_result,
            ),
            GitCommandDefinition(
                name="add_remote",
                request_model=GitRemoteAddCommandRequest,
                risk=GitCommandRisk.WRITE,
                refresh_domains=frozenset({"remotes", "refs"}),
                prepare=_prepare_add_remote,
            ),
            GitCommandDefinition(
                name="rename_remote",
                request_model=GitRemoteRenameCommandRequest,
                risk=GitCommandRisk.WRITE,
                refresh_domains=frozenset({"remotes", "refs", "status"}),
                prepare=_prepare_rename_remote,
            ),
            GitCommandDefinition(
                name="set_remote_url",
                request_model=GitRemoteSetUrlCommandRequest,
                risk=GitCommandRisk.WRITE,
                refresh_domains=frozenset({"remotes"}),
                prepare=_prepare_set_remote_url,
            ),
            GitCommandDefinition(
                name="remove_remote",
                request_model=GitRemoteRemoveCommandRequest,
                risk=GitCommandRisk.DESTRUCTIVE,
                refresh_domains=frozenset({"remotes", "refs", "status"}),
                prepare=_prepare_remove_remote,
            ),
            GitCommandDefinition(
                name="set_upstream",
                request_model=GitUpstreamCommandRequest,
                risk=GitCommandRisk.WRITE,
                refresh_domains=frozenset({"status", "refs"}),
                prepare=_prepare_set_upstream,
            ),
            GitCommandDefinition(
                name="update",
                request_model=GitUpdateCommandRequest,
                risk=GitCommandRisk.WRITE,
                refresh_domains=frozenset({"status", "refs", "history", "diff"}),
                prepare=_prepare_update,
                parse_result=_parse_update_result,
            ),
            GitCommandDefinition(
                name="push",
                request_model=GitPushCommandRequest,
                risk=GitCommandRisk.WRITE,
                refresh_domains=frozenset({"status", "refs", "history"}),
                prepare=_prepare_push,
                parse_result=_parse_push_result,
                preflight=_preflight_push,
                risk_resolver=lambda request: (
                    GitCommandRisk.REMOTE_DESTRUCTIVE
                    if request.force_with_lease
                    else GitCommandRisk.WRITE
                ),
            ),
            GitCommandDefinition(
                name="stash_push",
                request_model=GitStashPushCommandRequest,
                risk=GitCommandRisk.WRITE,
                refresh_domains=frozenset({"status", "diff", "stash"}),
                prepare=_prepare_stash_push,
            ),
            GitCommandDefinition(
                name="stash_apply",
                request_model=GitStashEntryCommandRequest,
                risk=GitCommandRisk.WRITE,
                refresh_domains=frozenset({"status", "diff", "stash"}),
                prepare=lambda request: _prepare_stash_entry("apply", request),
                refresh_on_failure=True,
            ),
            GitCommandDefinition(
                name="stash_pop",
                request_model=GitStashEntryCommandRequest,
                risk=GitCommandRisk.WRITE,
                refresh_domains=frozenset({"status", "diff", "stash"}),
                prepare=lambda request: _prepare_stash_entry("pop", request),
                refresh_on_failure=True,
            ),
            GitCommandDefinition(
                name="stash_branch",
                request_model=GitStashBranchCommandRequest,
                risk=GitCommandRisk.WRITE,
                refresh_domains=frozenset({"status", "diff", "refs", "history", "stash"}),
                prepare=_prepare_stash_branch,
                refresh_on_failure=True,
            ),
            GitCommandDefinition(
                name="stash_drop",
                request_model=GitStashEntryCommandRequest,
                risk=GitCommandRisk.DESTRUCTIVE,
                refresh_domains=frozenset({"stash"}),
                prepare=lambda request: _prepare_stash_entry("drop", request),
            ),
            GitCommandDefinition(
                name="stash_clear",
                request_model=GitStashClearCommandRequest,
                risk=GitCommandRisk.DESTRUCTIVE,
                refresh_domains=frozenset({"stash"}),
                prepare=lambda _request: GitPreparedCommand(
                    argv=("stash", "clear"), summary="Cleared all stashes"
                ),
            ),
            GitCommandDefinition(
                name="merge",
                request_model=GitMergeCommandRequest,
                risk=GitCommandRisk.WRITE,
                refresh_domains=frozenset({"status", "diff", "history", "refs"}),
                prepare=_prepare_merge,
                refresh_on_failure=True,
            ),
            GitCommandDefinition(
                name="merge_abort",
                request_model=GitMergeAbortCommandRequest,
                risk=GitCommandRisk.DESTRUCTIVE,
                refresh_domains=frozenset({"status", "diff", "history", "refs"}),
                prepare=lambda _request: GitPreparedCommand(
                    argv=("merge", "--abort"),
                    summary="Aborted merge",
                ),
                refresh_on_failure=True,
            ),
            GitCommandDefinition(
                name="rebase",
                request_model=GitRebaseCommandRequest,
                risk=GitCommandRisk.HISTORY_REWRITE,
                refresh_domains=frozenset({"status", "diff", "history", "refs"}),
                prepare=_prepare_rebase,
                refresh_on_failure=True,
            ),
            GitCommandDefinition(
                name="rebase_control",
                request_model=GitRebaseControlCommandRequest,
                risk=GitCommandRisk.WRITE,
                risk_resolver=_control_action_risk,
                refresh_domains=frozenset({"status", "diff", "history", "refs"}),
                prepare=_prepare_rebase_control,
                refresh_on_failure=True,
            ),
            GitCommandDefinition(
                name="cherry_pick",
                request_model=GitCherryPickCommandRequest,
                risk=GitCommandRisk.WRITE,
                refresh_domains=frozenset({"status", "diff", "history", "refs"}),
                prepare=_prepare_cherry_pick,
                refresh_on_failure=True,
            ),
            GitCommandDefinition(
                name="cherry_pick_control",
                request_model=GitCherryPickControlCommandRequest,
                risk=GitCommandRisk.WRITE,
                risk_resolver=_control_action_risk,
                refresh_domains=frozenset({"status", "diff", "history", "refs"}),
                prepare=_prepare_cherry_pick_control,
                refresh_on_failure=True,
            ),
            GitCommandDefinition(
                name="revert",
                request_model=GitRevertCommandRequest,
                risk=GitCommandRisk.WRITE,
                refresh_domains=frozenset({"status", "diff", "history", "refs"}),
                prepare=_prepare_revert,
                refresh_on_failure=True,
            ),
            GitCommandDefinition(
                name="revert_control",
                request_model=GitRevertControlCommandRequest,
                risk=GitCommandRisk.WRITE,
                risk_resolver=_control_action_risk,
                refresh_domains=frozenset({"status", "diff", "history", "refs"}),
                prepare=_prepare_revert_control,
                refresh_on_failure=True,
            ),
            GitCommandDefinition(
                name="reset",
                request_model=GitResetCommandRequest,
                risk=GitCommandRisk.HISTORY_REWRITE,
                risk_resolver=lambda request: (
                    GitCommandRisk.DESTRUCTIVE
                    if request.mode == "hard"
                    else GitCommandRisk.HISTORY_REWRITE
                ),
                refresh_domains=frozenset({"status", "diff", "history", "refs", "reflog"}),
                prepare=_prepare_reset,
            ),
            GitCommandDefinition(
                name="restore",
                request_model=GitRestoreCommandRequest,
                risk=GitCommandRisk.WRITE,
                risk_resolver=lambda request: (
                    GitCommandRisk.DESTRUCTIVE if request.worktree else GitCommandRisk.WRITE
                ),
                refresh_domains=frozenset({"status", "diff"}),
                prepare=_prepare_restore,
            ),
            GitCommandDefinition(
                name="conflict_action",
                request_model=GitConflictActionCommandRequest,
                risk=GitCommandRisk.WRITE,
                risk_resolver=lambda request: (
                    GitCommandRisk.WRITE
                    if request.action in {"mark_resolved", "reopen"}
                    else GitCommandRisk.DESTRUCTIVE
                ),
                refresh_domains=frozenset({"status", "diff"}),
                prepare=_prepare_conflict_action,
            ),
            GitCommandDefinition(
                name="bisect_start",
                request_model=GitBisectStartCommandRequest,
                risk=GitCommandRisk.WRITE,
                refresh_domains=frozenset({"status", "history", "refs", "bisect"}),
                prepare=_prepare_bisect_start,
            ),
            GitCommandDefinition(
                name="bisect_control",
                request_model=GitBisectControlCommandRequest,
                risk=GitCommandRisk.WRITE,
                refresh_domains=frozenset({"status", "history", "refs", "bisect"}),
                prepare=_prepare_bisect_control,
            ),
            GitCommandDefinition(
                name="submodule_action",
                request_model=GitSubmoduleCommandRequest,
                risk=GitCommandRisk.WRITE,
                risk_resolver=lambda request: (
                    GitCommandRisk.DESTRUCTIVE
                    if request.action == "deinit" or request.recursive
                    else GitCommandRisk.WRITE
                ),
                refresh_domains=frozenset({"status", "diff", "submodules"}),
                prepare=_prepare_submodule_action,
            ),
            GitCommandDefinition(
                name="worktree_action",
                request_model=GitWorktreeCommandRequest,
                risk=GitCommandRisk.WRITE,
                risk_resolver=lambda request: (
                    GitCommandRisk.DESTRUCTIVE
                    if request.action in {"remove", "prune"}
                    else GitCommandRisk.WRITE
                ),
                refresh_domains=frozenset({"status", "refs", "worktrees"}),
                prepare=_prepare_worktree_action,
            ),
            GitCommandDefinition(
                name="lfs_action",
                request_model=GitLfsCommandRequest,
                risk=GitCommandRisk.WRITE,
                refresh_domains=frozenset({"status", "diff", "lfs"}),
                prepare=_prepare_lfs_action,
            ),
        )
    )


def _prepare_bisect_start(request: GitBisectStartCommandRequest) -> GitPreparedCommand:
    bad = validate_revision(request.bad_revision)
    good = validate_revision(request.good_revision)
    if bad == good:
        raise GitApiError("git_validation_failed", "Bisect good and bad revisions must differ")
    return GitPreparedCommand(
        argv=("bisect", "start", bad, good),
        summary=f"Started bisect between {good} and {bad}",
        timeout_seconds=300,
        result_data={"action": "start", "good_revision": good, "bad_revision": bad},
    )


def _prepare_bisect_control(request: GitBisectControlCommandRequest) -> GitPreparedCommand:
    return GitPreparedCommand(
        argv=("bisect", request.action),
        summary=f"Bisect {request.action}",
        timeout_seconds=300,
        result_data={"action": request.action},
    )


def _prepare_submodule_action(request: GitSubmoduleCommandRequest) -> GitPreparedCommand:
    paths = tuple(validate_repo_relative_path(path) for path in request.paths)
    argv = ["submodule"]
    if request.action == "init":
        argv.append("init")
    elif request.action == "update":
        argv.append("update")
        if request.recursive:
            argv.append("--recursive")
    elif request.action == "sync":
        argv.append("sync")
        if request.recursive:
            argv.append("--recursive")
    else:
        argv.append("deinit")
        if request.force:
            argv.append("--force")
    argv.extend(("--", *paths))
    return GitPreparedCommand(
        argv=tuple(argv),
        summary=f"Submodule {request.action}: {len(paths)} path(s)",
        timeout_seconds=600,
        result_data={
            "action": request.action,
            "paths": list(paths),
            "recursive": request.recursive,
        },
    )


def _prepare_worktree_action(request: GitWorktreeCommandRequest) -> GitPreparedCommand:
    if request.action == "prune":
        return GitPreparedCommand(
            argv=("worktree", "prune"),
            summary="Pruned stale worktree metadata",
            result_data={"action": "prune"},
        )
    assert request.worktree_path is not None
    path = Path(request.worktree_path).expanduser()
    if not path.is_absolute() or "\x00" in request.worktree_path:
        raise GitApiError("git_validation_failed", "Worktree path must be absolute")
    normalized_path = str(path.resolve())
    if request.action == "add":
        revision = validate_revision(request.revision)
        argv = ["worktree", "add"]
        if request.detach:
            argv.append("--detach")
        elif request.new_branch:
            argv.extend(("-b", validate_ref_name(request.new_branch)))
        argv.extend((normalized_path, revision))
    elif request.action == "remove":
        argv = ["worktree", "remove"]
        if request.force:
            argv.append("--force")
        argv.append(normalized_path)
    elif request.action == "lock":
        argv = ["worktree", "lock"]
        if request.lock_reason:
            argv.extend(("--reason", request.lock_reason.replace("\r", " ").replace("\n", " ")))
        argv.append(normalized_path)
    else:
        argv = ["worktree", "unlock", normalized_path]
    return GitPreparedCommand(
        argv=tuple(argv),
        summary=f"Worktree {request.action}: {normalized_path}",
        timeout_seconds=300,
        result_data={"action": request.action, "worktree_path": normalized_path},
    )


def _prepare_lfs_action(request: GitLfsCommandRequest) -> GitPreparedCommand:
    argv = ["lfs", request.action]
    if request.remote:
        argv.append(validate_remote_name(request.remote))
    if request.refspec:
        argv.append(validate_revision(request.refspec))
    return GitPreparedCommand(
        argv=tuple(argv),
        summary=f"Git LFS {request.action}",
        timeout_seconds=1800,
        result_data={
            "action": request.action,
            "remote": request.remote,
            "refspec": request.refspec,
        },
    )


def _prepare_conflict_action(
    request: GitConflictActionCommandRequest,
) -> GitPreparedCommand:
    path = validate_repo_relative_path(request.path)
    if any(character in path for character in "\r\n\t"):
        raise GitApiError(
            "git_validation_failed", "Conflict paths cannot contain control characters"
        )
    stages = sorted(request.expected_stages, key=lambda item: item.stage)
    expected_unmerged = "".join(
        f"{item.mode} {item.object_id} {item.stage}\t{path}\n" for item in stages
    )
    if request.action == "reopen":
        assert request.resolved_index_entry is not None
        zero_object = "0" * len(stages[0].object_id)
        index_info = f"0 {zero_object} 0\t{path}\n" + expected_unmerged
        return GitPreparedCommand(
            argv=("update-index", "--index-info"),
            input_text=index_info,
            summary=f"Reopened conflict for {path}",
            identity_checks=((('ls-files', '-s', '--', path), request.resolved_index_entry),),
            result_data={"action": request.action, "path": path},
        )
    identity_checks = ((('ls-files', '-u', '--', path), expected_unmerged.strip()),)
    if request.action == "mark_resolved":
        return GitPreparedCommand(
            argv=("add", "--", path),
            summary=f"Marked {path} resolved",
            identity_checks=identity_checks,
            result_queries=(("resolved_index", ("ls-files", "-s", "--", path)),),
            result_data={"action": request.action, "path": path},
        )
    if request.action in {"delete", "accept_delete"}:
        return GitPreparedCommand(
            argv=("rm", "--", path),
            summary=f"Accepted deletion for {path}",
            identity_checks=identity_checks,
            result_data={"action": request.action, "path": path},
        )
    label = request.action.removeprefix("accept_")
    if request.action == "keep_modified":
        labels = {2: "ours", 3: "theirs"}
        available = [labels[item.stage] for item in stages if item.stage in labels]
        if len(available) != 1:
            raise GitApiError(
                "git_validation_failed", "Delete/modify conflict has no unique modified side"
            )
        label = available[0]
    target_stage = 2 if label == "ours" else 3
    if not any(item.stage == target_stage for item in stages):
        raise GitApiError("git_validation_failed", f"Conflict has no {label} stage")
    return GitPreparedCommand(
        argv=("checkout", f"--{label}", "--", path),
        summary=f"Accepted {label} for {path}",
        identity_checks=identity_checks,
        result_data={"action": request.action, "path": path, "source": label},
    )


def _prepare_merge(request: GitMergeCommandRequest) -> GitPreparedCommand:
    source = validate_revision(request.source)
    argv = ["merge"]
    if request.strategy == "ff":
        argv.append("--ff")
    elif request.strategy == "no_ff":
        argv.append("--no-ff")
    else:
        argv.append("--squash")
    if request.message and request.strategy != "squash":
        argv.extend(("--message", request.message))
    elif request.strategy != "squash":
        argv.append("--no-edit")
    argv.append(source)
    return GitPreparedCommand(
        argv=tuple(argv),
        summary=f"Merged {source}" if request.strategy != "squash" else f"Squashed {source}",
        timeout_seconds=300,
    )


def _control_action_risk(
    request: GitRebaseControlCommandRequest
    | GitCherryPickControlCommandRequest
    | GitRevertControlCommandRequest,
) -> GitCommandRisk:
    return GitCommandRisk.WRITE if request.action == "continue" else GitCommandRisk.DESTRUCTIVE


def _prepare_rebase(request: GitRebaseCommandRequest) -> GitPreparedCommand:
    upstream = validate_revision(request.upstream)
    onto = validate_revision(request.onto) if request.onto else None
    argv = ["rebase"]
    environment: dict[str, str] | None = None
    if request.interactive:
        argv.append("--interactive")
        todo = "\n".join(
            f"{item.action} {validate_revision(item.object_id)} {_todo_subject(item.subject)}"
            for item in request.todo
        ) + "\n"
        editor_script = Path(__file__).with_name("sequence_editor.py")
        editor_command = (
            subprocess.list2cmdline([sys.executable, str(editor_script)])
            if os.name == "nt"
            else shlex.join([sys.executable, str(editor_script)])
        )
        environment = {
            "GIT_SEQUENCE_EDITOR": editor_command,
            "KEYDEX_REBASE_TODO": base64.b64encode(todo.encode("utf-8")).decode("ascii"),
        }
        reword_messages = {
            _todo_subject(item.subject): (item.message or "").replace("\r\n", "\n").strip()
            for item in request.todo
            if item.action == "reword"
        }
        if reword_messages:
            message_editor_script = Path(__file__).with_name("commit_message_editor.py")
            environment["GIT_EDITOR"] = (
                subprocess.list2cmdline([sys.executable, str(message_editor_script)])
                if os.name == "nt"
                else shlex.join([sys.executable, str(message_editor_script)])
            )
            environment["KEYDEX_REBASE_MESSAGES"] = base64.b64encode(
                json.dumps(reword_messages, ensure_ascii=False).encode("utf-8")
            ).decode("ascii")
    if onto:
        argv.extend(("--onto", onto))
    argv.append(upstream)
    return GitPreparedCommand(
        argv=tuple(argv),
        summary=f"Rebased onto {onto or upstream}",
        timeout_seconds=300,
        env=environment,
    )


def _prepare_rebase_control(request: GitRebaseControlCommandRequest) -> GitPreparedCommand:
    return GitPreparedCommand(
        argv=("rebase", f"--{request.action}"),
        summary=f"Rebase {request.action}",
        timeout_seconds=300,
    )


def _prepare_cherry_pick(request: GitCherryPickCommandRequest) -> GitPreparedCommand:
    commits = tuple(validate_revision(commit) for commit in request.commits)
    argv = ["cherry-pick"]
    if request.record_origin:
        argv.append("-x")
    argv.extend(commits)
    return GitPreparedCommand(
        argv=tuple(argv),
        summary=f"Cherry-picked {len(commits)} commit(s)",
        timeout_seconds=300,
        result_data={"requested_commits": list(commits), "record_origin": request.record_origin},
    )


def _prepare_cherry_pick_control(
    request: GitCherryPickControlCommandRequest,
) -> GitPreparedCommand:
    return GitPreparedCommand(
        argv=("cherry-pick", f"--{request.action}"),
        summary=f"Cherry-pick {request.action}",
        timeout_seconds=300,
    )


def _prepare_revert(request: GitRevertCommandRequest) -> GitPreparedCommand:
    commits = tuple(validate_revision(commit) for commit in request.commits)
    argv = ["revert", "--no-edit"]
    if request.mainline is not None:
        argv.extend(("--mainline", str(request.mainline)))
    argv.extend(commits)
    return GitPreparedCommand(
        argv=tuple(argv),
        summary=f"Reverted {len(commits)} commit(s)",
        timeout_seconds=300,
        result_data={"requested_commits": list(commits), "mainline": request.mainline},
    )


def _prepare_revert_control(request: GitRevertControlCommandRequest) -> GitPreparedCommand:
    return GitPreparedCommand(
        argv=("revert", f"--{request.action}"),
        summary=f"Revert {request.action}",
        timeout_seconds=300,
    )


def _prepare_reset(request: GitResetCommandRequest) -> GitPreparedCommand:
    target = validate_revision(request.target)
    return GitPreparedCommand(
        argv=("reset", f"--{request.mode}", target),
        summary=f"Reset {request.mode} to {target}",
        result_queries=(
            ("new_head", ("rev-parse", "HEAD")),
            ("recovery_head", ("rev-parse", "ORIG_HEAD")),
        ),
        result_data={"target": target, "mode": request.mode},
    )


def _prepare_restore(request: GitRestoreCommandRequest) -> GitPreparedCommand:
    paths = tuple(validate_repo_relative_path(path) for path in request.paths)
    argv = ["restore"]
    if request.source:
        argv.append(f"--source={validate_revision(request.source)}")
    if request.staged:
        argv.append("--staged")
    if request.worktree:
        argv.append("--worktree")
    argv.extend(("--", *paths))
    destinations = "index and worktree" if request.staged and request.worktree else (
        "index" if request.staged else "worktree"
    )
    return GitPreparedCommand(
        argv=tuple(argv),
        summary=f"Restored {len(paths)} path(s) in {destinations}",
        result_data={
            "paths": list(paths),
            "source": request.source,
            "staged": request.staged,
            "worktree": request.worktree,
        },
    )


def _todo_subject(subject: str) -> str:
    normalized = " ".join(subject.replace("\x00", " ").splitlines()).strip()
    return normalized or "Keydex rebase item"


def _prepare_commit(request: GitCommitCommandRequest) -> GitPreparedCommand:
    argv = ["commit", "--file=-"]
    if request.amend:
        argv.append("--amend")
    if request.sign:
        argv.append("-S")
    if request.paths:
        argv.extend(("--only", "--", *request.paths))
    setup_commands = (
        (("add", "--intent-to-add", "--", *request.untracked_paths),)
        if request.untracked_paths
        else ()
    )
    failure_commands = (
        (("reset", "--", *request.untracked_paths),)
        if request.untracked_paths
        else ()
    )
    return GitPreparedCommand(
        argv=tuple(argv),
        input_text=request.message,
        summary="Amended commit" if request.amend else "Created commit",
        setup_commands=setup_commands,
        failure_commands=failure_commands,
        result_queries=(("oid", ("rev-parse", "HEAD")),),
    )


def _prepare_apply_patch(request: GitPatchCommandRequest) -> GitPreparedCommand:
    patch = request.patch.replace("\r\n", "\n")
    if "\x00" in patch or "diff --git " not in patch or "@@ " not in patch:
        raise GitApiError(
            "git_validation_failed",
            "Git patch must be a unified diff without NUL bytes",
        )
    for line in patch.splitlines():
        if line.startswith(("--- ", "+++ ", "diff --git ")) and ("../" in line or "..\\" in line):
            raise GitApiError(
                "git_validation_failed",
                "Git patch paths must remain inside the repository",
            )
    argv = ["apply", "--unidiff-zero", "--whitespace=nowarn"]
    if request.cached:
        argv.append("--cached")
    if request.reverse:
        argv.append("--reverse")
    if request.check_only:
        argv.append("--check")
    if request.reject:
        argv.append("--reject")
    argv.append("-")
    identity_checks: tuple[tuple[tuple[str, ...], str], ...] = ()
    if request.expected_source_patch is not None:
        source_argv = ["diff", "--no-ext-diff", "--binary", "--find-renames"]
        if request.source_kind == "index":
            source_argv.append("--cached")
        source_argv.extend(["--", *request.source_paths])
        identity_checks = ((
            tuple(source_argv),
            request.expected_source_patch.replace("\r\n", "\n").strip(),
        ),)
    return GitPreparedCommand(
        argv=tuple(argv),
        input_text=patch,
        identity_checks=identity_checks,
        summary=(
            "Patch dry-run passed"
            if request.check_only
            else "Applied patch to index"
            if request.cached
            else "Applied patch to worktree"
        ),
        result_data={
            "check_only": request.check_only,
            "cached": request.cached,
            "reverse": request.reverse,
            "reject": request.reject,
        },
    )


def _prepare_create_branch(request: GitBranchCommandRequest) -> GitPreparedCommand:
    branch = validate_ref_name(request.branch_name)
    start_point = validate_revision(request.start_point)
    argv = ["switch", "-c", branch]
    if request.track:
        argv.append("--track")
    argv.append(start_point)
    return GitPreparedCommand(
        argv=tuple(argv),
        summary=f"Created and switched to {branch}",
    )


def _prepare_rename_branch(request: GitBranchRenameCommandRequest) -> GitPreparedCommand:
    old_name = validate_ref_name(request.old_name)
    new_name = validate_ref_name(request.new_name)
    return GitPreparedCommand(
        argv=("branch", "--move", old_name, new_name),
        summary=f"Renamed {old_name} to {new_name}",
    )


def _prepare_delete_branch(request: GitBranchDeleteCommandRequest) -> GitPreparedCommand:
    branch = validate_ref_name(request.branch_name)
    if request.remote:
        remote = validate_remote_name(request.remote)
        return GitPreparedCommand(
            argv=("push", remote, "--delete", branch),
            summary=f"Deleted {remote}/{branch}",
            timeout_seconds=300,
        )
    flag = "-D" if request.force else "-d"
    return GitPreparedCommand(argv=("branch", flag, branch), summary=f"Deleted {branch}")


def _prepare_create_tag(request: GitTagCreateCommandRequest) -> GitPreparedCommand:
    tag = validate_ref_name(request.tag_name)
    target = validate_revision(request.target)
    argv = ["tag"]
    if request.sign:
        argv.extend(("--sign", "--message", request.message or tag))
    elif request.annotated:
        argv.extend(("--annotate", "--message", request.message or tag))
    argv.extend((tag, target))
    return GitPreparedCommand(argv=tuple(argv), summary=f"Created tag {tag}")


def _prepare_delete_tag(request: GitTagDeleteCommandRequest) -> GitPreparedCommand:
    tag = validate_ref_name(request.tag_name)
    if request.remote:
        remote = validate_remote_name(request.remote)
        return GitPreparedCommand(
            argv=("push", remote, "--delete", f"refs/tags/{tag}"),
            summary=f"Deleted {remote} tag {tag}",
            timeout_seconds=300,
        )
    return GitPreparedCommand(argv=("tag", "--delete", tag), summary=f"Deleted tag {tag}")


def _prepare_checkout(request: GitCheckoutCommandRequest) -> GitPreparedCommand:
    ref = validate_revision(request.ref)
    argv = ("switch", "--detach", ref) if request.detach else ("switch", ref)
    return GitPreparedCommand(argv=argv, summary=f"Switched to {ref}")


def _prepare_fetch(request: GitFetchCommandRequest) -> GitPreparedCommand:
    if request.all_remotes:
        argv = ["fetch", "--all"]
        target = "all remotes"
    elif request.remote:
        target = validate_remote_name(request.remote)
        argv = ["fetch", target]
    else:
        raise GitApiError("git_validation_failed", "Fetch requires a remote or all remotes")
    normalized_refspec: str | None = None
    if request.refspec:
        if request.all_remotes:
            raise GitApiError("git_validation_failed", "A fetch refspec requires one remote")
        source, separator, target_ref = request.refspec.partition(":")
        if not separator:
            raise GitApiError(
                "git_validation_failed",
                "Fetch refspec must include a source and target",
            )
        normalized_refspec = f"{validate_ref_name(source)}:{validate_ref_name(target_ref)}"
    # Keep the API contract deterministic even when the user has configured
    # fetch.prune globally or for this repository.  The UI's unchecked state
    # means "retain stale remote-tracking refs", not "inherit Git config".
    argv.append("--prune" if request.prune else "--no-prune")
    if request.tags:
        argv.append("--tags")
    argv.append("--progress")
    if normalized_refspec:
        argv.append(normalized_refspec)
    return GitPreparedCommand(
        argv=tuple(argv),
        summary=f"Fetched {target}",
        timeout_seconds=300,
        result_data={
            "remote": None if request.all_remotes else target,
            "all_remotes": request.all_remotes,
        },
    )


def _parse_fetch_result(result: GitCommandResult) -> dict[str, object]:
    lines = [
        line.strip() for line in result.safe_stderr.replace("\r", "\n").splitlines() if line.strip()
    ]
    return {
        "status": "fetched",
        "progress_lines": lines[-40:],
        "output_truncated": result.stderr_truncated,
    }


def _prepare_add_remote(request: GitRemoteAddCommandRequest) -> GitPreparedCommand:
    remote = validate_remote_name(request.remote_name)
    url = validate_remote_url(request.url)
    return GitPreparedCommand(argv=("remote", "add", remote, url), summary=f"Added {remote}")


def _prepare_rename_remote(request: GitRemoteRenameCommandRequest) -> GitPreparedCommand:
    old_name = validate_remote_name(request.old_name)
    new_name = validate_remote_name(request.new_name)
    return GitPreparedCommand(
        argv=("remote", "rename", old_name, new_name),
        summary=f"Renamed {old_name} to {new_name}",
    )


def _prepare_set_remote_url(request: GitRemoteSetUrlCommandRequest) -> GitPreparedCommand:
    remote = validate_remote_name(request.remote_name)
    url = validate_remote_url(request.url)
    argv = ["remote", "set-url"]
    if request.push:
        argv.append("--push")
    argv.extend((remote, url))
    return GitPreparedCommand(argv=tuple(argv), summary=f"Updated {remote} URL")


def _prepare_remove_remote(request: GitRemoteRemoveCommandRequest) -> GitPreparedCommand:
    remote = validate_remote_name(request.remote_name)
    return GitPreparedCommand(argv=("remote", "remove", remote), summary=f"Removed {remote}")


def _prepare_set_upstream(request: GitUpstreamCommandRequest) -> GitPreparedCommand:
    branch = validate_ref_name(request.branch_name)
    if request.upstream:
        upstream = validate_ref_name(request.upstream)
        return GitPreparedCommand(
            argv=("branch", f"--set-upstream-to={upstream}", branch),
            summary=f"Set {branch} upstream to {upstream}",
        )
    return GitPreparedCommand(
        argv=("branch", "--unset-upstream", branch),
        summary=f"Unset {branch} upstream",
    )


def _prepare_push(request: GitPushCommandRequest) -> GitPreparedCommand:
    remote = validate_remote_name(request.remote)
    if request.tags and request.follow_tags:
        raise GitApiError(
            "git_validation_failed",
            "Push tags and follow tags are mutually exclusive",
        )
    if request.tag_name:
        if request.force_with_lease or request.set_upstream or request.tags or request.follow_tags:
            raise GitApiError(
                "git_validation_failed",
                "A single tag push cannot be combined with branch push options",
            )
        tag_name = validate_ref_name(request.tag_name)
        return GitPreparedCommand(
            argv=("push", remote, f"refs/tags/{tag_name}:refs/tags/{tag_name}"),
            summary=f"Pushed tag {tag_name} to {remote}",
            timeout_seconds=300,
            result_data={"remote": remote},
        )
    argv = ["push"]
    if request.force_with_lease:
        argv.append("--force-with-lease")
    if request.set_upstream:
        argv.append("--set-upstream")
    if request.tags:
        argv.append("--tags")
    elif request.follow_tags:
        argv.append("--follow-tags")
    argv.append(remote)
    source = validate_ref_name(request.source)
    target = validate_ref_name(request.target)
    argv.append(f"{source}:refs/heads/{target}")
    return GitPreparedCommand(
        argv=tuple(argv),
        summary=f"Pushed to {remote}",
        timeout_seconds=300,
        result_data={"remote": remote},
    )


def _preflight_push(request: GitPushCommandRequest) -> None:
    if request.tag_name:
        return
    target = validate_ref_name(request.target)
    if request.force_with_lease and target.casefold() in {"main", "master"}:
        raise GitApiError(
            "git_operation_conflict",
            f"Force push is blocked for protected branch {target}",
        )


def _parse_push_result(result: GitCommandResult) -> dict[str, object]:
    output = "\n".join(
        part.strip() for part in (result.safe_stdout, result.safe_stderr) if part.strip()
    )
    return {"status": "pushed", "output": output}


def _prepare_stash_push(request: GitStashPushCommandRequest) -> GitPreparedCommand:
    if request.staged and request.include_untracked:
        raise GitApiError(
            "git_validation_failed",
            "Stash staged-only and include-untracked options cannot be combined",
        )
    argv = ["stash", "push"]
    if request.staged:
        argv.append("--staged")
    if request.include_untracked:
        argv.append("--include-untracked")
    if request.message:
        argv.extend(("--message", request.message))
    return GitPreparedCommand(argv=tuple(argv), summary="Created stash")


def _prepare_stash_entry(
    action: str,
    request: GitStashEntryCommandRequest,
) -> GitPreparedCommand:
    selector = request.selector
    object_id = validate_revision(request.object_id)
    argv = ["stash", action]
    if action in {"apply", "pop"} and request.reinstate_index:
        argv.append("--index")
    argv.append(object_id if action == "apply" else selector)
    return GitPreparedCommand(
        argv=tuple(argv),
        summary=f"Stash {action} completed",
        identity_checks=((("rev-parse", "--verify", selector), object_id),),
    )


def _prepare_stash_branch(request: GitStashBranchCommandRequest) -> GitPreparedCommand:
    selector = request.selector
    object_id = validate_revision(request.object_id)
    branch = validate_ref_name(request.branch_name)
    return GitPreparedCommand(
        argv=("stash", "branch", branch, selector),
        summary=f"Created {branch} from {selector}",
        identity_checks=((("rev-parse", "--verify", selector), object_id),),
    )


def _prepare_update(request: GitUpdateCommandRequest) -> GitPreparedCommand:
    remote = validate_remote_name(request.remote)
    strategy_args = {
        "ff_only": ("--ff-only",),
        "merge": ("--no-rebase",),
        "rebase": ("--rebase",),
    }[request.strategy]
    argv = ["pull", *strategy_args, remote, validate_ref_name(request.refspec)]
    return GitPreparedCommand(
        argv=tuple(argv),
        summary=f"Updated from {remote} with {request.strategy}",
        timeout_seconds=300,
        result_data={"remote": remote},
    )


def _parse_update_result(result: GitCommandResult) -> dict[str, object]:
    output = "\n".join(
        part.strip() for part in (result.safe_stdout, result.safe_stderr) if part.strip()
    )
    normalized = output.casefold()
    status = (
        "up_to_date"
        if "already up to date" in normalized or "already up-to-date" in normalized
        else "updated"
    )
    return {"status": status, "output": output}
