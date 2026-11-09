// Responsive, minimalist Claude Code-inspired header.
// Adapts cleanly to narrow mobile screens without line-wrapping or visual clutter.
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface TuiLike {
  requestRender(): void;
}

const COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
  { name: "/model", description: "switch active model" },
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
  const isNarrow = safeWidth < 58;
  const boxWidth = Math.min(safeWidth - 4, 48);

  // Official Qronos mark (◈ Obsidian Core) instead of generic lightning bolt
  const title = " ◈ Qronos CLI ";
  const titleW = visibleWidth(title);
  const dashCount = Math.max(0, boxWidth - titleW - 3);
  const top = `╭─${title}${"─".repeat(dashCount)}╮`;
  const bottom = `╰${"─".repeat(Math.max(0, boxWidth - 2))}╯`;
  const cleanModel = modelName.replace(/^.*\//, "");

  const lines: string[] = [];

  if (!isNarrow) {
    const innerPad = Math.max(0, boxWidth - 11);
    const line1Content = truncateToWidth(cleanModel, innerPad).padEnd(innerPad);
    const line2Inner = Math.max(0, boxWidth - 4);
    const line2Content = truncateToWidth("Type prompt below or / for commands.", line2Inner).padEnd(line2Inner);

    lines.push(
      "",
      theme.fg("borderAccent", top),
      `${theme.fg("borderAccent", "│")} ${theme.bold(theme.fg("accent", "Model:"))} ${theme.fg("accent", line1Content)}${theme.fg("borderAccent", "│")}`,
      `${theme.fg("borderAccent", "│")} ${theme.fg("dim", line2Content)}${theme.fg("borderAccent", "│")}`,
      theme.fg("borderAccent", bottom),
      "",
    );
  } else {
    // Ultra-compact single line for mobile viewports
    lines.push(
      "",
      `${theme.bold(theme.fg("accent", "◈ Qronos CLI"))} ${theme.fg("dim", `· ${truncateToWidth(cleanModel, safeWidth - 18)}`)}`,
      theme.fg("dim", truncateToWidth("Type prompt below or / for commands.", safeWidth - 2)),
      "",
    );
  }

  // Expanded mode (ctrl+o): show command shortcuts
  if (expanded) {
    const commandLines = COMMANDS.map(({ name, description }) => {
      const padded = `  ▸ ${name}`.padEnd(NAME_COLUMN, " ");
      const full = `${padded}${description}`;
      return `${theme.fg("accent", padded)}${theme.fg("dim", description)}`;
    });
    lines.push(...commandLines, "");
    lines.push(theme.fg("dim", EXPANDED_HINT_LINE), "");
  }

  if (updateLatest) lines.push(...updateBannerLines(theme, updateLatest, safeWidth));

  // Strictly enforce visible width on every line with margin to prevent any terminal overflow
  return lines.map((line) => {
    if (!line) return "";
    return truncateToWidth(` ${line}`, safeWidth);
  });
}

export interface CreateHeaderExtensionOptions {
  modelName: string;
  updateLatest?: string;
}

export function createHeaderExtension(opts: CreateHeaderExtensionOptions): InlineExtension {
  return {
    name: "qronos-header",
    factory(pi: ExtensionAPI) {
      pi.on("session_start", (_event, ctx) => {
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
