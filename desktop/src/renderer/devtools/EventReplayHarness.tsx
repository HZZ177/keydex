import { useMemo } from "react";

import { MessageList } from "@/renderer/pages/conversation/messages";
import { createInitialConversationState, selectMessagesForThread, selectRuntimeState } from "@/renderer/stores/conversationStore";
import { reduceRuntimeEvent } from "@/renderer/pages/conversation/messages/reducer";

import { createEventReplayFixture, eventReplayThreadId } from "./eventReplayFixture";
import styles from "./EventReplayHarness.module.css";

export function EventReplayHarness() {
  const { messages, runtimeState } = useMemo(() => {
    const state = createEventReplayFixture().reduce(reduceRuntimeEvent, createInitialConversationState());
    return {
      messages: selectMessagesForThread(state, eventReplayThreadId),
      runtimeState: selectRuntimeState(state, eventReplayThreadId),
    };
  }, []);

  return (
    <main className={styles.page} data-testid="event-replay-harness">
      <header className={styles.header}>
        <h1>事件回放</h1>
        <p>开发验证入口：用固定事件序列检查消息流、工具、审批、错误和分组渲染。</p>
      </header>
      <MessageList messages={messages} runtimeState={runtimeState} emptyText="没有回放消息" />
    </main>
  );
}
