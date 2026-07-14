import { act, cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentSessionProvider,
  useAgentSessionRuntime,
} from "@/renderer/providers/AgentSessionProvider";
import {
  FileChangeProvider,
  useFileChanges,
  type FileChangeContextValue,
  type FileChangeTransport,
} from "@/renderer/providers/FileChangeProvider";
import type { ChatChannel, RuntimeBridge } from "@/runtime";
import type { AgentActionEnvelope } from "@/types/protocol";

afterEach(() => cleanup());

class FakeTransport implements FileChangeTransport {
  bindWorkspaceWatch = vi.fn();
  unbindWorkspaceWatch = vi.fn();
  bindLocalFileWatch = vi.fn();
  unbindLocalFileWatch = vi.fn();
  private readonly listeners = new Set<(event: AgentActionEnvelope) => void>();

  subscribeEvent(listener: (event: AgentActionEnvelope) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: AgentActionEnvelope) {
    for (const listener of this.listeners) listener(event);
  }
}

function renderProvider(transport = new FakeTransport()) {
  const captured: { current: FileChangeContextValue | null } = { current: null };
  function Probe() {
    captured.current = useFileChanges();
    return null;
  }
  const rendered = render(
    <FileChangeProvider transport={transport}>
      <Probe />
    </FileChangeProvider>,
  );
  const api = captured.current;
  if (!api) throw new Error("FileChangeProvider API was not captured");
  return { api, transport, ...rendered };
}

describe("FileChangeProvider", () => {
  it("reference counts workspace watch consumers", () => {
    const { api, transport } = renderProvider();
    const first = api.subscribeWorkspace("ws-1", vi.fn());
    const second = api.subscribeWorkspace("ws-1", vi.fn());

    expect(transport.bindWorkspaceWatch).toHaveBeenCalledTimes(1);
    first();
    expect(transport.unbindWorkspaceWatch).not.toHaveBeenCalled();
    second();
    expect(transport.unbindWorkspaceWatch).toHaveBeenCalledWith("ws-1");
  });

  it("reference counts local file watch consumers", () => {
    const { api, transport } = renderProvider();
    const first = api.subscribeLocalFile("local-1", "D:/tmp/a.md", vi.fn());
    const second = api.subscribeLocalFile("local-1", "D:/tmp/a.md", vi.fn());

    expect(transport.bindLocalFileWatch).toHaveBeenCalledTimes(1);
    first();
    expect(transport.unbindLocalFileWatch).not.toHaveBeenCalled();
    second();
    expect(transport.unbindLocalFileWatch).toHaveBeenCalledWith("local-1");
  });

  it("dispatches contiguous workspace change sequences incrementally", () => {
    const { api, transport } = renderProvider();
    const listener = vi.fn();
    api.subscribeWorkspace("ws-1", listener);
    transport.emit({
      action: "workspaceWatchBound",
      data: { workspace_id: "ws-1", sequence: 10, resync_required: true },
    });
    listener.mockClear();

    transport.emit({
      action: "workspaceFilesChanged",
      data: {
        workspace_id: "ws-1",
        sequence: 11,
        resync_required: false,
        changes: [{ kind: "modified", path: "a.md" }],
      },
    });
    transport.emit({
      action: "workspaceFilesChanged",
      data: {
        workspace_id: "ws-1",
        sequence: 12,
        resync_required: false,
        changes: [{ kind: "added", path: "b.md" }],
      },
    });

    expect(listener.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ sequence: 11, resyncRequired: false }),
      expect.objectContaining({ sequence: 12, resyncRequired: false }),
    ]);
  });

  it("requests resync when workspace change sequence has a gap", () => {
    const { api, transport } = renderProvider();
    const listener = vi.fn();
    api.subscribeWorkspace("ws-1", listener);
    transport.emit({
      action: "workspaceWatchBound",
      data: { workspace_id: "ws-1", sequence: 3, resync_required: true },
    });
    listener.mockClear();

    transport.emit({
      action: "workspaceFilesChanged",
      data: {
        workspace_id: "ws-1",
        sequence: 5,
        resync_required: false,
        changes: [{ kind: "modified", path: "incomplete.md" }],
      },
    });

    expect(listener).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      sequence: 5,
      resyncRequired: true,
      changes: [],
    });
  });

  it("requests resync after workspace watch rebound acknowledgement", () => {
    const { api, transport } = renderProvider();
    const listener = vi.fn();
    api.subscribeWorkspace("ws-1", listener);

    transport.emit({
      action: "workspaceWatchBound",
      data: { workspace_id: "ws-1", sequence: 20, resync_required: false },
    });

    expect(listener).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      sequence: 20,
      resyncRequired: true,
      changes: [],
    });
  });

  it("routes workspace file changes only to matching scope", () => {
    const { api, transport } = renderProvider();
    const first = vi.fn();
    const second = vi.fn();
    api.subscribeWorkspace("ws-a", first);
    api.subscribeWorkspace("ws-b", second);

    transport.emit({
      action: "workspaceFilesChanged",
      data: {
        workspace_id: "ws-a",
        sequence: 1,
        resync_required: false,
        changes: [{ kind: "added", path: "same.md" }],
      },
    });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("keeps file watch events outside agent session store", () => {
    let channelOnEvent: ((event: AgentActionEnvelope) => void) | null = null;
    let stateReference: unknown;
    const channel = {
      close: vi.fn(),
      getStatus: () => "open",
      getSessionId: () => null,
      requestStatus: vi.fn(),
    } as unknown as ChatChannel;
    const runtime = {
      conversation: {
        openChatChannel(onEvent: (event: AgentActionEnvelope) => void) {
          channelOnEvent = onEvent;
          return channel;
        },
      },
    } as unknown as RuntimeBridge;
    function Probe() {
      stateReference = useAgentSessionRuntime().state;
      return null;
    }
    render(
      <AgentSessionProvider runtime={runtime}>
        <Probe />
      </AgentSessionProvider>,
    );
    const before = stateReference;

    act(() => {
      channelOnEvent?.({
        action: "workspaceFilesChanged",
        data: {
          workspace_id: "ws-1",
          sequence: 1,
          resync_required: false,
          changes: [{ kind: "modified", path: "a.md" }],
        },
      });
    });

    expect(stateReference).toBe(before);
  });

  it("keeps workspace and local file watches bound when unrelated agent runtime state changes", () => {
    let setRuntimeDetail: ((detail: string | null) => void) | null = null;
    const bindLocalFileWatch = vi.fn();
    const bindWorkspaceWatch = vi.fn();
    const unbindLocalFileWatch = vi.fn();
    const unbindWorkspaceWatch = vi.fn();
    const channel = {
      bindLocalFileWatch,
      bindWorkspaceWatch,
      close: vi.fn(),
      getStatus: () => "open",
      getSessionId: () => null,
      requestStatus: vi.fn(),
      unbindLocalFileWatch,
      unbindWorkspaceWatch,
    } as unknown as ChatChannel;
    const runtime = {
      conversation: {
        openChatChannel() {
          return channel;
        },
      },
    } as unknown as RuntimeBridge;
    const listener = vi.fn();

    function Probe() {
      const agentRuntime = useAgentSessionRuntime();
      const fileChanges = useFileChanges();
      setRuntimeDetail = agentRuntime.setRuntimeDetail;
      useEffect(() => {
        const unsubscribeWorkspace = fileChanges.subscribeWorkspace("ws-1", listener);
        const unsubscribeLocal = fileChanges.subscribeLocalFile(
          "local-1",
          "D:/tmp/a.md",
          listener,
        );
        return () => {
          unsubscribeLocal();
          unsubscribeWorkspace();
        };
      }, [fileChanges]);
      return null;
    }

    render(
      <AgentSessionProvider runtime={runtime}>
        <FileChangeProvider>
          <Probe />
        </FileChangeProvider>
      </AgentSessionProvider>,
    );
    expect(bindLocalFileWatch).toHaveBeenCalledTimes(1);
    expect(bindWorkspaceWatch).toHaveBeenCalledTimes(1);

    act(() => {
      setRuntimeDetail?.("agent stream updated");
    });

    expect(bindLocalFileWatch).toHaveBeenCalledTimes(1);
    expect(bindWorkspaceWatch).toHaveBeenCalledTimes(1);
    expect(unbindLocalFileWatch).not.toHaveBeenCalled();
    expect(unbindWorkspaceWatch).not.toHaveBeenCalled();
  });
});
