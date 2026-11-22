// The small pieces that make a workflow report readable at a glance.
//
// Colour is added at render time, never stored: the same record must be usable
// for a colourless log, a test and the terminal. Ticks are bright green and
// crosses are a dark, heavy red so a failure is impossible to skim past.
import { foregroundAnsi, getTerminalColorMode, rgbColor } from "@earendil-works/pi-tui";
import { formatTokens, type WorkflowPhaseStat } from "./workflow-types";

export const BRIGHT_GREEN = rgbColor(46, 230, 118);
export const DARK_RED = rgbColor(193, 18, 31);
export const PHASE_BLUE = rgbColor(120, 180, 255);

export const TICK = "✓";
export const CROSS = "✗";
/** The same glyph Claude Code uses for a running agent. */
export const RUNNING = "✻";
export const PHASE_MARK = "▸";
/** An answer that came back from the journal instead of a fresh model call. */
export const REPLAY = "↺";
/**
 * An agent you stopped yourself.
 *
 * Not a cross: nothing went wrong. Not a tick either: the answer is missing. The
 * empty circle says "this one ended early, and you know why", and the amber
 * keeps it out of both the success and the failure colour.
 */
export const STOPPED = "⊘";
export const AMBER = rgbColor(255, 205, 130);

/** Bright green tick, for a finished agent. */
export function tick(): string {
  return paint(TICK, BRIGHT_GREEN);
}

/** Dark red cross, for a failed agent. */
export function cross(): string {
  return paint(CROSS, DARK_RED);
}

/** A phase name, in a calm blue so it reads as structure, not status. */
export function phaseMark(name: string): string {
  return paint(`${PHASE_MARK} ${name}`, PHASE_BLUE);
}

/** A replayed answer: the same calm blue, because it is not a failure either. */
export function replayMark(): string {
  return paint(REPLAY, PHASE_BLUE);
}

/** An agent you stopped: amber, which is neither "done" nor "broke". */
export function stoppedMark(): string {
  return paint(STOPPED, AMBER);
}

function paint(text: string, color: ReturnType<typeof rgbColor>): string {
  const ansi = foregroundAnsi(color, getTerminalColorMode());
  return ansi ? `${ansi}${text}\x1b[0m` : text;
}

/** `12s`, `4m 02s`. Milliseconds stay out of a report a human reads. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/**
 * A tiny horizontal bar, so "who did how much work" is visible without reading
 * numbers. `width` is the longest bar; anything non-zero gets at least one cell
 * so an agent that did almost nothing is still visible.
 */
export function tokenBar(tokens: number, max: number, width = 10): string {
  if (max <= 0 || tokens <= 0) return "";
  const filled = Math.max(1, Math.round((tokens / max) * width));
  return "█".repeat(Math.min(width, filled));
}

/** Total agents and tokens for a phase table. */
export function phaseTotals(stats: WorkflowPhaseStat[]): { agents: number; tokens: number; failed: number } {
  return stats.reduce(
    (total, stat) => ({
      agents: total.agents + stat.agents,
      tokens: total.tokens + stat.tokens,
      failed: total.failed + stat.failed,
    }),
    { agents: 0, tokens: 0, failed: 0 },
  );
}

/** One aligned table row, padded so columns line up in any colour mode. */
export function pad(text: string, width: number): string {
  // ANSI escapes have zero width; measure the visible text instead.
  const visible = text.replace(/\x1b\[[0-9;]*m/g, "");
  if (visible.length >= width) return text;
  return text + " ".repeat(width - visible.length);
}

export { formatTokens };
