from __future__ import annotations

import json
from pathlib import PurePosixPath

from backend.app.keydex.skills import SkillDefinition


def build_skill_activation_content(
    *,
    skill: SkillDefinition,
    skill_md_content: str,
    load_skill_tool_name: str,
) -> str:
    skill_root = _skill_base_dir(skill.relative_entry)
    context_payload = {
        "skill_name": skill.name,
        "source": skill.source,
        "workspace_path_mode": "workspace_relative",
        "skill_root": skill_root,
        "entry_file": skill.relative_entry,
        "resources": list(skill.resources),
        "resource_access": {
            "mode": "workspace_tools",
            "path_rule": "使用 skill_root + resources 中的相对路径组成工作区相对路径。",
            "read_text": ["read_file", "list_dir", "search_text", "search_files", "grep_files"],
            "execute_or_inspect": ["run_command"],
            "compatibility_fallback": (
                f'{load_skill_tool_name}(skill_name="{skill.name}", '
                'resource_path="<相对路径>")'
            ),
        },
    }
    return (
        "[skill activated]\n"
        f"你现在已进入工作区 Skill 模式：{skill.name}。\n"
        "下面的 SKILL.md 是当前任务的正式执行规范；后续应优先遵循该 Skill。\n"
        "--------\n"
        "技能上下文：\n"
        f"{json.dumps(context_payload, ensure_ascii=False, indent=2)}\n"
        "--------\n"
        "资源访问说明：\n"
        "本 Skill 位于当前工作区内，Skill 资源按普通工作区文件处理。\n"
        f"- Skill 根目录：`{skill_root}`。\n"
        f"- Skill 入口文件：`{skill.relative_entry}`。\n"
        "- 读取文本资源时，使用 `read_file` / `list_dir` / `search_text` / "
        "`search_files` / `grep_files`，路径写成 "
        f"`{skill_root}/<resources 中的相对路径>`。\n"
        "- 执行或检查脚本资源时，使用 `run_command`，优先把 `cwd` 设置为 "
        f"`{skill_root}`，命令中使用资源相对路径。\n"
        "- 不要自行拼接工作区外的绝对路径；不要把 `load_skill(resource_path=...)` "
        "作为默认资源访问方式。\n"
        "- 仅当普通工作区工具无法满足只读文本资源读取时，才可使用 "
        "`resource_access.compatibility_fallback` 作为兼容兜底。\n"
        "--------\n"
        "以下是 Skill 的正文内容，请结合该 Skill 完成用户需求：\n"
        f"{skill_md_content}"
    )


def _skill_base_dir(relative_entry: str) -> str:
    parent = PurePosixPath(str(relative_entry).replace("\\", "/")).parent.as_posix()
    return "." if parent == "" else parent
