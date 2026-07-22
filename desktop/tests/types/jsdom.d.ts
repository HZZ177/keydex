declare module "jsdom" {
  export interface JSDOMOptions {
    readonly url?: string;
    readonly pretendToBeVisual?: boolean;
    readonly runScripts?: "dangerously" | "outside-only";
  }

  export class JSDOM {
    constructor(html?: string, options?: JSDOMOptions);
    readonly window: Window & typeof globalThis & {
      close(): void;
      eval(source: string): unknown;
    };
  }
}
