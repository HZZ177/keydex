import { ConversationMarkdownAdapter } from "@/renderer/markdownRuntime/adapters";
import { MarkdownRuntimeStore } from "@/renderer/markdownRuntime/MarkdownRuntimeStore";

let store: MarkdownRuntimeStore | null = null;
let adapter: ConversationMarkdownAdapter | null = null;

export function conversationMarkdownRuntimeStore(): MarkdownRuntimeStore {
  store ??= new MarkdownRuntimeStore({ maxEntries: 128, maxRetainedBytes: 128 * 1024 * 1024 });
  return store;
}

export function conversationMarkdownAdapter(): ConversationMarkdownAdapter {
  adapter ??= new ConversationMarkdownAdapter();
  return adapter;
}

export function resetConversationMarkdownRuntimeForTests(): void {
  store?.close();
  store = null;
  adapter = null;
}

export function configureConversationMarkdownRuntimeForTests(input: {
  readonly store: MarkdownRuntimeStore;
  readonly adapter?: ConversationMarkdownAdapter;
}): void {
  store?.close();
  store = input.store;
  adapter = input.adapter ?? new ConversationMarkdownAdapter();
}
