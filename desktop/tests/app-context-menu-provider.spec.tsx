import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { GitBranch } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APP_ADD_WORKSPACE_FILE_TO_CHAT_EVENT,
  APP_EXPAND_WORKSPACE_DIRECTORY_EVENT,
  APP_START_WORKSPACE_FILE_ANNOTATION_EVENT,
} from "@/renderer/events/workspaceFileContext";
import {
  AppContextMenuProvider,
  useOptionalAppContextMenu,
} from "@/renderer/providers/AppContextMenuProvider";
import { createPastedTextFragmentElement } from "@/renderer/components/chat/SendBox/collapsiblePaste";

function CustomContextMenuTarget({ onAction }: { onAction: () => void }) {
  const contextMenu = useOptionalAppContextMenu();
  return (
    <button
      type="button"
      data-app-context-menu="local"
      onContextMenu={(event) => {
        event.preventDefault();
        contextMenu?.openContextMenu({
          items: [{ action: onAction, icon: GitBranch, id: "custom-action", label: "自定义操作" }],
          target: event.currentTarget,
          x: event.clientX,
          y: event.clientY,
        });
      }}
    >
      自定义目标
    </button>
  );
}

describe("AppContextMenuProvider", () => {
  const writeText = vi.fn();
  const readText = vi.fn();

  beforeEach(() => {
    writeText.mockResolvedValue(undefined);
    readText.mockResolvedValue("");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText,
        writeText,
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prevents the browser context menu and shows the app menu", () => {
    render(
      <AppContextMenuProvider>
        <main aria-label="页面内容">workspace</main>
      </AppContextMenuProvider>,
    );

    const target = screen.getByLabelText("页面内容");
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 30,
      clientY: 36,
    });
    fireEvent(target, event);

    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByRole("menu", { name: "页面右键菜单" })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "刷新" })).not.toBeNull();
    expect(screen.queryByRole("menuitem", { name: "暂无可用操作" })).toBeNull();
  });

  it("renders registered business actions in the single app context menu", async () => {
    const onAction = vi.fn();
    render(
      <AppContextMenuProvider>
        <CustomContextMenuTarget onAction={onAction} />
      </AppContextMenuProvider>,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: "自定义目标" }), {
      clientX: 12,
      clientY: 18,
    });

    const menu = screen.getByRole("menu", { name: "页面右键菜单" });
    expect(menu.dataset.contextKind).toBe("custom");
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(screen.queryByRole("menuitem", { name: "刷新" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "自定义操作" }));
    await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("menu", { name: "页面右键菜单" })).toBeNull();
  });

  it("copies selected text from an input", async () => {
    render(
      <AppContextMenuProvider>
        <input aria-label="输入区" defaultValue="hello world" />
      </AppContextMenuProvider>,
    );

    const input = screen.getByLabelText("输入区") as HTMLInputElement;
    input.setSelectionRange(0, 5);
    fireEvent.contextMenu(input, { clientX: 12, clientY: 18 });
    fireEvent.click(screen.getByRole("menuitem", { name: "复制" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("hello"));
  });

  it("pastes clipboard text into an input and emits input", async () => {
    readText.mockResolvedValue(" pasted");
    const onInput = vi.fn();

    render(
      <AppContextMenuProvider>
        <input aria-label="输入区" defaultValue="hello" onInput={onInput} />
      </AppContextMenuProvider>,
    );

    const input = screen.getByLabelText("输入区") as HTMLInputElement;
    input.setSelectionRange(5, 5);
    fireEvent.contextMenu(input, { clientX: 12, clientY: 18 });
    fireEvent.click(screen.getByRole("menuitem", { name: "粘贴" }));

    await waitFor(() => expect(input.value).toBe("hello pasted"));
    expect(onInput).toHaveBeenCalledTimes(1);
  });

  it("recognizes contenteditable textbox areas", () => {
    render(
      <AppContextMenuProvider>
        <div
          aria-label="富文本输入"
          contentEditable
          data-sendbox-input="true"
          role="textbox"
          suppressContentEditableWarning
        >
          hello
        </div>
      </AppContextMenuProvider>,
    );

    fireEvent.contextMenu(screen.getByRole("textbox", { name: "富文本输入" }), {
      clientX: 12,
      clientY: 18,
    });

    expect(screen.getByRole("menu", { name: "页面右键菜单" }).dataset.contextKind).toBe("editable");
    expect(screen.getByRole("menuitem", { name: "粘贴" })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "全选" })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "刷新" })).not.toBeNull();
  });

  it("copies complete raw text from a folded paste inside the sendbox editor", async () => {
    render(
      <AppContextMenuProvider>
        <div
          aria-label="富文本输入"
          contentEditable
          data-sendbox-input="true"
          role="textbox"
          suppressContentEditableWarning
        />
      </AppContextMenuProvider>,
    );
    const editor = screen.getByRole("textbox", { name: "富文本输入" });
    const rawText = `0123456789${"x".repeat(180)}ABCDEFGHIJ`;
    const fragment = createPastedTextFragmentElement(rawText, { id: "paste-menu-copy", collapsed: true });
    editor.append(fragment);
    const range = document.createRange();
    range.selectNode(fragment);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);

    fireEvent.contextMenu(fragment.querySelector('[data-paste-summary="true"]')!, { clientX: 12, clientY: 18 });
    expect(screen.getByRole("menu", { name: "页面右键菜单" }).dataset.contextKind).toBe("editable");
    fireEvent.click(screen.getByRole("menuitem", { name: "复制" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(rawText));
  });

  it("copies selected page text", async () => {
    render(
      <AppContextMenuProvider>
        <p>
          <span data-testid="selected-text">selected text</span>
        </p>
      </AppContextMenuProvider>,
    );

    const text = screen.getByTestId("selected-text");
    const range = document.createRange();
    range.selectNodeContents(text);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);

    fireEvent.contextMenu(text, { clientX: 12, clientY: 18 });
    expect(screen.getByRole("menu", { name: "页面右键菜单" }).dataset.contextKind).toBe("selection");
    fireEvent.click(screen.getByRole("menuitem", { name: "复制" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("selected text"));
  });

  it("leaves explicitly native context menu areas alone", () => {
    render(
      <AppContextMenuProvider>
        <div aria-label="原生区域" data-native-context-menu="true">
          native
        </div>
      </AppContextMenuProvider>,
    );

    const target = screen.getByLabelText("原生区域");
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 30,
      clientY: 36,
    });
    fireEvent(target, event);

    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole("menu", { name: "页面右键菜单" })).toBeNull();
  });

  it("shows file actions for workspace files and copies both path forms", async () => {
    render(
      <AppContextMenuProvider>
        <button
          type="button"
          data-workspace-entry-absolute-path={String.raw`D:\repo\src\main.ts`}
          data-workspace-entry-kind="file"
          data-workspace-entry-name="main.ts"
          data-workspace-entry-path="src/main.ts"
          data-workspace-root={String.raw`D:\repo`}
        >
          main.ts
        </button>
      </AppContextMenuProvider>,
    );

    const file = screen.getByRole("button", { name: "main.ts" });
    fireEvent.contextMenu(file, { clientX: 12, clientY: 18 });

    const menu = screen.getByRole("menu", { name: "页面右键菜单" });
    expect(menu.dataset.contextKind).toBe("workspace-file");
    const labels = within(menu).getAllByRole("menuitem").map((item) => item.textContent);
    expect(labels).toEqual([
      "复制文件",
      "打开于",
      "资源管理器",
      "复制绝对路径",
      "复制工作区相对路径",
      "添加到聊天",
      "刷新",
    ]);

    fireEvent.click(screen.getByRole("menuitem", { name: "复制绝对路径" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(String.raw`D:\repo\src\main.ts`));

    fireEvent.contextMenu(file, { clientX: 12, clientY: 18 });
    fireEvent.click(screen.getByRole("menuitem", { name: "复制工作区相对路径" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("src/main.ts"));
  });

  it("dispatches workspace file add-to-chat requests from file actions", async () => {
    const listener = vi.fn();
    const handleEvent = (event: Event) => listener((event as CustomEvent).detail);
    document.addEventListener(APP_ADD_WORKSPACE_FILE_TO_CHAT_EVENT, handleEvent);

    try {
      render(
        <AppContextMenuProvider>
          <button
            type="button"
            data-workspace-entry-absolute-path={String.raw`D:\repo\README.md`}
            data-workspace-entry-kind="file"
            data-workspace-entry-name="README.md"
            data-workspace-entry-path="README.md"
            data-workspace-id="ws-1"
            data-workspace-root={String.raw`D:\repo`}
            data-workspace-session-id="ses-1"
          >
            README.md
          </button>
        </AppContextMenuProvider>,
      );

      fireEvent.contextMenu(screen.getByRole("button", { name: "README.md" }), { clientX: 12, clientY: 18 });
      fireEvent.click(screen.getByRole("menuitem", { name: "添加到聊天" }));

      await waitFor(() => expect(listener).toHaveBeenCalledWith({
        absolutePath: String.raw`D:\repo\README.md`,
        file: {
          path: "README.md",
          name: "README.md",
          type: "file",
          source: "workspace",
        },
        sessionId: "ses-1",
        workspaceId: "ws-1",
        workspaceRoot: String.raw`D:\repo`,
      }));
    } finally {
      document.removeEventListener(APP_ADD_WORKSPACE_FILE_TO_CHAT_EVENT, handleEvent);
    }
  });

  it("dispatches add-to-chat requests from workspace document context areas", async () => {
    const listener = vi.fn();
    const handleEvent = (event: Event) => listener((event as CustomEvent).detail);
    document.addEventListener(APP_ADD_WORKSPACE_FILE_TO_CHAT_EVENT, handleEvent);

    try {
      render(
        <AppContextMenuProvider>
          <article
            aria-label="文档区域"
            data-workspace-document-context="true"
            data-workspace-document-name="guide.md"
            data-workspace-document-path="docs/guide.md"
            data-workspace-id="ws-1"
            data-workspace-session-id="ses-1"
          >
            <p>文档内容</p>
          </article>
        </AppContextMenuProvider>,
      );

      fireEvent.contextMenu(screen.getByText("文档内容"), { clientX: 12, clientY: 18 });

      const menu = screen.getByRole("menu", { name: "页面右键菜单" });
      expect(menu.dataset.contextKind).toBe("workspace-document");
      expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
        "添加该文件到对话",
        "对该文档新增批注",
        "刷新",
      ]);

      fireEvent.click(screen.getByRole("menuitem", { name: "添加该文件到对话" }));

      await waitFor(() => expect(listener).toHaveBeenCalledWith({
        absolutePath: "docs/guide.md",
        file: {
          path: "docs/guide.md",
          name: "guide.md",
          type: "file",
          source: "workspace",
        },
        sessionId: "ses-1",
        workspaceId: "ws-1",
        workspaceRoot: null,
      }));
    } finally {
      document.removeEventListener(APP_ADD_WORKSPACE_FILE_TO_CHAT_EVENT, handleEvent);
    }
  });

  it("dispatches file annotation requests from workspace document context areas", async () => {
    const listener = vi.fn();
    const handleEvent = (event: Event) => listener((event as CustomEvent).detail);
    document.addEventListener(APP_START_WORKSPACE_FILE_ANNOTATION_EVENT, handleEvent);

    try {
      render(
        <AppContextMenuProvider>
          <article
            aria-label="文档区域"
            data-workspace-document-context="true"
            data-workspace-document-name="guide.md"
            data-workspace-document-path="docs/guide.md"
            data-workspace-id="ws-1"
            data-workspace-session-id="ses-1"
          >
            <p>文档内容</p>
          </article>
        </AppContextMenuProvider>,
      );

      fireEvent.contextMenu(screen.getByText("文档内容"), { clientX: 12, clientY: 18 });
      fireEvent.click(screen.getByRole("menuitem", { name: "对该文档新增批注" }));

      await waitFor(() => expect(listener).toHaveBeenCalledWith({
        path: "docs/guide.md",
        sessionId: "ses-1",
        workspaceId: "ws-1",
        workspaceRoot: null,
      }));
    } finally {
      document.removeEventListener(APP_START_WORKSPACE_FILE_ANNOTATION_EVENT, handleEvent);
    }
  });

  it("shows directory actions for workspace directories", async () => {
    const expandListener = vi.fn();
    const addToChatListener = vi.fn();
    const handleExpandEvent = (event: Event) => expandListener((event as CustomEvent).detail);
    const handleAddToChatEvent = (event: Event) => addToChatListener((event as CustomEvent).detail);
    document.addEventListener(APP_EXPAND_WORKSPACE_DIRECTORY_EVENT, handleExpandEvent);
    document.addEventListener(APP_ADD_WORKSPACE_FILE_TO_CHAT_EVENT, handleAddToChatEvent);

    try {
      render(
        <AppContextMenuProvider>
          <button
            type="button"
            data-workspace-entry-absolute-path={String.raw`D:\repo\src`}
            data-workspace-entry-kind="directory"
            data-workspace-entry-name="src"
            data-workspace-entry-path="src"
            data-workspace-id="ws-1"
            data-workspace-root={String.raw`D:\repo`}
            data-workspace-session-id="ses-1"
          >
            src
          </button>
        </AppContextMenuProvider>,
      );

      fireEvent.contextMenu(screen.getByRole("button", { name: "src" }), { clientX: 12, clientY: 18 });

      const menu = screen.getByRole("menu", { name: "页面右键菜单" });
      expect(menu.dataset.contextKind).toBe("workspace-directory");
      expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
        "展开所有下级菜单",
        "添加该目录到会话",
        "刷新",
      ]);
      expect(screen.queryByRole("menuitem", { name: "暂无可用操作" })).toBeNull();
      expect(screen.queryByRole("menuitem", { name: "复制绝对路径" })).toBeNull();

      fireEvent.click(screen.getByRole("menuitem", { name: "添加该目录到会话" }));

      await waitFor(() => expect(addToChatListener).toHaveBeenCalledWith({
        absolutePath: String.raw`D:\repo\src`,
        file: {
          path: "src",
          name: "src",
          type: "directory",
          source: "workspace",
        },
        sessionId: "ses-1",
        workspaceId: "ws-1",
        workspaceRoot: String.raw`D:\repo`,
      }));

      fireEvent.contextMenu(screen.getByRole("button", { name: "src" }), { clientX: 12, clientY: 18 });
      fireEvent.click(screen.getByRole("menuitem", { name: "展开所有下级菜单" }));

      await waitFor(() => expect(expandListener).toHaveBeenCalledWith({
        path: "src",
        sessionId: "ses-1",
        workspaceId: "ws-1",
        workspaceRoot: String.raw`D:\repo`,
      }));
    } finally {
      document.removeEventListener(APP_EXPAND_WORKSPACE_DIRECTORY_EVENT, handleExpandEvent);
      document.removeEventListener(APP_ADD_WORKSPACE_FILE_TO_CHAT_EVENT, handleAddToChatEvent);
    }
  });
});
