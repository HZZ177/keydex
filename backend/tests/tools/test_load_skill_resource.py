from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.app.core.request_context import reset_request_context, set_request_context
from backend.app.keydex import KeydexRuntimeCache
from backend.app.keydex.skills import KEYDEX_SKILL_MAX_RESOURCE_BYTES
from backend.app.tools.skill import run_load_skill


def _write_skill(workspace: Path, name: str = "dev-plan") -> Path:
    skill_dir = workspace / ".keydex" / "skills" / name
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "\n".join(
            [
                "---",
                f"name: {name}",
                "description: Build a structured development plan.",
                "---",
                "",
                "# Dev Plan",
            ]
        ),
        encoding="utf-8",
    )
    return skill_dir


def _snapshot(workspace: Path):
    return KeydexRuntimeCache(
        system_root=workspace / "missing-system",
    ).get_workspace_snapshot(workspace)


def _payload(command) -> dict:
    return json.loads(command.update["messages"][0].content)


async def _run_with_snapshot(workspace: Path, resource_path: str):
    token = set_request_context(keydex_snapshot=_snapshot(workspace))
    try:
        return await run_load_skill(
            skill_name="dev-plan",
            resource_path=resource_path,
            tool_call_id="call_1",
        )
    finally:
        reset_request_context(token)


@pytest.mark.asyncio
async def test_load_skill_resource_reads_valid_text_file(tmp_path: Path) -> None:
    skill_dir = _write_skill(tmp_path)
    resource = skill_dir / "references" / "guide.md"
    resource.parent.mkdir()
    resource.write_text("resource guide", encoding="utf-8")

    command = await _run_with_snapshot(tmp_path, "references/guide.md")

    payload = _payload(command)
    assert payload["found"] is True
    assert payload["loaded"] is True
    assert payload["injected"] is False
    assert payload["content"] == "resource guide"
    assert "pending_skill_activations" not in command.update


@pytest.mark.asyncio
async def test_load_skill_resource_over_model_budget_fails_without_partial_content(
    tmp_path: Path,
) -> None:
    skill_dir = _write_skill(tmp_path)
    resource = skill_dir / "references" / "large-guide.md"
    resource.parent.mkdir()
    resource.write_text("资源正文😀\n" * 5000, encoding="utf-8")

    command = await _run_with_snapshot(tmp_path, "references/large-guide.md")
    payload = _payload(command)

    assert payload["code"] == "skill_content_too_large_for_model"
    assert payload["loaded"] is False
    assert "content" not in payload
    assert "资源正文" not in command.update["messages"][0].content


@pytest.mark.asyncio
@pytest.mark.parametrize("resource_path", ["../secret.md", "..\\secret.md"])
async def test_t77_load_skill_resource_rejects_parent_escape(
    tmp_path: Path,
    resource_path: str,
) -> None:
    _write_skill(tmp_path)
    (tmp_path / ".keydex" / "skills" / "secret.md").write_text("secret", encoding="utf-8")

    command = await _run_with_snapshot(tmp_path, resource_path)

    payload = _payload(command)
    assert payload["code"] == "skill_resource_forbidden"
    assert payload["loaded"] is False
    assert str(tmp_path) not in json.dumps(payload)


@pytest.mark.asyncio
async def test_t77_load_skill_resource_rejects_absolute_path(tmp_path: Path) -> None:
    _write_skill(tmp_path)
    outside = tmp_path / "outside.txt"
    outside.write_text("secret", encoding="utf-8")

    command = await _run_with_snapshot(tmp_path, str(outside.resolve()))

    payload = _payload(command)
    assert payload["code"] == "skill_resource_forbidden"
    assert payload["loaded"] is False
    assert "secret" not in json.dumps(payload)
    assert str(tmp_path) not in json.dumps(payload)


@pytest.mark.asyncio
async def test_t80_load_skill_resource_cannot_cross_into_another_skill(
    tmp_path: Path,
) -> None:
    _write_skill(tmp_path)
    other = _write_skill(tmp_path, name="other")
    (other / "secret.txt").write_text("other secret", encoding="utf-8")

    command = await _run_with_snapshot(tmp_path, "../other/secret.txt")

    payload = _payload(command)
    assert payload["code"] == "skill_resource_forbidden"
    assert payload["loaded"] is False
    assert "other secret" not in json.dumps(payload)


@pytest.mark.asyncio
async def test_t78_load_skill_resource_rejects_symlink_escape(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    skill_dir = _write_skill(tmp_path)
    outside = tmp_path / "outside.txt"
    outside.write_text("outside secret", encoding="utf-8")
    link = skill_dir / "linked.txt"
    try:
        link.symlink_to(outside)
    except OSError:
        link.write_text("link-like placeholder", encoding="utf-8")
        from backend.app.keydex.skills import discovery

        original_is_link_like = discovery._is_link_like

        monkeypatch.setattr(
            discovery,
            "_is_link_like",
            lambda path: path == link or original_is_link_like(path),
        )
    token = set_request_context(keydex_snapshot=_snapshot(tmp_path))
    try:
        command = await run_load_skill(
            skill_name="dev-plan",
            resource_path="linked.txt",
            tool_call_id="call_1",
        )
    finally:
        reset_request_context(token)

    payload = _payload(command)
    assert payload["code"] == "skill_not_found"
    assert payload["loaded"] is False
    assert "outside secret" not in json.dumps(payload)


@pytest.mark.asyncio
async def test_t78_load_skill_resource_rejects_junction_like_component(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    skill_dir = _write_skill(tmp_path)
    junction_like = skill_dir / "junction.txt"
    junction_like.write_text("must not load", encoding="utf-8")
    original_is_junction = getattr(Path, "is_junction", None)

    def fake_is_junction(path: Path) -> bool:
        if path == junction_like:
            return True
        return bool(original_is_junction(path)) if callable(original_is_junction) else False

    monkeypatch.setattr(Path, "is_junction", fake_is_junction, raising=False)
    token = set_request_context(keydex_snapshot=_snapshot(tmp_path))
    try:
        command = await run_load_skill(
            skill_name="dev-plan",
            resource_path="junction.txt",
            tool_call_id="call_1",
        )
    finally:
        reset_request_context(token)

    payload = _payload(command)
    assert payload["code"] == "skill_not_found"
    assert payload["loaded"] is False
    assert "must not load" not in json.dumps(payload)


@pytest.mark.asyncio
async def test_load_skill_resource_rejects_missing_file(tmp_path: Path) -> None:
    _write_skill(tmp_path)

    command = await _run_with_snapshot(tmp_path, "references/missing.md")

    payload = _payload(command)
    assert payload["code"] == "skill_resource_not_found"
    assert payload["loaded"] is False


@pytest.mark.asyncio
async def test_load_skill_resource_rejects_directory(tmp_path: Path) -> None:
    skill_dir = _write_skill(tmp_path)
    (skill_dir / "references").mkdir()

    command = await _run_with_snapshot(tmp_path, "references")

    payload = _payload(command)
    assert payload["code"] == "skill_resource_not_file"
    assert payload["loaded"] is False


@pytest.mark.asyncio
async def test_t82_load_skill_resource_rejects_too_large_file(tmp_path: Path) -> None:
    skill_dir = _write_skill(tmp_path)
    resource = skill_dir / "large.txt"
    resource.write_text("x" * (KEYDEX_SKILL_MAX_RESOURCE_BYTES + 1), encoding="utf-8")

    command = await _run_with_snapshot(tmp_path, "large.txt")

    payload = _payload(command)
    assert payload["code"] == "skill_resource_too_large"
    assert payload["loaded"] is False


@pytest.mark.asyncio
async def test_t81_t82_load_skill_resource_rejects_non_utf8_file(tmp_path: Path) -> None:
    skill_dir = _write_skill(tmp_path)
    resource = skill_dir / "binary.bin"
    resource.write_bytes(b"\xff\xfe\xfd")

    command = await _run_with_snapshot(tmp_path, "binary.bin")

    payload = _payload(command)
    assert payload["code"] == "skill_resource_not_text"
    assert payload["loaded"] is False


@pytest.mark.asyncio
async def test_t81_load_skill_resource_rejects_nul_binary_file(tmp_path: Path) -> None:
    skill_dir = _write_skill(tmp_path)
    resource = skill_dir / "binary.dat"
    resource.write_bytes(b"text\0binary")

    command = await _run_with_snapshot(tmp_path, "binary.dat")

    payload = _payload(command)
    assert payload["code"] == "skill_resource_not_text"
    assert payload["loaded"] is False


@pytest.mark.asyncio
async def test_t83_script_resource_is_returned_as_read_only_text_not_activated(
    tmp_path: Path,
) -> None:
    skill_dir = _write_skill(tmp_path)
    script = skill_dir / "scripts" / "run.ps1"
    script.parent.mkdir()
    script.write_text("Write-Output should-not-run", encoding="utf-8")

    command = await _run_with_snapshot(tmp_path, "scripts/run.ps1")

    payload = _payload(command)
    assert payload["loaded"] is True
    assert payload["injected"] is False
    assert payload["content"] == "Write-Output should-not-run"
    assert "pending_skill_activations" not in command.update
