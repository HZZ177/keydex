from __future__ import annotations

import time

from backend.app.storage import StorageRepositories, init_database


def _repositories(tmp_path) -> StorageRepositories:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.sessions.create(
        session_id="ses-approval",
        user_id="local-user",
        scene_id="desktop-agent",
        title="审批会话",
    )
    return repositories


def test_command_approval_repository_create_list_and_resolve(tmp_path) -> None:
    repositories = _repositories(tmp_path)

    approval = repositories.command_approvals.create(
        approval_id="approval-1",
        session_id="ses-approval",
        command="pnpm test",
        cwd=".",
        title="是否允许执行命令？",
        details={"command": "pnpm test"},
    )

    assert approval.status == "pending"
    assert repositories.command_approvals.get("approval-1") == approval
    assert repositories.command_approvals.list_pending(session_id="ses-approval") == [approval]

    resolved = repositories.command_approvals.resolve(
        "approval-1",
        status="approved",
        decision="approved",
        trust_scope="once",
    )

    assert resolved is not None
    assert resolved.status == "approved"
    assert resolved.decision == "approved"
    assert repositories.command_approvals.list_pending(session_id="ses-approval") == []


def test_trusted_command_rules_crud_and_last_used(tmp_path) -> None:
    repositories = _repositories(tmp_path)

    rule = repositories.trusted_command_rules.create(
        rule_id="rule-1",
        command_pattern="pnpm test",
        normalized_command="pnpm test",
        match_type="exact",
        shell="shell",
        workspace_root="d:/project",
        cwd_pattern=".",
    )

    assert rule.enabled is True
    assert repositories.trusted_command_rules.list() == [rule]

    disabled = repositories.trusted_command_rules.set_enabled("rule-1", False)
    assert disabled is not None
    assert disabled.enabled is False

    touched = repositories.trusted_command_rules.touch_last_used("rule-1")
    assert touched is not None
    assert touched.last_used_at is not None

    assert repositories.trusted_command_rules.delete("rule-1") is True
    assert repositories.trusted_command_rules.list() == []


def test_command_approval_audit_lists_latest_first(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    for index in range(2):
        repositories.command_approvals.create(
            approval_id=f"approval-{index}",
            session_id="ses-approval",
            command=f"echo {index}",
            cwd=".",
            title="是否允许执行命令？",
        )
        repositories.command_approval_audit.create(
            audit_id=f"audit-{index}",
            approval_id=f"approval-{index}",
            session_id="ses-approval",
            command=f"echo {index}",
            cwd=".",
            decision="approved",
        )
        time.sleep(0.001)

    records, total = repositories.command_approval_audit.list()

    assert total == 2
    assert [record.id for record in records] == ["audit-1", "audit-0"]
