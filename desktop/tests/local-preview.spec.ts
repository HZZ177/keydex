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

  it("prepares browser html files through the local preview server", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("http://127.0.0.1:8765/api/local-preview/html/register");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        path: "D:/repo/prototype/index.html",
        scope_path: "D:/repo",
      });
      return new Response(JSON.stringify({
        path: "D:\\repo\\prototype\\index.html",
        url: "http://127.0.0.1:8765/api/local-preview/html/token/prototype/index.html",
      }), {
        headers: { "Content-Type": "application/json" },
      });
    });
    const runtime = createLocalPreviewRuntime(createHttpClient({
      baseUrl: "http://127.0.0.1:8765",
      fetcher: fetcher as typeof fetch,
    }), {
      isTauriRuntime: () => true,
    });

    await expect(runtime.prepareHtmlFile("D:/repo/prototype/index.html", "D:/repo")).resolves.toEqual({
      path: "D:\\repo\\prototype\\index.html",
      url: "http://127.0.0.1:8765/api/local-preview/html/token/prototype/index.html",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("prepares isolated html content through the local preview server", async () => {
    const content = "<main>Preview<script>document.body.dataset.ready='true'</script></main>";
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("http://127.0.0.1:8765/api/local-preview/html/content/register");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ content });
      return new Response(JSON.stringify({
        url: "http://127.0.0.1:8765/api/local-preview/html/content/token",
      }), {
        headers: { "Content-Type": "application/json" },
      });
    });
    const runtime = createLocalPreviewRuntime(createHttpClient({
      baseUrl: "http://127.0.0.1:8765",
      fetcher: fetcher as typeof fetch,
    }));

    await expect(runtime.prepareHtmlContent(content)).resolves.toEqual({
      url: "http://127.0.0.1:8765/api/local-preview/html/content/token",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
