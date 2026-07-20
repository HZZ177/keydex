import { SquareTerminal } from "lucide-react";

import { selectRunningTerminalCount } from "./terminalSelectors";
import { useTerminal, useTerminalStore } from "./TerminalProvider";

export interface TerminalDockActionProps {
  badgeClassName: string;
  className: string;
  disabled?: boolean;
  iconSize?: number;
  iconStrokeWidth?: number;
}

export function TerminalDockAction({
  badgeClassName,
  className,
  disabled = false,
  iconSize = 17,
  iconStrokeWidth = 2.1,
}: TerminalDockActionProps) {
  const { available, scope, store } = useTerminal();
  const dockOpen = useTerminalStore((state) => state.ui.dockOpen);
  const runningTerminalCount = useTerminalStore((state) =>
    selectRunningTerminalCount(state, scope.sessionId),
  );
  const terminalUnavailable = !available || !scope.sessionId || scope.loading;

  return (
    <button
      id="terminal-content-action"
      className={className}
      type="button"
      aria-label={dockOpen ? "收起终端" : "打开终端"}
      aria-pressed={dockOpen}
      title={
        !available
          ? "内置终端仅在 Keydex 桌面客户端中可用"
          : scope.loading
            ? "会话正在加载，终端暂不可用"
            : !scope.sessionId
              ? "打开会话后可使用终端"
              : "终端（Ctrl+`）"
      }
      disabled={disabled || terminalUnavailable}
      data-active={dockOpen ? "true" : "false"}
      data-running-count={runningTerminalCount}
      data-testid="terminal-dock-action"
      onClick={() => store.getState().setDockOpen(!store.getState().ui.dockOpen)}
    >
      <SquareTerminal size={iconSize} strokeWidth={iconStrokeWidth} />
      {runningTerminalCount > 0 ? (
        <span className={badgeClassName} aria-hidden="true">
          {runningTerminalCount}
        </span>
      ) : null}
    </button>
  );
}
