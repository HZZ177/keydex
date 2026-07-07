import { describe, expect, it, vi } from "vitest";

import { createHttpClient, createLocalPreviewRuntime, type TauriInvoke } from "@/runtime";

describe("LocalPreviewRuntime", () => {
  it("reads local text files through Tauri before the backend base URL is configured", async () => {
    const invokeMock = vi.fn(async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
      expect(command).toBe("read_text_file");
      expect(args).toEqual({ path: "D:/notes/readme.md" });
      return {
        path: "D:/notes/readme.md",
        content: "# Readme",
        encoding: "utf-8",
      };
    });
    const invoke = invokeMock as unknown as TauriInvoke;
    const runtime = createLocalPreviewRuntime(createHttpClient(), {
      invoke,
      isTauriRuntime: () => true,
    });

    await expect(runtime.readFile("D:/notes/readme.md")).resolves.toEqual({
      path: "D:/notes/readme.md",
      content: "# Readme",
      encoding: "utf-8",
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
