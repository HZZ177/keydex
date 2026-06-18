import { useState } from "react";

import { runtimeBridge, type RuntimeBridge } from "@/runtime";
import { SendBox } from "@/renderer/components/chat/SendBox";
import { RuntimeModelSelector, useRuntimeModelSelection } from "@/renderer/components/model";
import styles from "./HomePage.module.css";

export interface HomePageProps {
  runtime?: RuntimeBridge;
  onNavigateToConversation: (sessionId: string, initialModel: string, initialMessage: string) => void;
  onOpenModelSettings: () => void;
}

export function HomePage({
  runtime = runtimeBridge,
  onNavigateToConversation,
  onOpenModelSettings,
}: HomePageProps) {
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modelSelection = useRuntimeModelSelection(runtime);

  const canSubmit = draft.trim().length > 0 && !submitting && modelSelection.modelLoadState !== "loading";

  const submit = async () => {
    const text = draft.trim();
    if (!text || submitting) {
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const model = modelSelection.selectedModel.trim();
      if (!model) {
        setError("请先在设置中选择模型");
        onOpenModelSettings();
        return;
      }

      const session = await runtime.conversation.createSession({
        title: text.slice(0, 32),
        session_tag: "chat",
      });
      setDraft("");
      onNavigateToConversation(session.id, model, text);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className={styles.home} data-testid="home-page">
      <section className={styles.canvas} aria-label="新对话">
        <h1 className={styles.title}>我们应该在 codex-copy 中构建什么？</h1>
        <SendBox
          value={draft}
          runtimeState={submitting ? "starting" : "idle"}
          canSend={canSubmit}
          canStop={false}
          ariaLabel="新对话输入"
          inputLabel="输入需求"
          placeholder="随心输入"
          statusText={submitting ? "正在创建对话" : ""}
          disabled={submitting}
          variant="codex"
          allowFileSelection={false}
          controls={
            <RuntimeModelSelector
              model={modelSelection.selectedModel}
              modelOptions={modelSelection.modelOptions}
              modelLoadState={modelSelection.modelLoadState}
              modelError={modelSelection.modelError}
              disabled={submitting}
              onModelChange={modelSelection.setSelectedModel}
              onOpenModelSettings={onOpenModelSettings}
            />
          }
          onChange={setDraft}
          onSend={() => void submit()}
          onStop={() => undefined}
        />

        {error ? (
          <div className={styles.error} role="alert">
            {error}
          </div>
        ) : null}
      </section>
    </main>
  );
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (reason && typeof reason === "object" && typeof (reason as { message?: unknown }).message === "string") {
    return (reason as { message: string }).message;
  }
  return "发送失败";
}
