from backend.app.git.remote_errors import classify_remote_failure


def test_remote_errors_are_classified_into_actionable_safe_categories() -> None:
    cases = {
        (
            "fatal: Authentication failed for "
            "'https://user:secret@example.test/repo.git'"
        ): "git_credentials_missing",
        "fatal: credential helper failed: helper exploded": "git_credential_helper_failed",
        "Host key verification failed. Check known_hosts": "git_host_key_failed",
        "fatal: unable to access: Could not resolve host: example.test": "git_network_unavailable",
    }
    for diagnostic, code in cases.items():
        failure = classify_remote_failure(diagnostic)
        assert failure.code == code
        assert failure.help_action
        assert "secret" not in failure.diagnostic


def test_unknown_remote_failure_keeps_a_redacted_diagnostic() -> None:
    failure = classify_remote_failure(
        "fatal: https://person:password@example.test/repo rejected the request"
    )
    assert failure.code == "git_failed"
    assert "password" not in failure.diagnostic
    assert "***" in failure.diagnostic
