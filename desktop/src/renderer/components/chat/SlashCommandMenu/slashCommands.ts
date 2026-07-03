import type { WorkspaceSkillSummary } from "@/runtime";

const SLASH_QUERY_PATTERN = /(?:^|\s)\/([^\s/]*)$/;
const SLASH_QUERY_REPLACE_PATTERN = /(?:^|\s)\/[^\s/]*$/;

export interface SlashCommand {
  id: string;
  kind: "builtin" | "goal" | "skill_group" | "skill";
  label: string;
  title: string;
  description: string;
  skill?: WorkspaceSkillSummary;
  childCount?: number;
  searchText?: string;
}

export interface BuildSlashCommandsOptions {
  includeBypassConversation?: boolean;
  includeGoal?: boolean;
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

export function skillGroupSlashCommand(skills: WorkspaceSkillSummary[] = []): SlashCommand {
  return {
    id: "skill",
    kind: "skill_group",
    label: "Skill",
    title: "Skill",
    description: skills.length ? `选择 ${skills.length} 个工作区 Skill` : "选择工作区 Skill",
    childCount: skills.length,
    searchText: skills
      .map((skill) => `${skill.label} ${skill.name} ${skill.description} ${skill.source}`)
      .join(" "),
  };
}

export function skillToSlashCommand(skill: WorkspaceSkillSummary): SlashCommand {
  return {
    id: `skill:${skill.name}`,
    kind: "skill",
    label: skill.label || `/${skill.name}`,
    title: skill.name,
    description: skill.description,
    skill,
  };
}

export function buildSlashCommands(
  skills: WorkspaceSkillSummary[] = [],
  options: BuildSlashCommandsOptions = {},
): SlashCommand[] {
  const commands = [skillGroupSlashCommand(skills)];
  if (options.includeGoal !== false) {
    commands.unshift(goalSlashCommand());
  }
  if (options.includeBypassConversation !== false) {
    commands.unshift(bypassConversationSlashCommand());
  }
  return commands;
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

export function filterSlashSkills(skills: WorkspaceSkillSummary[], query: string): WorkspaceSkillSummary[] {
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
