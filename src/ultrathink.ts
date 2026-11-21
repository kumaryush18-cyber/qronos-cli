// `ultrathink`: one word in the prompt, two effects, no model call.
//
// 1. It is painted in the input box — brand orange with a pale-orange band
//    flowing through it — the moment it is typed as a standalone word.
// 2. It adds a hidden instruction for that turn, asking for a careful,
//    planned answer instead of a quick one.
//
// Matching is deliberately strict. `ultrathinking`, `ultrathink.ts`,
// `foo/ultrathink` and words inside `code spans` or fences do nothing: a path
// in a prompt must not silently change how the agent works.
import { shimmerPhase, shimmerText } from "./shimmer";

export const ULTRATHINK_WORD = "ultrathink";
/** Where the hidden instruction goes in the system prompt. */
export const ULTRATHINK_SECTION = "qronos-ultrathink";
/** Footer label shown while the word is in the editor. */
export const ULTRATHINK_STATUS = "ultrathink on";

export interface WordMatch {
  start: number;
  end: number;
}

/** A character that would turn the word into part of a longer token. */
function isWordChar(ch: string | undefined): boolean {
  if (!ch) return false;
  return /[A-Za-z0-9_\-./\\]/.test(ch);
}

/**
 * Blank out code so a snippet cannot trigger the keyword.
 *
 * Replacing with spaces keeps every index in place, so this can run before
 * matching and the positions still line up with the original text.
 */
export function maskCode(text: string): string {
  let out = text;
  const blank = (match: string) => " ".repeat(match.length);
  // Fenced blocks first, so backticks inside them are not treated as spans.
  out = out.replace(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g, blank);
  out = out.replace(/(`[^`\n]*`)/g, blank);
  return out;
}

/** Every standalone `ultrathink`, left to right. */
export function findUltrathink(text: string): WordMatch[] {
  const masked = maskCode(text);
  const matches: WordMatch[] = [];
  let from = 0;
  for (;;) {
    const at = masked.indexOf(ULTRATHINK_WORD, from);
    if (at === -1) break;
    const before = at === 0 ? undefined : masked[at - 1];
    const after = masked[at + ULTRATHINK_WORD.length];
    if (!isWordChar(before) && !isWordChar(after)) {
      matches.push({ start: at, end: at + ULTRATHINK_WORD.length });
    }
    from = at + ULTRATHINK_WORD.length;
  }
  return matches;
}

export function hasUltrathink(text: string): boolean {
  return findUltrathink(text).length > 0;
}

/**
 * Paint one rendered line. ANSI is added, never text, so the visible width is
 * unchanged and the input box layout cannot move.
 */
export function paintUltrathinkLine(line: string, now: number = Date.now()): string {
  const matches = findUltrathink(line);
  if (matches.length === 0) return line;
  let out = line;
  // Right to left, so earlier replacements do not shift later indexes.
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index]!;
    const painted = shimmerText(ULTRATHINK_WORD, shimmerPhase(now));
    out = out.slice(0, match.start) + painted + out.slice(match.end);
  }
  return out;
}

export function paintUltrathinkLines(lines: string[], now: number = Date.now()): string[] {
  return lines.map((line) => paintUltrathinkLine(line, now));
}

/** The hidden instruction. Short on purpose: it competes with the real prompt. */
export const ULTRATHINK_NOTICE = `The user wrote the word "ultrathink" in this prompt, so they want care instead of speed:

- Before editing anything, state the plan in 2-4 lines: what you will change, and why.
- Check the assumptions the plan rests on. If a fact is unknown, go and read it first.
- Prefer one well-verified change over several speculative ones.
- When you report back, say what you checked and what you did not check.

This applies to this turn only. It does not change the user's other instructions.`;

export function ultrathinkSection(): string {
  return `## Ultrathink (this turn)\n${ULTRATHINK_NOTICE}`;
}
