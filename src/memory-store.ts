// File layer for memory: atomic writes, one-file-at-a-time state, a lock, and
// the journal ring buffer.
//
// Robustness rules this file exists to enforce:
// 1. A crash mid-write must never leave a half-written MEMORY.md. Every write
//    goes to `<file>.tmp` and is renamed into place (rename is atomic on one
//    filesystem). A reader therefore sees the old document or the new one.
// 2. A missing or corrupt state/journal must not lose the document. Bad JSON
//    is treated as "no data yet", and the next successful sync rewrites it.
// 3. Only one consolidator at a time. The lock carries the pid and a start
//    time; a lock older than LOCK_STALE_MS is taken over, because a killed
//    process cannot release it.
// 4. Reading memory never throws: a permission error means "no memory", which
//    degrades to normal behaviour instead of breaking the session.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { redactSecrets } from "./secret-redact";
import type { MemoryPaths } from "./memory-paths";

/** Bumped when the on-disk shape changes; an older state file is reset, not migrated. */
export const STATE_VERSION = 1;
/** Turns kept in the journal before the oldest are dropped. */
export const JOURNAL_MAX_ENTRIES = 400;
/** Hard cap on journal bytes, so a huge prompt cannot bloat the agent dir. */
export const JOURNAL_MAX_CHARS = 240_000;
/** A lock older than this is considered abandoned (a killed process). */
export const LOCK_STALE_MS = 180_000;
/** One turn as the consolidator sees it. Redacted and clamped before it is written. */
export interface JournalEntry {
  /** Monotonic per-project counter; `state.lastSeq` records how far we consumed. */
  seq: number;
  /** Epoch ms. */
  at: number;
  /** The user's prompt for the turn (clamped, redacted). */
  prompt: string;
  /** The assistant's final text for the turn (clamped, redacted). */
  answer: string;
  /** Tool names used in the turn, deduped. */
  tools: string[];
  /** Files the turn touched, repo-relative, deduped. */
  files: string[];
  /** "error" when the turn ended in a failure, so failures can be remembered too. */
  outcome: "ok" | "error";
}

export interface MemoryState {
  version: number;
  /** Epoch ms of the last successful consolidation. */
  lastSyncAt: number;
  /** Highest journal seq that has been folded into the document. */
  lastSeq: number;
  /** Successful consolidations, for `/memory stats`. */
  syncs: number;
  /** Turns appended, for `/memory stats`. */
  turns: number;
  /** Approximate tokens injected last time, so the budget is visible. */
  injectedTokens: number;
}

export const EMPTY_STATE: MemoryState = {
  version: STATE_VERSION,
  lastSyncAt: 0,
  lastSeq: 0,
  syncs: 0,
  turns: 0,
  injectedTokens: 0,
};

/** Read a text file, or undefined when it does not exist / cannot be read. */
export function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Write a file by rename, creating parent directories. Returns false instead
 * of throwing: a read-only home directory must not break a session.
 */
export function writeAtomic(path: string, contents: string): boolean {
  const tmp = `${path}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, contents, "utf8");
    renameSync(tmp, path);
    return true;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Nothing to clean up.
    }
    return false;
  }
}

/** True when the file exists and has content. */
export function hasContents(path: string): boolean {
  const text = readText(path);
  return text !== undefined && text.trim() !== "";
}

function parseJson<T>(text: string | undefined): T | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** Positive finite number, or the fallback. Keeps a corrupt state from poisoning maths. */
function positive(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Read the state file. A version mismatch, missing file or broken JSON all
 * resolve to EMPTY_STATE rather than an error: the counters are a cache, not
 * the memory itself.
 */
export function readState(paths: Pick<MemoryPaths, "state">): MemoryState {
  const raw = parseJson<Record<string, unknown>>(readText(paths.state));
  if (!raw || positive(raw.version, 0) !== STATE_VERSION) return { ...EMPTY_STATE };
  return {
    version: STATE_VERSION,
    lastSyncAt: positive(raw.lastSyncAt, 0),
    lastSeq: positive(raw.lastSeq, 0),
    syncs: positive(raw.syncs, 0),
    turns: positive(raw.turns, 0),
    injectedTokens: positive(raw.injectedTokens, 0),
  };
}

export function writeState(paths: Pick<MemoryPaths, "state">, state: MemoryState): boolean {
  return writeAtomic(paths.state, `${JSON.stringify({ ...state, version: STATE_VERSION }, null, 2)}\n`);
}

/**
 * Parse the journal. Lines that are not valid objects are skipped, not fatal:
 * a torn last line after a crash must cost at most one turn.
 */
export function parseJournal(text: string | undefined): JournalEntry[] {
  if (!text) return [];
  const out: JournalEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const raw = parseJson<Record<string, unknown>>(line);
    if (!raw || typeof raw !== "object") continue;
    const prompt = typeof raw.prompt === "string" ? raw.prompt : "";
    const answer = typeof raw.answer === "string" ? raw.answer : "";
    if (prompt === "" && answer === "") continue;
    out.push({
      seq: positive(raw.seq, out.length + 1),
      at: positive(raw.at, 0),
      prompt,
      answer,
      tools: arrayOfStrings(raw.tools),
      files: arrayOfStrings(raw.files),
      outcome: raw.outcome === "error" ? "error" : "ok",
    });
  }
  return sortBySeq(out);
}

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item !== "");
}

/** Stable, ascending order by seq, so the pipeline always reads oldest first. */
export function sortBySeq(entries: JournalEntry[]): JournalEntry[] {
  return [...entries].sort((a, b) => a.seq - b.seq);
}

export function readJournal(paths: Pick<MemoryPaths, "journal">): JournalEntry[] {
  return parseJournal(readText(paths.journal));
}

export function serializeJournal(entries: JournalEntry[]): string {
  if (entries.length === 0) return "";
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

/**
 * Keep the newest entries while staying under both caps. Trimming by whole
 * entries (never by line) means a reader never sees half a turn.
 */
export function trimJournal(
  entries: JournalEntry[],
  maxEntries = JOURNAL_MAX_ENTRIES,
  maxChars = JOURNAL_MAX_CHARS,
): JournalEntry[] {
  const sorted = sortBySeq(entries);
  const byCount = sorted.slice(Math.max(0, sorted.length - Math.max(0, maxEntries)));
  let chars = 0;
  const kept: JournalEntry[] = [];
  for (let i = byCount.length - 1; i >= 0; i -= 1) {
    const entry = byCount[i]!;
    const size = JSON.stringify(entry).length + 1;
    if (kept.length > 0 && chars + size > maxChars) break;
    chars += size;
    kept.unshift(entry);
  }
  return kept;
}

/**
 * Append one turn and trim the ring. Returns the stored entry (seq assigned) or
 * undefined when the write failed. The written copy is redacted again, so a
 * caller that forgot cannot store a secret.
 */
export function appendJournal(
  paths: Pick<MemoryPaths, "journal"> & Partial<Pick<MemoryPaths, "state">>,
  entry: Omit<JournalEntry, "seq">,
  limits: { maxEntries?: number; maxChars?: number } = {},
): JournalEntry | undefined {
  const existing = readJournal(paths);
  // The floor comes from the state file, not only from the journal: consumed
  // rows are deleted, so a fresh append after a sync would otherwise reuse seq 1
  // and the pipeline would think it had already read them.
  const floor =
    typeof paths.state === "string" ? readState({ state: paths.state }).lastSeq : 0;
  const nextSeq = Math.max(existing.reduce((max, item) => Math.max(max, item.seq), 0), floor) + 1;
  const stored: JournalEntry = {
    seq: nextSeq,
    at: entry.at,
    prompt: redactSecrets(entry.prompt),
    answer: redactSecrets(entry.answer),
    tools: entry.tools.map((tool) => redactSecrets(tool)).slice(0, 24),
    files: entry.files.map((file) => redactSecrets(file)).slice(0, 32),
    outcome: entry.outcome,
  };
  const trimmed = trimJournal([...existing, stored], limits.maxEntries, limits.maxChars);
  if (!writeAtomic(paths.journal, serializeJournal(trimmed))) return undefined;
  return stored;
}

/** Replace the journal wholesale (used after a successful sync to drop consumed turns). */
export function rewriteJournal(paths: Pick<MemoryPaths, "journal">, entries: JournalEntry[]): boolean {
  return writeAtomic(paths.journal, serializeJournal(trimJournal(entries)));
}

export interface LockOptions {
  now?: number;
  pid?: number;
  staleMs?: number;
}

/**
 * Take the consolidation lock. Returns true when this process may run. A lock
 * from a dead pid or an old timestamp is taken over, so a crashed sync does not
 * block memory forever.
 */
export function acquireLock(paths: Pick<MemoryPaths, "root" | "lock">, options: LockOptions = {}): boolean {
  const now = options.now ?? Date.now();
  const pid = options.pid ?? process.pid;
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  try {
    mkdirSync(paths.root, { recursive: true });
    const handle = openSync(paths.lock, "wx");
    writeSync(handle, JSON.stringify({ pid, at: now }));
    closeSync(handle);
    return true;
  } catch {
    // Something is there. It may be stale.
  }
  const holder = parseJson<{ pid?: number; at?: number }>(readText(paths.lock));
  const age = now - positive(holder?.at, 0);
  const holderPid = positive(holder?.pid, 0);
  const holderAlive = holderPid > 0 && pidAlive(holderPid);
  if (age > staleMs || (holderPid > 0 && !holderAlive)) {
    return writeAtomic(paths.lock, JSON.stringify({ pid, at: now }));
  }
  return false;
}

/** Release the lock, but only if this process still owns it. */
export function releaseLock(paths: Pick<MemoryPaths, "lock">, pid: number = process.pid): boolean {
  const holder = parseJson<{ pid?: number }>(readText(paths.lock));
  if (holder && positive(holder.pid, 0) !== pid) return false;
  try {
    rmSync(paths.lock, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** True when the pid is alive (EPERM counts as alive: the process exists). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True when a memory folder exists at all, so injection can skip the work. */
export function memoryExists(paths: Pick<MemoryPaths, "root">): boolean {
  return existsSync(paths.root);
}
