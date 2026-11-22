// "Run this agent again?" — the card that stops a restart before it costs money.
//
// A restart is a fresh model call, so it is the one panel action that spends
// tokens. The card is small and its default is No: closing it runs nothing.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { cardBorder, cardColour, cardRow, type CardLine } from "./workflow-card-style";
import { shimmerPhase, shimmerText } from "./shimmer";

const CARD_WIDTH = 66;

/** Width of a line as the eye counts it, without colour codes. */
function visibleWidth(text: string): number {
  return text.replace(/\u001b\[[0-9;]*m/g, "").length;
}

export interface RestartConfirmRequest {
  /** The agent that would run again. */
  label: string;
  model?: string;
  tokens?: number;
  reason?: string;
}

export interface RestartConfirmState {
  request: RestartConfirmRequest;
  selected: number;
  width: number;
}

/** The card, as lines. Two answers, and the safe one is not the default. */
export function buildRestartLines(state: RestartConfirmState): CardLine[] {
  const width = Math.max(28, state.width - 4);
  const { request } = state;
  const lines: CardLine[] = [];
  lines.push({ text: cardRow("Run this agent again?", "", "", width), style: "title" });
  lines.push({ text: "", style: "hint" });
  lines.push({ text: `  ${truncateToWidth(request.label, width - 2, "…", false)}`, style: "code" });
  const facts = [request.model, request.tokens ? `${request.tokens} tokens last time` : ""].filter(Boolean).join(" · ");
  if (facts !== "") lines.push({ text: `  ${truncateToWidth(facts, width - 2, "…", false)}`, style: "subtitle" });
  lines.push({ text: "", style: "hint" });
  // The cost is the whole point of asking, so it is said in plain words.
  lines.push({ text: "  this calls the model again and spends tokens again", style: "warn" });
  lines.push({ text: "  the rest of the run is not touched", style: "hint" });
  lines.push({ text: "", style: "hint" });
  lines.push({ text: `  ${state.selected === 0 ? "▸" : " "} 1. Yes, run it again`, style: state.selected === 0 ? "option-selected" : "option" });
  lines.push({ text: `  ${state.selected === 1 ? "▸" : " "} 2. No`, style: state.selected === 1 ? "option-selected" : "option" });
  lines.push({ text: "", style: "hint" });
  lines.push({ text: "  enter choose · y yes · esc no", style: "hint" });
  return lines;
}

export interface RestartConfirmOptions {
  request: RestartConfirmRequest;
  theme: Theme;
  done: (approved: boolean) => void;
  requestRender?: () => void;
  width?: number;
}

export class RestartConfirmPrompt {
  private readonly options: RestartConfirmOptions;
  private readonly theme: Theme;
  private readonly requestRender: () => void;
  private readonly width: number;
  selected = 1;
  finished = false;

  constructor(options: RestartConfirmOptions) {
    this.options = options;
    this.theme = options.theme;
    this.requestRender = options.requestRender ?? (() => {});
    this.width = options.width ?? CARD_WIDTH;
  }

  dispose(): void {}

  invalidate(): void {}

  render(width: number): string[] {
    const cardWidth = Math.max(28, Math.min(this.width, width));
    const lines = buildRestartLines({ request: this.options.request, selected: this.selected, width: cardWidth });
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
      this.selected = this.selected === 0 ? 1 : 0;
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
 * Ask, and come back with a yes or a no.
 *
 * No terminal, no card, no restart: a host that cannot ask cannot get a yes out
 * of a question nobody saw.
 */
export async function askRestartConfirm(
  ctx: { ui?: { custom?: unknown }; theme?: unknown } | undefined,
  request: RestartConfirmRequest,
  options: { custom?: unknown; theme?: Theme; width?: number } = {},
): Promise<boolean> {
  const custom = options.custom ?? (ctx as { ui?: { custom?: unknown } } | undefined)?.ui?.custom;
  if (typeof custom !== "function") return false;
  let approved = false;
  await (custom as (...args: unknown[]) => Promise<unknown>).call(
    ctx,
    (tui: any, panelTheme: Theme, _kb: any, done: () => void) =>
      new RestartConfirmPrompt({
        request,
        theme: panelTheme ?? (options.theme as Theme),
        done: (value) => {
          approved = value;
          done();
        },
        requestRender: () => tui?.requestRender?.(),
        width: options.width,
      }),
    { overlay: true, overlayOptions: { anchor: "center", width: options.width ?? CARD_WIDTH, maxHeight: 16 } },
  );
  return approved;
}

/** The shimmer title is exported for a caller that wants only the words. */
export function restartTitle(text: string, phase = shimmerPhase(Date.now())): string {
  return shimmerText(text, phase, { bold: true });
}
