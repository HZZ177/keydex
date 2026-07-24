export interface ProjectIconColorOption {
  id: string;
  label: string;
  lightColor: string;
  darkColor: string;
  lightSwatch: string;
  darkSwatch: string;
  ring: "center" | "soft" | "vivid";
}

export const PROJECT_ICON_COLOR_OPTIONS = [
  {
    id: "white", label: "银灰",
    lightColor: "#687386", darkColor: "#d8dbe6",
    lightSwatch: "#f4f6fa", darkSwatch: "#f4f6fa", ring: "center",
  },
  {
    id: "soft-lime", label: "柔和青柠",
    lightColor: "#758600", darkColor: "#d9ed8a",
    lightSwatch: "#d9ed8a", darkSwatch: "#d9ed8a", ring: "soft",
  },
  {
    id: "soft-green", label: "柔和绿色",
    lightColor: "#168b5b", darkColor: "#9de5bd",
    lightSwatch: "#9de5bd", darkSwatch: "#9de5bd", ring: "soft",
  },
  {
    id: "soft-blue", label: "柔和蓝色",
    lightColor: "#187da8", darkColor: "#9bdcf1",
    lightSwatch: "#9bdcf1", darkSwatch: "#9bdcf1", ring: "soft",
  },
  {
    id: "soft-violet", label: "柔和紫色",
    lightColor: "#6d59b5", darkColor: "#c6b7f5",
    lightSwatch: "#c6b7f5", darkSwatch: "#c6b7f5", ring: "soft",
  },
  {
    id: "soft-rose", label: "柔和玫红",
    lightColor: "#b54776", darkColor: "#f1a8c8",
    lightSwatch: "#f1a8c8", darkSwatch: "#f1a8c8", ring: "soft",
  },
  {
    id: "soft-orange", label: "柔和橙色",
    lightColor: "#b96820", darkColor: "#f5be87",
    lightSwatch: "#f5be87", darkSwatch: "#f5be87", ring: "soft",
  },
  {
    id: "vivid-lime", label: "青柠",
    lightColor: "#708700", darkColor: "#cbdc65",
    lightSwatch: "#a8d400", darkSwatch: "#a8d400", ring: "vivid",
  },
  {
    id: "vivid-green", label: "绿色",
    lightColor: "#159447", darkColor: "#74d985",
    lightSwatch: "#42ce5c", darkSwatch: "#42ce5c", ring: "vivid",
  },
  {
    id: "vivid-emerald", label: "翠绿",
    lightColor: "#008d67", darkColor: "#61d4aa",
    lightSwatch: "#24c997", darkSwatch: "#24c997", ring: "vivid",
  },
  {
    id: "vivid-teal", label: "蓝绿",
    lightColor: "#008c91", darkColor: "#62ced0",
    lightSwatch: "#22c7c9", darkSwatch: "#22c7c9", ring: "vivid",
  },
  {
    id: "vivid-blue", label: "蓝色",
    lightColor: "#147db3", darkColor: "#7daee9",
    lightSwatch: "#2eb8ed", darkSwatch: "#2eb8ed", ring: "vivid",
  },
  {
    id: "vivid-indigo", label: "靛蓝",
    lightColor: "#3e6ed0", darkColor: "#9ba4ef",
    lightSwatch: "#4f8df7", darkSwatch: "#4f8df7", ring: "vivid",
  },
  {
    id: "vivid-violet", label: "紫色",
    lightColor: "#6558d3", darkColor: "#b998e8",
    lightSwatch: "#6f70f7", darkSwatch: "#6f70f7", ring: "vivid",
  },
  {
    id: "vivid-magenta", label: "洋红",
    lightColor: "#8f4bc8", darkColor: "#d18bd9",
    lightSwatch: "#a45ff0", darkSwatch: "#a45ff0", ring: "vivid",
  },
  {
    id: "vivid-rose", label: "玫红",
    lightColor: "#b83eaa", darkColor: "#e686b4",
    lightSwatch: "#d850d2", darkSwatch: "#d850d2", ring: "vivid",
  },
  {
    id: "vivid-red", label: "桃红",
    lightColor: "#cf3979", darkColor: "#f08ab8",
    lightSwatch: "#f34f98", darkSwatch: "#f34f98", ring: "vivid",
  },
  {
    id: "vivid-orange", label: "红色",
    lightColor: "#d74646", darkColor: "#f47c7c",
    lightSwatch: "#f45656", darkSwatch: "#f45656", ring: "vivid",
  },
  {
    id: "vivid-yellow", label: "琥珀",
    lightColor: "#8e7600", darkColor: "#e9c75e",
    lightSwatch: "#f2b51b", darkSwatch: "#f2b51b", ring: "vivid",
  },
] as const satisfies readonly ProjectIconColorOption[];

export type ProjectIconColorId = (typeof PROJECT_ICON_COLOR_OPTIONS)[number]["id"];
export type ProjectIconColorPreferences = Record<string, ProjectIconColorId>;

export const PROJECT_ICON_COLOR_STORAGE_KEY = "keydex.sidebar.project-icon-colors.v1";

const PROJECT_ICON_OUTLINE_BASE = "#202431";
const PROJECT_ICON_OUTLINE_SWATCH_WEIGHT = 0.45;

const PROJECT_ICON_COLOR_IDS = new Set<string>(PROJECT_ICON_COLOR_OPTIONS.map((option) => option.id));

interface PersistedProjectIconColors {
  version: 1;
  colors: Record<string, unknown>;
}

export function readProjectIconColorPreferences(
  storage: Pick<Storage, "getItem"> | null = browserStorage(),
): ProjectIconColorPreferences {
  if (!storage) {
    return {};
  }
  try {
    const raw = storage.getItem(PROJECT_ICON_COLOR_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Partial<PersistedProjectIconColors>;
    if (parsed.version !== 1 || !isRecord(parsed.colors)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed.colors).filter(
        (entry): entry is [string, ProjectIconColorId] =>
          Boolean(entry[0]) && typeof entry[1] === "string" && PROJECT_ICON_COLOR_IDS.has(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

export function writeProjectIconColorPreferences(
  colors: ProjectIconColorPreferences,
  storage: Pick<Storage, "setItem"> | null = browserStorage(),
): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(
      PROJECT_ICON_COLOR_STORAGE_KEY,
      JSON.stringify({ version: 1, colors } satisfies PersistedProjectIconColors),
    );
  } catch {
    // Storage availability must not make the sidebar unusable.
  }
}

export function updateProjectIconColorPreference(
  current: ProjectIconColorPreferences,
  workspaceId: string,
  colorId: ProjectIconColorId | null,
): ProjectIconColorPreferences {
  if (!workspaceId) {
    return current;
  }
  if (colorId === null) {
    if (!(workspaceId in current)) {
      return current;
    }
    const next = { ...current };
    delete next[workspaceId];
    return next;
  }
  if (current[workspaceId] === colorId) {
    return current;
  }
  return { ...current, [workspaceId]: colorId };
}

export function projectIconColorValue(
  colorId: ProjectIconColorId | null | undefined,
  theme: "light" | "dark",
): string | undefined {
  const option = PROJECT_ICON_COLOR_OPTIONS.find((candidate) => candidate.id === colorId);
  return theme === "dark" ? option?.darkColor : option?.lightColor;
}

export function projectIconSwatchValue(
  colorId: ProjectIconColorId | null | undefined,
  theme: "light" | "dark",
): string | undefined {
  const option = PROJECT_ICON_COLOR_OPTIONS.find((candidate) => candidate.id === colorId);
  return theme === "dark" ? option?.darkSwatch : option?.lightSwatch;
}

export function projectIconOutlineValue(
  colorId: ProjectIconColorId | null | undefined,
  theme: "light" | "dark",
): string | undefined {
  const swatch = projectIconSwatchValue(colorId, theme);
  return swatch
    ? mixHexColors(swatch, PROJECT_ICON_OUTLINE_BASE, PROJECT_ICON_OUTLINE_SWATCH_WEIGHT)
    : undefined;
}

function mixHexColors(first: string, second: string, firstWeight: number): string {
  const mixChannel = (offset: number) => {
    const firstChannel = Number.parseInt(first.slice(offset, offset + 2), 16);
    const secondChannel = Number.parseInt(second.slice(offset, offset + 2), 16);
    return Math.round(
      firstChannel * firstWeight + secondChannel * (1 - firstWeight),
    ).toString(16).padStart(2, "0");
  };
  return `#${mixChannel(1)}${mixChannel(3)}${mixChannel(5)}`;
}

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
