// Lessons: one-line durable facts the agent chose to remember.
//
// The difference from the curated document: the document is produced by the
// consolidation pipeline from many turns, slowly. A lesson is immediate and
// explicit — the agent saw a trap ("this repo needs `bun test --bail` or the
// suite hangs") and wants the next session to know it. Newest first, newest
// wins, duplicates folded, capped, and every line redacted before it is stored.
import { cleanText } from "./secret-redact";

export const LESSON_MAX_ENTRIES = 100;
export const LESSON_MAX_CHARS = 400;

export interface Lesson {
  /** Epoch ms when it was captured. */
  at: number;
  /** The lesson text (already cleaned by addLesson). */
  text: string;
}

const LINE = /^[-*]\s+(?:\[(\d{4}-\d{2}-\d{2})\]\s*)?(.*)$/;

/** Parse `learned.md`. Unknown lines are dropped: this file is machine-written. */
export function parseLessons(markdown: string | undefined): Lesson[] {
  if (!markdown) return [];
  const out: Lesson[] = [];
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = LINE.exec(line);
    if (!match) continue;
    const text = (match[2] ?? "").trim();
    if (text === "") continue;
    const at = match[1] ? Date.parse(`${match[1]}T00:00:00Z`) : 0;
    out.push({ at: Number.isFinite(at) ? at : 0, text });
  }
  return out;
}

function day(at: number): string {
  return new Date(at > 0 ? at : Date.now()).toISOString().slice(0, 10);
}

export function renderLessons(lessons: Lesson[]): string {
  if (lessons.length === 0) return "";
  const lines = ["# Lessons", ""];
  for (const lesson of lessons) lines.push(`- [${day(lesson.at)}] ${lesson.text}`);
  return `${lines.join("\n")}\n`;
}

/** Case/space-insensitive identity, ignoring a trailing full stop. */
export function lessonKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!;,]+$/, "");
}

export interface AddLessonResult {
  lessons: Lesson[];
  added: boolean;
  reason?: "empty" | "duplicate";
}

/**
 * Add a lesson to the front. A duplicate is dropped (but reported), because the
 * same lesson learned twice is not more true and would slowly push out others.
 */
export function addLesson(
  existing: Lesson[],
  raw: string,
  at: number,
  max = LESSON_MAX_ENTRIES,
): AddLessonResult {
  const text = cleanText(raw, LESSON_MAX_CHARS).replace(/\s+/g, " ").trim();
  if (text === "") return { lessons: existing, added: false, reason: "empty" };
  const key = lessonKey(text);
  if (existing.some((lesson) => lessonKey(lesson.text) === key)) {
    return { lessons: existing, added: false, reason: "duplicate" };
  }
  const next = [{ at, text }, ...existing].slice(0, Math.max(1, max));
  return { lessons: next, added: true };
}

/** Remove a lesson whose text contains the given fragment, for `/memory forget`. */
export function forgetLesson(existing: Lesson[], raw: string): { lessons: Lesson[]; removed: number } {
  const key = lessonKey(raw);
  if (key === "") return { lessons: existing, removed: 0 };
  const kept = existing.filter((lesson) => !lessonKey(lesson.text).includes(key));
  return { lessons: kept, removed: existing.length - kept.length };
}
