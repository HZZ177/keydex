import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BROWSER_BASE_TOKENS,
  BROWSER_DUAL_THEME_TOKENS,
  BROWSER_INTERACTION_STATES,
  BROWSER_OVERLAY_TOKEN_MAP,
  BROWSER_REMOTE_PAGE_THEME_POLICY,
  BROWSER_RIGHT_SIDEBAR_SELECTORS,
  BROWSER_SHARED_COMPONENTS,
  BROWSER_VISUAL_CONTRACT_SCHEMA_VERSION,
  readBrowserAppearanceTheme,
  readBrowserPageAppearance,
} from "../src/renderer/features/browser/visualContract";

const desktopRoot = process.cwd();
const srcRoot = resolve(desktopRoot, "src");
const fixturePath = resolve(
  desktopRoot,
  "..",
  "test-fixtures",
  "sidebar-browser",
  "contracts",
  "browser-visual-contract-v1.json",
);

interface VisualFixture {
  schemaVersion: number;
  baseTokens: string[];
  dualThemeTokens: string[];
  sharedComponents: { name: string; source: string }[];
  rightSidebarSelectors: string[];
  interactionStates: string[];
  remotePageThemePolicy: string;
}

function readVisualFixture(): VisualFixture {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as VisualFixture;
}

describe("browser visual contract", () => {
  it("uses the restrained warm canvas when the light browser surface token is unavailable", () => {
    const root = document.createElement("div");

    expect(readBrowserPageAppearance("light", root).backgroundColor).toEqual({
      red: 255,
      green: 254,
      blue: 252,
      alpha: 255,
    });
    expect(readBrowserPageAppearance("dark", root).backgroundColor).toEqual({
      red: 40,
      green: 42,
      blue: 54,
      alpha: 255,
    });
  });

  it("keeps the executable contract aligned with the review fixture", () => {
    const fixture = readVisualFixture();

    expect(fixture.schemaVersion).toBe(BROWSER_VISUAL_CONTRACT_SCHEMA_VERSION);
    expect(fixture.baseTokens).toEqual(BROWSER_BASE_TOKENS);
    expect(fixture.dualThemeTokens).toEqual(BROWSER_DUAL_THEME_TOKENS);
    expect(fixture.sharedComponents).toEqual(BROWSER_SHARED_COMPONENTS);
    expect(fixture.rightSidebarSelectors).toEqual(BROWSER_RIGHT_SIDEBAR_SELECTORS);
    expect(fixture.interactionStates).toEqual(BROWSER_INTERACTION_STATES);
    expect(fixture.remotePageThemePolicy).toBe(BROWSER_REMOTE_PAGE_THEME_POLICY);
  });

  it("sources geometry, shadow, and motion from the existing base theme", () => {
    const baseCss = readSource("renderer/styles/themes/base.css");

    for (const token of BROWSER_BASE_TOKENS) {
      expect(baseCss, `${token} must remain a Keydex base token`).toContain(`${token}:`);
    }
  });

  it("defines every browser semantic token in both existing themes", () => {
    const themeCss = readSource("renderer/styles/themes/default-color-scheme.css");
    const darkStart = themeCss.indexOf(':root[data-theme="dark"]');
    expect(darkStart).toBeGreaterThan(0);
    const lightTheme = themeCss.slice(0, darkStart);
    const darkTheme = themeCss.slice(darkStart);

    for (const token of BROWSER_DUAL_THEME_TOKENS) {
      expect(lightTheme, `${token} is missing from light theme`).toContain(`${token}:`);
      expect(darkTheme, `${token} is missing from dark theme`).toContain(`${token}:`);
    }
  });

  it("reuses the current sidebar selectors, interaction states, and reduced-motion policy", () => {
    const layoutCss = readSource("renderer/components/layout/Layout.module.css");
    const initialPageCss = readSource(
      "renderer/components/layout/RightSidebarInitialPage.module.css",
    );

    for (const selector of BROWSER_RIGHT_SIDEBAR_SELECTORS) {
      expect(layoutCss, `${selector} is missing from the current sidebar baseline`).toContain(
        selector,
      );
    }
    for (const state of BROWSER_INTERACTION_STATES) {
      expect(`${layoutCss}\n${initialPageCss}`, `${state} is missing from the visual baseline`).toContain(
        state,
      );
    }
    expect(layoutCss).toContain("height: 42px;");
    expect(layoutCss).toContain("var(--motion-fast)");
    expect(initialPageCss).toContain("var(--surface-hover)");
  });

  it("keeps dialogs, menus, tooltips, notifications, and floating layers shared", () => {
    for (const component of BROWSER_SHARED_COMPONENTS) {
      const source = readSource(component.source);
      expect(source, `${component.name} must remain an exported shared component`).toContain(
        `export function ${component.name}`,
      );
    }
  });

  it("rejects a second palette, radius, shadow, or motion system in browser CSS", () => {
    const browserRoot = resolve(srcRoot, "renderer/features/browser");
    const cssFiles = collectCssFiles(browserRoot);

    for (const cssFile of cssFiles) {
      const css = readFileSync(cssFile, "utf8");
      expect(css, `${cssFile} contains a hard-coded hex color`).not.toMatch(/#[\da-f]{3,8}\b/i);
      expect(css, `${cssFile} contains a hard-coded rgb/hsl color`).not.toMatch(
        /(?:rgb|hsl)a?\s*\(/i,
      );
      expect(css, `${cssFile} contains a literal border radius`).not.toMatch(
        /border-radius\s*:\s*(?!0(?:\D|$))\d/i,
      );
      expect(css, `${cssFile} contains a literal transition duration`).not.toMatch(
        /transition(?:-duration)?\s*:[^;]*\d+ms/i,
      );
      expect(css, `${cssFile} contains a literal box shadow`).not.toMatch(
        /box-shadow\s*:\s*(?!none\b|var\()[^;]+/i,
      );
    }
  });

  it("maps injected page overlays only from the existing Keydex semantic tokens", () => {
    const colorTokens = Object.entries(BROWSER_OVERLAY_TOKEN_MAP)
      .filter(([name]) => name !== "radius" && name !== "motion")
      .map(([, token]) => token);
    for (const token of colorTokens) expect(BROWSER_DUAL_THEME_TOKENS).toContain(token);
    expect(BROWSER_BASE_TOKENS).toContain(BROWSER_OVERLAY_TOKEN_MAP.radius);
    expect(BROWSER_BASE_TOKENS).toContain(BROWSER_OVERLAY_TOKEN_MAP.motion);

    const root = document.createElement("div");
    root.style.setProperty("--annotation-accent", "rgb(216, 117, 117)");
    root.style.setProperty("--color-bg-elevated", "rgb(255, 255, 255)");
    root.style.setProperty("--surface-bg", "var(--color-bg-elevated)");
    root.style.setProperty("--color-text-1", "rgb(23, 23, 23)");
    root.style.setProperty("--color-border-strong", "rgb(201, 201, 201)");
    root.style.setProperty("--color-warning", "rgb(217, 119, 6)");
    root.style.setProperty("--color-danger", "rgb(217, 45, 32)");
    root.style.setProperty("--radius-xs", "4px");
    root.style.setProperty("--motion-fast", "140ms");
    document.body.append(root);
    const theme = readBrowserAppearanceTheme("light", false, root);
    const reduced = readBrowserAppearanceTheme("light", true, root);
    root.remove();

    expect(theme).toMatchObject({
      theme: "light",
      backgroundColor: { red: 255, green: 255, blue: 255, alpha: 255 },
      tokens: { accent: "rgb(216, 117, 117)", surface: "rgb(255, 255, 255)" },
      radiusPx: 4,
      motionMs: 140,
      reducedMotion: false,
    });
    expect(reduced.motionMs).toBe(0);
  });

  it("pins the browser stage to the flexible grid row when the optional accessory is empty", () => {
    const panelCss = readSource("renderer/features/browser/ui/BrowserPanel.module.css");

    expect(panelCss).toMatch(/\.toolbar\s*\{[^}]*grid-row:\s*1;/s);
    expect(panelCss).toMatch(/\.toolbarAccessory\s*\{[^}]*grid-row:\s*2;/s);
    expect(panelCss).not.toMatch(/\.pageIdentity\s*\{/s);
    expect(panelCss).toMatch(/\.stage\s*\{[^}]*grid-row:\s*3;/s);
  });
});

function readSource(relativePath: string): string {
  return readFileSync(resolve(srcRoot, relativePath), "utf8");
}

function collectCssFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = resolve(root, entry);
    if (statSync(path).isDirectory()) {
      result.push(...collectCssFiles(path));
    } else if (entry.endsWith(".css")) {
      result.push(path);
    }
  }
  return result;
}
