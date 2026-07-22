import { useEffect, useRef, type RefObject } from "react";

import type { TerminalXtermHandle } from "./terminalXtermRegistry";

export const TERMINAL_NATIVE_RESIZE_SETTLE_MS = 80;

export function useTerminalFit(options: {
  hostRef: RefObject<HTMLElement | null>;
  handle: TerminalXtermHandle | null;
  active: boolean;
  visible: boolean;
  onResize: (size: { cols: number; rows: number; pixelWidth: number; pixelHeight: number }) => void;
}) {
  const lastSizeRef = useRef("");
  const onResizeRef = useRef(options.onResize);
  onResizeRef.current = options.onResize;

  useEffect(() => {
    const host = options.hostRef.current;
    const handle = options.handle;
    if (!host || !handle || !options.active || !options.visible) return;
    let frame: number | null = null;
    let resizeTimer: number | null = null;
    let pendingSize: { cols: number; rows: number; pixelWidth: number; pixelHeight: number } | null = null;
    const commitResize = () => {
      resizeTimer = null;
      const size = pendingSize;
      pendingSize = null;
      if (!size || !host.isConnected || !options.visible) return;
      const identity = `${size.cols}:${size.rows}:${size.pixelWidth}:${size.pixelHeight}`;
      if (identity !== lastSizeRef.current) {
        lastSizeRef.current = identity;
        onResizeRef.current(size);
      }
      handle.terminal.refresh(0, Math.max(0, handle.terminal.rows - 1));
      handle.terminal.focus();
    };
    const fit = () => {
      frame = null;
      if (!host.isConnected || host.clientWidth <= 0 || host.clientHeight <= 0) return;
      handle.fitAddon.fit();
      const cols = Math.max(2, handle.terminal.cols);
      const rows = Math.max(2, handle.terminal.rows);
      const pixelWidth = Math.min(65_535, Math.max(0, Math.round(host.clientWidth)));
      const pixelHeight = Math.min(65_535, Math.max(0, Math.round(host.clientHeight)));
      pendingSize = { cols, rows, pixelWidth, pixelHeight };
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(commitResize, TERMINAL_NATIVE_RESIZE_SETTLE_MS);
    };
    const schedule = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(host);
    schedule();
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
    };
  }, [options.active, options.handle, options.hostRef, options.visible]);
}
