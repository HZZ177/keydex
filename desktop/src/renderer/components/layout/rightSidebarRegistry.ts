export type RightSidebarRegisteredPanelType = "files" | "conversation" | "review" | "git";

export interface RightSidebarPanelDefinition {
  type: RightSidebarRegisteredPanelType;
  label: string;
  icon: "folder" | "message" | "review" | "git";
  order: number;
  multiplicity: "multiple" | "singleton";
  idPrefix: string;
}

export class RightSidebarPanelRegistry {
  private readonly definitions = new Map<RightSidebarRegisteredPanelType, RightSidebarPanelDefinition>();

  constructor(definitions: readonly RightSidebarPanelDefinition[] = []) {
    definitions.forEach((definition) => this.register(definition));
  }

  register(definition: RightSidebarPanelDefinition): void {
    if (this.definitions.has(definition.type)) {
      throw new Error(`Right sidebar panel type is already registered: ${definition.type}`);
    }
    if (!definition.idPrefix.trim() || !definition.label.trim()) {
      throw new Error("Right sidebar panel definitions require label and idPrefix");
    }
    this.definitions.set(definition.type, Object.freeze({ ...definition }));
  }

  get(type: RightSidebarRegisteredPanelType): RightSidebarPanelDefinition {
    const definition = this.definitions.get(type);
    if (!definition) throw new Error(`Unknown right sidebar panel type: ${type}`);
    return definition;
  }

  list(): readonly RightSidebarPanelDefinition[] {
    return Array.from(this.definitions.values()).sort(
      (left, right) => left.order - right.order || left.type.localeCompare(right.type),
    );
  }

  resolve(panelId: string): RightSidebarPanelDefinition | null {
    return this.list().find((definition) => panelId.startsWith(definition.idPrefix)) ?? null;
  }

  panelId(type: RightSidebarRegisteredPanelType, sequence = 1): string {
    const definition = this.get(type);
    return definition.multiplicity === "singleton"
      ? `${definition.idPrefix}singleton`
      : `${definition.idPrefix}${sequence}`;
  }
}

export const rightSidebarPanelRegistry = new RightSidebarPanelRegistry([
  {
    type: "conversation",
    label: "旁路对话",
    icon: "message",
    order: 10,
    multiplicity: "multiple",
    idPrefix: "right-sidebar:conversation:",
  },
  {
    type: "files",
    label: "文件",
    icon: "folder",
    order: 20,
    multiplicity: "multiple",
    idPrefix: "right-sidebar:files:",
  },
  {
    type: "review",
    label: "审阅",
    icon: "review",
    order: 30,
    multiplicity: "multiple",
    idPrefix: "right-sidebar:review:",
  },
  {
    type: "git",
    label: "Git",
    icon: "git",
    order: 40,
    multiplicity: "singleton",
    idPrefix: "right-sidebar:git:",
  },
]);
