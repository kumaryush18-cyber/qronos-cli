// Claude-Code-style working line: spinner + "↓ 12.3k".
//
// pi draws its own "thinking" line under the editor and only lets an extension
// change two things: the text (setWorkingMessage) and the animation frames
// (setWorkingIndicator). Frames are rendered *verbatim* (see pi-tui's Loader:
// renderIndicatorVerbatim), so the token count can ride inside the frame:
//
//     ⠋ ↓ 12.3k  Thinking...
//
// That keeps pi's own wording and colour for the message, and gives us the
// arrow + count Claude Code shows. The number is the real context size from
// ctx.getContextUsage() — never a guess — and the plain spinner is used when
// the size is unknown (e.g. right after a compaction).
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

/** pi's default spinner glyphs, kept so the animation looks unchanged. */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Frame interval pi uses by default; re-stated because we pass our own frames. */
export const FRAME_INTERVAL_MS = 80;

/** Message streaming fires very often; only rewrite the frames this often. */
export const MIN_UPDATE_MS = 250;

/**
 * Compact token count: 847 -> "847", 12_340 -> "12.3k", 1_240_000 -> "1.2M".
 * Returns undefined when the number is unknown so the caller can fall back.
 */
export function formatTokenCount(tokens: number | null | undefined): string | undefined {
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) return undefined;
  const n = Math.floor(tokens);
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 10 ? k.toFixed(1) : String(Math.round(k))}k`;
  }
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Spinner frames with the arrow + count appended. Unknown count = plain frames,
 * so the line never shows a made-up number.
 */
export function buildFrames(
  tokens: number | null | undefined,
  glyphs: readonly string[] = SPINNER_FRAMES,
): string[] {
  const count = formatTokenCount(tokens);
  if (!count) return [...glyphs];
  return glyphs.map((glyph) => `${glyph} ↓ ${count}`);
}

export interface CreateThinkingMeterOptions {
  /** Injected clock, for tests. Defaults to Date.now. */
  now?: () => number;
}

/**
 * Keeps the working-indicator frames in sync with the real context size.
 * Adds no tool, makes no model call, and changes nothing outside the spinner.
 */
export function createThinkingMeterExtension(opts: CreateThinkingMeterOptions = {}): InlineExtension {
  const now = opts.now ?? Date.now;
  return {
    name: "qronos-thinking-meter",
    factory(api: ExtensionAPI) {
      let lastTokens: number | undefined;
      let lastAt = Number.NEGATIVE_INFINITY;

      const apply = (ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1], force: boolean): void => {
        let tokens: number | undefined;
        try {
          tokens = ctx.getContextUsage()?.tokens ?? undefined;
        } catch {
          // No bound session yet (or a compaction just cleared it): plain spinner.
          tokens = undefined;
        }
        if (!force) {
          if (tokens === lastTokens) return;
          if (now() - lastAt < MIN_UPDATE_MS) return;
        }
        lastAt = now();
        lastTokens = tokens;
        ctx.ui.setWorkingIndicator({ frames: buildFrames(tokens), intervalMs: FRAME_INTERVAL_MS });
      };

      api.on("session_start", (_event, ctx) => {
        lastTokens = undefined;
        lastAt = Number.NEGATIVE_INFINITY;
        apply(ctx, true);
      });
      api.on("message_update", (_event, ctx) => apply(ctx, false));
      api.on("turn_end", (_event, ctx) => apply(ctx, true));
    },
  };
}
