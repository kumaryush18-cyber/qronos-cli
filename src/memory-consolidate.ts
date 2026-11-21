// Consolidation: the write path of memory.
//
// The promise this file keeps: a sync either improves the document or changes
// nothing. Every failure mode has a defined answer, and none of them erase
// knowledge:
//
//   no new turns          -> nothing to do, no model call
//   another sync running  -> skipped, the other one wins
//   model call fails      -> the document and journal stay exactly as they were
//   answer unparseable    -> same
//   answer has no items   -> journal rows are still marked consumed (they taught
//                            us nothing durable) so they cannot be retried forever
//   write fails           -> state is not advanced, so the next sync retries
//
// One model call per sync. The merge itself is local and deterministic
// (memory-doc.ts), which is why a bad merge is a unit test and not a mystery.
import { parseDoc, mergeDoc, renderDoc, docItemCount, type MemoryDoc } from "./memory-doc";
import {
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionPrompt,
  isEmptyExtraction,
  parseExtraction,
  selectEntries,
  type SelectLimits,
} from "./memory-extract";
import type { MemoryPaths } from "./memory-paths";
import {
  acquireLock,
  readJournal,
  readState,
  readText,
  releaseLock,
  rewriteJournal,
  writeAtomic,
  writeState,
  type JournalEntry,
  type MemoryState,
} from "./memory-store";

/** Called with (systemPrompt, userPrompt) and must return the model's raw text. */
export type ExtractionModel = (systemPrompt: string, userPrompt: string) => Promise<string>;

export type ConsolidateStatus =
  | "synced"
  | "nothing-new"
  | "busy"
  | "model-failed"
  | "bad-answer"
  | "write-failed";

export interface ConsolidateResult {
  status: ConsolidateStatus;
  /** Turns consumed by this run. */
  consumed: number;
  /** Items added to the document. */
  added: number;
  /** Total items in the document after the run. */
  total: number;
  /** Human-readable reason for a non-success status. */
  reason?: string;
}

export interface ConsolidateOptions {
  paths: MemoryPaths;
  /** The model call. Rejecting is fine: it maps to "model-failed". */
  extract: ExtractionModel;
  /** Project name for the prompt. */
  projectName?: string;
  /** Injected in tests. */
  now?: () => number;
  /** Batch limits, mostly for tests. */
  limits?: SelectLimits;
  /** Set false in tests to skip the lock file. */
  lock?: boolean;
}

const NO_OP: ConsolidateResult = { status: "nothing-new", consumed: 0, added: 0, total: 0 };

/** Count items in an incoming memory object. */
function countIncoming(memory: Record<string, string[] | undefined>): number {
  return Object.values(memory).reduce((sum, list) => sum + (list?.length ?? 0), 0);
}

/**
 * Run one consolidation pass. Never throws: every error becomes a status, so
 * the caller can report it without a try/catch at the call site.
 */
export async function consolidate(options: ConsolidateOptions): Promise<ConsolidateResult> {
  const now = options.now ?? (() => Date.now());
  const paths = options.paths;
  const useLock = options.lock !== false;

  let locked = false;
  if (useLock) {
    locked = acquireLock(paths, { now: now() });
    if (!locked) return { ...NO_OP, status: "busy" };
  }

  try {
    const state = readState(paths);
    const journal = readJournal(paths);
    const entries = selectEntries(journal, state.lastSeq, options.limits);
    if (entries.length === 0) {
      return { ...NO_OP, status: "nothing-new", total: docItemCount(readDocDoc(paths)) };
    }

    const doc = readDocDoc(paths);
    const prompt = buildExtractionPrompt(entries, options.projectName ?? "this project");

    // One retry, only when the answer itself was unusable. An empty answer is
    // the one failure a real model produces by accident (seen live with
    // glm-5.3-flash: completeSimple resolved with no content), and re-asking
    // once costs little and saves a whole sync cycle. Model *errors* are not
    // retried here: retry.ts already owns that policy.
    let parsed = parseExtraction("");
    let lastReason = "no attempt";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let answer: string;
      try {
        answer = await options.extract(EXTRACTION_SYSTEM_PROMPT, prompt);
      } catch (error) {
        return {
          status: "model-failed",
          consumed: 0,
          added: 0,
          total: docItemCount(doc),
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      parsed = parseExtraction(answer);
      if (parsed.ok) break;
      lastReason = parsed.reason;
    }

    if (!parsed.ok) {
      return {
        status: "bad-answer",
        consumed: 0,
        added: 0,
        total: docItemCount(doc),
        reason: lastReason,
      };
    }

    const at = now();
    const empty = isEmptyExtraction(parsed.memory);
    const merged = empty ? doc : mergeDoc(doc, parsed.memory);
    const added = Math.max(0, docItemCount(merged) - docItemCount(doc));

    if (!empty) {
      if (!writeAtomic(paths.doc, renderDoc(merged, at))) {
        return { status: "write-failed", consumed: 0, added: 0, total: docItemCount(doc) };
      }
    }

    // Consume the rows we looked at. Dropped even when the answer was empty:
    // re-asking the same model about the same turns rarely changes its mind,
    // and it would block new turns from being read.
    const consumedSeq = entries[entries.length - 1]!.seq;
    const remaining = journal.filter((entry) => entry.seq > consumedSeq);
    rewriteJournal(paths, remaining);

    const nextState: MemoryState = {
      ...state,
      lastSeq: Math.max(state.lastSeq, consumedSeq),
      lastSyncAt: at,
      syncs: state.syncs + 1,
    };
    writeState(paths, nextState);

    return { status: "synced", consumed: entries.length, added, total: docItemCount(merged) };
  } catch (error) {
    // A surprise (permission change, full disk) must not take the session down.
    return {
      status: "write-failed",
      consumed: 0,
      added: 0,
      total: 0,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (locked) releaseLock(paths);
  }
}

/**
 * Read MEMORY.md. A missing file is an empty document, not an error: the first
 * sync of a project starts from nothing.
 */
function readDocDoc(paths: MemoryPaths): MemoryDoc {
  return parseDoc(readText(paths.doc));
}

/** True when there is enough new material to be worth a model call. */
export function shouldSync(
  state: MemoryState,
  journal: readonly JournalEntry[],
  options: { minTurns?: number; minIntervalMs?: number; now?: number } = {},
): boolean {
  const minTurns = Math.max(1, options.minTurns ?? 6);
  const minIntervalMs = Math.max(0, options.minIntervalMs ?? 30 * 60_000);
  const now = options.now ?? Date.now();
  const fresh = journal.filter((entry) => entry.seq > state.lastSeq).length;
  if (fresh < minTurns) return false;
  // A project that has never synced has no "last sync" to wait for.
  if (state.lastSyncAt === 0) return true;
  return now - state.lastSyncAt >= minIntervalMs;
}
