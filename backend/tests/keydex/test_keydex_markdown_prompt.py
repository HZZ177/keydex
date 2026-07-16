from __future__ import annotations

from pathlib import Path

from backend.app.keydex.capabilities.keydex_markdown import (
    KEYDEX_MARKDOWN_CONTEXT_PROTOCOL,
    EffectiveKeydexMarkdownSnapshot,
    KeydexMarkdownDocument,
    render_keydex_markdown_context,
)


def _document(scope: str, content: str) -> KeydexMarkdownDocument:
    locator = (
        "system:keydex.md"
        if scope == "system"
        else "workspace:.keydex/keydex.md"
    )
    return KeydexMarkdownDocument(
        scope=scope,  # type: ignore[arg-type]
        locator=locator,
        content=content,
        raw_hash="a" * 64,
        byte_size=len(content.encode("utf-8")),
    )


def test_km17_no_effective_documents_returns_none() -> None:
    assert render_keydex_markdown_context(EffectiveKeydexMarkdownSnapshot()) is None


def test_km18_prompt_v2_golden_string_is_stable() -> None:
    snapshot = EffectiveKeydexMarkdownSnapshot(
        documents=(
            _document("system", "系统指导"),
            _document("workspace", "项目指导"),
        )
    )

    rendered = render_keydex_markdown_context(snapshot)

    assert KEYDEX_MARKDOWN_CONTEXT_PROTOCOL == "keydex.workspace_instructions.v2"
    assert rendered == """<keydex-instructions>
以下是用户维护的 Keydex 持久指导。与当前任务相关时，请遵循这些指导。
文档按作用域从宽到窄排列；发生冲突时，以后出现且更具体的项目级指导为准。

## system:keydex.md（用户的全局指导）

系统指导

## workspace:.keydex/keydex.md（当前项目指导）

项目指导

</keydex-instructions>"""


def test_km19_document_content_remains_plain_markdown_inside_single_wrapper() -> None:
    marker = '## 自定义约定\nquote=" slash=\\ unicode=雪\n<示例>保持原文</示例>'
    rendered = render_keydex_markdown_context(
        EffectiveKeydexMarkdownSnapshot(documents=(_document("workspace", marker),))
    )

    assert rendered is not None
    assert rendered.startswith("<keydex-instructions>\n")
    assert rendered.endswith("\n</keydex-instructions>")
    assert rendered.count("<keydex-instructions>") == 1
    assert rendered.count("</keydex-instructions>") == 1
    assert marker in rendered
    assert '"version":1' not in rendered
    assert "## workspace:.keydex/keydex.md（当前项目指导）" in rendered


def test_km31_renderer_metadata_does_not_add_physical_paths(tmp_path: Path) -> None:
    private_home = tmp_path / "private-home"
    private_workspace = tmp_path / "private-workspace"
    rendered = render_keydex_markdown_context(
        EffectiveKeydexMarkdownSnapshot(
            documents=(_document("system", "safe content"),)
        )
    )

    assert rendered is not None
    assert str(private_home) not in rendered
    assert str(private_workspace) not in rendered
    assert "system:keydex.md" in rendered
