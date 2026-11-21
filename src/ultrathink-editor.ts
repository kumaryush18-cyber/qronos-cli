// The editor subclass that draws `ultrathink` in orange.
//
// Why a subclass and not a patch of pi's source: pi exposes
// `ctx.ui.setEditorComponent(...)` exactly for this, and `Editor.render()` is
// public. We paint the rendered lines and never touch the editor's text, so
// submission, undo, cursor movement and width measurement stay pi's own.
//
// The animation only runs while the word is present. A timer that never stops
// would keep the terminal redrawing forever, which is a battery bug.
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { findKeywords, paintKeywordLines } from "./ultrathink";

/** One frame every 90 ms: smooth enough for a 4-character band, cheap to draw. */
export const ULTRATHINK_FRAME_MS = 90;

export interface UltrathinkEditorOptions {
  /** Injected in tests. */
  now?: () => number;
  startTicker?: (tick: () => void, ms: number) => unknown;
  stopTicker?: (handle: unknown) => void;
}

export class UltrathinkEditor extends CustomEditor {
  private readonly now: () => number;
  private readonly startTicker: (tick: () => void, ms: number) => unknown;
  private readonly stopTicker: (handle: unknown) => void;
  private ticker: unknown;
  /** True after the last render saw the word; read by tests. */
  animating = false;

  constructor(
    tui: TUI,
    theme: ConstructorParameters<typeof CustomEditor>[1],
    keybindings: ConstructorParameters<typeof CustomEditor>[2],
    options: UltrathinkEditorOptions = {},
  ) {
    super(tui, theme, keybindings);
    this.now = options.now ?? Date.now;
    this.startTicker =
      options.startTicker ??
      ((tick, ms) => {
        const handle = setInterval(tick, ms);
        if (typeof handle === "object" && "unref" in handle) (handle as { unref(): void }).unref();
        return handle;
      });
    this.stopTicker = options.stopTicker ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  }

  render(width: number): string[] {
    const lines = super.render(width);
    const painted = paintKeywordLines(lines, this.now());
    this.syncTicker(findKeywords(this.getText()).length > 0);
    return painted;
  }

  /** Start the animation when the word appears, stop it when it goes. */
  private syncTicker(wanted: boolean): void {
    if (wanted && !this.animating) {
      this.animating = true;
      this.ticker = this.startTicker(() => {
        if (findKeywords(this.getText()).length === 0) {
          this.stop();
          return;
        }
        this.tui.requestRender();
      }, ULTRATHINK_FRAME_MS);
      return;
    }
    if (!wanted && this.animating) this.stop();
  }

  stop(): void {
    if (!this.animating) return;
    this.animating = false;
    this.stopTicker(this.ticker);
    this.ticker = undefined;
  }

  dispose(): void {
    this.stop();
  }
}
