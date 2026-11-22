// The journal: what a workflow run actually did, written as it happens.
//
// Two reasons this file exists:
//   1. Resume. You cannot freeze a JavaScript function half way, so a resumed
//      run replays the script and gets recorded answers from here instead of
//      calling the model again.
//   2. Trust. After a crash you can read what ran, in order, without guessing.
//
// It is append-only JSONL: one line per event. A crash can only ever damage the
// last line, and the reader skips a line it cannot parse instead of losing the
// whole file. Agent output is redacted before it is written, because a journal
// outlives the session that made it.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets } from "./secret-redact";
import type { WorkflowUsage } from "./workflow-types";

/** How much of one agent's answer is kept. Enough to replay, not enough to leak. */
export const JOURNAL_TEXT_LIMIT = 4000;
/** Runs older than this are removed on prune, in days. */
export const JOURNAL_KEEP_DAYS = 7;
/** How many runs to keep regardless of age. */
export const JOURNAL_KEEP_RUNS = 20;
/** Absolute ceiling, so the folder cannot grow without limit. */
export const JOURNAL_HARD_CAP = 200;

export type JournalEntry =
  | {
      kind: "run_start";
      at: number;
      id: string;
      name: string;
      script: string;
      maxAgents: number;
      wallClockMs: number;
      /** Work passed in as `args`, when it can survive a JSON round trip. */
      args?: unknown;
      /** Set when this run replays the journal of an earlier one. */
      resumedFrom?: string;
    }
  | { kind: "phase"; at: number; name: string }
  | {
      kind: "agent_start";
      at: number;
      id: string;
      label: string;
      phase?: string;
      /** Redacted, capped task text: what the agent was actually asked. */
      prompt?: string;
      model?: string;
    }
  | {
      kind: "agent_end";
      at: number;
      id: string;
      ok: boolean;
      error?: string;
      usage?: WorkflowUsage;
      durationMs: number;
      /** Redacted answer, so a replay can return it without a model call. */
      text?: string;
      /** Redacted structured value, when a schema was used. */
      data?: unknown;
      /** Stable call name (scope plus position). A replay matches on this. */
      key?: string;
      scope?: string;
      index?: number;
      /** Hash of the request, so a changed prompt replays nothing after it. */
      fingerprint?: string;
      /** True when this answer came from the journal rather than a model call. */
      replayed?: boolean;
      /** Copied from the start line, so one record holds the task as well. */
      prompt?: string;
    }
  | { kind: "log"; at: number; message: string }
  | {
      kind: "run_end";
      at: number;
      ok: boolean;
      error?: string;
      tokens: WorkflowUsage;
      durationMs: number;
      replayed?: number;
    };

export function journalDir(agentDir: string): string {
  return join(agentDir, "workflow-runs");
}

export function journalPath(agentDir: string, runId: string): string {
  return join(journalDir(agentDir), `${runId}.jsonl`);
}

/** Trim a string to the stored limit without splitting a multi-byte character. */
function capText(text: string, limit = JOURNAL_TEXT_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… (${text.length - limit} more characters were not stored)`;
}

export class WorkflowJournal {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /**
   * Append one entry.
   *
   * Never throws: a workflow must not fail because a disk was full. The caller
   * gets `false` so a test can see it, and the run carries on without a journal.
   */
  append(entry: JournalEntry): boolean {
    try {
      mkdirSync(journalDir(this.dirOf()), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
      return true;
    } catch {
      return false;
    }
  }

  /** Write an agent result with the answer already redacted and capped. */
  appendAgentEnd(
    entry: Omit<Extract<JournalEntry, { kind: "agent_end" }>, "text" | "data"> & {
      text?: string;
      data?: unknown;
    },
  ): boolean {
    const redactedText = typeof entry.text === "string" ? capText(redactSecrets(entry.text)) : undefined;
    // A structured value is redacted as text, then parsed back: redaction is a
    // string operation, so this is the only honest way to keep it valid JSON.
    let redactedData: unknown;
    if (entry.data !== undefined) {
      try {
        const text = JSON.stringify(entry.data);
        redactedData = text === undefined ? undefined : JSON.parse(redactSecrets(text));
      } catch {
        // A value that cannot survive a JSON round trip is not stored.
        redactedData = undefined;
      }
    }
    return this.append({ ...entry, text: redactedText, data: redactedData });
  }

  /** Read every entry that can be parsed. A torn line is skipped, not fatal. */
  read(): JournalEntry[] {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return [];
    }
    const entries: JournalEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        const parsed = JSON.parse(trimmed) as JournalEntry;
        if (parsed && typeof parsed === "object" && typeof parsed.kind === "string") entries.push(parsed);
      } catch {
        // A half-written last line from a crash: skip it and keep going.
      }
    }
    return entries;
  }

  /** The recorded answers, keyed by agent call id, for a replay. */
  recordedAnswers(): Map<string, { ok: boolean; text: string; data?: unknown; usage?: WorkflowUsage; error?: string }> {
    const answers = new Map<string, { ok: boolean; text: string; data?: unknown; usage?: WorkflowUsage; error?: string }>();
    for (const entry of this.read()) {
      if (entry.kind !== "agent_end") continue;
      answers.set(entry.key ?? entry.id, {
        ok: entry.ok,
        text: entry.text ?? "",
        data: entry.data,
        usage: entry.usage,
        error: entry.error,
      });
    }
    return answers;
  }

  /** The `run_start` entry, which carries the script a resume needs. */
  runStart(): Extract<JournalEntry, { kind: "run_start" }> | undefined {
    const first = this.read()[0];
    return first?.kind === "run_start" ? first : undefined;
  }

  /** True when the run reached its end entry. */
  finished(): boolean {
    return this.read().some((entry) => entry.kind === "run_end");
  }

  private dirOf(): string {
    const parts = this.path.split(/[\\/]/);
    parts.pop();
    return parts.join("/") || ".";
  }
}

/** Remove journals older than the keep window, and everything past the keep count. */
export function pruneJournals(dir: string, now = Date.now()): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return 0;
  }
  const files = names
    .map((name) => {
      const full = join(dir, name);
      try {
        return { full, modified: statSync(full).mtimeMs };
      } catch {
        return undefined;
      }
    })
    .filter((file): file is { full: string; modified: number } => file !== undefined)
    .sort((a, b) => b.modified - a.modified);

  const tooOld = JOURNAL_KEEP_DAYS * 24 * 60 * 60 * 1000;
  files.forEach((file, index) => {
    const old = now - file.modified > tooOld;
    // Two rules, both needed: an old file is removed only once it falls out of
    // the newest runs (so a week of silence does not erase a useful record), and
    // a hard cap removes the excess even when it is all fresh.
    const remove = (old && index >= JOURNAL_KEEP_RUNS) || index >= JOURNAL_HARD_CAP;
    if (!remove) return;
    try {
      rmSync(file.full, { force: true });
      removed += 1;
    } catch {
      // A file we cannot remove must not stop the others.
    }
  });
  return removed;
}

export function journalExists(agentDir: string, runId: string): boolean {
  return existsSync(journalPath(agentDir, runId));
}

/** What `/workflows saved` shows: a run on disk that can be resumed. */
export interface SavedRun {
  runId: string;
  name: string;
  startedAt: number;
  agents: number;
  /** True when the run already reached its end entry. */
  finished: boolean;
  ok?: boolean;
  tokens?: WorkflowUsage;
  /** Set when this record is itself a resume of an earlier run. */
  resumedFrom?: string;
}

/**
 * Every run on disk, newest first.
 *
 * A run with no `run_end` is an interrupted run. A run with a `run_end` that
 * failed is also worth showing: it can be resumed to try the failed part again.
 */
export function listSavedRuns(dir: string): SavedRun[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const runs: SavedRun[] = [];
  for (const name of names) {
    const journal = new WorkflowJournal(join(dir, name));
    const entries = journal.read();
    const start = entries[0]?.kind === "run_start" ? entries[0] : undefined;
    if (!start) continue;
    const end = [...entries].reverse().find((entry) => entry.kind === "run_end");
    runs.push({
      runId: start.id || name.replace(/\.jsonl$/, ""),
      name: start.name,
      startedAt: start.at,
      agents: entries.filter((entry) => entry.kind === "agent_end" && !entry.replayed).length,
      finished: end !== undefined,
      ok: end?.kind === "run_end" ? end.ok : undefined,
      tokens: end?.kind === "run_end" ? end.tokens : undefined,
      resumedFrom: start.resumedFrom,
    });
  }
  return runs.sort((a, b) => b.startedAt - a.startedAt);
}
