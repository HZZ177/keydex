from __future__ import annotations

from backend.app.keydex.capabilities.keydex_markdown.models import (
    EffectiveKeydexMarkdownSnapshot,
)

KEYDEX_MARKDOWN_CONTEXT_PROTOCOL = "keydex.workspace_instructions.v2"

_KEYDEX_MARKDOWN_CONTEXT_HEADER = """<keydex-instructions>
以下是用户维护的 Keydex 持久指导。与当前任务相关时，请遵循这些指导。
文档按作用域从宽到窄排列；发生冲突时，以后出现且更具体的项目级指导为准。"""

_KEYDEX_MARKDOWN_CONTEXT_FOOTER = "</keydex-instructions>"

_DOCUMENT_LABELS = {
    "system": "用户的全局指导",
    "workspace": "当前项目指导",
}


def render_keydex_markdown_context(
    snapshot: EffectiveKeydexMarkdownSnapshot,
) -> str | None:
    if not snapshot.documents:
        return None
    sections = [_KEYDEX_MARKDOWN_CONTEXT_HEADER]
    sections.extend(
        f"## {document.locator}（{_DOCUMENT_LABELS[document.scope]}）\n\n{document.content}"
        for document in snapshot.documents
    )
    sections.append(_KEYDEX_MARKDOWN_CONTEXT_FOOTER)
    return "\n\n".join(sections)
