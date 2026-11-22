// "Run this agent again?" — the card that stops a restart before it costs money.
//
// A restart is a fresh model call, so it is the one panel action that spends
// tokens. Usually the task was unclear rather than the model being wrong, so the
// card offers a third answer: change the words, then run.
//
//   ╭────────────────────────────────────────────────────────────────╮
//   │ Run this agent again?                                          │
//   │   coding-agent                                                 │
//   │   claude-haiku-5.5 · 4300 tokens last time                     │
//   │   this calls the model again and spends tokens again           │
//   │   the rest of the run is not touched                           │
//   │   ▸ 1. Yes, run it again                                       │
//   │     2. Edit the task, then run it                              │
//   │     3. No                                                      │
//   ╰────────────────────────────────────────────────────────────────╯
//
// Three rules:
//
//   1. The cursor starts on No, and closing the card means No. Silence never
//      spends anything.
//   2. The edited task is shown before it runs: a change the user cannot see is
//      a change the user cannot trust.
//   3. Cancel does nothing at all — not "runs the old prompt", not "runs nothing
//      and says it failed".
import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { cardBorder, cardColour, cardRow, type CardLine } from "./workflow-card-style";
import { shimmerPhase } from "./shimmer";
import { editTextInEditor } from "./editor-edit";

const CARD_WIDTH = 66;
const CARD_HEIGHT = 20;
const PROMPT_PREVIEW = 3;

/** The three answers, in the order the card shows them. */
export const RESTART_ANSWERS = ["yes", "edit", "no"] as const;
export type RestartAnswer = (typeof RESTART_ANSWERS)[number];

export interface RestartConfirmRequest {
  /** The agent that would run again. */
  label: string;
  model?: string;
  tokens?: number;
  /** The task it had, so the card can show what would be repeated. */
  prompt?: string;
}

export interface RestartConfirmState {
  request: RestartConfirmRequest;
  selected: number;
  width: number;
  /** True while the task is being typed in the card. */
  editing?: boolean;
  /** The task as it stands: the original, or what the user typed. */
  draft?: string;
}

export interface RestartConfirmOutcome {
  approved: boolean;
  /** Set only when the task was changed: what to run instead. */
  prompt?: string;
}

/** Width of a line as the eye counts it, without colour codes. */
function visibleWidth(text: string): number {
  return text.replace(/\u001b\[[0-9;]*m/g, "").length;
}

/** The task, wrapped to the card, so a long one does not vanish. */
function promptLines(draft: string, width: number): string[] {
  const words = draft.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current === "" ? word : `${current} ${word}`;
    if (next.length > width) {
      if (current !== "") lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

/** The card, as lines. */
export function buildRestartLines(state: RestartConfirmState): CardLine[] {
  const width = Math.max(26, state.width - 4);
  const { request } = state;
  const draft = state.draft ?? request.prompt ?? "";
  const changed = draft.trim() !== (request.prompt ?? "").trim();

  const lines: CardLine[] = [];
  lines.push({ text: cardRow("Run this agent again?", "", "", width), style: "title" });
  lines.push({ text: "", style: "hint" });
  lines.push({ text: `  ${truncateToWidth(request.label, width - 2, "…", false)}`, style: "code" });
  const facts = [request.model, request.tokens ? `${request.tokens} tokens last time` : ""].filter(Boolean).join(" · ");
  if (facts !== "") lines.push({ text: `  ${truncateToWidth(facts, width - 2, "…", false)}`, style: "subtitle" });
  lines.push({ text: "", style: "hint" });

  // The task is on the card in both modes: before the edit, so the user can see
  // what they are agreeing to; after it, so the change is never invisible.
  const wrapped = promptLines(draft, width - 4);
  const shown = state.editing ? wrapped : wrapped.slice(0, PROMPT_PREVIEW);
  for (const line of shown) lines.push({ text: `  ${line}`, style: "code" });
  if (shown.length < wrapped.length) {
    lines.push({ text: `  … ${wrapped.length - shown.length} more line${wrapped.length - shown.length === 1 ? "" : "s"}`, style: "hint" });
  }
  if (changed) lines.push({ text: "  edited, not the task it had before", style: "warn" });
  lines.push({ text: "", style: "hint" });

  if (state.editing) {
    lines.push({ text: "  type to change it · ctrl+g editor · enter run it · esc back", style: "hint" });
    return lines;
  }

  // The cost is the whole point of asking, so it is said in plain words.
  lines.push({ text: "  this calls the model again and spends tokens again", style: "warn" });
  lines.push({ text: "  the rest of the run is not touched", style: "hint" });
  lines.push({ text: "", style: "hint" });
  const labels = ["Yes, run it again", "Edit the task, then run it", "No"];
  for (const [index, label] of labels.entries()) {
    lines.push({
      text: `  ${state.selected === index ? "▸" : " "} ${index + 1}. ${label}`,
      style: state.selected === index ? "option-selected" : "option",
    });
  }
  lines.push({ text: "", style: "hint" });
  lines.push({ text: "  enter choose · y yes · e edit · esc no", style: "hint" });
  return lines;
}

export interface RestartConfirmOptions {
  request: RestartConfirmRequest;
  theme: Theme;
  done: (outcome: RestartConfirmOutcome) => void;
  requestRender?: () => void;
  width?: number;
  /** Injected for tests; defaults to the real `$EDITOR` helper. */
  edit?: (text: string) => string | undefined;
}

export class RestartConfirmPrompt {
  private readonly options: RestartConfirmOptions;
  private readonly theme: Theme;
  private readonly requestRender: () => void;
  private readonly width: number;
  private readonly edit: (text: string) => string | undefined;
  /** The safe answer, so Enter alone never spends anything. */
  selected = 2;
  draft: string;
  editing = false;
  finished = false;

  constructor(options: RestartConfirmOptions) {
    this.options = options;
    this.theme = options.theme;
    this.requestRender = options.requestRender ?? (() => {});
    this.width = options.width ?? CARD_WIDTH;
    this.edit = options.edit ?? ((text: string) => editTextInEditor(text, { fileName: "task.txt" }));
    this.draft = options.request.prompt ?? "";
  }

  dispose(): void {}

  invalidate(): void {}

  render(width: number): string[] {
    const cardWidth = Math.max(26, Math.min(this.width, width));
    const lines = buildRestartLines({ request: this.options.request, selected: this.selected, width: cardWidth, editing: this.editing, draft: this.draft });
    const inner = Math.max(1, cardWidth - 2);
    const border = cardBorder(this.theme);
    const out = [border(`╭${"─".repeat(inner)}╮`)];
    for (const line of lines) {
      const painted = cardColour(line, this.theme, cardWidth, shimmerPhase(Date.now()));
      // The pad is measured on the visible text: a colour code is not a column.
      const missing = Math.max(0, inner - visibleWidth(painted));
      out.push(`${border("│")}${truncateToWidth(`${painted}${" ".repeat(missing)}`, inner, "…", false)}${border("│")}`);
    }
    out.push(border(`╰${"─".repeat(inner)}╯`));
    return out;
  }

  handleInput(data: string): void {
    if (this.editing) {
      this.handleEditing(data);
      return;
    }
    if (matchesKey(data, "escape") || data === "n" || data === "N" || data === "3") {
      this.finish(false);
      return;
    }
    if (data === "y" || data === "Y" || data === "1") {
      this.finish(true);
      return;
    }
    if (data === "e" || data === "E" || data === "2") {
      this.startEditing();
      return;
    }
    if (matchesKey(data, "return")) {
      if (this.selected === 0) this.finish(true);
      else if (this.selected === 1) this.startEditing();
      else this.finish(false);
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "down")) {
      const delta = matchesKey(data, "up") ? -1 : 1;
      this.selected = Math.max(0, Math.min(2, this.selected + delta));
      this.requestRender();
    }
  }

  /** Open the task for typing, keeping the words that are already there. */
  startEditing(): void {
    this.editing = true;
    this.selected = 1;
    this.requestRender();
  }

  private handleEditing(data: string): void {
    if (matchesKey(data, "escape")) {
      // Back to the answers, with the text as it stands: a mistake in the card is
      // not the same as a decision.
      this.editing = false;
      this.requestRender();
      return;
    }
    if (data === "\u0007" /* ctrl+g */) {
      const edited = this.edit(this.draft);
      if (typeof edited === "string") this.draft = edited;
      this.requestRender();
      return;
    }
    if (matchesKey(data, "return")) {
      this.finish(true);
      return;
    }
    if (matchesKey(data, "backspace")) {
      this.draft = this.draft.slice(0, -1);
      this.requestRender();
      return;
    }
    // One key at a time, and a paste arrives as one chunk: both are text.
    if (data.length >= 1 && !data.startsWith("\u001b")) {
      this.draft += data;
      this.requestRender();
    }
  }

  private finish(approved: boolean): void {
    if (this.finished) return;
    this.finished = true;
    const original = (this.options.request.prompt ?? "").trim();
    const changed = this.draft.trim() !== original && this.draft.trim() !== "";
    // A prompt is only sent when it really differs; the caller then runs the same
    // task it always would have run.
    this.options.done({ approved, prompt: approved && changed ? this.draft : undefined });
  }
}

/**
 * Ask, and come back with a decision.
 *
 * No terminal, no card, no restart: a host that cannot ask cannot get a yes out
 * of a question nobody saw.
 */
export async function askRestartConfirm(
  ctx: { ui?: { custom?: unknown }; theme?: unknown } | undefined,
  request: RestartConfirmRequest,
  options: { custom?: unknown; theme?: Theme; width?: number; edit?: (text: string) => string | undefined } = {},
): Promise<RestartConfirmOutcome> {
  const custom = options.custom ?? (ctx as { ui?: { custom?: unknown } } | undefined)?.ui?.custom;
  if (typeof custom !== "function") return { approved: false };
  let outcome: RestartConfirmOutcome | undefined;
  await (custom as (...args: unknown[]) => Promise<unknown>).call(
    ctx,
    (tui: any, panelTheme: Theme, _kb: any, done: () => void) =>
      new RestartConfirmPrompt({
        request,
        theme: panelTheme ?? (options.theme as Theme),
        done: (value) => {
          outcome = value;
          done();
        },
        requestRender: () => tui?.requestRender?.(),
        width: options.width,
        edit: options.edit,
      }),
    { overlay: true, overlayOptions: { anchor: "center", width: options.width ?? CARD_WIDTH, maxHeight: CARD_HEIGHT } },
  );
  // Closing the card without choosing means No.
  return outcome ?? { approved: false };
}
