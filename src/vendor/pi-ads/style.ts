// ALL rendering/styling for pi-ads lives in this one module. Blade
// Runner 2049-leaning terminal aesthetic: box-drawing frame, a scanline-style
// glyph accent (░▒▓) in the header, theme-aware accent color pulled from
// pi's active theme so the frame matches whatever theme the user has picked.
//
// Every function here is pure (string in, string out) so it's testable
// without a real pi TUI: callers pass a `ThemeLike` (the real `Theme` class
// from @earendil-works/pi-coding-agent satisfies this structurally) and an
// explicit `columns` width instead of reading the terminal directly.
import { createHash } from "node:crypto";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AdCreative } from "@qronos/shared";

/** Structural subset of pi's `Theme` class actually used for styling. */
export interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

// ---------------------------------------------------------------------------
// Sanitizer — strips ANSI/OSC/control sequences from every creative text
// field before it's ever assembled into a widget line. Ad copy is untrusted
// input; nothing here may reach the terminal un-neutralized.
// ---------------------------------------------------------------------------

const OSC_RE = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g; // ESC ] ... (BEL | ST)
const CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g; // ESC [ ... final byte
const C1_RE = /[\x80-\x9f]/g; // 8-bit C1 control range (alternate ESC triggers)
const C0_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g; // C0 controls + DEL, excl. \t\r\n (handled separately)

export function sanitizeText(input: string): string {
  return input
    .replace(OSC_RE, "")
    .replace(CSI_RE, "")
    .replace(/\x1b/g, "") // any leftover ESC byte from an unrecognized sequence
    .replace(C1_RE, "")
    .replace(/[\t\r\n]+/g, " ")
    .replace(C0_RE, "")
    .trim();
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

/**
 * Fit `text` to exactly `width` terminal cells: truncate with "…" when too wide,
 * pad with spaces when too narrow. Measures cells (CJK and emoji take two),
 * not JS string length, so a row never overflows the terminal. `text` is
 * already sanitized, so it carries no escape sequences.
 */
function fit(text: string, width: number): string {
  return truncateToWidth(text, Math.max(0, width), "…", true);
}

/**
 * OSC 8 hyperlink. Terminals that support OSC 8 render `text` as clickable;
 * terminals that don't simply ignore the invisible control bytes and show
 * `text` as-is. We deliberately make `text` the human CTA (which names the
 * destination, e.g. "get the skill @ slop.cash") rather than the raw click
 * URL: the click URL is a long, random `/c/<token>` tracking redirect that
 * looks untrustworthy in the terminal and suppresses the click (first paid-ad
 * feedback, 2026-08-18, #61). Clickable where OSC 8 is supported; a clean,
 * legible destination where it is not.
 */
export function osc8(text: string, url: string, id?: string): string {
  const params = id ? `id=${id}` : "";
  return `\x1b]8;${params};${url}\x07${text}\x1b]8;;\x07`;
}

// ---------------------------------------------------------------------------
// Ad rendering
// ---------------------------------------------------------------------------

/** One styled run of a card row. Widths are measured on the plain text. */
interface Run {
  text: string;
  style: (text: string) => string;
}

/**
 * Visible width in terminal cells, not characters: a CJK glyph or an emoji takes
 * two cells, and a line measured by string length would overflow the terminal
 * (pi throws past its width) or leave the borders ragged.
 */
function plainLength(text: string): number {
  return visibleWidth(text);
}

/** Cut to a width without padding; rows add their own spaces. */
function clipWidth(text: string, width: number): string {
  return truncateToWidth(text, Math.max(1, width), "…", false);
}

/**
 * Premium ad card.
 *
 * What makes it catch the eye without shouting, in a terminal:
 *
 * 1. A short **brand rail** (`▬▬▬`) on the top border, in the warm accent
 *    colour. It is the only saturated thing on the card, so the eye lands there
 *    first — the same trick a coloured tab uses in print.
 * 2. **One glyph** (`✦`) opening the headline, not a wall of symbols.
 * 3. **Type hierarchy**: headline bold and warm, body quiet, call to action in
 *    the accent with a small arrow. Three levels, never two weights of noise.
 * 4. **A hairline frame**, not a heavy box: `─` in the border colour, so the
 *    card reads as a quiet panel instead of a table.
 * 5. **A right-aligned CTA** on the body line, so the card is two text rows tall
 *    instead of three: more information, less height stolen from the chat.
 * 6. The whole frame stays one clickable link (OSC 8), and `sponsored` always
 *    sits on the border, in dim text. An ad that hides that it is an ad is not
 *    premium, it is a dark pattern.
 */
export function renderAdCard(
  creative: AdCreative,
  clickUrl: string,
  theme: ThemeLike,
  columns: number,
): string[] {
  const headline = sanitizeText(creative.headline) || "Sponsored";
  const body = sanitizeText(creative.body);
  const cta = sanitizeText(creative.cta) || "Learn more";
  const url = sanitizeText(clickUrl);

  // -6, not -4: pi's TUI draws widget lines behind a 1-2 column gutter, so a
  // line built to exactly `columns` wraps its closing border onto the next
  // row (witnessed live at 80/100/140 cols on 2026-08-15).
  const innerWidth = Math.max(20, columns - 6);

  // a short hex digest of the (sanitized) click URL, not the click token
  // itself, so the id visible in the escape stream is stable for hover-grouping
  // without doubling as a second copy of the tracker.
  const linkId = createHash("sha256").update(url).digest("hex").slice(0, 12);

  const border = (text: string) => theme.fg("border", text);
  const brand = (text: string) => theme.fg("accent", text);
  const warm = (text: string) => theme.bold(theme.fg("warning", text));
  const quiet = (text: string) => theme.fg("dim", text);

  // Every row carries the same OSC 8 link and id, so a terminal that groups by
  // id treats the whole card as one link, not just the CTA.
  const link = (text: string) => osc8(text, url, linkId);

  const top = (() => {
    const rail = "▬▬▬";
    const label = " sponsored ";
    // corner + leading dash + rail + label = everything except the filler dashes
    const fixed = rail.length + label.length + 3;
    if (innerWidth - fixed < 4) {
      // Too narrow for the brand rail: keep the disclosure, drop the flourish.
      const short = " sponsored ";
      return `╭${label}${"─".repeat(Math.max(0, innerWidth - short.length))}╮`;
    }
    const dashes = "─".repeat(innerWidth - fixed);
    return border("╭─") + brand(rail) + border(`──${label}${dashes}╮`);
  })();

  const bottom = border(`╰${"─".repeat(innerWidth)}╯`);

  /** One row: border, runs padded to the inner width, border. */
  const row = (runs: Run[]): string => {
    let plain = 0;
    for (const run of runs) plain += plainLength(run.text);
    const gap = Math.max(0, innerWidth - plain);
    const styled = runs.map((run) => run.style(run.text)).join("");
    return border("│") + styled + " ".repeat(gap) + border("│");
  };

  const rows: string[] = [];
  const headlineText = clipWidth(headline, Math.max(4, innerWidth - 4));
  rows.push(row([{ text: " ", style: quiet }, { text: "✦ ", style: brand }, { text: headlineText, style: warm }]));

  if (body) {
    // The CTA is untrusted copy like everything else: fit it before it can
    // widen a row past the terminal.
    const ctaText = clipWidth(`${cta} ↗`, Math.max(8, innerWidth - 6));
    const ctaWidth = plainLength(ctaText);
    const bodyRoom = innerWidth - 4 - ctaWidth - 2;
    if (bodyRoom >= 12) {
      // Body and CTA share a line: the card stays two text rows tall.
      const bodyText = clipWidth(body, bodyRoom);
      const pad = Math.max(2, bodyRoom - plainLength(bodyText) + 2);
      rows.push(
        row([
          { text: "   ", style: quiet },
          { text: bodyText, style: quiet },
          { text: " ".repeat(pad), style: (text) => text },
          { text: ctaText, style: warm },
        ]),
      );
    } else {
      rows.push(row([{ text: "   ", style: quiet }, { text: clipWidth(body, innerWidth - 3), style: quiet }]));
      rows.push(row([{ text: "   ", style: quiet }, { text: ctaText, style: warm }]));
    }
  } else {
    rows.push(row([{ text: "   ", style: quiet }, { text: `${cta} ↗`, style: warm }]));
  }

  return [link(top), ...rows.map((line) => link(line)), link(bottom)];
}

/** Below adMinColumns: one plain line, no frame. Still an OSC 8 link (degrades to plain text). */
export function renderPlainAdLine(
  creative: AdCreative,
  clickUrl: string,
  theme: ThemeLike,
  columns: number,
): string {
  const headline = sanitizeText(creative.headline);
  const cta = sanitizeText(creative.cta);
  const url = sanitizeText(clickUrl);
  // same as the card — the CTA carries the destination; the raw tracker
  // URL is the OSC-8 target only, never visible text.
  const plain = truncateToWidth(`✦ ${headline} — ${cta}  ·  sponsored`, Math.max(0, columns - 2), "…");
  return theme.fg("dim", osc8(plain, url));
}

/** Narrowest render width the framed card fits: 20 inner + 4 frame + 1 margin column. */
const CARD_MIN_COLUMNS = 25;

/**
 * pi widget factory for an ad. pi calls `render(width)` with the live terminal
 * width on every paint, so the card (or the below-`adMinColumns` plain line)
 * is re-laid-out after a resize instead of keeping the width it had at fetch
 * time. Lines get one leading space, the same one-column margin pi gives a
 * string[] widget; the card is already built 2 columns narrower than `width`.
 */
export function adWidget(creative: AdCreative, clickUrl: string, adMinColumns: number) {
  return (_tui: unknown, theme: ThemeLike) => ({
    // A line wider than `width` makes pi's renderer throw, so never draw the
    // card where it cannot fit (even if AD_MIN_COLUMNS is set low), and draw
    // nothing at all when there is no column to draw in.
    render: (width: number): string[] =>
      width < 1
        ? []
        : (width >= Math.max(adMinColumns, CARD_MIN_COLUMNS)
            ? renderAdCard(creative, clickUrl, theme, width)
            : [renderPlainAdLine(creative, clickUrl, theme, width)]
          ).map((line) => ` ${line}`),
    invalidate() {},
  });
}

// ---------------------------------------------------------------------------
// Meter / error line
// ---------------------------------------------------------------------------

export function renderErrorLine(message: string, theme: ThemeLike): string {
  return theme.fg("error", message);
}

/** Warning-colored (not error) meter line, e.g. a low-credit or slow-lane nudge. */
export function renderWarningLine(message: string, theme: ThemeLike): string {
  return theme.fg("warning", message);
}
