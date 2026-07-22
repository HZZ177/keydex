declare module "lowlight/lib/core" {
  export interface LowlightTextNode {
    readonly type: "text";
    readonly value: string;
  }

  export interface LowlightElementNode {
    readonly type: "element";
    readonly properties?: {
      readonly className?: readonly string[];
    };
    readonly children: readonly LowlightNode[];
  }

  export type LowlightNode = LowlightTextNode | LowlightElementNode;

  export interface LowlightResult {
    readonly relevance: number;
    readonly language: string | null;
    readonly value: readonly LowlightNode[];
  }

  export interface LowlightCore {
    highlight(language: string, value: string, options?: { readonly prefix?: string }): LowlightResult;
    registerLanguage(language: string, grammar: HighlightLanguageGrammar): void;
    listLanguages(): string[];
  }

  export type HighlightLanguageGrammar = (highlighter: unknown) => unknown;

  const lowlight: LowlightCore;
  export default lowlight;
}

declare module "highlight.js/lib/languages/*" {
  import type { HighlightLanguageGrammar } from "lowlight/lib/core";

  const grammar: HighlightLanguageGrammar;
  export default grammar;
}
