from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from backend.app.keydex.skills.model import SkillDefinitionError

SKILL_NAME_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def parse_skill_frontmatter(entry_file: str | Path) -> dict[str, str]:
    path = Path(entry_file)
    try:
        content = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise SkillDefinitionError(
            "skill_frontmatter_unreadable",
            str(exc),
            path=str(path),
        ) from exc
    return parse_skill_frontmatter_text(content, path=str(path))


def parse_skill_frontmatter_text(content: str, *, path: str | None = None) -> dict[str, str]:
    fields = _parse_frontmatter_fields(content, path=path)
    try:
        name_value = fields["name"]
    except KeyError as exc:
        raise SkillDefinitionError(
            "skill_frontmatter_missing_name",
            "frontmatter field 'name' is required",
            path=path,
        ) from exc
    try:
        description_value = fields["description"]
    except KeyError as exc:
        raise SkillDefinitionError(
            "skill_frontmatter_missing_description",
            "frontmatter field 'description' is required",
            path=path,
        ) from exc

    return {
        "name": validate_skill_name(name_value, path=path),
        "description": validate_skill_description(description_value, path=path),
    }


def validate_skill_name(value: Any, *, path: str | None = None) -> str:
    if not isinstance(value, str):
        raise SkillDefinitionError(
            "skill_name_invalid",
            "skill name must be a string",
            path=path,
        )
    name = value.strip()
    if not SKILL_NAME_PATTERN.fullmatch(name):
        raise SkillDefinitionError(
            "skill_name_invalid",
            "skill name must match ^[A-Za-z0-9_-]{1,64}$",
            path=path,
            details={"value": value},
        )
    return name


def validate_skill_description(value: Any, *, path: str | None = None) -> str:
    if not isinstance(value, str):
        raise SkillDefinitionError(
            "skill_description_invalid",
            "skill description must be a string",
            path=path,
        )
    description = value.strip()
    if not description:
        raise SkillDefinitionError(
            "skill_description_empty",
            "skill description must not be empty",
            path=path,
        )
    return description


def _parse_frontmatter_fields(content: str, *, path: str | None) -> dict[str, str]:
    lines = content.splitlines()
    if not lines or lines[0].strip() != "---":
        raise SkillDefinitionError(
            "skill_frontmatter_missing",
            "SKILL.md must start with YAML frontmatter",
            path=path,
        )

    closing_index = next(
        (index for index in range(1, len(lines)) if lines[index].strip() == "---"),
        None,
    )
    if closing_index is None:
        raise SkillDefinitionError(
            "skill_frontmatter_unclosed",
            "YAML frontmatter closing delimiter is missing",
            path=path,
        )

    return _parse_yaml_subset(lines[1:closing_index], path=path)


def _parse_yaml_subset(lines: list[str], *, path: str | None) -> dict[str, str]:
    fields: dict[str, str] = {}
    index = 0
    while index < len(lines):
        line = lines[index]
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            index += 1
            continue
        if line[:1].isspace() or ":" not in line:
            raise SkillDefinitionError(
                "skill_frontmatter_invalid",
                f"invalid frontmatter line: {line}",
                path=path,
            )

        key, raw_value = line.split(":", 1)
        key = key.strip()
        value = raw_value.strip()
        if not key:
            raise SkillDefinitionError(
                "skill_frontmatter_invalid",
                "frontmatter key must not be empty",
                path=path,
            )

        if value in {"|", ">", "|-", ">-", "|+", ">+"}:
            block_value, index = _consume_block_scalar(
                lines,
                index + 1,
                folded=value.startswith(">"),
            )
            fields[key] = block_value
            continue

        fields[key] = _strip_inline_quotes(value)
        index += 1

    return fields


def _consume_block_scalar(
    lines: list[str],
    start_index: int,
    *,
    folded: bool,
) -> tuple[str, int]:
    block_lines: list[str] = []
    index = start_index
    while index < len(lines):
        line = lines[index]
        if line.strip() and not line[:1].isspace():
            break
        block_lines.append(line[2:] if line.startswith("  ") else line.lstrip())
        index += 1

    if folded:
        return " ".join(part.strip() for part in block_lines if part.strip()).strip(), index
    return "\n".join(block_lines).strip(), index


def _strip_inline_quotes(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        return value[1:-1]
    return value
