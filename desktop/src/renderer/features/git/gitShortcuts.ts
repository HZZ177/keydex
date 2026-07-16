export type GitShortcutCommand = "update" | "commit" | "push" | "create_branch";

export interface GitShortcutBinding {
  command: GitShortcutCommand;
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  label: string;
}

export const DEFAULT_GIT_SHORTCUTS: Readonly<Record<GitShortcutCommand, GitShortcutBinding>> = Object.freeze({
  update: binding("update", "t", { ctrl: true }, "Ctrl+T"),
  commit: binding("commit", "k", { ctrl: true }, "Ctrl+K"),
  push: binding("push", "k", { ctrl: true, shift: true }, "Ctrl+Shift+K"),
  create_branch: binding("create_branch", "n", { ctrl: true, alt: true }, "Ctrl+Alt+N"),
});

export interface ResolvedGitShortcuts {
  bindings: Readonly<Record<GitShortcutCommand, GitShortcutBinding>>;
  conflicts: readonly { signature: string; commands: readonly GitShortcutCommand[] }[];
}

export function resolveGitShortcuts(
  overrides: Partial<Record<GitShortcutCommand, Partial<Omit<GitShortcutBinding, "command">>>> = {},
): ResolvedGitShortcuts {
  const bindings = Object.fromEntries(
    (Object.keys(DEFAULT_GIT_SHORTCUTS) as GitShortcutCommand[]).map((command) => [
      command,
      Object.freeze({ ...DEFAULT_GIT_SHORTCUTS[command], ...overrides[command], command }),
    ]),
  ) as Record<GitShortcutCommand, GitShortcutBinding>;
  const bySignature = new Map<string, GitShortcutCommand[]>();
  Object.values(bindings).forEach((value) => {
    const signature = gitShortcutSignature(value);
    bySignature.set(signature, [...(bySignature.get(signature) ?? []), value.command]);
  });
  return {
    bindings: Object.freeze(bindings),
    conflicts: Array.from(bySignature.entries())
      .filter(([, commands]) => commands.length > 1)
      .map(([signature, commands]) => ({ signature, commands: Object.freeze(commands) })),
  };
}

export function matchesGitShortcut(event: KeyboardEvent, binding: GitShortcutBinding): boolean {
  return event.key.toLocaleLowerCase() === binding.key.toLocaleLowerCase()
    && event.ctrlKey === binding.ctrl
    && event.shiftKey === binding.shift
    && event.altKey === binding.alt
    && event.metaKey === binding.meta;
}

export function isEditableGitShortcutTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(
    target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])"),
  );
}

export function gitShortcutSignature(binding: GitShortcutBinding): string {
  return [binding.ctrl ? "ctrl" : "", binding.shift ? "shift" : "", binding.alt ? "alt" : "", binding.meta ? "meta" : "", binding.key.toLocaleLowerCase()]
    .filter(Boolean)
    .join("+");
}

function binding(
  command: GitShortcutCommand,
  key: string,
  modifiers: Partial<Pick<GitShortcutBinding, "ctrl" | "shift" | "alt" | "meta">>,
  label: string,
): GitShortcutBinding {
  return {
    command,
    key,
    ctrl: modifiers.ctrl ?? false,
    shift: modifiers.shift ?? false,
    alt: modifiers.alt ?? false,
    meta: modifiers.meta ?? false,
    label,
  };
}
