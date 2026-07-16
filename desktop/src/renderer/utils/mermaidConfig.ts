import type { MermaidConfig } from "mermaid";

export type MermaidThemeMode = "light" | "dark";

const BASE_MERMAID_CONFIG = {
  startOnLoad: false,
  securityLevel: "strict",
  suppressErrorRendering: true,
  look: "classic",
  flowchart: {
    useMaxWidth: false,
  },
} satisfies MermaidConfig;

const DARK_MERMAID_THEME_VARIABLES = {
  darkMode: true,
  background: "#282a36",
  primaryColor: "#343746",
  primaryTextColor: "#f8f8f2",
  primaryBorderColor: "#6272a4",
  secondaryColor: "#3a3d4e",
  secondaryTextColor: "#f8f8f2",
  secondaryBorderColor: "#6272a4",
  tertiaryColor: "#30323f",
  tertiaryTextColor: "#f8f8f2",
  tertiaryBorderColor: "#6272a4",
  textColor: "#f8f8f2",
  lineColor: "#a9acc2",
  mainBkg: "#343746",
  nodeBkg: "#343746",
  nodeBorder: "#6272a4",
  nodeTextColor: "#f8f8f2",
  titleColor: "#f8f8f2",
  edgeLabelBackground: "#282a36",
  clusterBkg: "#30323f",
  clusterBorder: "#6272a4",
  actorBkg: "#343746",
  actorBorder: "#6272a4",
  actorTextColor: "#f8f8f2",
  actorLineColor: "#a9acc2",
  signalColor: "#a9acc2",
  signalTextColor: "#f8f8f2",
  labelBoxBkgColor: "#30323f",
  labelBoxBorderColor: "#6272a4",
  labelTextColor: "#f8f8f2",
  loopTextColor: "#f8f8f2",
  activationBkgColor: "#44475a",
  activationBorderColor: "#bd93f9",
  noteBkgColor: "#44475a",
  noteTextColor: "#f8f8f2",
  noteBorderColor: "#6272a4",
  sequenceNumberColor: "#f8f8f2",
  stateBkg: "#343746",
  stateLabelColor: "#f8f8f2",
  transitionColor: "#a9acc2",
  transitionLabelColor: "#f8f8f2",
  labelBackgroundColor: "#282a36",
} as const;

export function getMermaidConfig(theme: MermaidThemeMode): MermaidConfig {
  if (theme === "dark") {
    return {
      ...BASE_MERMAID_CONFIG,
      theme: "base",
      themeVariables: {
        ...DARK_MERMAID_THEME_VARIABLES,
      },
    };
  }

  return {
    ...BASE_MERMAID_CONFIG,
    theme: "neutral",
  };
}
