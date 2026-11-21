// What actually reaches the model.
//
// Two rules make this safe to ship on by default:
// 1. It is a hint, never an authority. The block says so in plain words, because
//    stale memory that the agent trusts over the repo is worse than no memory.
// 2. It has a hard token budget. A project with a thousand lessons must not turn
//    every session into an expensive one, so we add pieces in priority order and
//    stop at the cap: header + file paths, then the five sections, then lessons
//    newest-first.
//
// Tokens are estimated as chars / 4 (the usual English approximation). We are
// budgeting prompt space, not billing, so an approximation that never
// under-counts badly is the right tool — no tokenizer dependency.
import { docHighlights, docItemCount, type MemoryDoc } from "./memory-doc";
import type { Lesson } from "./memory-lessons";
import type { MemoryPaths } from "./memory-paths";

/** pi puts extension sections under their key; this is ours. */
export const MEMORY_SECTION = "qronos-memory";

/** Default injection budget. Roughly 1.2k tokens: a few hundred lines of chat. */
export const DEFAULT_BUDGET_TOKENS = 1200;

/** Lessons shown at most, so a chatty learner cannot crowd out the document. */
export const MAX_INJECTED_LESSONS = 10;

/** Items per section shown inline; the full file is one `read` away. */
export const HIGHLIGHTS_PER_SECTION = 3;

export function approxTokens(text: string): number {
  if (text === "") return 0;
  return Math.ceil(text.length / 4);
}

export interface MemoryBlockInput {
  doc: MemoryDoc;
  lessons: readonly Lesson[];
  paths: Pick<MemoryPaths, "doc" | "lessons">;
  budgetTokens?: number;
}

/**
 * Build the system-prompt block. Returns "" when there is nothing to say, so an
 * empty project gets no heading and no wasted tokens.
 */
export function buildMemoryBlock(input: MemoryBlockInput): string {
  const { doc, lessons, paths } = input;
  const budget = Math.max(64, input.budgetTokens ?? DEFAULT_BUDGET_TOKENS);
  const hasDoc = docItemCount(doc) > 0;
  if (!hasDoc && lessons.length === 0) return "";

  const head = [
    "## Memory Guidance (learned from earlier sessions in this project)",
    "These notes are hints from past work, not the current state of the repo.",
    "If a note contradicts the code or the user, trust the code or the user, and say the note looks stale.",
    `Full documents: ${paths.doc} and ${paths.lessons} — read them when a hint matters.`,
  ].join("\n");

  const tail = "Write a new durable fact with the `learn` tool; update the document with `/memory sync`.";
  let block = head;
  let used = approxTokens(`${head}\n${tail}`);

  if (hasDoc) {
    const section = `\n### Project memory\n${docHighlights(doc, HIGHLIGHTS_PER_SECTION)
      .map((line) => `- ${line}`)
      .join("\n")}`;
    const cost = approxTokens(section);
    if (used + cost <= budget) {
      block += section;
      used += cost;
    }
  }

  if (lessons.length > 0) {
    const shown: string[] = [];
    for (const lesson of lessons.slice(0, MAX_INJECTED_LESSONS)) {
      const line = `- ${lesson.text}`;
      const cost = approxTokens(line);
      if (used + cost > budget) break;
      shown.push(line);
      used += cost;
    }
    if (shown.length > 0) block += `\n### Lessons\n${shown.join("\n")}`;
  }

  block += `\n${tail}`;
  return `${block}\n`;
}

/** Short footer/status label, e.g. `memory 12`. Empty when there is no memory. */
export function memoryStatusLabel(doc: MemoryDoc, lessons: readonly Lesson[]): string {
  const items = docItemCount(doc) + lessons.length;
  return items === 0 ? "" : `memory ${items}`;
}
