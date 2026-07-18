import type { AssistantSurfaceMode } from "./workbenchAssistantState";

import { MAX_WORKBENCH_ASSISTANT_DRAWER_WIDTH } from "@/renderer/hooks/layout/layoutStore";

export interface WorkbenchAssistantGeometryOptions {
  drawerWidth: number;
  viewportWidth: number;
}

export interface WorkbenchAssistantGeometry {
  height: string;
  inset: string;
  pointerEvents: "auto" | "none";
  radius: number;
  width: string;
  zIndex: number;
}

export function getWorkbenchAssistantGeometry(
  mode: AssistantSurfaceMode,
  options: WorkbenchAssistantGeometryOptions,
): WorkbenchAssistantGeometry {
  switch (mode) {
    case "drawer":
      return {
        width: `${clampWorkbenchDrawerWidth(options.drawerWidth, options.viewportWidth)}px`,
        height: "100%",
        inset: "0 0 0 auto",
        radius: 18,
        zIndex: 2,
        pointerEvents: "auto",
      };
    case "expanded":
      return {
        width: "100%",
        height: "auto",
        inset: "48px 0 104px",
        radius: 0,
        zIndex: 58,
        pointerEvents: "none",
      };
    case "composer":
      return {
        width: "min(640px, calc(100% - 56px))",
        height: "auto",
        inset: "auto auto 16px 50%",
        radius: 20,
        zIndex: 55,
        pointerEvents: "auto",
      };
    case "capsule":
      return {
        width: "min(560px, calc(100% - 56px))",
        height: "auto",
        inset: "auto auto 16px 50%",
        radius: 999,
        zIndex: 55,
        pointerEvents: "auto",
      };
  }
}

export function clampWorkbenchDrawerWidth(preferredWidth: number, viewportWidth: number): number {
  const viewportCap = Math.max(320, Math.floor(viewportWidth * 0.46));
  return Math.min(Math.max(320, preferredWidth), MAX_WORKBENCH_ASSISTANT_DRAWER_WIDTH, viewportCap);
}

export function workbenchAssistantGeometryCssVars(
  mode: AssistantSurfaceMode,
  options: WorkbenchAssistantGeometryOptions,
): Record<string, string | number> {
  const geometry = getWorkbenchAssistantGeometry(mode, options);
  return {
    "--workbench-assistant-geometry-height": geometry.height,
    "--workbench-assistant-geometry-inset": geometry.inset,
    "--workbench-assistant-geometry-pointer-events": geometry.pointerEvents,
    "--workbench-assistant-geometry-radius": `${geometry.radius}px`,
    "--workbench-assistant-geometry-width": geometry.width,
    "--workbench-assistant-geometry-z-index": geometry.zIndex,
  };
}
