// U1: replaces pi's built-in startup header (hidden via quietStartup, see
// pi-launch.ts) with a short free-pi header — name, model, welcome line, and
// the five commands a user needs. KTD1/KTD2: a plain object component
// (render/invalidate/setExpanded), no @earendil-works/pi-tui dependency —
// same structural-typing approach as packages/pi-ads/src/style.ts.
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

/** Structural subset of pi's `Theme` class actually used for styling. */
export interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** Structural subset of pi's `TUI` actually used by the header component. */
export interface TuiLike {
  requestRender(): void;
}

// R2: fixed command list, in order, with descriptions. Names padded so every
// description starts at the same column.
const COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
  { name: "/usage", description: "credits and usage statistics" },
  { name: "/model", description: "switch active model" },
  { name: "/support", description: "visit today's sponsor" },
  { name: "/buy-credits", description: "top up token balance on qronos.me" },
  { name: "/close-other-session", description: "free a stuck session on another machine" },
  { name: "/update", description: "get the latest qronos-cli" },
];

const NAME_COLUMN = 26; // 2 leading spaces + longest name (20) + 4 spaces gap

const WELCOME_LINE =
  "Autonomous terminal agent with tool execution (bash, read, write, edit) and MCP.";

// Split into two lines rather than one 106-char line, so it fits the 100-column
// truncation rule in headerLines without ever being cut off with an ellipsis.
const CONSENT_LINE_1 = "Universal Gateway: https://qronos.me · Active Safety & Identity Shielding.";
const CONSENT_LINE_2 = "Sponsors power free inference. Press ctrl+o for options or / for commands.";

const EXPANDED_HINT_LINE = "esc interrupt · ctrl+c clear / exit · / commands · ! bash";

/**
 * The update notice, in the same boxed shape pi uses for its own "Update
 * Available" banner — but for free-pi-cli's version, pointing at /update.
 * pi's own banner is suppressed (PI_SKIP_VERSION_CHECK, see pi-launch.ts)
 * because it names `pi update`, a command our users don't have.
 */
const UPDATE_BORDER_CHAR = "─";
const UPDATE_MAX_WIDTH = 100;

export function updateBannerLines(theme: ThemeLike, latest: string, width: number): string[] {
  const headline = "Update Available";
  const detail = `New version ${latest} is available. Run /update`;
  // One column is reserved for the left margin the caller adds.
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

/**
 * Pure line builder for R1-R3 (+ R6 when expanded). Testable with a fake theme.
 * `width` is applied to the plain text before styling, so escape bytes never
 * count toward it; a line that does not fit is shown dim and truncated.
 */
export function headerLines(
  theme: ThemeLike,
  modelName: string,
  expanded: boolean,
  width: number = Number.POSITIVE_INFINITY,
  /** Newer free-pi-cli version, when the server reported one. Renders the update banner. */
  updateLatest?: string,
): string[] {
  // One column is reserved for the left margin added below.
  const inner = width - 1;
  const fit = (plain: string, styled: () => string): string =>
    plain.length <= inner ? styled() : theme.fg("dim", truncate(plain, inner));

  const dim = (plain: string) => fit(plain, () => theme.fg("dim", plain));
  const accent = (plain: string) => fit(plain, () => theme.fg("accent", plain));

  const boxWidth = Math.min(inner, 64);
  const boxTop = `╭─ ⚡ QRONOS CLI ${"─".repeat(Math.max(0, boxWidth - 18))}╮`;
  const boxBottom = `╰${"─".repeat(Math.max(0, boxWidth - 2))}╯`;
  const boxLine1 = `│ Model: ${modelName.slice(0, boxWidth - 14).padEnd(boxWidth - 12)} │`;
  const boxLine2 = `│ Base: https://api.qronos.me/v1${" ".repeat(Math.max(0, boxWidth - 34))} │`;

  const bannerLines = inner >= 45 ? [
    theme.fg("borderAccent", boxTop),
    theme.bold(theme.fg("accent", boxLine1)),
    theme.fg("dim", boxLine2),
    theme.fg("borderAccent", boxBottom),
  ] : [
    `${theme.bold(theme.fg("accent", "⚡ QRONOS CLI"))} ${theme.fg("dim", `· ${modelName}`)}`,
  ];

  const commandLines = COMMANDS.map(({ name, description }) => {
    const padded = `  ▸ ${name}`.padEnd(NAME_COLUMN, " ");
    return fit(`${padded}${description}`, () => `${theme.fg("accent", padded)}${theme.fg("dim", description)}`);
  });

  const lines = [
    "",
    ...bannerLines,
    "",
    dim(WELCOME_LINE),
    dim(CONSENT_LINE_1),
    dim(CONSENT_LINE_2),
    "",
    ...commandLines,
    "",
  ];
  if (expanded) lines.push(dim(EXPANDED_HINT_LINE));
  if (updateLatest) lines.push(...updateBannerLines(theme, updateLatest, width));
  // pi indents its own header and widget lines by one column; match it.
  return lines.map((line) => (line === "" ? line : ` ${line}`));
}

export interface CreateHeaderExtensionOptions {
  modelName: string;
  /** Newer free-pi-cli version reported by /client-version, when one exists. */
  updateLatest?: string;
}

/** R1-R7: registers the `free-pi-header` inline extension. session_start only. */
export function createHeaderExtension(opts: CreateHeaderExtensionOptions): InlineExtension {
  return {
    name: "free-pi-header",
    factory(pi: ExtensionAPI) {
      pi.on("session_start", (_event, ctx) => {
        ctx.ui.setHeader((tui: TuiLike, theme: ThemeLike) => {
          let expanded = false;
          return {
            render(width: number): string[] {
              return headerLines(theme, opts.modelName, expanded, width, opts.updateLatest);
            },
            invalidate(): void {
              // no-op: headerLines has no cached state to drop.
            },
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
