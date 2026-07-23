import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AppContextMenuProvider } from "../src/renderer/providers/AppContextMenuProvider";
import type { BrowserEventEnvelope } from "../src/renderer/features/browser/domain";
import {
  BrowserDownloadController,
  browserDownloadController,
  isDangerousFilename,
} from "../src/renderer/features/browser/runtime/BrowserDownloadController";
import { DangerousDownloadPrompt } from "../src/renderer/features/browser/ui/DangerousDownloadPrompt";
import { DownloadsView } from "../src/renderer/features/browser/ui/DownloadsView";
import { runtimeBridge } from "../src/runtime";

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

function completed(id = "download-1"): BrowserEventEnvelope<"download.completed"> {
  return {
    schemaVersion: 1,
    kind: "download.completed",
    panelId: "panel-1",
    surfaceId: "surface-1",
    generation: 1,
    sequence: 2,
    occurredAt: "2026-07-21T00:00:01Z",
    payload: {
      downloadId: id,
      filePath: `C:\\Users\\tester\\Downloads\\${id}.pdf`,
    },
  };
}

function started(
  filename = "report.pdf",
  id = "download-1",
): BrowserEventEnvelope<"download.started"> {
  return {
    schemaVersion: 1,
    kind: "download.started",
    panelId: "panel-1",
    surfaceId: "surface-1",
    generation: 1,
    sequence: 2,
    occurredAt: "2026-07-21T00:00:01Z",
    payload: {
      downloadId: id,
      filePath: `C:\\Users\\tester\\Downloads\\${filename}`,
      filename,
    },
  };
}

function interrupted(id = "download-1"): BrowserEventEnvelope<"download.interrupted"> {
  return {
    schemaVersion: 1,
    kind: "download.interrupted",
    panelId: "panel-1",
    surfaceId: "surface-1",
    generation: 1,
    sequence: 3,
    occurredAt: "2026-07-21T00:00:02Z",
    payload: {
      downloadId: id,
      errorCategory: "paused",
      canResume: true,
    },
  };
}

function resumed(id = "download-1"): BrowserEventEnvelope<"download.resumed"> {
  return {
    schemaVersion: 1,
    kind: "download.resumed",
    panelId: "panel-1",
    surfaceId: "surface-1",
    generation: 1,
    sequence: 4,
    occurredAt: "2026-07-21T00:00:03Z",
    payload: { downloadId: id },
  };
}

function failed(errorCategory = "cancelled", id = "download-1"): BrowserEventEnvelope<"download.failed"> {
  return {
    schemaVersion: 1,
    kind: "download.failed",
    panelId: "panel-1",
    surfaceId: "surface-1",
    generation: 1,
    sequence: 5,
    occurredAt: "2026-07-21T00:00:04Z",
    payload: { downloadId: id, errorCategory },
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
    (listener as ((event: BrowserEventEnvelope) => void) | null)?.(started());
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
    const response = controller.respond("download-1", "cancel");
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    (listener as ((event: BrowserEventEnvelope) => void) | null)?.(failed());
    await response;
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

  it("keeps the host-owned completed path for reveal and delete actions", async () => {
    let listener: ((event: BrowserEventEnvelope) => void) | null = null;
    const controller = new BrowserDownloadController();
    controller.start({
      send: vi.fn().mockResolvedValue({ ok: true, requestId: "request" }),
      subscribe: (next: (event: BrowserEventEnvelope) => void) => {
        listener = next;
        return vi.fn();
      },
    } as never);

    (listener as ((event: BrowserEventEnvelope) => void) | null)?.(requested("report.pdf"));
    (listener as ((event: BrowserEventEnvelope) => void) | null)?.(completed());

    expect(controller.store.getState().items["download-1"]).toMatchObject({
      state: "completed",
      filePath: "C:\\Users\\tester\\Downloads\\download-1.pdf",
    });
    controller.remove("download-1");
    expect(controller.store.getState().items["download-1"]).toBeUndefined();
  });

  it("uses the resolved duplicate filename and controls an active native download", async () => {
    let listener: ((event: BrowserEventEnvelope) => void) | null = null;
    const send = vi.fn().mockResolvedValue({ ok: true, requestId: "request" });
    const controller = new BrowserDownloadController();
    controller.start({
      send,
      subscribe: (next: (event: BrowserEventEnvelope) => void) => {
        listener = next;
        return vi.fn();
      },
    } as never);

    (listener as ((event: BrowserEventEnvelope) => void) | null)?.(requested("report.pdf"));
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(
      "browser_respond_download",
      expect.objectContaining({ decision: "accept" }),
    ));
    (listener as ((event: BrowserEventEnvelope) => void) | null)?.(started("report (1).pdf"));
    expect(controller.store.getState().items["download-1"]).toMatchObject({
      filename: "report (1).pdf",
      filePath: "C:\\Users\\tester\\Downloads\\report (1).pdf",
    });

    await controller.control("download-1", "pause");
    expect(send).toHaveBeenLastCalledWith("browser_control_download", expect.objectContaining({
      action: "pause",
    }));
    (listener as ((event: BrowserEventEnvelope) => void) | null)?.(interrupted());
    expect(controller.store.getState().items["download-1"]?.state).toBe("paused");

    await controller.control("download-1", "resume");
    expect(send).toHaveBeenLastCalledWith("browser_control_download", expect.objectContaining({
      action: "resume",
    }));
    (listener as ((event: BrowserEventEnvelope) => void) | null)?.(resumed());
    await controller.control("download-1", "cancel");
    expect(send).toHaveBeenLastCalledWith("browser_control_download", expect.objectContaining({
      action: "cancel",
    }));
    (listener as ((event: BrowserEventEnvelope) => void) | null)?.(failed());
    expect(controller.store.getState().items["download-1"]?.state).toBe("cancelled");
  });

  it("never turns a quiet active download into an automatic cancellation", async () => {
    vi.useFakeTimers();
    try {
      let listener: ((event: BrowserEventEnvelope) => void) | null = null;
      const send = vi.fn().mockResolvedValue({ ok: true, requestId: "request" });
      const controller = new BrowserDownloadController();
      controller.start({
        send,
        subscribe: (next: (event: BrowserEventEnvelope) => void) => {
          listener = next;
          return vi.fn();
        },
      } as never);

      (listener as ((event: BrowserEventEnvelope) => void) | null)?.(requested("setup.exe"));
      await controller.respond("download-1", "accept");
      (listener as ((event: BrowserEventEnvelope) => void) | null)?.(started("setup.exe"));
      await vi.advanceTimersByTimeAsync(5 * 60_000);

      expect(send).not.toHaveBeenCalledWith(
        "browser_control_download",
        expect.objectContaining({ action: "cancel" }),
      );
      expect(controller.store.getState().items["download-1"]?.state).toBe("downloading");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a native terminal event authoritative when it arrives before the command response", async () => {
    let listener: ((event: BrowserEventEnvelope) => void) | null = null;
    const send = vi.fn(async () => {
      (listener as ((event: BrowserEventEnvelope) => void) | null)?.(started());
      (listener as ((event: BrowserEventEnvelope) => void) | null)?.(completed());
      return { ok: true, requestId: "request" };
    });
    const controller = new BrowserDownloadController();
    controller.start({
      send,
      subscribe: (next: (event: BrowserEventEnvelope) => void) => {
        listener = next;
        return vi.fn();
      },
    } as never);

    (listener as ((event: BrowserEventEnvelope) => void) | null)?.(requested("report.pdf"));
    await vi.waitFor(() => expect(controller.store.getState().items["download-1"]?.state).toBe("completed"));
  });

  it("never reopens a terminal download when a late progress event arrives", async () => {
    let listener: ((event: BrowserEventEnvelope) => void) | null = null;
    const controller = new BrowserDownloadController();
    controller.start({
      send: vi.fn().mockResolvedValue({ ok: true, requestId: "request" }),
      subscribe: (next: (event: BrowserEventEnvelope) => void) => {
        listener = next;
        return vi.fn();
      },
    } as never);
    (listener as ((event: BrowserEventEnvelope) => void) | null)?.(requested("report.pdf"));
    (listener as ((event: BrowserEventEnvelope) => void) | null)?.(started());
    (listener as ((event: BrowserEventEnvelope) => void) | null)?.(completed());
    (listener as ((event: BrowserEventEnvelope) => void) | null)?.({
      ...started(),
      kind: "download.progress",
      sequence: 6,
      payload: { downloadId: "download-1", receivedBytes: 2_048, totalBytes: 2_048 },
    } as BrowserEventEnvelope<"download.progress">);

    expect(controller.store.getState().items["download-1"]?.state).toBe("completed");
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
      filePath: null,
      canResume: false,
    };
    const onAccept = vi.fn();
    render(<DangerousDownloadPrompt item={item} responding={false} onAccept={onAccept} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "仍然下载" }));
    expect(onAccept).toHaveBeenCalledOnce();
  });

  it("renders a selectable themed downloads popover with quick and context actions", async () => {
    const revealPath = vi.spyOn(runtimeBridge.desktopPicker, "revealPath").mockResolvedValue(undefined);
    const onClose = vi.fn();
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
          filePath: "C:\\Users\\tester\\Downloads\\report.pdf",
          canResume: false,
        },
      },
    });
    render(
      <AppContextMenuProvider>
        <div data-theme="dark"><DownloadsView onClose={onClose} /></div>
      </AppContextMenuProvider>,
    );
    expect(screen.getByRole("dialog", { name: "下载" }).getAttribute("aria-modal")).toBe("false");
    expect(screen.getByText("report.pdf")).not.toBeNull();
    expect(screen.getByText("已完成")).not.toBeNull();

    const row = screen.getByRole("option", { name: "report.pdf，已完成" });
    fireEvent.click(row);
    expect(row.getAttribute("aria-selected")).toBe("true");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "在资源管理器中显示 report.pdf" }));
    });
    await vi.waitFor(() => {
      expect(revealPath).toHaveBeenCalledWith("C:\\Users\\tester\\Downloads\\report.pdf");
      expect(onClose).toHaveBeenCalledOnce();
    });

    fireEvent.contextMenu(row, { clientX: 24, clientY: 24 });
    expect(await screen.findByRole("menuitem", { name: "在资源管理器中显示" })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "删除文件" })).not.toBeNull();
  });

  it("closes the downloads popover when the renderer page is clicked outside it", () => {
    const onClose = vi.fn();
    browserDownloadController.store.setState({ items: {} });

    render(<DownloadsView onClose={onClose} />);
    fireEvent.pointerDown(document.body);

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("opens deletion confirmation as a centered sibling overlay instead of clipping it inside the popover", async () => {
    const deleteBrowserDownload = vi.spyOn(
      runtimeBridge.desktopPicker,
      "deleteBrowserDownload",
    ).mockResolvedValue(undefined);
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
          filePath: "C:\\Users\\tester\\Downloads\\report.pdf",
          canResume: false,
        },
      },
    });

    render(<DownloadsView onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "删除 report.pdf" }));
    const confirmation = screen.getByRole("alertdialog", { name: "删除下载文件？" });
    const popover = screen.getByRole("dialog", { name: "下载" });
    expect(confirmation).not.toBeNull();
    expect(popover.contains(confirmation)).toBe(false);
    fireEvent.pointerDown(confirmation);
    expect(popover).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "删除文件" }));
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(deleteBrowserDownload).toHaveBeenCalledWith(
        "C:\\Users\\tester\\Downloads\\report.pdf",
      );
      expect(browserDownloadController.store.getState().items.complete).toBeUndefined();
    });
  });
});
