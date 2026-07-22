import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { BrowserEventEnvelope } from "../src/renderer/features/browser/domain";
import {
  BrowserDownloadController,
  browserDownloadController,
  isDangerousFilename,
} from "../src/renderer/features/browser/runtime/BrowserDownloadController";
import { DangerousDownloadPrompt } from "../src/renderer/features/browser/ui/DangerousDownloadPrompt";
import { DownloadsView } from "../src/renderer/features/browser/ui/DownloadsView";

function requested(filename: string, id = "download-1"): BrowserEventEnvelope<"download.requested"> {
  return {
    schemaVersion: 1,
    kind: "download.requested",
    panelId: "panel-1",
    surfaceId: "surface-1",
    generation: 1,
    sequence: 1,
    occurredAt: "2026-07-21T00:00:00Z",
    payload: {
      downloadId: id,
      url: "https://example.com/file?token=%5Bredacted%5D",
      suggestedFilename: filename,
      totalBytes: 2_048,
    },
  };
}

describe("BrowserDownloadController", () => {
  it("auto-accepts ordinary files into the host-managed Downloads target", async () => {
    let listener: ((event: BrowserEventEnvelope) => void) | null = null;
    const send = vi.fn().mockResolvedValue({ ok: true, requestId: "request" });
    const controller = new BrowserDownloadController();
    controller.start({ send, subscribe: (next: (event: BrowserEventEnvelope) => void) => { listener = next; return vi.fn(); } } as never);
    (listener as ((event: BrowserEventEnvelope) => void) | null)?.(requested("report.pdf"));
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith("browser_respond_download", {
      panelId: "panel-1",
      surfaceId: "surface-1",
      generation: 1,
      downloadId: "download-1",
      decision: "accept",
    }));
    expect(controller.store.getState().items["download-1"]?.state).toBe("downloading");
  });

  it("holds executable files for explicit confirmation and releases the surface after cancel", async () => {
    let listener: ((event: BrowserEventEnvelope) => void) | null = null;
    const send = vi.fn().mockResolvedValue({ ok: true, requestId: "request" });
    const onIdle = vi.fn();
    const controller = new BrowserDownloadController();
    controller.setSurfaceIdleHandler(onIdle);
    controller.start({ send, subscribe: (next: (event: BrowserEventEnvelope) => void) => { listener = next; return vi.fn(); } } as never);
    (listener as ((event: BrowserEventEnvelope) => void) | null)?.(requested("setup.exe"));
    expect(send).not.toHaveBeenCalled();
    await controller.respond("download-1", "cancel");
    expect(send).toHaveBeenCalledWith("browser_respond_download", expect.objectContaining({ decision: "cancel" }));
    expect(onIdle).toHaveBeenCalledOnce();
    expect(isDangerousFilename("script.PS1")).toBe(true);
  });

  it("fails pending work and cancels its timeout when the owning surface crashes", async () => {
    vi.useFakeTimers();
    try {
      let listener: ((event: BrowserEventEnvelope) => void) | null = null;
      const send = vi.fn().mockResolvedValue({ ok: true, requestId: "request" });
      const onIdle = vi.fn();
      const controller = new BrowserDownloadController();
      controller.setSurfaceIdleHandler(onIdle);
      controller.start({
        send,
        subscribe: (next: (event: BrowserEventEnvelope) => void) => {
          listener = next;
          return vi.fn();
        },
      } as never);
      (listener as ((event: BrowserEventEnvelope) => void) | null)?.(requested("setup.exe"));
      const surface = { panelId: "panel-1", surfaceId: "surface-1", generation: 1 };

      controller.failSurface(surface, "render_process_exited");
      await vi.advanceTimersByTimeAsync(30_000);

      expect(controller.store.getState().items["download-1"]).toMatchObject({
        state: "failed",
        errorCategory: "render_process_exited",
      });
      expect(send).not.toHaveBeenCalled();
      expect(onIdle).toHaveBeenCalledWith(surface);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("download UI", () => {
  it("uses a shared confirmation dialog for dangerous downloads", () => {
    const item = {
      id: "download-danger",
      surface: { panelId: "panel-1", surfaceId: "surface-1", generation: 1 },
      url: "https://example.com/setup.exe",
      filename: "setup.exe",
      receivedBytes: 0,
      totalBytes: 1_024,
      state: "requested" as const,
      errorCategory: null,
      dangerous: true,
    };
    const onAccept = vi.fn();
    render(<DangerousDownloadPrompt item={item} responding={false} onAccept={onAccept} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "仍然下载" }));
    expect(onAccept).toHaveBeenCalledOnce();
  });

  it("renders progress and completion in the themed downloads drawer", () => {
    browserDownloadController.store.setState({
      items: {
        complete: {
          id: "complete",
          surface: { panelId: "panel-1", surfaceId: "surface-1", generation: 1 },
          url: "https://example.com/report.pdf",
          filename: "report.pdf",
          receivedBytes: 2_048,
          totalBytes: 2_048,
          state: "completed",
          errorCategory: null,
          dangerous: false,
        },
      },
    });
    render(<div data-theme="dark"><DownloadsView onClose={vi.fn()} /></div>);
    expect(screen.getByRole("dialog")).not.toBeNull();
    expect(screen.getByText("report.pdf")).not.toBeNull();
    expect(screen.getByText("已完成")).not.toBeNull();
  });
});
