// The parts a card in the chat is built from: a row with a right-hand side, one
// colour per line, and a border. Two cards use them (the approval card and the
// tool card), so they live here instead of being copied into each.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { shimmerText } from "./shimmer";

export type CardLineStyle =
  | "title"
  | "subtitle"
  | "phase"
  | "warn"
  | "option"
  | "option-selected"
  | "code"
  | "hint";

export interface CardLine {
  text: string;
  style: CardLineStyle;
}

/**
 * Left text, right text, and the space between them.
 *
 * When both do not fit, the left is kept and the right is dropped: the left is
 * what the card is about, the right is context.
 */
export function cardRow(left: string, counter: string, right: string, width: number): string {
  const tail = [counter, right].filter((part) => part !== "").join("  ");
  if (tail === "") return left;
  const room = width - tail.length - 1;
  if (room < 8) return truncateToWidth(`${left}  ${tail}`, width, "…", false);
  return `${truncateToWidth(left, room, "…", false)}${" ".repeat(Math.max(1, width - Math.min(left.length, room) - tail.length))}${tail}`;
}

/** Paint one line with the card's colour language. */
export function cardColour(line: CardLine, theme: Theme, width: number, shimmer: number): string {
  const paint = (slot: string): string => {
    try {
      const fg = (theme as unknown as { fg?: (name: string, text: string) => string }).fg;
      return fg ? fg(slot, line.text) : line.text;
    } catch {
      return line.text;
    }
  };
  if (line.style === "title") {
    // The same pale-orange band as the header: the heading is the one thing that
    // should catch the eye on a card that stops a run.
    return truncateToWidth(shimmerText(line.text, shimmer, { bold: true }), width - 2, "…", false);
  }
  switch (line.style) {
    case "subtitle":
      return paint("accent");
    case "phase":
      return paint("text");
    case "warn":
      return paint("warning");
    case "option-selected":
      return paint("accent");
    case "option":
    case "code":
    case "hint":
      return paint(line.style === "option" ? "text" : "muted");
    default:
      return line.text;
  }
}

/** The border lines, in the border colour when the theme has one. */
export function cardBorder(theme: Theme): (text: string) => string {
  return (text: string) => {
    try {
      const fg = (theme as unknown as { fg?: (name: string, text: string) => string }).fg;
      return fg ? fg("border", text) : text;
    } catch {
      return text;
    }
  };
}
