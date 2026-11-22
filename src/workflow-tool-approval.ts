// The card a workflow subagent's tool call stops at.
//
// Claude Code shows it inside the agent's own work, and a workflow that can
// write and run shell commands needs the same door:
//
//   ╭──────────────────────────────────────────────────────────────────────╮
//   │ Bash command                    from the "analyze-src" workflow  1/3 │  <- orange, glowing
//   │                                                                      │
//   │   $ cd src && ls                                                     │
//   │                                                                      │
//   │ ▸ 1. Yes                                                             │
//   │   2. Yes, allow shell commands for this run                          │
//   │   3. Yes, and switch to auto mode                                    │
//   │   4. No                                                              │
//   │                                                                      │
//   │ enter choose · 1 2 3 4 pick · esc cancel · nothing runs unless yes   │
//   ╰──────────────────────────────────────────────────────────────────────╯
//
// Three rules:
//
//   1. The card lives in the chat, not in the panel. A decision about a tool
//      belongs where the conversation is, and the panel must stay read-only.
//   2. Closing the card without choosing means "No". Silence never runs a tool.
//   3. The card only decides. The mode table lives in workflow-permissions.ts,
//      so the decision can be tested without a terminal.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { CardLineStyle, CardLine } from "./workflow-card-style";
import { cardRow, cardColour, cardBorder } from "./workflow-card-style";
import { shimmerPhase, shimmerText } from "./shimmer";
import { cardTitle, grantLabel, oneLine, type ToolFacts } from "./workflow-permissions";

const CARD_WIDTH = 74;
const CARD_HEIGHT = 18;

/** The four answers, in the order Claude Code puts them. */
export const TOOL_ANSWERS = ["Yes", "yes-for-run", "yes-and-auto", "No"] as const;
export type ToolAnswer = (typeof TOOL_ANSWERS)[number];

export interface ToolApprovalRequest {
  /** The workflow that asked, so the card can name it. */
  workflow: string;
  facts: ToolFacts;
  /** How many times this run has stopped to ask, and which one this is. */
  asked: number;
  total?: number;
}

export interface ToolApprovalState {
  request: ToolApprovalRequest;
  selected: number;
  width: number;
  now: number;
}

export interface ToolApprovalOutcome {
  answer: ToolAnswer;
  /** True when there was no terminal to ask in. */
  skipped?: boolean;
}

/** The code block a shell command or a path is drawn in. */
function bodyLines(request: ToolApprovalRequest, width: number): string[] {
  const { facts } = request;
  const raw = facts.kind === "shell" ? facts.command ?? "" : facts.path ?? "";
  if (raw === "") return [];
  const first = facts.kind === "shell" ? `$ ${oneLine(raw)}` : `  ${oneLine(raw)}`;
  // A command can be long; three lines are enough to recognise it, and the rest
  // would push the answers off the screen.
  const wrapped: string[] = [];
  let rest = first;
  while (rest.length > 0 && wrapped.length < 3) {
    // The third line is where a command stops being recognisable anyway, so the
    // rest becomes a mark instead of another row.
    if (wrapped.length === 2) {
      wrapped.push(`${rest.slice(0, Math.max(0, width - 1))}…`);
      break;
    }
    wrapped.push(rest.slice(0, width));
    rest = rest.slice(width);
  }
  return wrapped;
}

/** The whole card, as lines. */
export function buildToolApprovalLines(state: ToolApprovalState): CardLine[] {
  const width = Math.max(30, state.width - 4);
  const { request } = state;
  const total = request.total;
  const where = `from the "${request.workflow}" workflow`;
  // "1 of 3" only when the script said how many agents it plans; otherwise the
  // bare number, because a made-up denominator is worse than no denominator.
  const counter = total && total > 1 ? `${request.asked} of ${total}` : `${request.asked}`;

  const lines: CardLine[] = [];
  lines.push({ text: cardRow(`${cardTitle(request.facts)} · ${where}`, counter, "", width), style: "title" });
  lines.push({ text: "", style: "hint" });

  for (const line of bodyLines(request, width - 4)) {
    lines.push({ text: `  ${line}`, style: "code" });
  }
  if (request.facts.kind === "write" && !request.facts.insideProject) {
    lines.push({ text: "  ! this path is outside the project", style: "warn" });
  }
  if (request.facts.dangerous && request.facts.kind === "shell") {
    lines.push({ text: "  ! this command can destroy work", style: "warn" });
  }

  lines.push({ text: "", style: "hint" });
  const options = [TOOL_ANSWERS[0], "yes-for-run", TOOL_ANSWERS[2], TOOL_ANSWERS[3]] as const;
  const labels = [
    "Yes",
    grantLabel(request.facts),
    "Yes, and switch to auto mode",
    "No",
  ];
  for (const [index, label] of labels.entries()) {
    const selected = state.selected === index;
    lines.push({
      text: `  ${selected ? "▸" : " "} ${index + 1}. ${label}`,
      style: selected ? "option-selected" : "option",
    });
  }
  void options;

  lines.push({ text: "", style: "hint" });
  lines.push({ text: "  enter choose · 1 2 3 4 pick · esc cancel", style: "hint" });
  lines.push({ text: "  nothing runs unless you say yes", style: "hint" });
  return lines;
}

export interface ToolApprovalPromptOptions {
  request: ToolApprovalRequest;
  theme: Theme;
  done: (outcome: ToolApprovalOutcome) => void;
  requestRender?: () => void;
  width?: number;
  now?: () => number;
}

/** The overlay component. Keys match the rest of the CLI. */
export class WorkflowToolApprovalPrompt {
  private readonly options: ToolApprovalPromptOptions;
  private readonly theme: Theme;
  private readonly requestRender: () => void;
  private readonly width: number;
  private readonly now: () => number;

  selected = 0;
  finished = false;

  constructor(options: ToolApprovalPromptOptions) {
    this.options = options;
    this.theme = options.theme;
    this.requestRender = options.requestRender ?? (() => {});
    this.width = options.width ?? CARD_WIDTH;
    this.now = options.now ?? Date.now;
  }

  dispose(): void {}

  invalidate(): void {}

  render(width: number): string[] {
    const cardWidth = Math.max(30, Math.min(this.width, width));
    const lines = buildToolApprovalLines({ request: this.options.request, selected: this.selected, width: cardWidth, now: this.now() });
    const inner = Math.max(1, cardWidth - 2);
    const border = cardBorder(this.theme);
    const out = [border(`╭${"─".repeat(inner)}╮`)];
    for (const line of lines) {
      const painted = cardColour(line as CardLine & { style: CardLineStyle }, this.theme, cardWidth, shimmerPhase(this.now()));
      const padded = `${painted}${" ".repeat(Math.max(0, inner - visible(painted)))}`;
      out.push(`${border("│")}${truncateToWidth(padded, inner, "…", false)}${border("│")}`);
    }
    out.push(border(`╰${"─".repeat(inner)}╯`));
    return out;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      // Closing without choosing is "No": silence must never run a tool.
      this.finish("No");
      return;
    }
    if (matchesKey(data, "return")) {
      this.choose(this.selected);
      return;
    }
    if (matchesKey(data, "up")) {
      this.selected = Math.max(0, this.selected - 1);
      this.requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      this.selected = Math.min(TOOL_ANSWERS.length - 1, this.selected + 1);
      this.requestRender();
      return;
    }
    if (data === "1" || data === "2" || data === "3" || data === "4") {
      this.choose(Number(data) - 1);
    }
  }

  /** Pick an answer and close. Every answer closes the card. */
  choose(index: number): void {
    this.selected = Math.max(0, Math.min(TOOL_ANSWERS.length - 1, index));
    this.finish(TOOL_ANSWERS[this.selected]!);
  }

  private finish(answer: ToolAnswer): void {
    if (this.finished) return;
    this.finished = true;
    this.options.done({ answer });
  }
}

/** Visible width, ignoring colour codes. */
function visible(text: string): number {
  return text.replace(/\u001b\[[0-9;]*m/g, "").length;
}

export interface AskToolOptions {
  width?: number;
  now?: () => number;
  /** Injected for tests: the overlay host. */
  custom?: unknown;
  theme?: Theme;
}

/**
 * Ask, and come back with an answer.
 *
 * With no terminal there is no one to ask. The caller decides what that means;
 * this function says "skipped" and never pretends the user said yes.
 */
export async function askToolApproval(
  ctx: { ui?: { custom?: unknown }; theme?: unknown } | undefined,
  request: ToolApprovalRequest,
  options: AskToolOptions = {},
): Promise<ToolApprovalOutcome> {
  const custom = options.custom ?? (ctx as { ui?: { custom?: unknown } } | undefined)?.ui?.custom;
  if (typeof custom !== "function") return { answer: "No", skipped: true };

  let outcome: ToolApprovalOutcome | undefined;
  const theme = (options.theme ?? (ctx as { theme?: Theme }).theme) as Theme;
  await (custom as (...args: unknown[]) => Promise<unknown>).call(
    ctx,
    (tui: any, panelTheme: Theme, _kb: any, done: () => void) =>
      new WorkflowToolApprovalPrompt({
        request,
        theme: panelTheme ?? theme,
        done: (result) => {
          outcome = result;
          done();
        },
        requestRender: () => tui?.requestRender?.(),
        width: options.width,
        now: options.now,
      }),
    { overlay: true, overlayOptions: { anchor: "center", width: options.width ?? CARD_WIDTH, maxHeight: CARD_HEIGHT } },
  );

  return outcome ?? { answer: "No" };
}
