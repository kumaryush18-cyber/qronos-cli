// Agent Hub, part C: the panel.
//
// Variant A: a floating overlay in the middle of the screen, opened with Alt+A
// or `/agents`. It reads the registry and draws it; it never owns state that
// matters. Two rules follow from that:
//
//   1. Approvals stay in the main chat. A row only says "needs approval" and
//      Enter takes you to the transcript, because a roster nobody opens must
//      never be the only way to unblock an agent.
//   2. Closing the panel loses nothing. Every decision it can make (kill, steer,
//      revive) is a registry call, so the same actions work from anywhere later.

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  InlineExtension,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentRecord, AgentRegistry } from "./agent-registry";
import {
  buildHubLines,
  moveSelection,
  type HubLine,
  type HubLineStyle,
} from "./agent-hub-view";
import { buildChatLines, maxScroll, moveScroll, type ChatLine, type ChatLineStyle } from "./agent-chat-view";

export interface CreateAgentHubOptions {
  registry: AgentRegistry;
  /** Panel width, in columns. Clamped to the terminal by the overlay. */
  width?: number;
}

const PANEL_WIDTH = 68;
/** Height the overlay asks for: enough for a roster or a readable chat. */
const PANEL_HEIGHT = 24;

export function createAgentHubExtension(opts: CreateAgentHubOptions): InlineExtension {
  return {
    name: "qronos-agent-hub",
    factory(qronos: ExtensionAPI) {
      const open = async (ctx: ExtensionCommandContext | any) => {
        const records = opts.registry.list();
        if (records.length === 0) {
          ctx.ui?.notify?.("No subagents in this session yet.", "info");
          return;
        }
        await (ctx.ui.custom as any)(
          (tui: any, theme: Theme, _kb: any, done: () => void) =>
            new AgentHubPanel({
              registry: opts.registry,
              theme,
              done,
              requestRender: () => tui.requestRender?.(),
              width: opts.width ?? PANEL_WIDTH,
              height: PANEL_HEIGHT,
            }),
          { overlay: true, overlayOptions: { anchor: "center", width: opts.width ?? PANEL_WIDTH, maxHeight: PANEL_HEIGHT } },
        );
      };

      qronos.registerCommand("agents", {
        description: "Show the subagents running in this session",
        handler: async (_args: string, ctx: ExtensionCommandContext) => {
          await open(ctx);
        },
      });

      qronos.registerShortcut("alt+a", {
        description: "Agent Hub",
        handler: async (ctx: any) => {
          await open(ctx);
        },
      });
    },
  };
}

export interface AgentHubPanelOptions {
  registry: AgentRegistry;
  theme: Theme;
  done: () => void;
  requestRender?: () => void;
  width?: number;
  /** How many lines the overlay gives the panel, chat included. */
  height?: number;
  now?: () => number;
}

/**
 * The panel component. Exported so tests can drive it without a terminal:
 * `render()` returns plain lines and `handleInput()` takes key strings.
 */
export class AgentHubPanel {
  private readonly registry: AgentRegistry;
  private readonly theme: Theme;
  private readonly done: () => void;
  private readonly requestRender: () => void;
  private readonly width: number;
  /** Lines the overlay gives us; the chat window is sized from it. */
  height: number;
  private readonly unsubscribe: () => void;
  private readonly now: () => number;

  selected = 0;
  /** "list" = the roster, "chat" = one agent's own conversation. */
  mode: "list" | "chat" = "list";
  steering = "";
  steeringFor?: string;
  /** Lines scrolled up from the bottom of a chat. 0 follows new output. */
  scrollBack = 0;

  constructor(options: AgentHubPanelOptions) {
    this.registry = options.registry;
    this.theme = options.theme;
    this.done = options.done;
    this.requestRender = options.requestRender ?? (() => {});
    this.width = options.width ?? PANEL_WIDTH;
    this.height = options.height ?? PANEL_HEIGHT;
    this.now = options.now ?? Date.now;
    this.unsubscribe = this.registry.subscribe(() => this.requestRender());
  }

  dispose(): void {
    this.unsubscribe();
  }

  invalidate(): void {}

  render(width: number): string[] {
    const panelWidth = Math.max(24, Math.min(this.width, width));
    if (this.mode === "chat" && this.current()) {
      // The chat gets the whole screen height the overlay allows, so a long
      // answer can be read instead of squashed into a roster row.
      const height = Math.max(6, this.height - 6);
      const lines = buildChatLines({
        record: this.current()!,
        width: panelWidth,
        height,
        scrollBack: this.scrollBack,
        now: this.now(),
      });
      const body = lines.map((line) => this.chatStyle(line, panelWidth));
      return this.box(body, panelWidth);
    }
    const state = {
      records: this.registry.list(),
      selected: Math.min(this.selected, Math.max(0, this.registry.list().length - 1)),
      width: panelWidth,
      now: this.now(),
      transcriptFor: undefined,
      steering: this.steeringFor ? this.steering : undefined,
    };
    const lines = buildHubLines(state);
    const body = lines.map((line) => this.style(line, panelWidth));
    return this.box(body, panelWidth);
  }

  handleInput(data: string): void {
    const records = this.registry.list();

    if (this.steeringFor) {
      if (matchesKey(data, "escape")) {
        this.steering = "";
        this.steeringFor = undefined;
        this.requestRender();
        return;
      }
      if (matchesKey(data, "return")) {
        if (this.steering.trim() !== "") this.registry.steer(this.steeringFor, this.steering);
        this.steering = "";
        this.steeringFor = undefined;
        this.requestRender();
        return;
      }
      if (matchesKey(data, "backspace")) {
        this.steering = this.steering.slice(0, -1);
        this.requestRender();
        return;
      }
      // Printable characters only: control keys are handled above.
      if (data.length === 1 && data >= " ") {
        this.steering += data;
        this.requestRender();
      }
      return;
    }

    if (matchesKey(data, "escape")) {
      if (this.mode === "chat") {
        this.mode = "list";
        this.scrollBack = 0;
        this.requestRender();
      } else {
        this.done();
      }
      return;
    }

    if (this.mode === "chat") {
      const record = this.current();
      if (!record) {
        this.mode = "list";
        return;
      }
      const limit = maxScroll(record, Math.max(24, this.width), Math.max(6, this.height - 6));
      if (matchesKey(data, "up")) {
        this.scrollBack = moveScroll(this.scrollBack, limit, 1);
      } else if (matchesKey(data, "down")) {
        this.scrollBack = moveScroll(this.scrollBack, limit, -1);
      } else if (matchesKey(data, "pageUp")) {
        this.scrollBack = moveScroll(this.scrollBack, limit, 10);
      } else if (matchesKey(data, "pageDown")) {
        this.scrollBack = moveScroll(this.scrollBack, limit, -10);
      } else if (matchesKey(data, "home")) {
        this.scrollBack = limit;
      } else if (matchesKey(data, "end")) {
        this.scrollBack = 0;
      } else if (matchesKey(data, "k")) {
        this.registry.abort(record.id);
      } else if (matchesKey(data, "r")) {
        this.registry.revive(record.id);
      } else if (matchesKey(data, "s")) {
        if (record.status === "running" || record.status === "waiting-approval") {
          this.steeringFor = record.id;
          this.steering = "";
        }
      }
      this.requestRender();
      return;
    }

    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      if (matchesKey(data, "k") && !matchesKey(data, "up")) {
        const record = this.current();
        if (record) this.registry.abort(record.id);
        this.requestRender();
        return;
      }
      this.selected = moveSelection(this.selected, records.length, -1);
      this.requestRender();
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.selected = moveSelection(this.selected, records.length, 1);
      this.requestRender();
      return;
    }

    if (matchesKey(data, "return")) {
      if (this.current()) {
        this.mode = "chat";
        this.scrollBack = 0;
      }
      this.requestRender();
      return;
    }

    if (matchesKey(data, "s")) {
      const record = this.current();
      if (record && (record.status === "running" || record.status === "waiting-approval")) {
        this.steeringFor = record.id;
        this.steering = "";
      }
      this.requestRender();
      return;
    }

    if (matchesKey(data, "r")) {
      const record = this.current();
      if (record) this.registry.revive(record.id);
      this.requestRender();
    }
  }

  private current(): AgentRecord | undefined {
    return this.registry.list()[this.selected];
  }

  private colour(style: HubLineStyle, text: string): string {
    const theme = this.theme as any;
    try {
      switch (style) {
        case "title":
          return theme.fg("accent", text);
        case "row-selected":
          return theme.fg("accent", text);
        case "row-waiting":
          return theme.fg("warning", text);
        case "row-failed":
          return theme.fg("error", text);
        case "row-done":
          return theme.fg("dim", text);
        case "detail":
        case "hint":
          return theme.fg("dim", text);
        default:
          return text;
      }
    } catch {
      // A theme without this token must not break the panel.
      return text;
    }
  }

  private chatStyle(line: ChatLine, width: number): string {
    const theme = this.theme as any;
    let text = line.text;
    try {
      switch (line.style as ChatLineStyle) {
        case "header":
          text = theme.fg("accent", line.text);
          break;
        case "label":
          text = theme.fg("accent", line.text);
          break;
        case "rule":
        case "hint":
        case "dim":
          text = theme.fg("dim", line.text);
          break;
        case "tool-ok":
          text = theme.fg("success", line.text);
          break;
        case "tool-fail":
          text = theme.fg("error", line.text);
          break;
        case "error":
          text = theme.fg("error", line.text);
          break;
        case "steer":
          text = theme.fg("warning", line.text);
          break;
        case "notice":
          text = theme.fg("warning", line.text);
          break;
        default:
          break;
      }
    } catch {
      text = line.text;
    }
    return truncateToWidth(text, width, "…", false);
  }

  private style(line: HubLine, width: number): string {
    return truncateToWidth(this.colour(line.style, line.text), width, "…", false);
  }

  private box(lines: string[], width: number): string[] {
    const theme = this.theme as any;
    const inner = Math.max(1, width - 2);
    const border = (text: string) => {
      try {
        return theme.fg("border", text);
      } catch {
        return text;
      }
    };
    const out: string[] = [border(`╭${"─".repeat(inner)}╮`)];
    for (const line of lines) {
      // Pad by *visible* width: a themed line carries ANSI codes that count in
      // string length but occupy no columns.
      const padded = `${line}${" ".repeat(Math.max(0, inner - visibleLength(line)))}`;
      out.push(border("│") + truncateToWidth(padded, inner, "…", false) + border("│"));
    }
    out.push(border(`╰${"─".repeat(inner)}╯`));
    return out;
  }
}

/** Visible width, ignoring ANSI colour codes the theme may have added. */
function visibleLength(text: string): number {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "").length;
}
