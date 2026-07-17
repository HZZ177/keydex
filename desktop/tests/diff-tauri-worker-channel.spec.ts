import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  PierreWorkerEnvironmentError,
  resolvePierreWorkerEnvironment,
} from "@/renderer/components/diff/engine/pierreWorkerEnvironment";
import { PierreWorkerFactoryController } from "@/renderer/components/diff/engine/pierreWorkerFactory";

describe("Tauri WebView Pierre Worker channel", () => {
  it.each([
    ["web", "http://127.0.0.1:5173/index.html", false, "http://127.0.0.1:5173/assets/pierre.js"],
    ["tauri_dev", "http://127.0.0.1:5173/index.html", true, "http://127.0.0.1:5173/assets/pierre.js"],
    ["tauri_packaged", "http://tauri.localhost/index.html", true, "http://tauri.localhost/assets/pierre.js"],
    ["tauri_packaged", "tauri://localhost/index.html", true, "tauri://localhost/assets/pierre.js"],
  ] as const)("resolves the same local asset in %s", (runtime, pageUrl, tauriRuntime, workerUrl) => {
    expect(resolvePierreWorkerEnvironment("/assets/pierre.js", { pageUrl, tauriRuntime }))
      .toEqual({
        runtime,
        pageUrl,
        workerUrl,
        protocol: new URL(pageUrl).protocol,
        sameOrigin: true,
      });
  });

  it.each([
    "C:\\Program Files\\Keydex\\assets\\pierre.js",
    "\\\\server\\share\\pierre.js",
    "blob:http://tauri.localhost/worker",
    "data:text/javascript,postMessage(1)",
    "https://cdn.example.com/pierre.js",
  ])("rejects unsafe packaged worker source %s", (assetUrl) => {
    expect(() => resolvePierreWorkerEnvironment(assetUrl, {
      pageUrl: "http://tauri.localhost/index.html",
      tauriRuntime: true,
    })).toThrow(PierreWorkerEnvironmentError);
  });

  it("starts a module worker through the packaged origin and allows the owner to terminate it", () => {
    const terminate = vi.fn();
    const construction = vi.fn();
    const WorkerConstructor = class {
      constructor(url: string | URL, options?: WorkerOptions) {
        construction(String(url), options);
      }
      addEventListener() {}
      terminate = terminate;
    };
    const controller = new PierreWorkerFactoryController({
      workerUrl: "/assets/pierre.js",
      workerConstructor: WorkerConstructor as never,
      pageUrl: "http://tauri.localhost/index.html",
      tauriRuntime: true,
    });
    const worker = controller.create();
    worker.terminate();
    expect(construction).toHaveBeenCalledWith(
      "http://tauri.localhost/assets/pierre.js",
      expect.objectContaining({ type: "module" }),
    );
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("keeps packaged frontend assets local and records the currently disabled CSP", () => {
    const config = JSON.parse(readFileSync(resolve(process.cwd(), "src-tauri/tauri.conf.json"), "utf8"));
    expect(config.build.frontendDist).toBe("../dist");
    expect(config.build.devUrl).toBe("http://127.0.0.1:5173");
    expect(config.build.beforeDevCommand).toBe("pnpm dev");
    expect(config.build.beforeBuildCommand).toBe("pnpm build");
    expect(config.app.security.csp).toBeNull();
    const factory = readFileSync(
      resolve(process.cwd(), "src/renderer/components/diff/engine/pierreWorkerFactory.ts"),
      "utf8",
    );
    expect(factory).toContain("PIERRE_WORKER_CSP_REQUIREMENT");
    expect(factory).not.toContain("cdn.");
  });
});
