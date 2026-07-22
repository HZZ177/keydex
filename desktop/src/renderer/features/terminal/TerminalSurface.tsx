import "@xterm/xterm/css/xterm.css";

import { useCallback, useEffect, useRef, useState } from "react";

import { openExternalUrl } from "@/runtime/externalLinks";
import type { TerminalRuntimeEvent, TerminalSnapshot } from "@/runtime";
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

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!handle) return;
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "c" && handle.terminal.hasSelection()) {
        event.preventDefault();
        void navigator.clipboard.writeText(handle.terminal.getSelection()).catch(() => {
          notifications.error("复制终端选区失败");
        });
        return;
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "v") {
        event.preventDefault();
        void navigator.clipboard
          .readText()
          .then((text) => handle.terminal.paste(text))
          .catch(() => notifications.error("读取剪贴板失败"));
      }
    },
    [handle, notifications],
  );

  return (
    <section
      className={styles.surface}
      data-active={active ? "true" : "false"}
      data-visible={visible ? "true" : "false"}
      data-terminal-id={snapshot.terminalId}
      aria-label={`终端 ${snapshot.title}`}
      aria-hidden={!visible}
      onKeyDown={handleKeyDown}
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
