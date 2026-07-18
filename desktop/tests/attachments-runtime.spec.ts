import { afterEach, describe, expect, it, vi } from "vitest";

import { createAttachmentsRuntime } from "@/runtime/attachments";
import { RuntimeHttpError } from "@/runtime/errors";
import { createHttpClient } from "@/runtime/httpClient";

describe("attachments runtime error contract", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes upload detail envelopes without dropping provider diagnostics", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            detail: {
              schema_version: 1,
              code: "attachment_rejected",
              message: "附件被拒绝",
              details: { provider: { code: "unsafe_media", request_id: "req-attachment" } },
              retryable: false,
              status: 422,
            },
          }),
          { status: 422, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const runtime = createAttachmentsRuntime(createHttpClient({ baseUrl: "http://127.0.0.1:8765" }));

    const error = await runtime.uploadImage(new Blob(["image"], { type: "image/png" })).catch((value) => value);

    expect(error).toBeInstanceOf(RuntimeHttpError);
    expect(error).toMatchObject({
      schema_version: 1,
      code: "attachment_rejected",
      message: "附件被拒绝",
      details: { provider: { code: "unsafe_media", request_id: "req-attachment" } },
      retryable: false,
      status: 422,
      method: "POST",
    });
  });

  it("uses the shared stable fallback for empty upload failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
    const runtime = createAttachmentsRuntime(createHttpClient({ baseUrl: "http://127.0.0.1:8765" }));

    const error = await runtime.uploadLocalFile(new Blob(["file"])).catch((value) => value);

    expect(error).toMatchObject({
      schema_version: 1,
      code: "http_500",
      message: "请求失败：HTTP 500",
      details: {},
      retryable: false,
      status: 500,
    });
  });

  it("keeps successful raw uploads unchanged", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: "attachment-1",
            attachment_id: "attachment-1",
            user_id: "local-user",
            type: "image",
            source: "pasted",
            name: "image.png",
            path: "attachments/image.png",
            mime_type: "image/png",
            size: 5,
            created_at: "2026-07-18T00:00:00Z",
            updated_at: "2026-07-18T00:00:00Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const runtime = createAttachmentsRuntime(createHttpClient({ baseUrl: "http://127.0.0.1:8765" }));

    const attachment = await runtime.uploadImage(
      new Blob(["image"], { type: "image/png" }),
      { filename: "image.png" },
    );

    expect(attachment).toMatchObject({ attachment_id: "attachment-1", name: "image.png" });
  });
});
