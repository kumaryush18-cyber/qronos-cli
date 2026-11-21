// Replay: the part that makes a resumed run cheap.
//
// A JavaScript function cannot be frozen half way. You cannot take a script that
// was waiting on agent() number 7, save it, and load it again. What you CAN do is
// run the script again from the top and give back the answers it already received.
// The script then walks the same path, and only the calls that never finished (or
// that changed) reach the model.
//
// Three rules, and they are Claude Code's rules:
//
//   1. A call is matched by POSITION, not by time: its scope plus the number of
//      the call inside that scope. Two runs of one script ask for the same
//      positions in the same order.
//   2. A saved answer is used only when the request is unchanged (same prompt,
//      same agent type, same model). A changed request runs live.
//   3. The FIRST changed or failed call ends the saved region for that scope:
//      everything after it runs live too. A script that shifted one prompt earlier
//      has shifted everything after it, and replaying those answers would mix two
//      different runs into one result.
//
// A recorded FAILURE is not replayed. Redoing a failed step is the whole point of
// resuming, and Claude Code does the same.
import { createHash } from "node:crypto";
import type { JournalEntry } from "./workflow-journal";
import type { WorkflowAgentResult, WorkflowUsage } from "./workflow-types";

/** What one finished agent left behind, in the shape a replay needs. */
export interface ReplayRecord {
  key: string;
  scope: string;
  index: number;
  /** Hash of the request. A different hash means "this call changed". */
  fingerprint: string;
  ok: boolean;
  text: string;
  data?: unknown;
  error?: string;
  usage?: WorkflowUsage;
}

/** The parts of an agent request that decide whether an answer is still valid. */
export interface ReplayRequestShape {
  prompt: string;
  agent?: string;
  model?: string;
}

export type ReplayMiss = "not-recorded" | "changed" | "failed" | "after-changed";

export type ReplayLookup = { hit: true; result: WorkflowAgentResult } | { hit: false; reason: ReplayMiss };

/** The stable name of one agent call. `""` is the top-level script's scope. */
export function agentKey(scope: string, index: number): string {
  return `${scope}#${index}`;
}

/** A short, stable hash of the request; not a security boundary, just identity. */
export function fingerprintOf(shape: ReplayRequestShape): string {
  const payload = JSON.stringify([shape.prompt, shape.agent ?? "", shape.model ?? ""]);
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

/** Build replay records from journal entries. Only finished calls carry one. */
export function replayRecordsFromJournal(entries: JournalEntry[]): ReplayRecord[] {
  const records: ReplayRecord[] = [];
  for (const entry of entries) {
    if (entry.kind !== "agent_end") continue;
    if (!entry.key || typeof entry.index !== "number") continue;
    records.push({
      key: entry.key,
      scope: entry.scope ?? "",
      index: entry.index,
      fingerprint: entry.fingerprint ?? "",
      ok: entry.ok,
      text: entry.text ?? "",
      data: entry.data,
      error: entry.error,
      usage: entry.usage,
    });
  }
  return records;
}

export class WorkflowReplay {
  private readonly records = new Map<string, ReplayRecord>();
  /** Per scope, the first position whose saved answer may not be used again. */
  private readonly boundary = new Map<string, number>();
  private hits = 0;
  private misses = 0;

  constructor(records: ReplayRecord[] = []) {
    for (const record of records) this.records.set(record.key, record);
  }

  get size(): number {
    return this.records.size;
  }

  get stats(): { hits: number; misses: number } {
    return { hits: this.hits, misses: this.misses };
  }

  /** Ask for a saved answer. Never throws: a miss is a normal outcome. */
  lookup(scope: string, index: number, shape: ReplayRequestShape): ReplayLookup {
    const limit = this.boundary.get(scope);
    if (limit !== undefined && index >= limit) {
      this.misses += 1;
      return { hit: false, reason: "after-changed" };
    }

    const record = this.records.get(agentKey(scope, index));
    if (!record) {
      // A call that never finished. It does not end the saved region: in a
      // parallel fan-out a later call can finish first, and its answer is still
      // good.
      this.misses += 1;
      return { hit: false, reason: "not-recorded" };
    }
    if (record.fingerprint !== fingerprintOf(shape)) {
      this.closeScope(scope, index);
      this.misses += 1;
      return { hit: false, reason: "changed" };
    }
    if (!record.ok) {
      this.closeScope(scope, index);
      this.misses += 1;
      return { hit: false, reason: "failed" };
    }

    this.hits += 1;
    return {
      hit: true,
      result: {
        ok: true,
        text: record.text,
        data: record.data,
        usage: record.usage,
        replayed: true,
      },
    };
  }

  private closeScope(scope: string, index: number): void {
    const current = this.boundary.get(scope);
    this.boundary.set(scope, current === undefined ? index : Math.min(current, index));
  }
}

/** Text for the report: `3 replayed, 4 live`, or nothing when nothing was saved. */
export function describeReplay(stats: { hits: number; misses: number }): string {
  if (stats.hits === 0 && stats.misses === 0) return "";
  const parts: string[] = [];
  if (stats.hits > 0) parts.push(`${stats.hits} replayed`);
  if (stats.misses > 0) parts.push(`${stats.misses} live`);
  return parts.join(", ");
}
