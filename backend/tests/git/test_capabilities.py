from __future__ import annotations

import subprocess

from backend.app.git.capabilities import parse_git_version, probe_git_capabilities


def completed(argv: list[str], returncode: int, stdout: str = "", stderr: str = ""):
    return subprocess.CompletedProcess(argv, returncode, stdout, stderr)


def test_parse_git_version_accepts_vendor_suffixes_and_rejects_unknown_output() -> None:
    assert parse_git_version("git version 2.49.0.windows.1") == (2, 49, 0)
    assert parse_git_version("git version 2.43.1 (Apple Git-155)") == (2, 43, 1)
    assert parse_git_version("not git") is None


def test_probe_reports_missing_and_invalid_git_without_crashing() -> None:
    assert probe_git_capabilities(which=lambda _name: None).model_dump() == {
        "available": False,
        "executable": None,
        "version": None,
        "supports_switch": False,
        "supports_restore": False,
        "supports_pathspec_from_file": False,
        "lfs_available": False,
        "reason": "git executable was not found",
    }
    invalid = probe_git_capabilities(
        executable="git",
        execute=lambda argv: completed(argv, 0, "unexpected"),
    )
    assert invalid.available is False
    assert invalid.reason == "git returned an unsupported version response"


def test_probe_builds_version_feature_matrix_and_independent_lfs_capability() -> None:
    def execute(argv: list[str]):
        if argv[1:] == ["--version"]:
            return completed(argv, 0, "git version 2.49.0.windows.1\n")
        return completed(argv, 0, "git-lfs/3.6.1 (GitHub; windows amd64; go 1.23.0)\n")

    capability = probe_git_capabilities(executable="C:/Git/bin/git.exe", execute=execute)
    assert capability.available is True
    assert capability.version == "2.49.0"
    assert capability.supports_switch is True
    assert capability.supports_restore is True
    assert capability.supports_pathspec_from_file is True
    assert capability.lfs_available is True


def test_probe_exposes_old_git_without_claiming_new_commands() -> None:
    def execute(argv: list[str]):
        if argv[1:] == ["--version"]:
            return completed(argv, 0, "git version 2.12.5")
        return completed(argv, 1, stderr="git: 'lfs' is not a git command")

    capability = probe_git_capabilities(executable="git", execute=execute)
    assert capability.available is True
    assert capability.supports_switch is False
    assert capability.supports_restore is False
    assert capability.supports_pathspec_from_file is False
    assert capability.lfs_available is False
