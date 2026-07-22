import { describe, expect, it, vi } from "vitest";

import { createHttpClient, createRightSidebarRuntime } from "@/runtime";

describe("right sidebar runtime", () => {
  it("uses scope paths, If-Match and the explicit promotion endpoint", async () => {
    const fetcher = vi.fn().mockImplementation((_url, init: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify(null), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })),
    );
    const runtime = createRightSidebarRuntime(createHttpClient({
      baseUrl: "http://keydex",
      fetcher,
    }));

    const empty = await runtime.get({ kind: "global", id: null });
    await runtime.put({ kind: "workspace", id: "workspace/1" }, { version: 2 }, 4);
    await runtime.promote({
      source_scope_kind: "workspace",
      source_scope_id: "workspace/1",
      source_revision: 5,
      target_session_id: "session-1",
    });

    expect(fetcher.mock.calls[0][0]).toBe("http://keydex/api/ui/right-sidebar/scopes/global");
    expect(empty).toBeNull();
    expect(fetcher.mock.calls[1][0]).toBe(
      "http://keydex/api/ui/right-sidebar/scopes/workspace/workspace%2F1",
    );
    expect(fetcher.mock.calls[1][1]).toEqual(expect.objectContaining({
      method: "PUT",
      headers: expect.objectContaining({ "If-Match": "4" }),
    }));
    expect(fetcher.mock.calls[2][0]).toBe("http://keydex/api/ui/right-sidebar/promotions");
  });
});
