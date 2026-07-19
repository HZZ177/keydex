import { describe, expect, it } from "vitest";

import { filePreviewBottomScrollSpace } from "@/renderer/components/workspace/FilePreviewBottomScrollSpace";

describe("filePreviewBottomScrollSpace", () => {
  it("reserves thirty percent of the viewport after overflowing content", () => {
    expect(filePreviewBottomScrollSpace(1_001, 400)).toBe(120);
    expect(filePreviewBottomScrollSpace(4_000, 333)).toBe(100);
  });

  it("does not make a short document scroll only for the extra space", () => {
    expect(filePreviewBottomScrollSpace(400, 400)).toBe(0);
    expect(filePreviewBottomScrollSpace(401, 400)).toBe(0);
    expect(filePreviewBottomScrollSpace(0, 400)).toBe(0);
  });

  it("rejects unusable geometry", () => {
    expect(filePreviewBottomScrollSpace(Number.NaN, 400)).toBe(0);
    expect(filePreviewBottomScrollSpace(1_000, 0)).toBe(0);
  });
});
