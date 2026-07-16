from __future__ import annotations

from backend.app.keydex.capabilities.keydex_markdown import (
    EffectiveKeydexMarkdownSnapshot,
    KeydexMarkdownDocument,
    render_keydex_markdown_context,
)
from backend.tests.e2e_keydex_server import (
    _activation_marker,
    _context_summary,
    _keydex_context,
    _parse_keydex_context_message,
    _skill_request,
)


def _wrapped(*documents: tuple[str, str, str]) -> str:
    rendered = render_keydex_markdown_context(
        EffectiveKeydexMarkdownSnapshot(
            documents=tuple(
                KeydexMarkdownDocument(
                    scope=scope,  # type: ignore[arg-type]
                    locator=locator,
                    content=content,
                    raw_hash="a" * 64,
                    byte_size=len(content.encode("utf-8")),
                )
                for scope, locator, content in documents
            )
        )
    )
    assert rendered is not None
    return rendered


def test_context_parser_reports_role_order_count_markers_and_latest_real_user() -> None:
    payload = {
        "messages": [
            {"role": "system", "content": "agent prompt"},
            {
                "role": "user",
                "content": _wrapped(
                    ("system", "system:keydex.md", "SYSTEM-MD"),
                    ("workspace", "workspace:.keydex/keydex.md", "WORKSPACE-MD"),
                ),
            },
            {"role": "user", "content": "historical request"},
            {"role": "assistant", "content": "historical answer"},
            {"role": "user", "content": "E2E-LATEST-REQUEST"},
        ]
    }

    context = _keydex_context(payload)
    summary = _context_summary(context)

    assert context["context_count"] == 1
    assert context["last_user"] == "E2E-LATEST-REQUEST"
    assert context["context_before_last_user"] is True
    assert "documents=2" in summary
    assert "scopes=system,workspace" in summary
    assert "order=system>workspace" in summary
    assert "markers=SYSTEM-MD|WORKSPACE-MD" in summary
    assert "context_role=user" in summary


def test_context_parser_returns_an_explicit_empty_summary_without_wrapper() -> None:
    context = _keydex_context({"messages": [{"role": "user", "content": "plain request"}]})

    assert _context_summary(context) == (
        "context_count=0 documents=0 scopes=none order=none markers=none "
        "workspace_present=false last_user=plain request context_role=none "
        "context_before_conversation=false"
    )


def test_context_parser_rejects_malformed_or_wrongly_delimited_content() -> None:
    assert _parse_keydex_context_message("plain") is None
    assert (
        _parse_keydex_context_message(
            "<keydex-instructions>\n没有文档标题\n</keydex-instructions>"
        )
        is None
    )
    assert (
        _parse_keydex_context_message(
            "<keydex-instructions>\n"
            "## system:keydex.md（当前项目指导）\n\n内容\n"
            "</keydex-instructions>"
        )
        is None
    )
    assert (
        _parse_keydex_context_message(
            "<keydex-instructions>\n"
            "## system:keydex.md（用户的全局指导）\n\n内容\nmissing footer"
        )
        is None
    )


def test_context_summary_escapes_newlines_without_losing_unicode() -> None:
    context = _keydex_context(
        {
            "messages": [
                {
                    "role": "user",
                    "content": _wrapped(
                        ("system", "system:keydex.md", "第一行\n第二行"),
                    ),
                },
                {"role": "user", "content": "真实请求"},
            ]
        }
    )

    assert "markers=第一行\\n第二行" in _context_summary(context)


def test_skill_request_supports_explicit_and_automatic_e2e_triggers() -> None:
    assert _skill_request("KeydexSkillE2E shared workspace") == (
        "shared",
        "workspace",
    )
    assert _skill_request("KeydexAutoSkillE2E system-demo system") == (
        "system-demo",
        "system",
    )


def test_activation_marker_recognizes_the_packaged_builtin_guide() -> None:
    assert (
        _activation_marker(
            {
                "messages": [
                    {
                        "role": "tool",
                        "content": "# Keydex 产品使用指南\n\n内置说明",
                    }
                ]
            }
        )
        == "BUILTIN-KEYDEX-GUIDE"
    )


def test_activation_marker_ignores_stale_skill_output_from_history() -> None:
    assert (
        _activation_marker(
            {
                "messages": [
                    {"role": "tool", "content": "WORKSPACE-SHARED-V1"},
                    {"role": "assistant", "content": "old answer"},
                    {"role": "user", "content": "KeydexSkillE2E shared system"},
                    {"role": "tool", "content": "SYSTEM-SHARED-V1"},
                ]
            }
        )
        == "SYSTEM-SHARED-V1"
    )
