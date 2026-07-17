import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { StaticMarkdown } from "@/renderer/components/markdown/StaticMarkdown";
import { ReleaseNotesDialog } from "@/renderer/pages/settings/about/ReleaseNotesDialog";
import {
  loadAppReleaseHistory,
  normalizeReleaseMarkdown,
  parseGitHubReleaseList,
  resetAppReleaseHistoryCacheForTests,
  type AppReleaseHistory,
} from "@/runtime/appReleaseNotes";

describe("app release notes", () => {
  beforeEach(() => {
    resetAppReleaseHistoryCacheForTests();
    window.localStorage.clear();
  });

  it("repairs the recognizable single-line Markdown produced by the old workflow", () => {
    const source = "## 本次更新 说明。 ### 功能 - 第一项 - 第二项 ### 修复 - 第三项 Built from commit abc1234.";

    expect(normalizeReleaseMarkdown(source)).toBe([
      "## 本次更新 说明。",
      "",
      "### 功能",
      "- 第一项",
      "- 第二项",
      "",
      "### 修复",
      "- 第三项",
      "",
      "Built from commit abc1234.",
    ].join("\n"));
  });

  it("keeps correctly formatted multi-line Markdown unchanged", () => {
    const source = "## 本次更新\n\n- 第一项\n- 第二项";
    expect(normalizeReleaseMarkdown(source)).toBe(source);
  });

  it("filters drafts and sorts public releases by publish time", () => {
    const releases = parseGitHubReleaseList([
      releasePayload("v0.3.10", "2026-07-15T08:00:00Z"),
      { ...releasePayload("v0.3.12-beta.1", "2026-07-18T08:00:00Z"), prerelease: true },
      { ...releasePayload("v0.3.11", "2026-07-17T08:00:00Z"), draft: true },
    ]);

    expect(releases.map((release) => release.version)).toEqual(["0.3.12-beta.1", "0.3.10"]);
    expect(releases[0].prerelease).toBe(true);
  });

  it("falls back to the persisted history when the network is unavailable", async () => {
    const storage = memoryStorage();
    const fetcher = vi.fn().mockResolvedValue(response([releasePayload("v0.3.11", "2026-07-17T08:00:00Z")]));
    await loadAppReleaseHistory({ fetcher, storage, now: () => 1_000 });
    resetAppReleaseHistoryCacheForTests();

    const history = await loadAppReleaseHistory({
      fetcher: vi.fn().mockRejectedValue(new Error("offline")),
      forceRefresh: true,
      storage,
      now: () => 2_000,
    });

    expect(history.source).toBe("cache");
    expect(history.stale).toBe(true);
    expect(history.releases[0].version).toBe("0.3.11");
  });
});

describe("release Markdown and history dialog", () => {
  it("renders headings, emphasis and lists through the shared Markdown runtime", () => {
    render(<StaticMarkdown source={"## 更新内容\n\n- 支持 **Markdown**\n- 修复问题"} />);

    expect(screen.getByRole("heading", { name: "更新内容" })).toBeTruthy();
    expect(screen.getByText("Markdown").tagName).toBe("STRONG");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("switches between older and newer release notes", async () => {
    const loadHistory = vi.fn().mockResolvedValue({
      releases: [
        {
          id: "11",
          version: "0.3.11",
          tagName: "v0.3.11",
          title: "Keydex 0.3.11",
          body: "## 新版内容\n\n- 新功能",
          publishedAt: "2026-07-17T08:00:00Z",
          htmlUrl: "https://github.com/HZZ177/keydex/releases/tag/v0.3.11",
          prerelease: false,
        },
        {
          id: "10",
          version: "0.3.10",
          tagName: "v0.3.10",
          title: "Keydex 0.3.10",
          body: "## 上一版\n\n- 旧功能",
          publishedAt: "2026-07-15T08:00:00Z",
          htmlUrl: "https://github.com/HZZ177/keydex/releases/tag/v0.3.10",
          prerelease: false,
        },
      ],
      source: "network",
      fetchedAt: 1_000,
      stale: false,
    } satisfies AppReleaseHistory);

    render(<ReleaseNotesDialog currentVersion="0.3.11" loadHistory={loadHistory} onClose={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Keydex 0.3.11" })).toBeTruthy();
    expect(loadHistory).toHaveBeenCalledWith(expect.objectContaining({ forceRefresh: true }));
    expect(screen.getByText("当前版本")).toBeTruthy();
    expect((screen.getByRole("button", { name: "查看较新版本" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "查看较早版本" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "查看较早版本" }));
    expect(await screen.findByRole("heading", { name: "Keydex 0.3.10" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "上一版" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "查看较新版本" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "查看较新版本" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Keydex 0.3.11" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(2));
  });
});

function releasePayload(tagName: string, publishedAt: string) {
  return {
    id: tagName,
    tag_name: tagName,
    name: `Keydex ${tagName.slice(1)}`,
    body: "## 更新\n\n- 内容",
    draft: false,
    prerelease: false,
    published_at: publishedAt,
    html_url: `https://github.com/HZZ177/keydex/releases/tag/${tagName}`,
  };
}

function response(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as Response;
}

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}
