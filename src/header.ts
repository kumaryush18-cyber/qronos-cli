// Responsive, minimalist Claude Code-inspired header with pixel-accurate Qronos block logo.
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { CLI_VERSION } from "./version";

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

export function createHeaderExtension(opts: CreateHeaderExtensionOptions): InlineExtension {
  return {
    name: "qronos-header",
    factory(qronos: ExtensionAPI) {
      qronos.on("session_start", (_event, ctx) => {
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
    },
  };
}
