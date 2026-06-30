import { useCallback, useEffect, useRef, useState } from "react";

import type { RuntimeBridge } from "@/runtime";
import { isCloseWindowBehavior, windowLifecycleRuntime, type WindowLifecycleRuntime } from "@/runtime/windowLifecycle";
import { AppDialog, DialogButton } from "@/renderer/components/dialog";
import type { CloseWindowBehavior } from "@/types/protocol";

interface WindowClosePreferenceControllerProps {
  runtime: RuntimeBridge;
  windowLifecycle?: WindowLifecycleRuntime;
}

export function WindowClosePreferenceController({
  runtime,
  windowLifecycle = windowLifecycleRuntime,
}: WindowClosePreferenceControllerProps) {
  const [promptOpen, setPromptOpen] = useState(false);
  const [savingBehavior, setSavingBehavior] = useState<CloseWindowBehavior | null>(null);
  const [error, setError] = useState<string | null>(null);
  const handlingRef = useRef(false);

  const performCloseBehavior = useCallback(
    async (behavior: CloseWindowBehavior) => {
      if (behavior === "exit") {
        await windowLifecycle.exitApplication();
        return;
      }
      await windowLifecycle.hideWindowToTray();
      handlingRef.current = false;
    },
    [windowLifecycle],
  );

  const handleCloseRequest = useCallback(async () => {
    if (handlingRef.current) {
      return;
    }
    handlingRef.current = true;
    setError(null);

    try {
      const settings = await runtime.settings.getSettings();
      const behavior = settings.general?.close_window_behavior ?? null;
      if (isCloseWindowBehavior(behavior)) {
        await performCloseBehavior(behavior);
        return;
      }
      setPromptOpen(true);
    } catch (reason) {
      setError(errorMessage(reason));
      setPromptOpen(true);
    }
  }, [performCloseBehavior, runtime]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void windowLifecycle
      .listenForCloseRequest(() => {
        void handleCloseRequest();
      })
      .then((nextUnlisten) => {
        if (disposed) {
          nextUnlisten();
          return;
        }
        unlisten = nextUnlisten;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [handleCloseRequest, windowLifecycle]);

  const chooseBehavior = async (behavior: CloseWindowBehavior) => {
    setSavingBehavior(behavior);
    setError(null);
    try {
      await runtime.settings.saveGeneralSettings({ close_window_behavior: behavior });
      setPromptOpen(false);
      await performCloseBehavior(behavior);
    } catch (reason) {
      setError(errorMessage(reason));
      handlingRef.current = false;
    } finally {
      setSavingBehavior(null);
    }
  };

  if (!promptOpen) {
    return null;
  }

  return (
    <AppDialog
      title="选择关闭窗口后的默认行为"
      description="后续可以随时在设置 - 常规中变更。"
      size="confirm"
      backdrop="plain"
      showClose={false}
      closeOnEscape={false}
      closeOnOverlayClick={false}
      footer={
        <>
          <DialogButton
            disabled={savingBehavior !== null}
            type="button"
            onClick={() => void chooseBehavior("exit")}
          >
            退出程序
          </DialogButton>
          <DialogButton
            disabled={savingBehavior !== null}
            tone="primary"
            type="button"
            onClick={() => void chooseBehavior("minimize_to_tray")}
          >
            最小化到托盘
          </DialogButton>
        </>
      }
    >
      {error ? (
        <p role="alert" style={{ margin: 0, color: "var(--color-danger)", fontSize: 12 }}>
          {error}
        </p>
      ) : null}
    </AppDialog>
  );
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  return "关闭窗口策略读取失败";
}
