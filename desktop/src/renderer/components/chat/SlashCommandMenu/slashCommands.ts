import type { WorkspaceSkillSummary } from "@/runtime";

export interface SlashCommand {
  id: string;
  kind: "builtin" | "skill_group" | "skill";
  label: string;
  title: string;
  description: string;
  skill?: WorkspaceSkillSummary;
  childCount?: number;
  searchText?: string;
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

export function buildSlashCommands(skills: WorkspaceSkillSummary[] = []): SlashCommand[] {
  return [skillGroupSlashCommand(skills)];
}

export function getSlashQuery(value: string): string | null {
  const match = /(?:^|\s)\/([\w-]*)$/.exec(value);
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
  return value.replace(/(?:^|\s)\/[\w-]*$/, (match) => {
    const prefix = match.startsWith(" ") ? " " : "";
    return `${prefix}${replacement}`;
  });
}

export function removeSlashQuery(value: string): string {
  return replaceSlashQuery(value, "").trimEnd();
}
