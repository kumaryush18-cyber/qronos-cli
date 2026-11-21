// Magic keywords: one word in the prompt, two effects, no model call.
//
// 1. Painted in the input box — brand orange with a pale-orange band flowing
//    through it — the moment it is typed as a standalone word.
// 2. The ones that have a behaviour add a hidden instruction for that turn.
//
// Matching is deliberately strict. `ultrathinking`, `ultrathink.ts`,
// `foo/ultracode` and words inside `code spans` or fences do nothing: a path in
// a prompt must not silently change how the agent works.
import { shimmerPhase, shimmerText } from "./shimmer";

/** `ultrathink`: think and plan before editing. */
export const ULTRATHINK_WORD = "ultrathink";
/** `ultracode`: run the task as a multi-agent workflow (Claude Code's name). */
export const ULTRACODE_WORD = "ultracode";
/** `orchestrate`: fan out independent work across subagents. */
export const ORCHESTRATE_WORD = "orchestrate";

export const KEYWORDS = [ULTRATHINK_WORD, ULTRACODE_WORD, ORCHESTRATE_WORD] as const;
export type Keyword = (typeof KEYWORDS)[number];

/** Where the hidden instruction goes in the system prompt. */
export const ULTRATHINK_SECTION = "qronos-ultrathink";
export const ULTRACODE_SECTION = "qronos-ultracode";
export const ORCHESTRATE_SECTION = "qronos-orchestrate";
/** Footer label shown while a keyword is in the editor. */
export const ULTRATHINK_STATUS = "ultrathink on";

export interface WordMatch {
  start: number;
  end: number;
  word: Keyword;
}

/** A character that would turn the word into part of a longer token. */
function isWordChar(ch: string | undefined): boolean {
  if (!ch) return false;
  return /[A-Za-z0-9_\-./\\]/.test(ch);
}

/**
 * Blank out code so a snippet cannot trigger a keyword.
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

/** Every standalone magic keyword, in the order they appear. */
export function findKeywords(text: string): WordMatch[] {
  const masked = maskCode(text);
  const matches: WordMatch[] = [];
  for (const word of KEYWORDS) {
    let from = 0;
    for (;;) {
      const at = masked.indexOf(word, from);
      if (at === -1) break;
      const before = at === 0 ? undefined : masked[at - 1];
      const after = masked[at + word.length];
      if (!isWordChar(before) && !isWordChar(after)) matches.push({ start: at, end: at + word.length, word });
      from = at + word.length;
    }
  }
  return matches.sort((a, b) => a.start - b.start);
}

/** Every standalone `ultrathink`, left to right (kept for the first tests/API). */
export function findUltrathink(text: string): Array<{ start: number; end: number }> {
  return findKeywords(text)
    .filter((match) => match.word === ULTRATHINK_WORD)
    .map(({ start, end }) => ({ start, end }));
}

export function hasUltrathink(text: string): boolean {
  return findUltrathink(text).length > 0;
}

export function hasKeyword(text: string, word: Keyword): boolean {
  return findKeywords(text).some((match) => match.word === word);
}

/**
 * Paint one rendered line. ANSI is added, never text, so the visible width is
 * unchanged and the input box layout cannot move.
 */
export function paintKeywordLine(line: string, now: number = Date.now()): string {
  const matches = findKeywords(line);
  if (matches.length === 0) return line;
  let out = line;
  // Right to left, so earlier replacements do not shift later indexes.
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index]!;
    const painted = shimmerText(match.word, shimmerPhase(now));
    out = out.slice(0, match.start) + painted + out.slice(match.end);
  }
  return out;
}

export function paintKeywordLines(lines: string[], now: number = Date.now()): string[] {
  return lines.map((line) => paintKeywordLine(line, now));
}

/** Backwards-compatible names used by the editor and its tests. */
export const paintUltrathinkLine = paintKeywordLine;
export const paintUltrathinkLines = paintKeywordLines;

/** The hidden instruction for `ultrathink`. Short: it competes with the prompt. */
export const ULTRATHINK_NOTICE = `The user wrote the word "ultrathink" in this prompt, so they want care instead of speed:

- Before editing anything, state the plan in 2-4 lines: what you will change, and why.
- Check the assumptions the plan rests on. If a fact is unknown, go and read it first.
- Prefer one well-verified change over several speculative ones.
- When you report back, say what you checked and what you did not check.

This applies to this turn only. It does not change the user's other instructions.`;

export function ultrathinkSection(): string {
  return `## Ultrathink (this turn)\n${ULTRATHINK_NOTICE}`;
}