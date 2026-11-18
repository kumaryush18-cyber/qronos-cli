// Responsive, minimalist Claude Code-inspired header with pixel-accurate Qronos block logo.
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { CLI_VERSION } from "./version";
import { APP_TITLE_TEXT } from "./app-title";

export interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface TuiLike {
  requestRender(): void;
}

/**
 * Exact 11-row Block Art for Qronos AI.
 * You can edit this array directly — add or remove '█' or spaces on any row.
 */
export const LOGO_BLOCKS: string[] = [
  "  █████████        ", // Row 0
  " ████████     ██   ", // Row 1
  " ██████    ██████  ", // Row 2
  " ███     ███████   ", // Row 3
  " ██    ██  ████   █", // Row 4
  " █   ███     █   ██", // Row 5
  "    █████       ███", // Row 6
  "   ███████      ███", // Row 7
  "  ██████   ██    ██", // Row 8 - 1 block extra on left of row 8 vs row 9
  "   █      █████    ", // Row 9
  "        █████████  ", // Row 10
];

// Engaging Brand Orange Palette: Vibrant Orange on top, Warm Amber on bottom
// High-contrast and readable on BOTH light (white) and dark (black) terminal backgrounds!
export const COLOR_TOP = "\x1b[38;2;255;107;0m";     // #ff6b00 Vibrant Qronos Orange
export const COLOR_BOTTOM = "\x1b[38;2;255;160;50m";   // #ffa032 Warm Amber Gold
export const COLOR_RESET = "\x1b[0m";

const COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
  { name: "/model", description: "switch active model" },
  { name: "/thinking", description: "adjust reasoning effort level" },
  { name: "/usage", description: "check token balance and usage" },
  { name: "/support", description: "visit today's developer sponsor" },
  { name: "/buy-credits", description: "top up balance on qronos.me" },
  { name: "/update", description: "update qronos-cli" },
];

const NAME_COLUMN = 22;
const EXPANDED_HINT_LINE = "esc interrupt · ctrl+c clear/exit · / commands · ! bash";
const UPDATE_BORDER_CHAR = "─";
const UPDATE_MAX_WIDTH = 80;

export function updateBannerLines(theme: ThemeLike, latest: string, width: number): string[] {
  const headline = "Update Available";
  const detail = `New version ${latest} is available. Run /update`;
  const inner = Math.max(0, Math.min(width - 2, UPDATE_MAX_WIDTH));
  if (inner <= 0) return [];
  const border = theme.fg("warning", UPDATE_BORDER_CHAR.repeat(inner));
  return [
    "",
    border,
    theme.bold(theme.fg("warning", truncateToWidth(headline, inner))),
    theme.fg("dim", truncateToWidth(detail, inner)),
    border,
  ];
}

export function headerLines(
  theme: ThemeLike,
  modelName: string,
  expanded: boolean,
  width: number = Number.POSITIVE_INFINITY,
  updateLatest?: string,
): string[] {
  const safeWidth = Math.max(20, width);
  const cleanModel = modelName.replace(/^.*\//, "");
  const cwd = process.cwd();

  const RESET = "\x1b[0m";
  // Content lines placed directly beside rows 1, 2, 3, 4 of the logo
  // Uses theme tokens so it dynamically adapts to look stunning on BOTH light and dark themes!
  const textLines = [
    "",
    theme.bold(theme.fg("text", `Qronos AI v${CLI_VERSION}`)),
    theme.fg("muted", "qronos-me · API Gateway"),
    theme.fg("dim", truncateToWidth(cwd, Math.max(10, safeWidth - 23))),
    `${COLOR_TOP}●${RESET} ${theme.fg("text", cleanModel)}`,
    "",
    "",
    "",
    "",
    "",
    "",
  ];

  const lines: string[] = [];

  for (let r = 0; r < LOGO_BLOCKS.length; r++) {
    const rawLine = LOGO_BLOCKS[r] || "";
    let coloredLogo = "";
    const isTop = r <= 4;
    const blockColor = isTop ? COLOR_TOP : COLOR_BOTTOM;

    for (const ch of rawLine) {
      if (ch === "█") {
        coloredLogo += `${blockColor}█${RESET}`;
      } else {
        coloredLogo += " ";
      }
    }

    const text = textLines[r] ?? "";
    lines.push(` ${coloredLogo} ${text}`);
  }

  // Expanded mode (ctrl+o): show command shortcuts
  if (expanded) {
    lines.push("");
    const commandLines = COMMANDS.map(({ name, description }) => {
      const padded = `  ▸ ${name}`.padEnd(NAME_COLUMN, " ");
      return `${theme.fg("accent", padded)}${theme.fg("dim", description)}`;
    });
    lines.push(...commandLines, "");
    lines.push(theme.fg("dim", EXPANDED_HINT_LINE));
  }

  if (updateLatest) lines.push(...updateBannerLines(theme, updateLatest, safeWidth));

  // Strictly enforce visible width on every line to prevent terminal overflow
  return lines.map((line) => {
    if (!line) return "";
    return truncateToWidth(line, safeWidth);
  });
}

export interface CreateHeaderExtensionOptions {
  modelName: string;
  updateLatest?: string;
}

/**
 * Text shown in the terminal tab / window title.
 *
 * A terminal title takes TEXT ONLY (an OSC 0/2 escape with a string). There is
 * no standard way to put a colour or an image in it: terminals draw the title
 * with their own font and their own colours, so "orange" cannot travel with the
 * string. Orange lives inside the app instead — the header above the editor,
 * which the TUI draws itself.
 *
 * The text itself ("◇ Qronos CLI") lives in app-title.ts, because the bin shim
 * uses the same string for the OS process name. QRONOS_TITLE replaces it.
 */
export const DEFAULT_TERMINAL_TITLE = APP_TITLE_TEXT;

/** The title to set: QRONOS_TITLE when given, else the plain app name. */
export function resolveTerminalTitle(env: Record<string, string | undefined> = process.env): string {
  const raw = (env.QRONOS_TITLE ?? "").trim();
  return raw === "" ? DEFAULT_TERMINAL_TITLE : raw;
}

/** Back-compat alias for the default title. */
export const TERMINAL_TITLE = DEFAULT_TERMINAL_TITLE;

/** How often the title is written again. Cheap: one escape sequence, no redraw. */
export const TITLE_HEARTBEAT_MS = 3_000;

export interface TitleHost {
  setTitle(title: string): void;
}

/**
 * Pins the window title and keeps it pinned.
 *
 * pi writes "<app> - <session> - <folder>" whenever a session binds, and many
 * shells rewrite the title from PROMPT_COMMAND / precmd on every prompt, so a
 * single write at startup gets lost. Re-writing the same string on a slow
 * heartbeat is the only way to win that race from inside the app.
 *
 * Returns a stop function. Never throws: a failed title write must not break a
 * session.
 */
export function installTerminalTitle(
  ui: TitleHost,
  options: { title?: string; heartbeatMs?: number } = {},
): () => void {
  const title = options.title ?? resolveTerminalTitle();
  const write = (): void => {
    try {
      ui.setTitle(title);
    } catch {
      // ignore: the terminal refused the escape, nothing else to do
    }
  };
  write();
  const heartbeatMs = options.heartbeatMs ?? TITLE_HEARTBEAT_MS;
  if (heartbeatMs <= 0) return () => {};
  const timer = setInterval(write, heartbeatMs);
  // Node keeps the process alive for timers; the TUI owns the event loop.
  if (typeof timer === "object" && timer && typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

export function createHeaderExtension(opts: CreateHeaderExtensionOptions): InlineExtension {
  return {
    name: "qronos-header",
    factory(qronos: ExtensionAPI) {
      let stopTitle: (() => void) | undefined;
      qronos.on("session_start", (_event, ctx) => {
        // The tab/window title is plain text the app sends to the terminal.
        // pi writes "<app> - <session> - <folder>" on every rebind and shells
        // reset it on each prompt, so pin it and keep it pinned.
        stopTitle?.();
        stopTitle = installTerminalTitle(ctx.ui);
        ctx.ui.setHeader((tui: TuiLike, theme: ThemeLike) => {
          let expanded = false;

          return {
            render(width: number): string[] {
              return headerLines(theme, opts.modelName, expanded, width, opts.updateLatest);
            },
            invalidate(): void {},
            setExpanded(next: boolean): void {
              expanded = next;
              tui.requestRender();
            },
          };
        });
      });
      // Stop the heartbeat when the session goes away so a reused process does
      // not keep writing the title of a dead session.
      qronos.on("session_shutdown", () => {
        stopTitle?.();
        stopTitle = undefined;
      });
    },
  };
}
