from backend.app.agent.system_prompt import DEFAULT_SYSTEM_PROMPT


def test_default_prompt_requires_file_links_for_local_file_mentions() -> None:
    assert "回复正文里的本机文件名必须默认渲染为可打开的 Markdown 文件链接" in DEFAULT_SYSTEM_PROMPT
    assert "这不是可选增强" in DEFAULT_SYSTEM_PROMPT
    assert "[显示名称](<路径:行号>)" in DEFAULT_SYSTEM_PROMPT
    assert "README.md 第 162 行" in DEFAULT_SYSTEM_PROMPT
    assert "如果只是文件类型、扩展名、配置字段、工具参数示例，或你无法确定它对应的真实本机路径，不要编造链接" in DEFAULT_SYSTEM_PROMPT
