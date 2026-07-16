import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SendBox } from "@/renderer/components/chat/SendBox";
import { ComposerDraftProvider, useComposerDraft } from "@/renderer/features/composer";
import type { RuntimeBridge } from "@/runtime";

describe("SendBox controlled image attachments", () => {
  it("keeps an uploaded image after the draft store requests its durable preview", async () => {
    let resolveMedia!: (media: { data_url: string }) => void;
    const runtime = {
      attachments: {
        uploadImage: vi.fn().mockResolvedValue({
          id: "attachment-1",
          attachment_id: "attachment-1",
          type: "image",
          name: "upload.png",
          path: "",
          mime_type: "image/png",
          size: 5,
          source: "upload",
        }),
        readMedia: vi.fn().mockImplementation(
          () => new Promise<{ data_url: string }>((resolve) => {
            resolveMedia = resolve;
          }),
        ),
      },
    } as unknown as RuntimeBridge;
    const restoreObjectUrls = stubObjectUrls();

    function DraftBoundSendBox() {
      const { draft, setDraft } = useComposerDraft("session:attachment-regression");
      return (
        <>
          <SendBox
            value={draft.text}
            selectedImageAttachments={draft.attachments}
            runtimeState="idle"
            canSend={false}
            canStop={false}
            runtime={runtime}
            onSelectedImageAttachmentsChange={(attachments) => setDraft({ attachments })}
            onChange={(text) => setDraft({ text })}
            onSend={vi.fn()}
            onStop={vi.fn()}
          />
          <output data-testid="draft-attachments">
            {draft.attachments.map((attachment) => `${attachment.attachment_id}:${attachment.previewUrl ?? ""}`).join(",")}
          </output>
        </>
      );
    }

    const { container, unmount } = render(
      <ComposerDraftProvider storage={null}>
        <DraftBoundSendBox />
      </ComposerDraftProvider>,
    );

    try {
      const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
      if (!fileInput) {
        throw new Error("file input not found");
      }

      fireEvent.change(fileInput, {
        target: {
          files: [new File(["image"], "upload.png", { type: "image/png" })],
        },
      });

      await waitFor(() => expect(runtime.attachments.uploadImage).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(runtime.attachments.readMedia).toHaveBeenCalledWith("attachment-1"));

      await act(async () => {
        resolveMedia({ data_url: "data:image/png;base64,AA==" });
        await Promise.resolve();
      });

      expect(screen.getByRole("button", { name: "预览图片 upload.png" })).not.toBeNull();
      expect(screen.getByTestId("draft-attachments").textContent).toBe(
        "attachment-1:data:image/png;base64,AA==",
      );
    } finally {
      unmount();
      restoreObjectUrls();
    }
  });
});

function stubObjectUrls(): () => void {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn().mockReturnValue("blob:keydex-attachment-preview"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
  return () => {
    if (originalCreate) {
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        writable: true,
        value: originalCreate,
      });
    } else {
      Reflect.deleteProperty(URL, "createObjectURL");
    }
    if (originalRevoke) {
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        writable: true,
        value: originalRevoke,
      });
    } else {
      Reflect.deleteProperty(URL, "revokeObjectURL");
    }
  };
}
