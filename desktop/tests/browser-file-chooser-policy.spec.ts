import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BROWSER_COMMAND_KINDS,
  type BrowserCommandKind,
} from "../src/renderer/features/browser/domain";
import { BrowserOcclusionCoordinator } from "../src/renderer/features/browser/runtime/BrowserOcclusionCoordinator";

describe("browser file chooser policy", () => {
  it("has no command that can inject a local upload path", () => {
    const commands = BROWSER_COMMAND_KINDS as readonly BrowserCommandKind[];
    expect(commands.some((command) => /upload|file_chooser|choose_file/i.test(command))).toBe(false);
    const contract = readFileSync(
      resolve(process.cwd(), "src/renderer/features/browser/domain/browserHostContract.ts"),
      "utf8",
    );
    expect(contract).not.toMatch(/browser_(?:upload|choose_file|set_file)/u);
  });

  it("uses the shared system-picker occlusion reason and releases it idempotently", () => {
    const coordinator = new BrowserOcclusionCoordinator();
    const release = coordinator.acquire("system_picker");
    expect(coordinator.snapshot()).toEqual(expect.objectContaining({ count: 1 }));
    release();
    release();
    expect(coordinator.snapshot().count).toBe(0);
  });
});
