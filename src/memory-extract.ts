// Extraction: turn journal rows into the five memory buckets.
//
// This is the only model call in the whole memory feature, so it is built to
// fail small: a batch of at most EXTRACTION_MAX_ENTRIES turns, a hard input
// character cap, and a strict output shape. Anything unparseable, over-long or
// secret-looking is dropped instead of stored — a bad extraction must cost one
// sync, never the document.
import { extractJson } from "./agent-schema";
import { renderJournalEntry } from "./memory-journal";
import { normalizeItem, SECTION_ORDER, type IncomingMemory, type MemorySection } from "./memory-doc";
import type { JournalEntry } from "./memory-store";
import { looksLikeSecret } from "./secret-redact";

/** Turns per extraction call. More rows per call = fewer calls but a worse answer. */
export const EXTRACTION_MAX_ENTRIES = 10;
/** Hard cap on the prompt body, so one huge row cannot blow the context. */
export const EXTRACTION_MAX_INPUT_CHARS = 14_000;
/** Items accepted per section per call. */
export const EXTRACTION_ITEMS_PER_SECTION = 6;
/** Shorter items are noise ("fixed it", "ok"). */
export const MIN_ITEM_CHARS = 12;
/** Longest item kept from the model. */
export const MAX_ITEM_CHARS = 200;

export const EXTRACTION_SYSTEM_PROMPT = [
  "You extract durable project knowledge from a coding session.",
  "",
  "Keep only facts that stay true after this session and would change how a future session behaves:",
  "- decisions: a choice that was made (a library picked, a schema shape, an approach chosen) and why, when the why is short.",
  "- constraints: a rule the project or the environment imposes (must run on Node 20, no new DB tables, tests need a flag).",
  "- workflows: a repeatable sequence that worked (how to run the suite, how to regenerate a lockfile, how to publish).",
  "- failures: a bug that was found and what actually fixed it, so it is not reintroduced.",
  "- preferences: a lasting way the user wants things done (answer style, naming, formatting).",
  "",
  "Reject: one-off details, file contents, commands whose output is now stale, guesses, anything about API keys or passwords,",
  "and anything you are not sure about. Fewer, sharper items beat many vague ones.",
  "Write each item as one short sentence, no more than 200 characters, in plain English.",
  "",
  "Answer with JSON only, no prose and no code fence:",
  '{"decisions": [], "constraints": [], "workflows": [], "failures": [], "preferences": []}',
  'Use an empty array for a section with nothing durable. An all-empty answer is a valid answer.',
].join("\n");

export interface SelectLimits {
  maxEntries?: number;
  maxChars?: number;
}

/**
 * Rows that have not been folded into the document yet, oldest first, capped by
 * count and characters. The newest rows are preferred when the character cap
 * trips, because a fresh failure is more useful than a month-old one.
 */
export function selectEntries(
  journal: readonly JournalEntry[],
  lastSeq: number,
  limits: SelectLimits = {},
): JournalEntry[] {
  const maxEntries = Math.max(1, limits.maxEntries ?? EXTRACTION_MAX_ENTRIES);
  const maxChars = Math.max(500, limits.maxChars ?? EXTRACTION_MAX_INPUT_CHARS);
  // Sorted here, not trusted from the caller: a journal read from disk can be
  // in any order after a manual edit, and the prompt must read chronologically.
  const fresh = journal.filter((entry) => entry.seq > lastSeq).sort((a, b) => a.seq - b.seq);
  const chosen: JournalEntry[] = [];
  let chars = 0;
  for (let i = fresh.length - 1; i >= 0 && chosen.length < maxEntries; i -= 1) {
    const entry = fresh[i]!;
    const size = renderJournalEntry(entry).length + 2;
    if (chosen.length > 0 && chars + size > maxChars) break;
    chars += size;
    chosen.unshift(entry);
  }
  return chosen;
}

/** The user-turn prompt handed to the extraction model. */
export function buildExtractionPrompt(entries: readonly JournalEntry[], projectName: string): string {
  const rows = entries.map((entry) => renderJournalEntry(entry)).join("\n\n---\n\n");
  return [
    `Project: ${projectName}`,
    `Turns: ${entries.length}`,
    "",
    rows,
    "",
    "Return the JSON object now.",
  ].join("\n");
}

export type ExtractionResult =
  | { ok: true; memory: IncomingMemory; dropped: number }
  | { ok: false; reason: string };

function asText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  // Some models answer with objects: {"text": "..."} or {"lesson": "..."}.
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["text", "item", "lesson", "note", "value"]) {
      if (typeof record[key] === "string") return record[key] as string;
    }
  }
  return undefined;
}

/**
 * Parse the model's answer. Never throws. Every kept item is flattened,
 * clamped, filtered for secrets and deduplicated, so the document cannot be
 * polluted by a badly behaved model.
 */
export function parseExtraction(raw: string): ExtractionResult {
  if (!raw || raw.trim() === "") return { ok: false, reason: "empty answer" };
  const parsed = extractJson(raw);
  if (parsed.error !== undefined || parsed.value === undefined) {
    return { ok: false, reason: parsed.error ?? "no JSON in the answer" };
  }
  const value = parsed.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "answer was not a JSON object" };
  }
  const record = value as Record<string, unknown>;
  const memory: IncomingMemory = {};
  let dropped = 0;
  let recognized = false;
  for (const section of SECTION_ORDER) {
    const sectionValue = record[section];
    if (sectionValue === undefined) continue;
    recognized = true;
    const list = Array.isArray(sectionValue) ? sectionValue : [sectionValue];
    const items: string[] = [];
    const seen = new Set<string>();
    for (const entry of list) {
      const text = asText(entry);
      if (text === undefined) {
        dropped += 1;
        continue;
      }
      const item = normalizeItem(text).slice(0, MAX_ITEM_CHARS);
      if (item.length < MIN_ITEM_CHARS) {
        dropped += 1;
        continue;
      }
      if (looksLikeSecret(item)) {
        dropped += 1;
        continue;
      }
      const key = item.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
      if (items.length >= EXTRACTION_ITEMS_PER_SECTION) break;
    }
    if (items.length > 0) (memory as Record<MemorySection, string[]>)[section] = items;
  }
  if (!recognized) {
    // `{}` is a legitimate "nothing durable in these turns". An object with keys
    // we do not know is a model mistake, and is reported instead of stored.
    if (Object.keys(record).length === 0) return { ok: true, memory, dropped };
    return { ok: false, reason: "answer had none of the five sections" };
  }
  return { ok: true, memory, dropped };
}

/** True when the extraction produced nothing worth writing. */
export function isEmptyExtraction(memory: IncomingMemory): boolean {
  return SECTION_ORDER.every((section) => (memory[section]?.length ?? 0) === 0);
}
