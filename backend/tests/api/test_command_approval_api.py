from __future__ import annotations

from fastapi.testclient import TestClient

from backend.app.command_approval import approval_to_payload
from backend.app.core.config import AppSettings
from backend.app.main import create_app
from backend.app.tools.command_runtime.discovery import ShellDiscoveryResult


def test_settings_api_validates_and_saves_command_runtime_without_losing_model(
    tmp_path,
    monkeypatch,
) -> None:
    discovered_path = tmp_path / "cmd.exe"
    discovered_path.write_text("", encoding="utf-8")

    monkeypatch.setattr(
        "backend.app.api.settings.discover_shell",
        lambda shell, manual_path=None: ShellDiscoveryResult(
            shell=shell,
            found=True,
            path=str(discovered_path),
            label="Windows CMD",
            diagnostics=[],
        ),
    )
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    with TestClient(app) as client:
        response = client.get("/api/settings")
        assert response.status_code == 200
        assert response.json()["command"]["selected_shell"] == "git_bash"
        assert response.json()["command"]["file_access_mode"] == "workspace_trusted"

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
                    "command_enabled": True,
                    "selected_shell": "cmd",
                    "shell_path": str(discovered_path),
                    "require_approval_for_untrusted": True,
                    "allow_persistent_trust": False,
                    "file_access_mode": "workspace_read_only",
                    "default_timeout_seconds": 3,
                    "max_timeout_seconds": 9,
                    "inline_output_max_chars": 1024,
                    "tail_max_chars": 1024,
                    "output_file_max_bytes": 65536,
                }
            },
        )

        assert command_response.status_code == 200
        payload = command_response.json()
        assert payload["command"]["command_enabled"] is True
        assert payload["command"]["selected_shell"] == "cmd"
        assert payload["command"]["shell_path"] == str(discovered_path)
        assert payload["command"]["shell_label"] == "Windows CMD"
        assert payload["command"]["shells"]["cmd"]["shell_path"] == str(discovered_path)
        assert payload["command"]["allow_persistent_trust"] is False
        assert payload["command"]["file_access_mode"] == "workspace_read_only"
        assert payload["model"]["model"] == "qwen3-coder"


def test_settings_api_rejects_unavailable_runtime_without_overwriting_existing(
    tmp_path,
    monkeypatch,
) -> None:
    first_path = tmp_path / "cmd.exe"
    first_path.write_text("", encoding="utf-8")
    calls = []

    def fake_discover(shell, manual_path=None):
        calls.append(shell)
        if len(calls) == 1:
            return ShellDiscoveryResult(
                shell=shell,
                found=True,
                path=str(first_path),
                label="Windows CMD",
            )
        return ShellDiscoveryResult(shell=shell, found=False, error="missing Git Bash")

    monkeypatch.setattr("backend.app.api.settings.discover_shell", fake_discover)
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    with TestClient(app) as client:
        saved = client.put(
            "/api/settings",
            json={
                "command": {
                    "command_enabled": True,
                    "selected_shell": "cmd",
                    "shell_path": str(first_path),
                }
            },
        )
        assert saved.status_code == 200

        failed = client.put(
            "/api/settings",
            json={
                "command": {
                    "command_enabled": True,
                    "selected_shell": "git_bash",
                    "shell_path": str(tmp_path / "Git" / "bin" / "bash.exe"),
                }
            },
        )

        assert failed.status_code == 400
        assert failed.json()["detail"]["code"] == "command_runtime_unavailable"
        current = client.get("/api/settings").json()["command"]
        assert current["selected_shell"] == "cmd"
        assert current["shell_path"] == str(first_path)


def test_settings_api_saves_disabled_command_without_runtime_validation(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "backend.app.api.settings.discover_shell",
        lambda shell, manual_path=None: ShellDiscoveryResult(
            shell=shell,
            found=False,
            error="not called",
        ),
    )
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    with TestClient(app) as client:
        response = client.put(
            "/api/settings",
            json={
                "command": {
                    "command_enabled": False,
                    "selected_shell": "git_bash",
                    "shell_path": "",
                }
            },
        )

    assert response.status_code == 200
    payload = response.json()["command"]
    assert payload["command_enabled"] is False
    assert payload["selected_shell"] == "git_bash"


def test_settings_api_reads_legacy_bash_command_settings(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    app.state.repositories.settings.set(
        "command_settings",
        {
            "selected_shell": "bash",
            "shell_path": r"C:\Windows\System32\bash.exe",
            "shell_label": "Bash",
            "require_approval_for_untrusted": True,
        },
    )

    with TestClient(app) as client:
        response = client.get("/api/settings")

    assert response.status_code == 200
    payload = response.json()["command"]
    assert payload["command_enabled"] is True
    assert payload["selected_shell"] == "git_bash"
    assert payload["shell_path"] == ""
    assert payload["shell_label"] == ""


def test_command_runtime_probe_endpoints_return_discovery_payload(tmp_path, monkeypatch) -> None:
    bash = tmp_path / "Git" / "bin" / "bash.exe"
    bash.parent.mkdir(parents=True)
    bash.write_text("", encoding="utf-8")
    monkeypatch.setattr(
        "backend.app.api.settings.discover_shell",
        lambda shell, manual_path=None: ShellDiscoveryResult(
            shell=shell,
            found=True,
            path=str(bash),
            label="Git Bash",
            edition="git-bash",
        ),
    )
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    with TestClient(app) as client:
        response = client.post(
            "/api/settings/command/runtime/validate",
            json={"selected_shell": "git_bash", "shell_path": str(bash)},
        )

    assert response.status_code == 200
    assert response.json()["label"] == "Git Bash"


def test_trusted_rule_api_lists_disables_and_deletes(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    repositories = app.state.repositories
    rule = repositories.trusted_command_rules.create(
        rule_id="rule-api",
        command_pattern="pnpm test",
        normalized_command="pnpm test",
        match_type="exact",
        tool_name="run_cmd",
        shell="cmd",
        shell_path=r"C:\Windows\System32\cmd.exe",
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
        tool_name="run_cmd",
        shell="cmd",
        details={"command": "pnpm test", "shell_path": r"C:\Windows\System32\cmd.exe"},
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
        rule = repositories.trusted_command_rules.get(payload["trusted_rule_id"])
        assert rule is not None
        assert rule.tool_name == "run_cmd"
        assert rule.shell_path.endswith("cmd.exe")

        history = client.get("/api/settings/command/approval-history")
        assert history.status_code == 200
        assert history.json()["total"] == 1
        assert history.json()["list"][0]["approval_id"] == "approval-api"


def test_approval_decision_is_idempotent_and_persists_resolved_event(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    repositories = app.state.repositories

    with TestClient(app) as client:
        repositories.sessions.create(
            session_id="ses-idempotent-approval",
            user_id="local-user",
            scene_id="desktop-agent",
            title="幂等审批",
        )
        repositories.command_approvals.create(
            approval_id="approval-idempotent",
            session_id="ses-idempotent-approval",
            command="pnpm test",
            cwd=".",
            title="是否允许执行命令？",
            workspace_root="d:/project",
            tool_name="run_cmd",
            shell="cmd",
            turn_index=1,
            run_id="run-idempotent",
            details={"command": "pnpm test"},
        )

        first = client.post(
            "/api/approvals/approval-idempotent/decision",
            json={"decision": "rejected", "trust_scope": "once"},
        )
        repeated = client.post(
            "/api/approvals/approval-idempotent/decision",
            json={"decision": "approved", "trust_scope": "once"},
        )

    assert first.status_code == 200
    assert repeated.status_code == 200
    assert first.json()["status"] == "rejected"
    assert repeated.json()["status"] == "rejected"
    audits, total = repositories.command_approval_audit.list(
        session_id="ses-idempotent-approval"
    )
    assert total == 1
    assert audits[0].decision == "rejected"
    resolution_events = [
        event
        for event in repositories.message_events.list_by_session(
            "ses-idempotent-approval"
        )
        if event.action == "approval_resolved"
    ]
    assert len(resolution_events) == 1
    assert resolution_events[0].data["approval"]["status"] == "rejected"


def test_history_reconciles_stale_pending_approval_from_authoritative_record(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    repositories = app.state.repositories

    with TestClient(app) as client:
        repositories.sessions.create(
            session_id="ses-stale-approval",
            user_id="local-user",
            scene_id="desktop-agent",
            title="历史审批恢复",
        )
        pending = repositories.command_approvals.create(
            approval_id="approval-stale-history",
            session_id="ses-stale-approval",
            command="pnpm test",
            cwd=".",
            title="是否允许执行命令？",
            workspace_root="d:/project",
            tool_name="run_cmd",
            shell="cmd",
            turn_index=1,
            run_id="run-stale-history",
            details={"command": "pnpm test", "tool_name": "run_cmd"},
        )
        repositories.message_events.append_many(
            session_id="ses-stale-approval",
            events=[
                {
                    "event_id": "evt-stale-tool-start",
                    "turn_index": 1,
                    "action": "tool_start",
                    "data": {
                        "tool": "run_cmd",
                        "run_id": "run-stale-history",
                        "tool_call_id": "call-stale-history",
                        "params": {"command": "pnpm test"},
                    },
                },
                {
                    "event_id": "evt-stale-approval-requested",
                    "turn_index": 1,
                    "action": "approval_requested",
                    "data": {"approval": approval_to_payload(pending)},
                },
            ],
        )
        repositories.command_approvals.resolve(
            pending.id,
            status="rejected",
            decision="rejected",
            trust_scope="once",
        )

        response = client.get(
            "/api/sessions/ses-stale-approval/history?all_turns=true"
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["pending_approvals"] == []
    approval_messages = [
        message for message in payload["list"] if message["role"] == "approval"
    ]
    assert len(approval_messages) == 1
    assert approval_messages[0]["status"] == "rejected"
    assert approval_messages[0]["approval"]["status"] == "rejected"


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


def test_mcp_approval_decision_api_resolves_mcp_tool_call_without_trusted_command_rule(
    tmp_path,
) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    repositories = app.state.repositories
    repositories.sessions.create(
        session_id="ses-mcp-api",
        user_id="local-user",
        scene_id="desktop-agent",
        title="MCP 审批 API",
    )
    repositories.mcp_servers.create(
        server_id="srv_exec",
        name="Execution MCP",
        transport="streamable_http",
        url="https://mcp.example.test/mcp",
    )
    repositories.command_approvals.create(
        approval_id="approval-mcp-api",
        session_id="ses-mcp-api",
        command="mcp__srv_exec__search",
        cwd=".",
        title="允许 Execution MCP MCP 执行 search？",
        tool_name="mcp__srv_exec__search",
        shell="mcp",
        kind="mcp_tool_call",
        details={
            "approval_kind": "mcp_tool_call",
            "snapshot_id": "snap-a",
            "server_id": "srv_exec",
            "server_name": "Execution MCP",
            "raw_tool_name": "search",
            "model_tool_name": "mcp__srv_exec__search",
            "approval_mode": "auto",
            "arguments_preview": {"query": "hello"},
            "trust_options": ["once", "session", "persistent_tool", "persistent_server"],
            "matched_rule": None,
        },
    )

    with TestClient(app) as client:
        response = client.post(
            "/api/mcp/approvals/approval-mcp-api/decision",
            json={
                "decision": "approved",
                "trust_scope": "session",
            },
        )

    assert response.status_code == 200
    payload = response.json()
    audits, total = repositories.command_approval_audit.list(session_id="ses-mcp-api")
    assert payload["kind"] == "mcp_tool_call"
    assert payload["approval_kind"] == "mcp_tool_call"
    assert payload["status"] == "approved"
    assert payload["trust_scope"] == "session"
    assert payload["server_id"] == "srv_exec"
    assert payload["raw_tool_name"] == "search"
    assert payload["trust_options"] == [
        "once",
        "session",
        "persistent_tool",
        "persistent_server",
    ]
    assert repositories.trusted_command_rules.list() == []
    assert repositories.mcp_trust_rules.list(scope="session", session_id="ses-mcp-api")
    assert total == 1
    assert audits[0].metadata["kind"] == "mcp_tool_call"
    assert audits[0].metadata["mcp"]["server_id"] == "srv_exec"
    assert audits[0].metadata["mcp"]["trust_rule_id"]


def test_mcp_approval_decision_api_can_trust_entire_mcp_server(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    repositories = app.state.repositories
    repositories.sessions.create(
        session_id="ses-mcp-server-api",
        user_id="local-user",
        scene_id="desktop-agent",
        title="MCP 服务器信任",
    )
    repositories.mcp_servers.create(
        server_id="srv_exec",
        name="Execution MCP",
        transport="streamable_http",
        url="https://mcp.example.test/mcp",
        default_tool_approval_mode="prompt",
    )
    repositories.command_approvals.create(
        approval_id="approval-mcp-server-api",
        session_id="ses-mcp-server-api",
        command="mcp__srv_exec__search",
        cwd=".",
        title="允许 Execution MCP MCP 执行 search？",
        tool_name="mcp__srv_exec__search",
        shell="mcp",
        kind="mcp_tool_call",
        details={
            "approval_kind": "mcp_tool_call",
            "snapshot_id": "snap-a",
            "server_id": "srv_exec",
            "server_name": "Execution MCP",
            "raw_tool_name": "search",
            "model_tool_name": "mcp__srv_exec__search",
            "approval_mode": "prompt",
            "arguments_preview": {"query": "hello"},
            "trust_options": ["once", "session", "persistent_tool", "persistent_server"],
            "matched_rule": None,
        },
    )

    with TestClient(app) as client:
        response = client.post(
            "/api/mcp/approvals/approval-mcp-server-api/decision",
            json={
                "decision": "approved",
                "trust_scope": "persistent_server",
            },
        )

    server = repositories.mcp_servers.get("srv_exec")
    audits, total = repositories.command_approval_audit.list(session_id="ses-mcp-server-api")
    mcp_audits, mcp_total = repositories.mcp_audit_log.list(event_type="server.updated")
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "approved"
    assert payload["trust_scope"] == "persistent_server"
    assert server is not None
    assert server.default_tool_approval_mode == "approve"
    assert repositories.trusted_command_rules.list() == []
    assert repositories.mcp_trust_rules.list() == []
    assert total == 1
    assert audits[0].metadata["mcp"]["server_trusted"] is True
    assert mcp_total == 1
    assert mcp_audits[0].detail["default_tool_approval_mode"] == "approve"
    assert mcp_audits[0].detail["trust_scope"] == "persistent_server"


def test_mcp_approval_decision_api_rejects_exec_approval(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    repositories = app.state.repositories
    repositories.sessions.create(
        session_id="ses-mcp-api",
        user_id="local-user",
        scene_id="desktop-agent",
        title="MCP 审批 API",
    )
    repositories.command_approvals.create(
        approval_id="approval-exec-api",
        session_id="ses-mcp-api",
        command="pnpm test",
        cwd=".",
        title="是否允许执行命令？",
        tool_name="run_cmd",
        shell="cmd",
    )

    with TestClient(app) as client:
        response = client.post(
            "/api/mcp/approvals/approval-exec-api/decision",
            json={
                "decision": "approved",
                "trust_scope": "session",
            },
        )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "invalid_mcp_approval"
    assert repositories.command_approvals.get("approval-exec-api").status == "pending"
