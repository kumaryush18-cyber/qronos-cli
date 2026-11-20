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

export interface CreateAgentHubOptions {
  registry: AgentRegistry;
  /** Panel width, in columns. Clamped to the terminal by the overlay. */
  width?: number;
}

const PANEL_WIDTH = 68;

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
            }),
          { overlay: true, overlayOptions: { anchor: "center", width: opts.width ?? PANEL_WIDTH, maxHeight: 24 } },
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
  private readonly unsubscribe: () => void;
  private readonly now: () => number;

  selected = 0;
  mode: "list" | "transcript" = "list";
  steering = "";
  steeringFor?: string;

  constructor(options: AgentHubPanelOptions) {
    this.registry = options.registry;
    this.theme = options.theme;
    this.done = options.done;
    this.requestRender = options.requestRender ?? (() => {});
    this.width = options.width ?? PANEL_WIDTH;
    this.now = options.now ?? Date.now;
    this.unsubscribe = this.registry.subscribe(() => this.requestRender());
  }

  dispose(): void {
    this.unsubscribe();
  }

  invalidate(): void {}

  render(width: number): string[] {
    const panelWidth = Math.max(24, Math.min(this.width, width));
    const state = {
      records: this.registry.list(),
      selected: Math.min(this.selected, Math.max(0, this.registry.list().length - 1)),
      width: panelWidth,
      now: this.now(),
      transcriptFor: this.mode === "transcript" ? this.current() : undefined,
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
      if (this.mode === "transcript") {
        this.mode = "list";
        this.requestRender();
      } else {
        this.done();
      }
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
      this.mode = this.mode === "list" ? "transcript" : "list";
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
