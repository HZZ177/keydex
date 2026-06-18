export interface SlashCommand {
  id: "clear" | "settings" | "model" | "workspace";
  label: string;
  title: string;
  description: string;
}

export const defaultSlashCommands: SlashCommand[] = [
  {
    id: "clear",
    label: "/clear",
    title: "清空输入",
    description: "清空当前输入框内容",
  },
];

export function getSlashQuery(value: string): string | null {
  const match = /(?:^|\s)\/([\w-]*)$/.exec(value);
  return match ? match[1].toLowerCase() : null;
}

export function filterSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  if (!query) {
    return commands;
  }
  return commands.filter((command) => {
    const haystack = `${command.label} ${command.title} ${command.description}`.toLowerCase();
    return haystack.includes(query.toLowerCase());
  });
}

export function replaceSlashQuery(value: string, replacement: string): string {
  return value.replace(/(?:^|\s)\/[\w-]*$/, (match) => {
    const prefix = match.startsWith(" ") ? " " : "";
    return `${prefix}${replacement}`;
  });
}
