import "@xterm/xterm/css/xterm.css";

import { CheckSquare, ClipboardPaste, Copy } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { openExternalUrl } from "@/runtime/externalLinks";
import type { TerminalRuntimeEvent, TerminalSnapshot } from "@/runtime";
import { useOptionalAppContextMenu } from "@/renderer/providers/AppContextMenuProvider";
import { useNotifications } from "@/renderer/providers/NotificationProvider";

import { TerminalSearchBar } from "./TerminalSearchBar";
import { useTerminal } from "./TerminalProvider";
import {
  terminalXtermRegistry,
  type TerminalXtermHandle,
  type TerminalXtermRegistry,
} from "./terminalXtermRegistry";
import { useTerminalFit } from "./useTerminalFit";
import styles from "./TerminalSurface.module.css";

export function TerminalSurface({
  snapshot,
  active,
  visible,
  registry = terminalXtermRegistry,
}: {
  snapshot: TerminalSnapshot;
  active: boolean;
  visible: boolean;
  registry?: TerminalXtermRegistry;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [handle, setHandle] = useState<TerminalXtermHandle | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const { attachTerminal, writeTerminal, resizeTerminal } = useTerminal();
  const appContextMenu = useOptionalAppContextMenu();
  const notifications = useNotifications();

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const nextHandle = registry.getOrCreate(snapshot.terminalId, (uri) => {
      void openExternalUrl(uri, { allowHttp: true }).catch((reason) => {
        notifications.error(reason instanceof Error ? reason.message : "无法打开终端链接");
      });
    });
    registry.open(nextHandle, host);
    setHandle(nextHandle);
    const dataDisposable = nextHandle.terminal.onData((data) => {
      void writeTerminal(snapshot.terminalId, data);
    });
    const binaryDisposable = nextHandle.terminal.onBinary((data) => {
      const bytes = Uint8Array.from(data, (character) => character.charCodeAt(0) & 0xff);
      void writeTerminal(snapshot.terminalId, bytes);
    });
    let disposed = false;
    let attachmentDispose: (() => void) | null = null;
    void attachTerminal(snapshot.terminalId, (event) => applyRuntimeEvent(nextHandle, event))
      .then((attachment) => {
        if (disposed) attachment.dispose();
        else attachmentDispose = attachment.dispose;
      })
      .catch((reason) => {
        if (!disposed) notifications.error(reason instanceof Error ? reason.message : "无法连接终端输出");
      });
    return () => {
      disposed = true;
      attachmentDispose?.();
      dataDisposable.dispose();
      binaryDisposable.dispose();
    };
  }, [attachTerminal, notifications, registry, snapshot.terminalId, writeTerminal]);

  const handleResize = useCallback(
    (size: { cols: number; rows: number; pixelWidth: number; pixelHeight: number }) => {
      void resizeTerminal(snapshot.terminalId, size);
    },
    [resizeTerminal, snapshot.terminalId],
  );
  useTerminalFit({ hostRef, handle, active, visible, onResize: handleResize });

  const copySelection = useCallback(async () => {
    if (!handle?.terminal.hasSelection()) return;
    if (!navigator.clipboard?.writeText) {
      notifications.error("剪贴板不可用");
      return;
    }
    try {
      await navigator.clipboard.writeText(handle.terminal.getSelection());
    } catch {
      notifications.error("复制终端选区失败");
    } finally {
      handle.terminal.focus();
    }
  }, [handle, notifications]);

  const pasteClipboard = useCallback(async () => {
    if (!handle || snapshot.status !== "running") return;
    if (!navigator.clipboard?.readText) {
      notifications.error("剪贴板不可用");
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      handle.terminal.paste(text);
      handle.terminal.focus();
    } catch {
      notifications.error("读取剪贴板失败");
    }
  }, [handle, notifications, snapshot.status]);

  const showTerminalContextMenu = useCallback(
    (target: HTMLElement, x: number, y: number) => {
      if (!handle || !appContextMenu) return;
      appContextMenu.openContextMenu({
        target,
        x,
        y,
        items: [
          {
            id: "terminal-copy-selection",
            label: "复制",
            icon: Copy,
            disabled: !handle.terminal.hasSelection(),
            action: copySelection,
          },
          {
            id: "terminal-paste",
            label: "粘贴",
            icon: ClipboardPaste,
            disabled: snapshot.status !== "running",
            action: pasteClipboard,
          },
          {
            id: "terminal-select-all",
            label: "全选",
            icon: CheckSquare,
            action: () => {
              handle.terminal.selectAll();
              handle.terminal.focus();
            },
          },
        ],
      });
    },
    [appContextMenu, copySelection, handle, pasteClipboard, snapshot.status],
  );

  const handleContextMenu = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      if (!handle || !appContextMenu) return;
      event.preventDefault();
      event.stopPropagation();
      showTerminalContextMenu(event.currentTarget, event.clientX, event.clientY);
    },
    [appContextMenu, handle, showTerminalContextMenu],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!handle) return;
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        const bounds = event.currentTarget.getBoundingClientRect();
        event.preventDefault();
        event.stopPropagation();
        showTerminalContextMenu(
          event.currentTarget,
          bounds.left + Math.min(20, bounds.width),
          bounds.top + Math.min(20, bounds.height),
        );
        return;
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        event.stopPropagation();
        setSearchOpen(true);
        return;
      }
      const primaryModifier = (event.ctrlKey || event.metaKey) && !event.altKey;
      if (primaryModifier && event.key.toLowerCase() === "c" && handle.terminal.hasSelection()) {
        event.preventDefault();
        event.stopPropagation();
        void copySelection();
        return;
      }
      if (primaryModifier && event.key.toLowerCase() === "v") {
        event.preventDefault();
        event.stopPropagation();
        void pasteClipboard();
      }
    },
    [copySelection, handle, pasteClipboard, showTerminalContextMenu],
  );

  return (
    <section
      className={styles.surface}
      data-active={active ? "true" : "false"}
      data-visible={visible ? "true" : "false"}
      data-terminal-id={snapshot.terminalId}
      data-app-context-menu="local"
      aria-label={`终端 ${snapshot.title}`}
      aria-hidden={!visible}
      onContextMenu={handleContextMenu}
      onKeyDownCapture={handleKeyDown}
    >
      {handle ? (
        <TerminalSearchBar addon={handle.searchAddon} open={searchOpen} onClose={() => setSearchOpen(false)} />
      ) : null}
      <div ref={hostRef} className={styles.host} />
    </section>
  );
}

function applyRuntimeEvent(handle: TerminalXtermHandle, event: TerminalRuntimeEvent): Promise<void> {
  if (event.event !== "output") return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    try {
      handle.terminal.write(event.data, resolve);
    } catch (reason) {
      reject(reason);
    }
  });
}
