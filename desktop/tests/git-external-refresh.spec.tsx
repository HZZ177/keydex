import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActiveProjectProvider } from "@/renderer/providers/ActiveProjectProvider";
import { AgentSessionProvider } from "@/renderer/providers/AgentSessionProvider";
import { FileChangeProvider } from "@/renderer/providers/FileChangeProvider";
import { GitProvider } from "@/renderer/providers/GitProvider";
import type { ChatChannel, RuntimeBridge } from "@/runtime";
import type { GitRuntime } from "@/runtime/git";
import type {
  GitMetadataChangedEvent,
  GitRepositoryId,
  GitRepositoryVersion,
} from "@/runtime/gitTypes";
import type { AgentActionEnvelope } from "@/types/protocol";

afterEach(cleanup);

describe("Git external change refresh", () => {
  it("does not restart Git discovery when unrelated Agent context state changes", async () => {
    const fixture = createFixture();
    const rendered = render(
      <AgentSessionProvider runtime={fixture.runtimeBridge}>
        <FileChangeProvider>
          <ActiveProjectProvider
            discovery={{
              project: { workspaceId: "workspace-1", projectPath: "D:/repo", name: "repo" },
              repoRoots: [{ id: "repo-1", rootPath: "D:/repo", displayPath: ".", kind: "workspace" }],
            }}
          >
            <GitProvider runtime={fixture.gitRuntime}><div /></GitProvider>
          </ActiveProjectProvider>
        </FileChangeProvider>
      </AgentSessionProvider>,
    );

    await waitFor(() => expect(fixture.channel.bindGitRepositoryWatch).toHaveBeenCalledTimes(1));
    expect(fixture.gitRuntime.discover).toHaveBeenCalledTimes(1);

    act(() => fixture.emit({
      action: "pong",
      data: { id: "unrelated-agent-context-update" },
    }));
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 120));
    });

    expect(fixture.gitRuntime.discover).toHaveBeenCalledTimes(1);
    expect(fixture.gitRuntime.status).toHaveBeenCalledTimes(1);
    expect(fixture.gitRuntime.refs).toHaveBeenCalledTimes(1);
    expect(fixture.gitRuntime.history).toHaveBeenCalledTimes(1);
    expect(fixture.channel.bindGitRepositoryWatch).toHaveBeenCalledTimes(1);
    expect(fixture.channel.unbindGitRepositoryWatch).not.toHaveBeenCalled();

    rendered.unmount();
  });

  it("binds exact metadata watches and routes metadata and worktree changes to precise domains", async () => {
    const fixture = createFixture();
    const rendered = render(
      <AgentSessionProvider runtime={fixture.runtimeBridge}>
        <FileChangeProvider>
          <ActiveProjectProvider
            discovery={{
              project: { workspaceId: "workspace-1", projectPath: "D:/repo", name: "repo" },
              repoRoots: [{ id: "repo-1", rootPath: "D:/repo", displayPath: ".", kind: "workspace" }],
            }}
          >
            <GitProvider runtime={fixture.gitRuntime}><div /></GitProvider>
          </ActiveProjectProvider>
        </FileChangeProvider>
      </AgentSessionProvider>,
    );

    await waitFor(() => expect(fixture.channel.bindGitRepositoryWatch).toHaveBeenCalledWith(
      "workspace-1",
      "D:/repo",
      "repo-1",
    ));
    expect(fixture.channel.bindWorkspaceWatch).toHaveBeenCalledWith("workspace-1");
    expect(fixture.gitRuntime.status).toHaveBeenCalledTimes(1);
    expect(fixture.gitRuntime.refs).toHaveBeenCalledTimes(1);
    expect(fixture.gitRuntime.history).toHaveBeenCalledTimes(1);
    expect(fixture.gitRuntime.diff).not.toHaveBeenCalled();

    act(() => fixture.emit({
      action: "gitMetadataChanged",
      data: {
        repository_id: "repo-1",
        repository_version: "v2",
        sequence: 1,
        domains: ["refs", "history"],
        paths: ["HEAD"],
        resync_required: false,
      },
    }));
    await waitFor(() => {
      expect(fixture.gitRuntime.refs).toHaveBeenCalledTimes(2);
      expect(fixture.gitRuntime.history).toHaveBeenCalledTimes(2);
    });
    expect(fixture.gitRuntime.status).toHaveBeenCalledTimes(1);

    act(() => fixture.emit({
      action: "workspaceFilesChanged",
      data: {
        workspace_id: "workspace-1",
        sequence: 1,
        resync_required: false,
        changes: [{ kind: "modified", path: "src/main.ts" }],
      },
    }));
    await waitFor(() => {
      expect(fixture.gitRuntime.status).toHaveBeenCalledTimes(2);
      expect(fixture.gitRuntime.diff).toHaveBeenCalledTimes(1);
    });

    rendered.unmount();
    expect(fixture.channel.close).toHaveBeenCalledTimes(1);
  });
});

function createFixture() {
  const repositoryId = "repo-1" as GitRepositoryId;
  const repositoryVersion = "v1" as GitRepositoryVersion;
  let eventListener: ((event: AgentActionEnvelope) => void) | null = null;
  let metadataListener: ((event: GitMetadataChangedEvent) => void) | null = null;
  const channel = {
    close: vi.fn(),
    getStatus: vi.fn(() => "open"),
    getSessionId: vi.fn(() => null),
    requestStatus: vi.fn(),
    bindWorkspaceWatch: vi.fn(),
    unbindWorkspaceWatch: vi.fn(),
    bindGitRepositoryWatch: vi.fn(),
    unbindGitRepositoryWatch: vi.fn(),
  } as unknown as ChatChannel & Record<string, ReturnType<typeof vi.fn>>;
  const runtimeBridge = {
    conversation: {
      openChatChannel(listener: (event: AgentActionEnvelope) => void) {
        eventListener = listener;
        return channel;
      },
    },
  } as unknown as RuntimeBridge;
  const gitRuntime = {
    discover: vi.fn().mockResolvedValue({
      capability: {
        available: true,
        executable: "git",
        version: "2.50.0",
        supportsSwitch: true,
        supportsRestore: true,
        supportsPathspecFromFile: true,
        lfsAvailable: false,
      },
      repositories: [{
        id: repositoryId,
        workspaceId: "workspace-1",
        rootPath: "D:/repo",
        displayPath: ".",
        gitDirPath: "D:/repo/.git",
        kind: "workspace",
        parentRepoId: null,
        bare: false,
        ancestorAuthorization: "not_required",
      }],
      ancestorCandidate: null,
    }),
    status: vi.fn().mockResolvedValue({
      repositoryId,
      repositoryVersion,
      branch: { head: "main", detachedAt: null, upstream: null, ahead: 0, behind: 0, unborn: false },
      files: [],
      operation: null,
    }),
    refs: vi.fn().mockResolvedValue({ repositoryId, repositoryVersion, refs: [] }),
    history: vi.fn().mockResolvedValue({ repositoryId, repositoryVersion, commits: [], nextCursor: null }),
    diff: vi.fn().mockResolvedValue({ repositoryId, repositoryVersion, files: [] }),
    subscribe: vi.fn((listener: (event: GitMetadataChangedEvent) => void) => {
      metadataListener = listener;
      return () => { metadataListener = null; };
    }),
    acceptEvent: vi.fn((action: string, data: unknown) => {
      if (action !== "gitMetadataChanged") return false;
      const raw = data as Record<string, unknown>;
      metadataListener?.({
        repositoryId: String(raw.repository_id) as GitRepositoryId,
        repositoryVersion: String(raw.repository_version) as GitRepositoryVersion,
        sequence: Number(raw.sequence),
        domains: raw.domains as string[],
        paths: raw.paths as string[],
        resyncRequired: raw.resync_required === true,
      });
      return true;
    }),
  } as unknown as GitRuntime;
  return {
    channel,
    runtimeBridge,
    gitRuntime,
    emit(event: AgentActionEnvelope) {
      if (!eventListener) throw new Error("WebSocket listener is not ready");
      eventListener(event);
    },
  };
}
