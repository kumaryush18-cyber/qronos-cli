// Responsive, minimalist Claude Code-inspired header.
// Adapts cleanly to narrow mobile screens without line-wrapping or visual clutter.
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

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
  const inner = Math.max(0, Math.min(width - 1, UPDATE_MAX_WIDTH));
  if (inner <= 0) return [];
  const border = theme.fg("warning", UPDATE_BORDER_CHAR.repeat(inner));
  return [
    "",
    border,
    theme.bold(theme.fg("warning", truncate(headline, inner))),
    theme.fg("dim", truncate(detail, inner)),
    border,
  ];
}

function truncate(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (text.length <= maxWidth) return text;
  if (maxWidth <= 1) return text.slice(0, maxWidth);
  return `${text.slice(0, maxWidth - 1)}…`;
}

export function headerLines(
  theme: ThemeLike,
  modelName: string,
  expanded: boolean,
  width: number = Number.POSITIVE_INFINITY,
  updateLatest?: string,
): string[] {
  const inner = width - 1;
  const fit = (plain: string, styled: () => string): string =>
    plain.length <= inner ? styled() : theme.fg("dim", truncate(plain, inner));

  const dim = (plain: string) => fit(plain, () => theme.fg("dim", plain));

  // Clean, Claude Code-inspired header box
  const isNarrow = inner < 55;
  const boxWidth = Math.min(inner, 54);
  const title = " ⚡ Qronos CLI ";
  const top = `╭─${title}${"─".repeat(Math.max(0, boxWidth - title.length - 2))}╮`;
  const bottom = `╰${"─".repeat(Math.max(0, boxWidth - 2))}╯`;
  const cleanModel = modelName.replace(/^.*\//, ""); // Strip any provider prefix for clean display

  const lines: string[] = [];

  if (!isNarrow) {
    const line1 = `│ Model: ${cleanModel.padEnd(boxWidth - 11)}│`;
    const line2 = `│ Type prompt below or / for commands.${" ".repeat(Math.max(0, boxWidth - 40))}│`;
    lines.push(
      "",
      theme.fg("borderAccent", top),
      `${theme.fg("borderAccent", "│")} ${theme.bold(theme.fg("accent", "Model:"))} ${theme.fg("accent", cleanModel.padEnd(boxWidth - 11))}${theme.fg("borderAccent", "│")}`,
      theme.fg("dim", line2),
      theme.fg("borderAccent", bottom),
      "",
    );
  } else {
    // Ultra-compact single line for mobile viewports
    lines.push(
      "",
      `${theme.bold(theme.fg("accent", "⚡ Qronos CLI"))} ${theme.fg("dim", `· ${cleanModel}`)}`,
      theme.fg("dim", "Type prompt below or / for commands."),
      "",
    );
  }

  // Expanded mode (ctrl+o): show command shortcuts
  if (expanded) {
    const commandLines = COMMANDS.map(({ name, description }) => {
      const padded = `  ▸ ${name}`.padEnd(NAME_COLUMN, " ");
      return fit(`${padded}${description}`, () => `${theme.fg("accent", padded)}${theme.fg("dim", description)}`);
    });
    lines.push(...commandLines, "");
    lines.push(dim(EXPANDED_HINT_LINE), "");
  }

  if (updateLatest) lines.push(...updateBannerLines(theme, updateLatest, width));

  return lines.map((line) => (line === "" ? line : ` ${line}`));
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
