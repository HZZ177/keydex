import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import styles from "@/renderer/components/workspace/FilePreview.module.css";

describe("invasive annotation layout contract", () => {
  it.each([false, true])("keeps the document and annotation rail adjacent in one viewport when open=%s", (open) => {
    const { container } = render(
      <div className={styles.documentViewportShell}>
        <div className={styles.body} data-document-scroll-viewport="true">
          <div className={styles.documentCanvas} data-annotation-rail-open={open ? "true" : "false"}>
            <div className={styles.documentColumn} data-testid="document" />
            <aside className={styles.annotationRail} data-testid="rail" hidden={!open} />
          </div>
        </div>
        <div className={styles.previewScrollRail} data-testid="preview-scroll-rail" />
      </div>,
    );
    const shell = container.firstElementChild as HTMLElement;
    const viewport = shell.querySelector<HTMLElement>("[data-document-scroll-viewport='true']") as HTMLElement;
    const canvas = viewport.firstElementChild as HTMLElement;

    expect([...shell.children].map((child) => child.getAttribute("data-testid")))
      .toEqual([null, "preview-scroll-rail"]);
    expect(viewport.children).toHaveLength(1);
    expect([...canvas.children].map((child) => child.getAttribute("data-testid")))
      .toEqual(["document", "rail"]);
    expect(canvas.dataset.annotationRailOpen).toBe(open ? "true" : "false");
    expect(canvas.querySelector("[data-testid='rail']")?.hasAttribute("hidden")).toBe(!open);
  });
});
