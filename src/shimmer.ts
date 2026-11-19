// One shimmer implementation, shared by the header and the working line.
//
// Why a shared file: both places show a light-orange band flowing through text
// and both must use the SAME colours and the SAME 3 s speed, otherwise the two
// animations look unrelated.
import { foregroundAnsi, getTerminalColorMode, mixColors, rgbColor } from "@earendil-works/pi-tui";
import type { RgbColorValue } from "@earendil-works/pi-tui";

/** Brand and pale orange as values, for callers that mix their own base colour. */
export const BRAND_ORANGE: RgbColorValue = rgbColor(255, 107, 0);
export const PALE_ORANGE: RgbColorValue = rgbColor(255, 205, 130);

export const RESET = "\x1b[0m";

/** Bold, the only way a terminal can make text look bigger. */
export const BOLD = "\x1b[1m";

/** One sweep across the text takes this long. */
export const SHIMMER_PERIOD_MS = 3_000;

/** Width of the moving light band, in characters. */
export const SHIMMER_BAND = 4;

const BRAND = BRAND_ORANGE;
const PALE = PALE_ORANGE;

/**
 * Brand orange as a foreground escape for THIS terminal.
 *
 * Raw "38;2;…" looks colourless on terminals that pi detects as 256-colour:
 * pi renders widget lines through its own capability layer, so colours must be
 * produced with the same mode it detected.
 */
export function orangeAnsi(): string {
  return foregroundAnsi(BRAND, getTerminalColorMode());
}

/** The pale orange, for "finished" text and for the shimmer peak. */
export function lightOrangeAnsi(): string {
  return foregroundAnsi(PALE, getTerminalColorMode());
}

/** Secondary grey for de-emphasised parts. */
export function mutedAnsi(): string {
  return foregroundAnsi(rgbColor(148, 163, 184), getTerminalColorMode());
}

/**
 * How much glow a character gets: 0 = plain colour, 1 = full pale orange.
 *
 * `position` is the character's place along the sweep (column, or column + row
 * offset for a shape that is not one line). `span` is the total travel, so the
 * band enters from the left and leaves on the right as `phase` goes 0 -> 1.
 */
export function bandMixAt(position: number, span: number, phase: number, band = SHIMMER_BAND): number {
  const wrapped = ((phase % 1) + 1) % 1;
  const head = wrapped * span - band;
  const distance = Math.abs(position - head);
  return distance >= band ? 0 : 1 - distance / band;
}

/** Paint one character: `base` colour mixed toward the pale glow by `mix`. */
export function glowChar(ch: string, base: RgbColorValue, mix: number, bold = false): string {
  const colour = mix <= 0 ? base : mixColors(base, PALE, Math.min(1, mix));
  return (bold ? BOLD : "") + foregroundAnsi(colour, getTerminalColorMode()) + ch + RESET;
}

/**
 * Paints `text` so a band of light orange flows through it.
 *
 * `phase` runs 0 -> 1 for one sweep. Each character is mixed between brand
 * orange and light orange by how close it is to the band: the middle of the
 * band is brightest, the edges fade back to plain orange.
 */
export function shimmerText(text: string, phase: number, opts: { bold?: boolean } = {}): string {
  const chars = [...text];
  const span = chars.length + SHIMMER_BAND;
  let out = "";
  for (let index = 0; index < chars.length; index++) {
    out += glowChar(chars[index]!, BRAND, bandMixAt(index, span, phase), opts.bold);
  }
  return out;
}

/** The phase to use right now, so independent animations stay in step. */
export function shimmerPhase(now: number = Date.now()): number {
  return (now % SHIMMER_PERIOD_MS) / SHIMMER_PERIOD_MS;
}
