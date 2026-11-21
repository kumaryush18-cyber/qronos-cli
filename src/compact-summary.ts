// The compaction summary: what we ask for, and what we refuse to store.
//
// Two rules shape this file.
//
// 1. A summary is read back on every later prompt, so it must be short enough
//    to be worth having and structured enough to be scanned.
// 2. A half-written summary is worse than no summary. If the model hits its
//    token cap, forgets the headings, or answers with something else, we say so
//    and let the caller fall back to the built-in path.
import { clampMiddle, firstLine, renderEvidence, type CompactEvidence } from "./compact-digest";
import { redactSecrets } from "./secret-redact";

export const SUMMARY_SYSTEM_PROMPT = `You write a context checkpoint for another agent that will continue this work.

Rules:
- Report only what the conversation shows. Never invent a file, a command, a decision or a result.
- Keep exact names: file paths, function names, commands, error text.
- Prefer short bullets over paragraphs. No code fences, no greetings, no apology.
- If something is unknown, write "(unknown)" instead of guessing.
- Use these headings, in this order, and no others:

## Goal
One or two lines: what the user wants, in their words.

## Constraints & Preferences
- Rules the user stated, or "(none)".

## Progress
- [x] done
- [ ] in progress / not started

## Key Decisions
- **decision**: why

## Errors & Open Questions
- what failed, or what is still unclear, or "(none)"

## Next Steps
1. the next concrete action

## Critical Context
- anything a fresh agent could not guess`;

export const SUMMARY_HEADINGS = [
  "## Goal",
  "## Constraints & Preferences",
  "## Progress",
  "## Key Decisions",
  "## Errors & Open Questions",
  "## Next Steps",
  "## Critical Context",
] as const;

/** How many of the headings must appear before we trust the answer. */
export const MIN_HEADINGS = 4;

/** A summary longer than this is not a checkpoint, it is a second transcript. */
export const MAX_SUMMARY_CHARS = 12_000;

/** The prompt input is capped too: compaction must stay cheaper than the history. */
export const MAX_PROMPT_CHARS = 60_000;

export interface BuildPromptInput {
  transcript: string;
  evidence: CompactEvidence;
  previousSummary?: string;
  customInstructions?: string;
  isSplitTurn?: boolean;
}

export function buildCompactPrompt(input: BuildPromptInput): string {
  const parts: string[] = [];
  parts.push(
    input.previousSummary
      ? "Update the existing checkpoint below with the newer conversation. Keep every fact from the old checkpoint that is still true."
      : "Write a new checkpoint from the conversation below.",
  );
  if (input.previousSummary) {
    parts.push(`<previous-checkpoint>\n${clampMiddle(input.previousSummary, 6000, 1000)}\n</previous-checkpoint>`);
  }
  const evidence = renderEvidence(input.evidence);
  if (evidence) parts.push(`<recorded-facts>\n${evidence}\n</recorded-facts>`);
  if (input.isSplitTurn) {
    parts.push("The cut falls in the middle of a turn. The first lines below belong to a turn that continues after the checkpoint.");
  }
  if (input.customInstructions?.trim()) {
    parts.push(`The user asked the summary to focus on: ${firstLine(input.customInstructions, 500)}`);
  }
  parts.push(`<conversation>\n${input.transcript}\n</conversation>`);

  const text = parts.join("\n\n");
  return text.length > MAX_PROMPT_CHARS ? `${text.slice(0, MAX_PROMPT_CHARS)}\n… [truncated]` : text;
}

export interface SummaryOk {
  ok: true;
  summary: string;
}
export interface SummaryBad {
  ok: false;
  reason: string;
}
export type SummaryRead = SummaryOk | SummaryBad;

/** Count the headings that are actually there, not the ones we hoped for. */
export function countingHeadings(summary: string): number {
  return SUMMARY_HEADINGS.filter((heading) => summary.includes(heading)).length;
}

/**
 * Accept a model answer as a summary, or explain why not.
 *
 * Redaction runs here, before the text is stored, because a summary is fed back
 * to the provider on every following prompt: a key pasted into the chat must not
 * be re-sent forever inside a checkpoint.
 */
export function readSummary(answer: string, options: { maxChars?: number } = {}): SummaryRead {
  const maxChars = options.maxChars ?? MAX_SUMMARY_CHARS;
  let text = answer.replace(/\r\n/g, "\n").trim();
  if (text === "") return { ok: false, reason: "empty answer" };

  // Some models wrap the whole thing in a fence; unwrap carefully.
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(text);
  if (fenced?.[1]) text = fenced[1].trim();

  if (countingHeadings(text) < MIN_HEADINGS) {
    return { ok: false, reason: `only ${countingHeadings(text)} of ${SUMMARY_HEADINGS.length} headings` };
  }
  if (text.length < 80) return { ok: false, reason: "answer too short to be a checkpoint" };

  const redacted = redactSecrets(text).trim();
  if (redacted.length > maxChars) {
    return { ok: true, summary: `${redacted.slice(0, maxChars)}\n… [summary truncated]` };
  }
  return { ok: true, summary: redacted };
}

/** Append the recorded facts when a model dropped them. Idempotent. */
export function withEvidence(summary: string, evidence: CompactEvidence): string {
  const block = renderEvidence(evidence);
  if (!block) return summary;
  if (summary.includes(block)) return summary;
  return `${summary.trimEnd()}\n\n${block}`;
}

/** "compacted 48k → 3.1k tokens". Short, honest, no fake precision. */
export function compactStatusLine(tokensBefore: number, summaryChars: number): string {
  const after = Math.max(1, Math.round(summaryChars / 4));
  const before = tokensBefore >= 1000 ? `${Math.round(tokensBefore / 1000)}k` : String(tokensBefore);
  const tail = after >= 1000 ? `${(after / 1000).toFixed(1)}k` : String(after);
  return `compacted ${before} → ${tail} tokens`;
}

/** Rough token count, matching the memory module's estimate. */
export function approxTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}
