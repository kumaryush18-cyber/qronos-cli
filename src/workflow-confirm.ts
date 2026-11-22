// A yes/no card made from lines someone else wrote.
//
// The restart card and the approval card ask about things that cost money and
// each has its own shape. This one is for the small decisions in between —
// "save the change?" — where the question is yours but the danger is real.
//
//   ╭────────────────────────────────────────────────────────────────╮
//   │ Save the change?                                               │
//   │   .qronos/workflows/review.js                                  │
//   │   the file on disk would be replaced                           │
//   │   ▸ 1. Yes, save it                                            │
//   │     2. No, leave the file alone                                │
//   ╰────────────────────────────────────────────────────────────────╯
//
// The cursor starts on No. Closing the card means No. A host with no overlay
// means No. Silence never overwrites a file.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { cardBorder, cardColour, cardRow, type CardLine } from "./workflow-card-style";

const CARD_WIDTH = 62;
const CARD_HEIGHT = 18;

export interface ConfirmRequest {
  /** The question, in the smallest words that say it. */
  title: string;
  /** Facts under it: what would change, and what that means. */
  lines: string[];
  /** The two answers, as the card shows them. */
  yes: string;
  no: string;
}

export interface ConfirmState {
  request: ConfirmRequest;
  selected: number;
  width: number;
}

function visibleWidth(text: string): number {
  return text.replace(/\u001b\[[0-9;]*m/g, "").length;
}

/** The card, as lines. */
export function buildConfirmLines(state: ConfirmState): CardLine[] {
  const width = Math.max(24, state.width - 4);
  const lines: CardLine[] = [];
  lines.push({ text: cardRow(state.request.title, "", "", width), style: "title" });
  lines.push({ text: "", style: "hint" });
  for (const line of state.request.lines.slice(0, 4)) {
    lines.push({ text: `  ${truncateToWidth(line, width - 2, "…", false)}`, style: "subtitle" });
  }
  lines.push({ text: "", style: "hint" });
  lines.push({
    text: `  ${state.selected === 0 ? "▸" : " "} 1. ${state.request.yes}`,
    style: state.selected === 0 ? "option-selected" : "option",
  });
  lines.push({
    text: `  ${state.selected === 1 ? "▸" : " "} 2. ${state.request.no}`,
    style: state.selected === 1 ? "option-selected" : "option",
  });
  lines.push({ text: "", style: "hint" });
  lines.push({ text: "  enter choose · y yes · esc no", style: "hint" });
  return lines;
}

export interface ConfirmOptions {
  request: ConfirmRequest;
  theme: Theme;
  done: (approved: boolean) => void;
  requestRender?: () => void;
  width?: number;
}

export class ConfirmPrompt {
  private readonly options: ConfirmOptions;
  private readonly theme: Theme;
  private readonly requestRender: () => void;
  private readonly width: number;
  /** The safe answer, so Enter alone never writes anything. */
  selected = 1;
  finished = false;

  constructor(options: ConfirmOptions) {
    this.options = options;
    this.theme = options.theme;
    this.requestRender = options.requestRender ?? (() => {});
    this.width = options.width ?? CARD_WIDTH;
  }

  dispose(): void {}

  invalidate(): void {}

  render(width: number): string[] {
    const cardWidth = Math.max(24, Math.min(this.width, width));
    const inner = Math.max(1, cardWidth - 2);
    const border = cardBorder(this.theme);
    const out = [border(`╭${"─".repeat(inner)}╮`)];
    for (const line of buildConfirmLines({ request: this.options.request, selected: this.selected, width: cardWidth })) {
      const painted = cardColour(line, this.theme, cardWidth, 0);
      const missing = Math.max(0, inner - visibleWidth(painted));
      out.push(`${border("│")}${truncateToWidth(`${painted}${" ".repeat(missing)}`, inner, "…", false)}${border("│")}`);
    }
    out.push(border(`╰${"─".repeat(inner)}╯`));
    return out;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "n" || data === "N" || data === "2") {
      this.finish(false);
      return;
    }
    if (data === "y" || data === "Y" || data === "1") {
      this.finish(true);
      return;
    }
    if (matchesKey(data, "return")) {
      this.finish(this.selected === 0);
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "down")) {
      // Two answers, so the cursor stops at each end instead of wrapping: a
      // cursor that jumps from No to Yes is a cursor that can be pressed twice by
      // accident.
      this.selected = Math.max(0, Math.min(1, this.selected + (matchesKey(data, "up") ? -1 : 1)));
      this.requestRender();
    }
  }

  private finish(approved: boolean): void {
    if (this.finished) return;
    this.finished = true;
    this.options.done(approved);
  }
}

/**
 * Ask, and come back with a plain yes or no.
 *
 * No overlay, no yes: a question nobody saw cannot be answered, and "no" is the
 * answer that changes nothing.
 */
export async function askConfirm(
  ctx: { ui?: { custom?: unknown }; theme?: unknown } | undefined,
  request: ConfirmRequest,
  options: { custom?: unknown; theme?: Theme; width?: number } = {},
): Promise<boolean> {
  const custom = options.custom ?? (ctx as { ui?: { custom?: unknown } } | undefined)?.ui?.custom;
  if (typeof custom !== "function") return false;
  let approved: boolean | undefined;
  await (custom as (...args: unknown[]) => Promise<unknown>).call(
    ctx,
    (tui: any, panelTheme: Theme, _kb: any, done: () => void) =>
      new ConfirmPrompt({
        request,
        theme: panelTheme ?? (options.theme as Theme),
        done: (value) => {
          approved = value;
          done();
        },
        requestRender: () => tui?.requestRender?.(),
        width: options.width,
      }),
    { overlay: true, overlayOptions: { anchor: "center", width: options.width ?? CARD_WIDTH, maxHeight: CARD_HEIGHT } },
  );
  return approved === true;
}
