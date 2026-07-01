import { useCallback, useEffect, useRef, useState } from "react";

import type { RuntimeBridge } from "@/runtime";
import {
  closeWindowBehaviorStore,
  type CloseWindowBehaviorStore,
} from "@/runtime/closeWindowBehaviorStore";
import { isCloseWindowBehavior, windowLifecycleRuntime, type WindowLifecycleRuntime } from "@/runtime/windowLifecycle";
import { AppDialog, DialogButton } from "@/renderer/components/dialog";
import type { CloseWindowBehavior } from "@/types/protocol";

import { useOptionalRuntimeConnection } from "./RuntimeConnectionProvider";

interface WindowClosePreferenceControllerProps {
  runtime: RuntimeBridge;
  behaviorStore?: CloseWindowBehaviorStore;
  windowLifecycle?: WindowLifecycleRuntime;
}

const STARTUP_CLOSE_FALLBACK_BEHAVIOR: CloseWindowBehavior = "exit";

export function WindowClosePreferenceController({
  runtime,
  behaviorStore = closeWindowBehaviorStore,
  windowLifecycle = windowLifecycleRuntime,
}: WindowClosePreferenceControllerProps) {
  const runtimeConnection = useOptionalRuntimeConnection();
  const [promptOpen, setPromptOpen] = useState(false);
  const [savingBehavior, setSavingBehavior] = useState<CloseWindowBehavior | null>(null);
  const [error, setError] = useState<string | null>(null);
  const handlingRef = useRef(false);
  const pendingCloseRef = useRef(false);
  const handleCloseRequestRef = useRef<() => Promise<void>>(async () => undefined);
  const runtimeReady = runtimeConnection?.ready ?? true;
  const runtimeStatus = runtimeConnection?.status ?? "ready";

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

  const closeWithBehavior = useCallback(
    async (behavior: CloseWindowBehavior) => {
      try {
        await performCloseBehavior(behavior);
      } catch (reason) {
        setError(errorMessage(reason));
        handlingRef.current = false;
      }
    },
    [performCloseBehavior],
  );

  const resolveCloseRequest = useCallback(async () => {
    const cachedBehavior = behaviorStore.read();
    if (!runtimeReady) {
      if (cachedBehavior) {
        await closeWithBehavior(cachedBehavior);
        return;
      }
      if (shouldWaitForRuntime(runtimeStatus)) {
        pendingCloseRef.current = true;
        return;
      }
      await closeWithBehavior(STARTUP_CLOSE_FALLBACK_BEHAVIOR);
      return;
    }

    try {
      const settings = await runtime.settings.getSettings();
      const behavior = syncCloseBehaviorSnapshot(settings.general?.close_window_behavior ?? null, behaviorStore);
      if (behavior) {
        await closeWithBehavior(behavior);
        return;
      }
      setPromptOpen(true);
    } catch {
      await closeWithBehavior(cachedBehavior ?? STARTUP_CLOSE_FALLBACK_BEHAVIOR);
    }
  }, [behaviorStore, closeWithBehavior, runtime, runtimeReady, runtimeStatus]);

  const handleCloseRequest = useCallback(async () => {
    if (handlingRef.current) {
      return;
    }
    handlingRef.current = true;
    pendingCloseRef.current = false;
    setError(null);
    await resolveCloseRequest();
  }, [resolveCloseRequest]);

  useEffect(() => {
    handleCloseRequestRef.current = handleCloseRequest;
  }, [handleCloseRequest]);

  useEffect(() => {
    if (!pendingCloseRef.current) {
      return;
    }
    if (!runtimeReady && runtimeStatus !== "error") {
      return;
    }
    pendingCloseRef.current = false;
    void resolveCloseRequest();
  }, [resolveCloseRequest, runtimeReady, runtimeStatus]);

  useEffect(() => {
    if (!runtimeConnection?.ready || pendingCloseRef.current || handlingRef.current) {
      return;
    }
    let active = true;
    void runtime.settings
      .getSettings()
      .then((settings) => {
        if (!active) {
          return;
        }
        syncCloseBehaviorSnapshot(settings.general?.close_window_behavior ?? null, behaviorStore);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [behaviorStore, runtime, runtimeConnection?.ready]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void windowLifecycle
      .listenForCloseRequest(() => {
        void handleCloseRequestRef.current();
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
  }, [windowLifecycle]);

  const chooseBehavior = async (behavior: CloseWindowBehavior) => {
    setSavingBehavior(behavior);
    setError(null);
    try {
      await runtime.settings.saveGeneralSettings({ close_window_behavior: behavior });
      behaviorStore.write(behavior);
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

function shouldWaitForRuntime(status: string): boolean {
  return status === "idle" || status === "starting" || status === "retrying";
}

function syncCloseBehaviorSnapshot(
  behavior: CloseWindowBehavior | null,
  behaviorStore: CloseWindowBehaviorStore,
): CloseWindowBehavior | null {
  if (isCloseWindowBehavior(behavior)) {
    behaviorStore.write(behavior);
    return behavior;
  }
  behaviorStore.clear();
  return null;
}
