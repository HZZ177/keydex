from __future__ import annotations

import json

from backend.app.keydex.skills import SkillDefinition


def build_skill_activation_content(
    *,
    skill: SkillDefinition,
    skill_md_content: str,
    load_skill_tool_name: str,
) -> str:
    context_payload = {
        "id": f"skill:{skill.source}:{skill.name}",
        "skill_name": skill.name,
        "source": skill.source,
        "locator": skill.relative_entry,
        "resources": list(skill.resources),
        "resource_access": {
            "mode": "keydex_read_only",
            "read_text": (
                f'{load_skill_tool_name}(skill_name="{skill.name}", '
                f'source="{skill.source}", '
                'resource_path="<相对路径>")'
            ),
            "scripts": "resources may be read as text but must never be executed",
        },
    }
    return (
        "[skill activated]\n"
        f"你现在已激活 Keydex Skill：{skill.name}（来源：{skill.source}）。\n"
        "下面的 SKILL.md 是当前任务的正式执行规范；后续应优先遵循该 Skill。\n"
        "--------\n"
        "技能上下文：\n"
        f"{json.dumps(context_payload, ensure_ascii=False, indent=2)}\n"
        "--------\n"
        "资源访问说明：\n"
        f"- Skill 逻辑入口：`{skill.relative_entry}`。\n"
        "- 资源只能按 resources 中列出的相对路径，通过 "
        f"`{load_skill_tool_name}(skill_name=..., source=..., resource_path=...)` 只读加载。\n"
        "- 不要拼接绝对路径，不要通过工作区文件工具访问 system Skill。\n"
        "- scripts/ 下资源也只能作为文本读取，禁止执行。\n"
        "--------\n"
        "以下是 Skill 的正文内容，请结合该 Skill 完成用户需求：\n"
        f"{skill_md_content}"
    )
