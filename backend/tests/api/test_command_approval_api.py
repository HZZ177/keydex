from __future__ import annotations

from fastapi.testclient import TestClient

from backend.app.core.config import AppSettings
from backend.app.main import create_app


def test_settings_api_reads_and_writes_command_settings_without_losing_model(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    with TestClient(app) as client:
        response = client.get("/api/settings")
        assert response.status_code == 200
        assert response.json()["command"]["command_enabled"] is True

        model_response = client.put(
            "/api/settings",
            json={
                "model": {
                    "base_url": "http://provider.test/v1",
                    "api_key": "sk-1234567890",
                    "model": "qwen3-coder",
                }
            },
        )
        assert model_response.status_code == 200

        command_response = client.put(
            "/api/settings",
            json={
                "command": {
                    "command_enabled": False,
                    "require_approval_for_untrusted": True,
                    "allow_persistent_trust": False,
                    "default_timeout_seconds": 3,
                    "max_timeout_seconds": 9,
                    "max_output_chars": 128,
                }
            },
        )

        assert command_response.status_code == 200
        payload = command_response.json()
        assert payload["command"]["command_enabled"] is False
        assert payload["command"]["allow_persistent_trust"] is False
        assert payload["model"]["model"] == "qwen3-coder"


def test_trusted_rule_api_lists_disables_and_deletes(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    repositories = app.state.repositories
    rule = repositories.trusted_command_rules.create(
        rule_id="rule-api",
        command_pattern="pnpm test",
        normalized_command="pnpm test",
        match_type="exact",
        shell="shell",
        workspace_root="d:/project",
        cwd_pattern=".",
    )

    with TestClient(app) as client:
        listed = client.get("/api/settings/command/trusted-rules")
        assert listed.status_code == 200
        assert listed.json()["list"][0]["id"] == rule.id

        disabled = client.patch(
            f"/api/settings/command/trusted-rules/{rule.id}",
            json={"enabled": False},
        )
        assert disabled.status_code == 200
        assert disabled.json()["enabled"] is False

        deleted = client.delete(f"/api/settings/command/trusted-rules/{rule.id}")
        assert deleted.status_code == 200
        assert deleted.json()["deleted"] is True

        assert client.get("/api/settings/command/trusted-rules").json()["list"] == []


def test_approval_decision_api_creates_trusted_rule_and_history(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    repositories = app.state.repositories
    repositories.sessions.create(
        session_id="ses-api",
        user_id="local-user",
        scene_id="desktop-agent",
        title="审批 API",
    )
    repositories.command_approvals.create(
        approval_id="approval-api",
        session_id="ses-api",
        command="pnpm test",
        cwd=".",
        title="是否允许执行命令？",
        workspace_root="d:/project",
        details={"command": "pnpm test"},
    )

    with TestClient(app) as client:
        response = client.post(
            "/api/approvals/approval-api/decision",
            json={
                "decision": "approved",
                "trust_scope": "persistent",
                "rule_match_type": "exact",
            },
        )

        assert response.status_code == 200
        payload = response.json()
        assert payload["status"] == "approved"
        assert payload["trusted_rule_id"]

        history = client.get("/api/settings/command/approval-history")
        assert history.status_code == 200
        assert history.json()["total"] == 1
        assert history.json()["list"][0]["approval_id"] == "approval-api"


def test_approval_decision_api_rejects_broad_prefix(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    repositories = app.state.repositories
    repositories.sessions.create(
        session_id="ses-api",
        user_id="local-user",
        scene_id="desktop-agent",
        title="审批 API",
    )
    repositories.command_approvals.create(
        approval_id="approval-prefix",
        session_id="ses-api",
        command="git",
        cwd=".",
        title="是否允许执行命令？",
    )

    with TestClient(app) as client:
        response = client.post(
            "/api/approvals/approval-prefix/decision",
            json={
                "decision": "approved",
                "trust_scope": "persistent",
                "rule_match_type": "prefix",
            },
        )

    assert response.status_code == 400
    message = response.json()["detail"]["message"]
    assert "过宽" in message or "过短" in message
