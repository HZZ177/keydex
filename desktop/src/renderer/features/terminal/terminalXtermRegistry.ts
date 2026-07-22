import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal, type ITheme, type ITerminalOptions } from "@xterm/xterm";

import { TERMINAL_FEATURE_MANIFEST } from "./terminalFeatureManifest";

export interface TerminalXtermHandle {
  terminalId: string;
  terminal: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  webLinksAddon: WebLinksAddon;
  opened: boolean;
  host: HTMLElement | null;
  dispose(): void;
}

export type TerminalLinkActivator = (uri: string, event: MouseEvent) => void;
export type TerminalHandleFactory = (
  terminalId: string,
  activateLink: TerminalLinkActivator,
) => TerminalXtermHandle;

export class TerminalXtermRegistry {
  private readonly handles = new Map<string, TerminalXtermHandle>();

  constructor(private readonly factory: TerminalHandleFactory = createTerminalXtermHandle) {}

  getOrCreate(terminalId: string, activateLink: TerminalLinkActivator): TerminalXtermHandle {
    const existing = this.handles.get(terminalId);
    if (existing) return existing;
    const handle = this.factory(terminalId, activateLink);
    this.handles.set(terminalId, handle);
    return handle;
  }

  open(handle: TerminalXtermHandle, host: HTMLElement): void {
    if (handle.opened) {
      if (handle.host === host) return;
      const element = handle.terminal.element;
      if (element) {
        host.appendChild(element);
        handle.host = host;
        handle.terminal.refresh(0, Math.max(0, handle.terminal.rows - 1));
      }
      return;
    }
    handle.terminal.open(host);
    handle.opened = true;
    handle.host = host;
  }

  get(terminalId: string): TerminalXtermHandle | null {
    return this.handles.get(terminalId) ?? null;
  }

  dispose(terminalId: string): void {
    const handle = this.handles.get(terminalId);
    if (!handle) return;
    this.handles.delete(terminalId);
    handle.dispose();
  }

  disposeMissing(validTerminalIds: Iterable<string>): void {
    const valid = new Set(validTerminalIds);
    for (const terminalId of this.handles.keys()) {
      if (!valid.has(terminalId)) this.dispose(terminalId);
    }
  }

  disposeAll(): void {
    for (const terminalId of [...this.handles.keys()]) this.dispose(terminalId);
  }

  updateTheme(theme: "light" | "dark"): void {
    for (const handle of this.handles.values()) {
      handle.terminal.options.theme = terminalTheme(theme);
    }
  }

  get size(): number {
    return this.handles.size;
  }
}

export const terminalXtermRegistry = new TerminalXtermRegistry();

function createTerminalXtermHandle(
  terminalId: string,
  activateLink: TerminalLinkActivator,
): TerminalXtermHandle {
  const options: ITerminalOptions = {
    allowProposedApi: false,
    convertEol: false,
    cursorBlink: true,
    cursorStyle: "bar",
    fontFamily: "Cascadia Mono, Consolas, monospace",
    fontSize: 13,
    lineHeight: 1.2,
    scrollback: TERMINAL_FEATURE_MANIFEST.limits.scrollbackLines,
    theme: terminalTheme(),
    linkHandler: {
      activate(event, text) {
        activateLink(text, event);
      },
    },
  };
  const terminal = new Terminal(options);
  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon();
  const webLinksAddon = new WebLinksAddon((event, uri) => activateLink(uri, event));
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(searchAddon);
  terminal.loadAddon(webLinksAddon);
  return {
    terminalId,
    terminal,
    fitAddon,
    searchAddon,
    webLinksAddon,
    opened: false,
    host: null,
    dispose() {
      terminal.dispose();
    },
  };
}

export function terminalTheme(theme?: "light" | "dark"): ITheme {
  const dark = theme
    ? theme === "dark"
    : typeof document !== "undefined" &&
      (document.documentElement.dataset.theme === "dark" ||
        document.documentElement.classList.contains("dark"));
  return dark
    ? {
        background: "#111318",
        foreground: "#e8eaed",
        cursor: "#f8fafc",
        selectionBackground: "#315a8a88",
        black: "#24272e",
        red: "#f28b82",
        green: "#81c995",
        yellow: "#fdd663",
        blue: "#8ab4f8",
        magenta: "#c58af9",
        cyan: "#78d9ec",
        white: "#e8eaed",
        brightBlack: "#9aa0a6",
        brightRed: "#f6aea9",
        brightGreen: "#a8dab5",
        brightYellow: "#fde293",
        brightBlue: "#aecbfa",
        brightMagenta: "#d7aefb",
        brightCyan: "#a1e4f2",
        brightWhite: "#ffffff",
      }
    : {
        background: "#ffffff",
        foreground: "#24292f",
        cursor: "#24292f",
        selectionBackground: "#9fc5ef88",
        black: "#24292f",
        red: "#cf222e",
        green: "#116329",
        yellow: "#7d4e00",
        blue: "#0550ae",
        magenta: "#8250df",
        cyan: "#0b6f75",
        white: "#57606a",
        brightBlack: "#6e7781",
        brightRed: "#a40e26",
        brightGreen: "#1a7f37",
        brightYellow: "#8a5a00",
        brightBlue: "#0969da",
        brightMagenta: "#8250df",
        brightCyan: "#0b6f75",
        brightWhite: "#24292f",
      };
}
