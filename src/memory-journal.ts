// Turning one finished turn into a journal row.
//
// This is the pipeline's input, so it is deliberately narrow: the prompt, the
// final answer, the tools used and the files touched — not the whole transcript
// with file contents. A memory built from full tool output would be huge, go
// stale the moment the file changes, and be full of things nobody should store.
//
// Every field is redacted and clamped here, before it ever reaches the file.
import { cleanText, redactSecrets } from "./secret-redact";
import type { JournalEntry } from "./memory-store";

export const PROMPT_MAX_CHARS = 900;
export const ANSWER_MAX_CHARS = 1200;
export const MAX_TOOLS = 12;
export const MAX_FILES = 16;

export interface TurnSnapshot {
  prompt: string;
  answer: string;
  tools?: readonly string[];
  files?: readonly string[];
  outcome?: "ok" | "error";
  at: number;
}

/** Keep the tail of a long text: the end of an answer usually holds the result. */
export function tailClamp(text: string, maxChars: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  return `…${clean.slice(clean.length - (maxChars - 1)).trimStart()}`;
}

/** Repo-relative, forward-slash, deduped file list. Paths outside cwd are dropped. */
export function normalizeFiles(files: readonly string[], cwd: string, max = MAX_FILES): string[] {
  const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of files) {
    if (typeof raw !== "string" || raw.trim() === "") continue;
    let file = raw.replace(/\\/g, "/").trim();
    if (file.startsWith(`${root}/`)) file = file.slice(root.length + 1);
    if (file.startsWith("/") || /^[a-z]+:\/\//i.test(file)) continue;
    if (file.startsWith("../")) continue;
    const key = file.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file);
    if (out.length >= max) break;
  }
  return out;
}

/** Deduped tool names, order preserved. */
export function normalizeTools(tools: readonly string[], max = MAX_TOOLS): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    const name = typeof tool === "string" ? tool.trim() : "";
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Build the row. Returns undefined when the turn carries nothing worth
 * remembering (an empty prompt with an empty answer), so the journal does not
 * fill with gaps.
 */
export function buildJournalEntry(
  snapshot: TurnSnapshot,
  cwd: string,
): Omit<JournalEntry, "seq"> | undefined {
  const prompt = cleanText(snapshot.prompt, PROMPT_MAX_CHARS).trim();
  // Redact first, then keep the tail: the end of an answer holds the result.
  const answer = tailClamp(redactSecrets(snapshot.answer), ANSWER_MAX_CHARS);
  if (prompt === "" && answer === "") return undefined;
  return {
    at: snapshot.at,
    prompt,
    answer,
    tools: normalizeTools(snapshot.tools ?? []),
    files: normalizeFiles(snapshot.files ?? [], cwd),
    outcome: snapshot.outcome === "error" ? "error" : "ok",
  };
}

/** One journal row as plain text for the extraction prompt. */
export function renderJournalEntry(entry: JournalEntry): string {
  const stamp = new Date(entry.at > 0 ? entry.at : Date.now()).toISOString().slice(0, 16).replace("T", " ");
  const parts = [`#${entry.seq} ${stamp}`];
  if (entry.outcome === "error") parts.push("(turn failed)");
  if (entry.files.length > 0) parts.push(`files: ${entry.files.join(", ")}`);
  if (entry.tools.length > 0) parts.push(`tools: ${entry.tools.join(", ")}`);
  if (entry.prompt !== "") parts.push(`user: ${entry.prompt}`);
  if (entry.answer !== "") parts.push(`agent: ${entry.answer}`);
  return parts.join("\n");
}
