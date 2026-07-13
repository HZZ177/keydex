import { useCallback, useEffect, useRef, useState } from "react";

import {
  ConversationFollowController,
  type ConversationContentMutation,
  type ConversationFollowSnapshot,
} from "./ConversationFollowController";

export interface UseConversationFollowControllerOptions {
  readonly autoFollow?: boolean;
}

export interface UseConversationFollowControllerResult {
  readonly snapshot: ConversationFollowSnapshot;
  readonly showScrollToBottom: boolean;
  readonly userPinnedScroll: boolean;
  readonly setScrollerRef: (element: HTMLElement | null) => void;
  readonly notifyContentMutation: (kind: ConversationContentMutation) => void;
  readonly beginNavigation: () => void;
  readonly endNavigation: () => void;
  readonly beginHistoryRestore: () => void;
  readonly endHistoryRestore: () => void;
  readonly suspend: (reason: string) => void;
  readonly resume: (reason?: string) => void;
  readonly scrollToBottom: (behavior?: ScrollBehavior) => void;
}

export function useConversationFollowController(
  itemCount: number,
  { autoFollow = true }: UseConversationFollowControllerOptions = {},
): UseConversationFollowControllerResult {
  const controllerRef = useRef<ConversationFollowController | null>(null);
  const [snapshot, setSnapshot] = useState<ConversationFollowSnapshot>(() => emptySnapshot(autoFollow));
  if (!controllerRef.current) {
    controllerRef.current = new ConversationFollowController({
      autoFollow,
      onChange: (next) => setSnapshot((current) => snapshotsEqual(current, next) ? current : next),
    });
  }
  const controller = controllerRef.current;

  useEffect(() => {
    controller.setAutoFollow(autoFollow);
  }, [autoFollow, controller]);

  useEffect(() => {
    controller.setContentAvailable(itemCount > 0);
  }, [controller, itemCount]);

  useEffect(() => () => controller.destroy(), [controller]);

  const setScrollerRef = useCallback((element: HTMLElement | null) => controller.attach(element), [controller]);
  const notifyContentMutation = useCallback(
    (kind: ConversationContentMutation) => controller.notifyContentMutation(kind),
    [controller],
  );
  const beginNavigation = useCallback(() => controller.beginNavigation(), [controller]);
  const endNavigation = useCallback(() => controller.endNavigation(), [controller]);
  const beginHistoryRestore = useCallback(() => controller.beginHistoryRestore(), [controller]);
  const endHistoryRestore = useCallback(() => controller.endHistoryRestore(), [controller]);
  const suspend = useCallback((reason: string) => controller.suspend(reason), [controller]);
  const resume = useCallback((reason?: string) => controller.resume(reason), [controller]);
  const scrollToBottom = useCallback((behavior?: ScrollBehavior) => controller.scrollToBottom(behavior), [controller]);

  return {
    snapshot,
    showScrollToBottom: snapshot.showScrollToBottom,
    userPinnedScroll: snapshot.mode === "user-detached",
    setScrollerRef,
    notifyContentMutation,
    beginNavigation,
    endNavigation,
    beginHistoryRestore,
    endHistoryRestore,
    suspend,
    resume,
    scrollToBottom,
  };
}

function emptySnapshot(autoFollow: boolean): ConversationFollowSnapshot {
  return Object.freeze({
    mode: autoFollow ? "following-bottom" : "user-detached",
    reason: "initial",
    revision: 0,
    bottomGap: 0,
    showScrollToBottom: false,
    autoFollow,
    mutationSequence: 0,
    scrollSequence: 0,
  });
}

function snapshotsEqual(left: ConversationFollowSnapshot, right: ConversationFollowSnapshot): boolean {
  return left.mode === right.mode
    && left.reason === right.reason
    && left.showScrollToBottom === right.showScrollToBottom
    && left.autoFollow === right.autoFollow;
}
