// The save screen for `/export`.
//
// It looks like the Claude Code screen: a heading, a rule, one labelled field
// holding a name that is already filled in, and a hint line. Enter saves, Esc
// goes back and writes nothing.
//
// The field is pi's own `Input`, so arrows, Home/End, pasting and undo work
// exactly as they do in the message box.
import { Input, matchesKey } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

export interface ExportSavePanelOptions {
  /** The suggested name, already prefilled. */
  initialName: string;
  theme?: Theme;
  /** Called with the chosen name, or undefined when the user backed out. */
  done: (name: string | undefined) => void;
  /** The host's redraw hook; guarded, because a panel must never break a run. */
  requestRender?: () => void;
}

const RULE = "─".repeat(40);

export class ExportSavePanel {
  private readonly input: Input;
  private readonly theme?: Theme;
  private readonly done: (name: string | undefined) => void;
  private readonly requestRender?: () => void;

  constructor(options: ExportSavePanelOptions) {
    this.theme = options.theme;
    this.done = options.done;
    this.requestRender = options.requestRender;
    this.input = new Input({ prompt: "" });
    this.input.setValue(options.initialName);
    // setValue leaves the cursor at the start; the prefilled name is meant to be
    // extended from the end, so move there the same way a user would.
    this.input.handleInput("\u0005");
    this.input.focused = true;
    this.input.onSubmit = (value: string) => this.finish(value);
    this.input.onEscape = () => this.finish(undefined);
  }

  /** The name in the field right now — used by the tests. */
  value(): string {
    return this.input.getValue();
  }

  private finish(name: string | undefined): void {
    this.done(name);
  }

  private paint(colour: "accent" | "muted" | "text", text: string): string {
    const theme = this.theme;
    if (!theme || typeof theme.fg !== "function") return text;
    return theme.fg(colour, text);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.finish(undefined);
      return;
    }
    this.input.handleInput(data);
    try {
      this.requestRender?.();
    } catch {
      // A redraw hook must never break the panel.
    }
  }

  invalidate(): void {
    this.input.invalidate?.();
  }

  render(width: number): string[] {
    const inner = Math.max(20, width - 2);
    const lines: string[] = [];
    lines.push(this.paint("accent", "Export conversation"));
    lines.push(this.paint("muted", RULE));
    lines.push(this.paint("muted", "File name"));
    const field = this.input.render(inner);
    for (const line of field) lines.push(` ${line}`);
    lines.push("");
    lines.push(this.paint("muted", "Enter to save · Esc to go back"));
    return lines;
  }
}

/**
 * Show the panel and wait for a name.
 *
 * A host with no overlays (a script, a test, a plain terminal) answers
 * `undefined`, which means "nothing was saved" — never a surprise file.
 */
export async function askExportFileName(
  ctx: any,
  initialName: string,
  theme?: Theme,
): Promise<string | undefined> {
  if (typeof ctx?.ui?.custom !== "function") return undefined;
  return await (ctx.ui.custom as any)(
    (tui: any, panelTheme: Theme, _kb: any, done: (name: string | undefined) => void) =>
      new ExportSavePanel({
        initialName,
        theme: panelTheme ?? theme,
        done,
        requestRender: () => tui.requestRender?.(),
      }),
    { overlay: true, overlayOptions: { anchor: "center", width: 52, maxHeight: 10 } },
  );
}
