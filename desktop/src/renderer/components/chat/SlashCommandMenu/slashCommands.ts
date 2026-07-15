import type { SkillSummary } from "@/runtime";

const SLASH_QUERY_PATTERN = /(?:^|\s)\/([^\s/]*)$/;
const SLASH_QUERY_REPLACE_PATTERN = /(?:^|\s)\/[^\s/]*$/;

export interface SlashCommand {
  id: string;
  kind: "builtin" | "goal" | "skill_group" | "skill";
  label: string;
  title: string;
  description: string;
  skill?: SkillSummary;
  childCount?: number;
  searchText?: string;
}

export interface BuildSlashCommandsOptions {
  includeBypassConversation?: boolean;
  includeGoal?: boolean;
  includeContextCompression?: boolean;
}

export function bypassConversationSlashCommand(): SlashCommand {
  return {
    id: "bypass-conversation",
    kind: "builtin",
    label: "旁路对话",
    title: "旁路对话",
    description: "从当前最新完整轮次开启临时旁路会话",
    searchText: "btw bypass sidecar side conversation temporary",
  };
}

export function goalSlashCommand(): SlashCommand {
  return {
    id: "goal",
    kind: "goal",
    label: "目标",
    title: "目标",
    description: "创建一个长程目标",
    searchText: "goal objective task long running thread task changcheng mubiao 目标 长程任务",
  };
}

export function contextCompressionSlashCommand(): SlashCommand {
  return {
    id: "context-compression",
    kind: "builtin",
    label: "压缩上下文",
    title: "压缩上下文",
    description: "压缩当前会话上下文",
    searchText: "compress compact context yasuo shangxiawen 上下文 压缩",
  };
}

export function skillGroupSlashCommand(skills: SkillSummary[] = []): SlashCommand {
  return {
    id: "skill",
    kind: "skill_group",
    label: "Skill",
    title: "Skill",
    description: skills.length ? `选择 ${skills.length} 个可用 Skill` : "选择可用 Skill",
    childCount: skills.length,
    searchText: skills
      .map((skill) => `${skill.label} ${skill.name} ${skill.description} ${skill.source}`)
      .join(" "),
  };
}

export function skillToSlashCommand(skill: SkillSummary): SlashCommand {
  return {
    id: `skill:${skill.source}:${skill.name}`,
    kind: "skill",
    label: skill.label || `/${skill.name}`,
    title: skill.name,
    description: skill.description,
    skill,
  };
}

export function buildSlashCommands(
  skills: SkillSummary[] = [],
  options: BuildSlashCommandsOptions = {},
): SlashCommand[] {
  const commands: SlashCommand[] = [];
  if (options.includeBypassConversation !== false) {
    commands.push(bypassConversationSlashCommand());
  }
  if (options.includeGoal !== false) {
    commands.push(goalSlashCommand());
  }
  if (options.includeContextCompression !== false) {
    commands.push(contextCompressionSlashCommand());
  }
  commands.push(skillGroupSlashCommand(skills));
  return commands;
}

export function isContextCompressionSlashCommand(command: SlashCommand): boolean {
  return command.kind === "builtin" && command.id === "context-compression";
}

export function getSlashQuery(value: string): string | null {
  const match = SLASH_QUERY_PATTERN.exec(value);
  return match ? match[1].toLowerCase() : null;
}

export function filterSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  if (!query) {
    return commands;
  }
  return commands.filter((command) => {
    const haystack = `${command.label} ${command.title} ${command.description} ${command.searchText || ""}`.toLowerCase();
    return haystack.includes(query.toLowerCase());
  });
}

export function filterSlashSkills(skills: SkillSummary[], query: string): SkillSummary[] {
  if (!query) {
    return skills;
  }
  const normalizedQuery = query.toLowerCase();
  return skills.filter((skill) => {
    const haystack = `${skill.label} ${skill.name} ${skill.description} ${skill.source}`.toLowerCase();
    return haystack.includes(normalizedQuery);
  });
}

export function replaceSlashQuery(value: string, replacement: string): string {
  return value.replace(SLASH_QUERY_REPLACE_PATTERN, (match) => {
    const prefix = match.startsWith(" ") ? " " : "";
    return `${prefix}${replacement}`;
  });
}

export function removeSlashQuery(value: string): string {
  return replaceSlashQuery(value, "").trimEnd();
}
