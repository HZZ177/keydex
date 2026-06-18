import { Command } from "lucide-react";

import styles from "./SlashCommandMenu.module.css";
import type { SlashCommand } from "./slashCommands";

export interface SlashCommandMenuProps {
  commands: SlashCommand[];
  activeIndex: number;
  onSelect: (command: SlashCommand) => void;
}

export function SlashCommandMenu({ commands, activeIndex, onSelect }: SlashCommandMenuProps) {
  return (
    <div className={styles.menu} role="listbox" aria-label="斜杠菜单" data-testid="slash-command-menu">
      {commands.length ? (
        commands.map((command, index) => (
          <button
            className={styles.item}
            type="button"
            role="option"
            aria-selected={activeIndex === index}
            data-active={activeIndex === index ? "true" : "false"}
            key={command.id}
            onMouseDown={(event) => {
              event.preventDefault();
              onSelect(command);
            }}
          >
            <span className={styles.icon} aria-hidden="true">
              <Command size={14} />
            </span>
            <span className={styles.text}>
              <strong>{command.label}</strong>
              <span>{command.description}</span>
            </span>
          </button>
        ))
      ) : (
        <div className={styles.empty}>没有匹配的命令</div>
      )}
    </div>
  );
}
