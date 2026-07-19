import { Box, ChevronLeft, ChevronRight, Command, MessagesSquare, Search, Sparkles, Target } from "lucide-react";
import { useEffect, useRef } from "react";

import type { KeydexDiagnostic, SkillSummary } from "@/runtime";

import styles from "../ComposerPopupMenu/ComposerPopupMenu.module.css";
import {
  isContextCompressionSlashCommand,
  type SlashCommand,
} from "./slashCommands";

export interface SlashCommandMenuProps {
  mode: "root" | "skills";
  query: string;
  commands: SlashCommand[];
  skills: SkillSummary[];
  diagnostics?: KeydexDiagnostic[];
  contextWindowProgress?: number | null;
  activeIndex: number;
  onBack?: () => void;
  onSelectCommand: (command: SlashCommand) => void;
  onSelectSkill: (skill: SkillSummary) => void;
}

export function SlashCommandMenu({
  mode,
  query,
  commands,
  skills,
  diagnostics = [],
  contextWindowProgress = null,
  activeIndex,
  onBack,
  onSelectCommand,
  onSelectSkill,
}: SlashCommandMenuProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const showingSkills = mode === "skills";
  const rootItemCount = commands.length + skills.length;
  const itemCount = showingSkills ? skills.length : rootItemCount;
  const emptyText = showingSkills ? (query ? "没有匹配的 Skill" : "当前范围无 Skill") : "没有匹配的命令";
  const filterLabel = showingSkills ? "筛选 Skill" : "筛选命令";
  const diagnostic = showingSkills ? primarySkillDiagnostic(diagnostics) : null;

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
        {diagnostic ? (
          <div
            className={styles.error}
            data-diagnostic-code={diagnostic.code}
            data-testid="skill-diagnostic"
            role="alert"
          >
            {diagnostic.severity === "error" ? "Skill 配置错误" : "Skill 配置提醒"}：{diagnostic.reason}
          </div>
        ) : null}
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
                  contextWindowProgress={contextWindowProgress}
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

function primarySkillDiagnostic(diagnostics: KeydexDiagnostic[]): KeydexDiagnostic | null {
  return diagnostics.find((item) => item.severity === "error") ?? diagnostics[0] ?? null;
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
  contextWindowProgress,
  active,
  onSelect,
}: {
  command: SlashCommand;
  contextWindowProgress: number | null;
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
        {isContextCompressionSlashCommand(command) ? (
          <ContextWindowProgressIcon progress={contextWindowProgress} />
        ) : (
          <Icon size={14} />
        )}
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
  return Command;
}

function ContextWindowProgressIcon({ progress }: { progress: number | null }) {
  const hasProgress = typeof progress === "number" && Number.isFinite(progress);
  const progressBasis = hasProgress ? Math.max(0, progress) : 0;
  const displayedProgress = Math.min(1, progressBasis);
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const level = !hasProgress
    ? "idle"
    : progressBasis > 1
      ? "danger"
      : progressBasis > 0.9
        ? "warning"
        : "normal";

  return (
    <svg
      aria-hidden="true"
      className={styles.contextWindowRing}
      data-level={level}
      data-testid="context-compression-progress-ring"
      fill="none"
      viewBox="0 0 16 16"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle className={styles.contextWindowTrack} cx="8" cy="8" r={radius} />
      <circle
        className={styles.contextWindowProgress}
        cx="8"
        cy="8"
        data-context-window-ring-progress="true"
        r={radius}
        strokeDasharray={circumference}
        style={{ strokeDashoffset: circumference * (1 - displayedProgress) }}
      />
    </svg>
  );
}

function SkillItem({
  skill,
  active,
  onSelect,
}: {
  skill: SkillSummary;
  active: boolean;
  onSelect: (skill: SkillSummary) => void;
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

function skillDisplayName(skill: SkillSummary): string {
  const raw = skill.name || skill.label;
  const normalized = raw.replace(/^\//, "").trim();
  return normalized || "Skill";
}

function skillSourceLabel(source: SkillSummary["source"]): string {
  return source === "builtin" ? "内置" : source === "system" ? "系统级" : "项目级";
}
