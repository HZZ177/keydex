import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  clampWorkbenchDrawerWidth,
  getWorkbenchAssistantGeometry,
  workbenchAssistantGeometryCssVars,
} from "../src/renderer/pages/workbench/workbenchAssistantGeometry";

describe("workbench assistant geometry", () => {
  it("defines stable capsule, composer, expanded and drawer placement contracts", () => {
    expect(getWorkbenchAssistantGeometry("capsule", { drawerWidth: 420, viewportWidth: 1440 })).toMatchObject({
      width: "min(560px, calc(100% - 56px))",
      height: "auto",
      inset: "auto auto 16px 50%",
      radius: 999,
      zIndex: 55,
      pointerEvents: "auto",
    });
    expect(getWorkbenchAssistantGeometry("composer", { drawerWidth: 420, viewportWidth: 1440 })).toMatchObject({
      width: "min(640px, calc(100% - 56px))",
      radius: 20,
      pointerEvents: "auto",
    });
    expect(getWorkbenchAssistantGeometry("expanded", { drawerWidth: 420, viewportWidth: 1440 })).toMatchObject({
      width: "100%",
      inset: "48px 0 104px",
      zIndex: 58,
      pointerEvents: "none",
    });
    expect(getWorkbenchAssistantGeometry("drawer", { drawerWidth: 420, viewportWidth: 1440 })).toMatchObject({
      width: "420px",
      height: "100%",
      inset: "0 0 0 auto",
      radius: 18,
      zIndex: 2,
      pointerEvents: "auto",
    });
  });

  it("clamps drawer width for common desktop and narrow viewport sizes", () => {
    expect(clampWorkbenchDrawerWidth(280, 1440)).toBe(320);
    expect(clampWorkbenchDrawerWidth(420, 1280)).toBe(420);
    expect(clampWorkbenchDrawerWidth(720, 1600)).toBe(720);
    expect(clampWorkbenchDrawerWidth(2000, 3000)).toBe(1040);
    expect(clampWorkbenchDrawerWidth(520, 900)).toBe(414);
  });

  it("exports CSS variables for the shell animation layer", () => {
    expect(workbenchAssistantGeometryCssVars("drawer", { drawerWidth: 420, viewportWidth: 1440 })).toEqual({
      "--workbench-assistant-geometry-height": "100%",
      "--workbench-assistant-geometry-inset": "0 0 0 auto",
      "--workbench-assistant-geometry-pointer-events": "auto",
      "--workbench-assistant-geometry-radius": "18px",
      "--workbench-assistant-geometry-width": "420px",
      "--workbench-assistant-geometry-z-index": 2,
    });
  });

  it("keeps responsive shell width constraints in the workbench CSS contract", () => {
    const css = readFileSync(
      resolve(process.cwd(), "src/renderer/pages/workbench/WorkbenchAssistantSurface.module.css"),
      "utf8",
    );

    expect(css).toContain("--workbench-assistant-dock-inline-size: min(clamp(320px, var(--workbench-assistant-dock-width), 1040px), 46vw)");
    expect(css).toContain("--workbench-assistant-dock-out-target-width: min(420px, calc(100% - 56px))");
    expect(css).toContain(".chrome[data-shell-mode=\"capsule\"]");
    expect(css).toMatch(/\.chrome\[data-shell-mode="capsule"\]\s*\{[\s\S]*width: var\(--workbench-assistant-dock-out-target-width\)/);
    expect(css).toContain(".overlayPanel");
    expect(css).toContain(".expandedPanelFrame");
    expect(css).toContain("width: min(760px, 100%)");
    expect(css).not.toContain(".chrome[data-shell-mode=\"expanded\"]");
    expect(css).toContain("--workbench-assistant-dock-inline-size: min(380px, 48vw)");
  });

  it("keeps dock morph transitions on an opaque panel that collapses back to the capsule", () => {
    const css = readFileSync(
      resolve(process.cwd(), "src/renderer/pages/workbench/WorkbenchAssistantSurface.module.css"),
      "utf8",
    );

    expect(css).toContain(".chrome[data-shell-mode=\"dock-morph\"]");
    expect(css).toMatch(/\.chrome\[data-shell-mode="drawer"\],\s*\.chrome\[data-shell-mode="dock-morph"\]\s*\{[\s\S]*background: var\(--workbench-assistant-transition-bg\)/);
    expect(css).toContain(".chrome[data-shell-mode=\"dock-out-morph\"]");
    expect(css).toContain("--workbench-assistant-bottom-left: 50%");
    expect(css).toMatch(/\.chrome\[data-shell-mode="dock-out-morph"\]\[data-dock-out-target="capsule"\]\s*\{[\s\S]*left: var\(--workbench-assistant-bottom-left\)/);
    expect(css).toMatch(/\.chrome\[data-shell-mode="dock-out-morph"\]\[data-dock-out-target="capsule"\]\s*\{[\s\S]*width: var\(--workbench-assistant-dock-out-target-width\)/);
    expect(css).toContain(".surface[data-dock-transition=\"dock-out\"] .morphPanel");
    expect(css).toContain("--workbench-assistant-compose-duration: 420ms");
    expect(css).toContain("--workbench-assistant-dock-out-duration: 650ms");
    expect(css).toMatch(/\.surface\[data-dock-transition="dock-out"\]\s*\{[\s\S]*--workbench-assistant-compose-duration: var\(--workbench-assistant-dock-out-duration\)/);
    expect(css).toContain("animation: morphPanelConcealToCapsule var(--workbench-assistant-compose-duration)");
    expect(css).toMatch(/@keyframes morphPanelConcealToCapsule\s*\{[\s\S]*clip-path: inset\(50% 0 50% 0 round 18px\)/);
    expect(css).toMatch(/\.chrome\s*\{[\s\S]*transition:\s*[\s\S]*left var\(--workbench-assistant-compose-duration\)/);
    expect(css).toMatch(/\.chrome\s*\{[\s\S]*height var\(--workbench-assistant-compose-duration\)/);
    expect(css).toMatch(/\.chrome\s*\{[\s\S]*translate var\(--workbench-assistant-compose-duration\)/);
    expect(css).not.toContain("dockOutChromeToTarget");
    expect(css).not.toContain("52% {");
    expect(css).not.toContain("78% {");
    expect(css).not.toMatch(/\.capsule\[data-compose-open="false"\]\s*\{[\s\S]*width: fit-content/);
    expect(css).toContain("animation: dockOutComposerFrameToCapsule var(--workbench-assistant-compose-duration)");
    expect(css).toContain("animation: dockOutInputSurfaceToCapsule var(--workbench-assistant-compose-duration)");
    expect(css).toMatch(/\.shell\[data-transition-phase="dock-out"\] \.chrome\s*\{[\s\S]*transform-origin: bottom center/);
    expect(css).toMatch(/\.surface\[data-dock-transition="dock-out"\] \.morphPanel\[data-panel-mode="morph"\] \.morphMiddle\s*\{[\s\S]*transform-origin: bottom center/);
    expect(css).toMatch(/\.surface\[data-dock-transition="dock-out"\] \.capsule,\s*\.surface\[data-dock-transition="dock-out"\] \.composerFrame,\s*\.surface\[data-dock-transition="dock-out"\] \.inputSurface\s*\{[\s\S]*transform-origin: bottom center/);
    expect(css).not.toContain("morphPanelDockOut");
  });

  it("keeps a flat outer support layer around the assistant controls and input", () => {
    const css = readFileSync(
      resolve(process.cwd(), "src/renderer/pages/workbench/WorkbenchAssistantSurface.module.css"),
      "utf8",
    );

    expect(css).toMatch(/--workbench-assistant-glass-bg:\s*color-mix\([\s\S]*var\(--color-bg-elevated\) 72%,[\s\S]*var\(--color-border-strong\)/);
    expect(css).toContain("--workbench-assistant-glass-border: transparent");
    expect(css).toContain("--workbench-assistant-glass-shadow: none");
    expect(css).toContain("--workbench-assistant-control-glass-bg: var(--control-pill-bg)");
    expect(css).toContain("--workbench-assistant-control-glass-shadow: none");
    expect(css).toMatch(/\.chrome::before\s*\{[\s\S]*backdrop-filter/);
    expect(css).toMatch(/\.chrome\[data-shell-mode="capsule"\]::before,\s*\.chrome\[data-shell-mode="composer"\]::before,\s*\.chrome\[data-shell-mode="dock-out-morph"\]\[data-dock-out-target="capsule"\]::before,\s*\.chrome\[data-shell-mode="dock-out-morph"\]\[data-dock-out-target="composer"\]::before\s*\{[\s\S]*opacity: 1/);
    expect(css).toMatch(/\.chrome\[data-shell-mode="composer"\]::before\s*\{[\s\S]*inset: -12px -18px -10px[\s\S]*border-radius: 32px/);
    expect(css).toMatch(/\.chrome\[data-shell-mode="capsule"\]::before,\s*\.chrome\[data-shell-mode="dock-out-morph"\]\[data-dock-out-target="capsule"\]::before\s*\{[\s\S]*inset: -14px -24px -12px[\s\S]*border-radius: 34px/);
    expect(css).not.toMatch(/\.chrome\[data-shell-mode="drawer"\]::before/);
    expect(css).not.toMatch(/\.chrome\[data-shell-mode="dock-morph"\]::before/);
    expect(css).toMatch(/\.composerFrameAccessory :global\(\[aria-label="输入框状态"\] > \[data-selected-item\] > \[data-selected-item\]\)\s*\{[\s\S]*var\(--workbench-assistant-control-glass-bg\)/);
    expect(css).not.toContain(':global([aria-label="输入框状态"] [data-selected-item])');
    expect(css).toMatch(/\.dockHandle\s*\{[\s\S]*var\(--workbench-assistant-control-glass-bg\)/);
    expect(css).toMatch(/\.headerActionButton\s*\{[\s\S]*var\(--workbench-assistant-control-glass-bg\)/);
    expect(css).toMatch(/@supports not \(\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\)\)/);
  });

  it("keeps the workbench canvas dock-out layout animation slightly slower than dock-in", () => {
    const css = readFileSync(
      resolve(process.cwd(), "src/renderer/pages/workbench/WorkbenchModePage.module.css"),
      "utf8",
    );

    expect(css).toContain("--workbench-dock-layout-duration: 420ms");
    expect(css).toContain("--workbench-dock-layout-out-duration: 650ms");
    expect(css).toMatch(/\.workspace\[data-dock-transition-phase="dock-out"\]\s*\{[\s\S]*--workbench-dock-layout-duration: var\(--workbench-dock-layout-out-duration\)/);
    expect(css).toMatch(/\.workspace\[data-dock-transition-phase="dock-in"\] \.canvas\s*\{[\s\S]*animation: workbenchCanvasDockIn var\(--workbench-dock-layout-duration\)/);
    expect(css).toMatch(/\.workspace\[data-dock-transition-phase="dock-out"\] \.canvas\s*\{[\s\S]*animation: workbenchCanvasDockOut var\(--workbench-dock-layout-duration\)/);
    expect(css).toMatch(/\.workspace\[data-assistant-drawer-inline="true"\] \.canvas\s*\{[\s\S]*margin-right: 0/);
    expect(css).toMatch(/\.workspace\[data-dock-transition-phase="resize"\] \.canvas\s*\{[\s\S]*transition: none/);
    expect(css).toMatch(/\.workspace\[data-dock-transition-phase="resize"\] \.canvas\s*\{[\s\S]*will-change: auto/);
  });

  it("keeps the settled drawer as a real flex column instead of an overlay reservation", () => {
    const css = readFileSync(
      resolve(process.cwd(), "src/renderer/pages/workbench/WorkbenchAssistantSurface.module.css"),
      "utf8",
    );

    const inlineSurfaceRule = css.match(/\.surface\[data-dock-layout="inline"\]\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? "";
    expect(inlineSurfaceRule).toContain("position: relative");
    expect(inlineSurfaceRule).toContain("width: var(--workbench-assistant-dock-inline-size)");
    expect(inlineSurfaceRule).toContain("flex: 0 0 var(--workbench-assistant-dock-inline-size)");
    expect(inlineSurfaceRule).not.toContain("position: absolute");
    expect(inlineSurfaceRule).not.toContain("inset: 0");
  });

  it("disables drawer chrome transitions while the user is resizing", () => {
    const css = readFileSync(
      resolve(process.cwd(), "src/renderer/pages/workbench/WorkbenchAssistantSurface.module.css"),
      "utf8",
    );

    expect(css).toMatch(/\.surface\[data-drawer-resizing="true"\] \.chrome,\s*\.surface\[data-drawer-resizing="true"\] \.chrome::before,\s*\.surface\[data-drawer-resizing="true"\] \.capsule,\s*\.surface\[data-drawer-resizing="true"\] \.composerFrame,\s*\.surface\[data-drawer-resizing="true"\] \.inputSurface\s*\{[\s\S]*transition: none/);
  });

  it("keeps the base chrome as the single morphing shell for bottom and drawer states", () => {
    const css = readFileSync(
      resolve(process.cwd(), "src/renderer/pages/workbench/WorkbenchAssistantSurface.module.css"),
      "utf8",
    );

    const baseChromeRule = css.match(/\.chrome\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? "";
    expect(baseChromeRule).toContain("position: absolute");
    expect(baseChromeRule).toContain("transition:");
    expect(baseChromeRule).toContain("left var(--workbench-assistant-compose-duration)");
    expect(baseChromeRule).toContain("height var(--workbench-assistant-compose-duration)");
    expect(baseChromeRule).toContain("translate: -50% 0");
    expect(baseChromeRule).toContain("translate var(--workbench-assistant-compose-duration)");
    expect(baseChromeRule).toContain("transform: none");
    expect(baseChromeRule).not.toContain("transform var(--workbench-assistant-compose-duration)");
    expect(css).not.toMatch(/\.chrome(?:\[[^\]]+\])?\s*\{[^}]*transform: translateX\(-50%\)/);
  });

  it("keeps the fixed drawer conversation panel visually stable without a second reveal", () => {
    const css = readFileSync(
      resolve(process.cwd(), "src/renderer/pages/workbench/WorkbenchAssistantSurface.module.css"),
      "utf8",
    );

    expect(css).not.toContain("drawerPanelSettleIn");
    expect(css).not.toContain("drawerPanelGrowFromComposer");
    expect(css).not.toContain("clip-path: inset(92% 0 0 0");
    expect(css).not.toContain("drawerPanelContentReveal");
    const drawerPanelRule = css.match(/\.drawerPanel\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? "";
    expect(drawerPanelRule).not.toContain("animation:");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*\.drawerPanel/);
  });

  it("keeps the live workbench message carrier separate from the header trigger", () => {
    const css = readFileSync(
      resolve(process.cwd(), "src/renderer/pages/workbench/WorkbenchAssistantSurface.module.css"),
      "utf8",
    );
    expect(css).toContain("messageButton");
    expect(css).toContain("messageCarrier");
    expect(css).toMatch(/\.messageButton\s*\{[\s\S]*grid-area: messageButton/);
    expect(css).toMatch(/\.messageCarrier\s*\{[\s\S]*grid-area: messageCarrier/);
    expect(css).toMatch(/\.messageCarrier\s*\{[\s\S]*box-sizing: border-box/);
    expect(css).toMatch(/\.messageCarrier\s*\{[\s\S]*width: 100%/);
    expect(css).toMatch(/\.messageCarrier\s*\{[\s\S]*height: 100%/);
    expect(css).toMatch(/\.messageCarrier\s*\{[\s\S]*animation: workbenchMessageCarrierUnfurl/);
    expect(css).toMatch(/@keyframes workbenchMessageCarrierUnfurl\s*\{[\s\S]*clip-path: inset\(0 48% 0 48% round var\(--radius-pill\)\)/);
    expect(css).toMatch(/@keyframes workbenchMessageCarrierUnfurl\s*\{[\s\S]*clip-path: inset\(0 0 0 0 round var\(--radius-pill\)\)/);
    expect(css).not.toContain("width: min(66%, 280px)");
    expect(css).not.toContain("--workbench-message-trigger-enter-duration");
    expect(css).not.toContain("transition-duration: 560ms");
    expect(css).not.toMatch(/\.messageTrigger\[data-state="priming"\]/);
  });

  it("keeps the workbench message carrier hover flat", () => {
    const css = readFileSync(
      resolve(process.cwd(), "src/renderer/pages/workbench/WorkbenchAssistantSurface.module.css"),
      "utf8",
    );
    const hoverRule = css.match(/\.messageCarrier:hover,\s*\.messageCarrier:focus-visible\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? "";

    expect(hoverRule).toContain("background: var(--control-pill-hover-bg)");
    expect(hoverRule).toContain("box-shadow: none");
    expect(hoverRule).toContain("transform: none");
  });

  it("keeps the workbench message carrier dot and text vertically centered", () => {
    const css = readFileSync(
      resolve(process.cwd(), "src/renderer/pages/workbench/WorkbenchAssistantSurface.module.css"),
      "utf8",
    );
    const iconRule = css.match(/\.messageCarrierIcon\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? "";
    const textRule = css.match(/\.messageCarrierText\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? "";
    const dotRule = css.match(/\.messageCarrierDot\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? "";

    expect(iconRule).toContain("align-self: center");
    expect(iconRule).toContain("line-height: 0");
    expect(textRule).toContain("align-self: center");
    expect(dotRule).toContain("display: block");
  });

  it("keeps live workbench message carrier text free of fade refresh animation", () => {
    const css = readFileSync(
      resolve(process.cwd(), "src/renderer/pages/workbench/WorkbenchAssistantSurface.module.css"),
      "utf8",
    );
    const textRule = css.match(/\.messageCarrierText\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? "";

    expect(css).not.toContain("data-refresh-animation");
    expect(css).not.toContain("workbenchMessageCarrierTextRefresh");
    expect(textRule).not.toContain("opacity 180ms");
    expect(textRule).not.toContain("animation:");
  });

  it("keeps the settled drawer chrome visually aligned with the morph endpoint", () => {
    const css = readFileSync(
      resolve(process.cwd(), "src/renderer/pages/workbench/WorkbenchAssistantSurface.module.css"),
      "utf8",
    );

    expect(css).toContain("--workbench-assistant-drawer-radius: 18px");
    expect(css).toMatch(/\.chrome\[data-shell-mode="drawer"\],\s*\.chrome\[data-shell-mode="dock-morph"\]\s*\{[\s\S]*border: 1px solid color-mix\(in srgb, var\(--color-border-subtle\) 78%, transparent\)/);
    expect(css).toMatch(/\.chrome\[data-shell-mode="drawer"\],\s*\.chrome\[data-shell-mode="dock-morph"\]\s*\{[\s\S]*border-right: 0/);
    expect(css).toMatch(/\.chrome\[data-shell-mode="drawer"\],\s*\.chrome\[data-shell-mode="dock-morph"\]\s*\{[\s\S]*box-shadow: -16px 0 42px rgb\(15 23 42 \/ 8%\)/);
    expect(css).toMatch(/\.chrome\[data-shell-mode="drawer"\],\s*\.chrome\[data-shell-mode="dock-morph"\]\s*\{[\s\S]*border-radius: var\(--workbench-assistant-drawer-radius\) 0 0 var\(--workbench-assistant-drawer-radius\)/);
    expect(css).toMatch(/\.morphPanel\s*\{[\s\S]*border-radius: inherit/);
    expect(css).toMatch(/\.drawer\s*\{[\s\S]*border-radius: inherit/);
    expect(css).toMatch(/\.drawer > \.drawerHeader\s*\{[\s\S]*background: transparent/);
    expect(css).toMatch(/\.drawer > \.drawerHeader\s*\{[\s\S]*box-shadow: none/);
    expect(css).toMatch(/\.drawerPanel\s*\{[\s\S]*background: transparent/);
    expect(css).toMatch(/\.drawerPanel\s*\{[\s\S]*box-shadow: none/);
    expect(css).not.toContain(".drawerComposer");
    expect(css).toMatch(/\.chrome\[data-shell-mode="drawer"\] \.capsule,\s*\.chrome\[data-shell-mode="dock-morph"\] \.capsule\s*\{[\s\S]*padding: 8px 10px/);
    expect(css).not.toMatch(/\.chrome\[data-shell-mode="drawer"\] \.capsule,\s*\.chrome\[data-shell-mode="dock-morph"\] \.capsule,\s*\.chrome\[data-shell-mode="dock-out-morph"\] \.capsule/);
  });

  it("keeps the inline assistant host transparent so rounded drawer corners do not show a rectangular backing", () => {
    const css = readFileSync(
      resolve(process.cwd(), "src/renderer/pages/workbench/WorkbenchAssistantSurface.module.css"),
      "utf8",
    );
    const inlineSurfaceRule = css.match(/\.surface\[data-dock-layout="inline"\]\s*\{(?<body>[^}]*)\}/)?.groups?.body ?? "";

    expect(inlineSurfaceRule).toContain("background: transparent");
    expect(inlineSurfaceRule).toContain("border-left: 0");
    expect(inlineSurfaceRule).toContain("overflow: visible");
    expect(inlineSurfaceRule).toContain("position: relative");
    expect(inlineSurfaceRule).toContain("padding: 0");
  });
});
