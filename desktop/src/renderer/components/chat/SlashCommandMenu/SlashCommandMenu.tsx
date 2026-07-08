import { Box, ChevronLeft, ChevronRight, Command, MessagesSquare, Search, Sparkles, Target } from "lucide-react";
import { useEffect, useRef } from "react";

import type { WorkspaceSkillSummary } from "@/runtime";

import styles from "../ComposerPopupMenu/ComposerPopupMenu.module.css";
import {
  isContextCompressionSlashCommand,
  type SlashCommand,
} from "./slashCommands";

export interface SlashCommandMenuProps {
  mode: "root" | "skills";
  query: string;
  commands: SlashCommand[];
  skills: WorkspaceSkillSummary[];
  activeIndex: number;
  onBack?: () => void;
  onSelectCommand: (command: SlashCommand) => void;
  onSelectSkill: (skill: WorkspaceSkillSummary) => void;
}

export function SlashCommandMenu({
  mode,
  query,
  commands,
  skills,
  activeIndex,
  onBack,
  onSelectCommand,
  onSelectSkill,
}: SlashCommandMenuProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const showingSkills = mode === "skills";
  const rootItemCount = commands.length + skills.length;
  const itemCount = showingSkills ? skills.length : rootItemCount;
  const emptyText = showingSkills ? (query ? "没有匹配的 Skill" : "当前项目无 Skill") : "没有匹配的命令";
  const filterLabel = showingSkills ? "筛选 Skill" : "筛选命令";

  useEffect(() => {
    const activeOption = bodyRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    activeOption?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, commands, mode, skills]);

  return (
    <div
      className={styles.menu}
      role="listbox"
      aria-label="斜杠菜单"
      data-menu-mode={mode}
      data-testid="slash-command-menu"
    >
      <div className={styles.header}>
        {showingSkills ? (
          <button
            className={styles.backButton}
            type="button"
            aria-label="返回斜杠菜单"
            onMouseDown={(event) => {
              event.preventDefault();
              onBack?.();
            }}
          >
            <ChevronLeft size={14} />
          </button>
        ) : (
          <span className={styles.backSpacer} />
        )}
        <label className={styles.filterBox} onMouseDown={(event) => event.preventDefault()}>
          <Search size={13} strokeWidth={1.9} aria-hidden="true" />
          <input
            aria-label={filterLabel}
            className={styles.filterInput}
            placeholder={filterLabel}
            readOnly
            tabIndex={-1}
            value={query}
          />
        </label>
        <span className={styles.headerMeta}>{showingSkills ? "技能" : "commands"}</span>
      </div>

      <div ref={bodyRef} className={styles.body}>
        {itemCount ? (
          showingSkills ? (
            skills.map((skill, index) => (
              <SkillItem
                key={skill.name}
                skill={skill}
                active={activeIndex === index}
                onSelect={onSelectSkill}
              />
            ))
          ) : (
            <>
              {commands.map((command, index) => (
                <CommandItem
                  key={command.id}
                  command={command}
                  active={activeIndex === index}
                  onSelect={onSelectCommand}
                />
              ))}
              {skills.length ? (
                <>
                  <SkillSectionDivider />
                  {skills.map((skill, index) => (
                    <SkillItem
                      key={skill.name}
                      skill={skill}
                      active={activeIndex === commands.length + index}
                      onSelect={onSelectSkill}
                    />
                  ))}
                </>
              ) : null}
            </>
          )
        ) : (
          <div className={styles.empty}>{emptyText}</div>
        )}
      </div>
    </div>
  );
}

function SkillSectionDivider() {
  return (
    <div className={styles.sectionDivider} data-testid="slash-skill-section" role="presentation">
      <span>Skill</span>
    </div>
  );
}

function CommandItem({
  command,
  active,
  onSelect,
}: {
  command: SlashCommand;
  active: boolean;
  onSelect: (command: SlashCommand) => void;
}) {
  const Icon = slashCommandIcon(command);
  return (
    <button
      className={styles.item}
      type="button"
      role="option"
      aria-label={command.kind === "goal" ? "创建目标" : undefined}
      aria-selected={active}
      data-active={active ? "true" : "false"}
      data-kind={command.kind}
      onMouseDown={(event) => {
        event.preventDefault();
        onSelect(command);
      }}
    >
      <span className={styles.icon} aria-hidden="true">
        <Icon size={14} />
      </span>
      <span className={styles.text}>
        <strong>{command.label}</strong>
        <span>{command.description}</span>
      </span>
      {command.kind === "skill_group" ? <ChevronRight className={styles.enterIcon} size={13} /> : null}
    </button>
  );
}

function slashCommandIcon(command: SlashCommand) {
  if (command.kind === "skill_group") {
    return Sparkles;
  }
  if (command.kind === "goal") {
    return Target;
  }
  if (command.kind === "builtin" && command.id === "bypass-conversation") {
    return MessagesSquare;
  }
  if (isContextCompressionSlashCommand(command)) {
    return StaticProgressRingIcon;
  }
  return Command;
}

function StaticProgressRingIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 16 16"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="8" cy="8" opacity="0.22" r="5.5" stroke="currentColor" strokeWidth="2" />
      <circle
        cx="8"
        cy="8"
        r="5.5"
        stroke="currentColor"
        strokeDasharray="8.64 25.92"
        strokeLinecap="round"
        strokeWidth="2"
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}

function SkillItem({
  skill,
  active,
  onSelect,
}: {
  skill: WorkspaceSkillSummary;
  active: boolean;
  onSelect: (skill: WorkspaceSkillSummary) => void;
}) {
  const label = skill.label || `/${skill.name}`;
  const displayName = skillDisplayName(skill);
  return (
    <button
      className={styles.item}
      type="button"
      role="option"
      aria-label={`选择 Skill ${label}`}
      aria-selected={active}
      data-active={active ? "true" : "false"}
      data-kind="skill"
      onMouseDown={(event) => {
        event.preventDefault();
        onSelect(skill);
      }}
    >
      <span className={styles.icon} aria-hidden="true">
        <Box size={14} />
      </span>
      <span className={styles.text}>
        <strong>{displayName}</strong>
        <span>{skill.description}</span>
      </span>
      <span className={styles.sourceBadge}>{skillSourceLabel(skill.source)}</span>
    </button>
  );
}

function skillDisplayName(skill: WorkspaceSkillSummary): string {
  const raw = skill.name || skill.label;
  const normalized = raw.replace(/^\//, "").trim();
  return normalized || "Skill";
}

function skillSourceLabel(source: WorkspaceSkillSummary["source"]): string {
  return source === "system" ? "系统" : "keydex";
}
