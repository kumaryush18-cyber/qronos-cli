import { describe, expect, test } from "bun:test";
import {
  WorkflowReplay,
  agentKey,
  describeReplay,
  fingerprintOf,
  replayRecordsFromJournal,
  type ReplayRecord,
} from "../src/workflow-replay";
import type { JournalEntry } from "../src/workflow-journal";

const record = (overrides: Partial<ReplayRecord> = {}): ReplayRecord => ({
  key: agentKey("", 0),
  scope: "",
  index: 0,
  fingerprint: fingerprintOf({ prompt: "a" }),
  ok: true,
  text: "answer: a",
  usage: { input: 10, output: 5, total: 15 },
  ...overrides,
});

describe("agentKey", () => {
  test("the top-level scope is empty and readable", () => {
    expect(agentKey("", 3)).toBe("#3");
  });

  test("a child scope keeps its own positions", () => {
    expect(agentKey("w0/", 1)).toBe("w0/#1");
  });
});

describe("fingerprintOf", () => {
  test("is stable for the same request", () => {
    expect(fingerprintOf({ prompt: "a" })).toBe(fingerprintOf({ prompt: "a" }));
  });

  test("changes when the prompt changes", () => {
    expect(fingerprintOf({ prompt: "a" })).not.toBe(fingerprintOf({ prompt: "b" }));
  });

  test("changes when the model or agent type changes", () => {
    const base = fingerprintOf({ prompt: "a" });
    expect(fingerprintOf({ prompt: "a", model: "m" })).not.toBe(base);
    expect(fingerprintOf({ prompt: "a", agent: "general-purpose" })).not.toBe(base);
  });

  test("ignores the label, which changes nothing about the work", () => {
    expect(fingerprintOf({ prompt: "a" })).toBe(fingerprintOf({ prompt: "a" }));
  });
});

describe("replayRecordsFromJournal", () => {
  test("keeps only finished agents", () => {
    const entries: JournalEntry[] = [
      { kind: "run_start", at: 1, id: "r", name: "n", script: "s", maxAgents: 1, wallClockMs: 1 },
      { kind: "agent_start", at: 2, id: "#0", label: "a" },
      { kind: "agent_end", at: 3, id: "#0", key: "#0", scope: "", index: 0, fingerprint: "f", ok: true, durationMs: 1, text: "x" },
      { kind: "run_end", at: 4, ok: true, tokens: { input: 1, output: 1, total: 2 }, durationMs: 3 },
    ];
    const records = replayRecordsFromJournal(entries);
    expect(records).toHaveLength(1);
    expect(records[0]!.key).toBe("#0");
    expect(records[0]!.text).toBe("x");
  });

  test("skips an end entry with no position, which a replay cannot use", () => {
    const entries: JournalEntry[] = [
      { kind: "agent_end", at: 3, id: "wf-1", ok: true, durationMs: 1, text: "x" },
    ];
    expect(replayRecordsFromJournal(entries)).toHaveLength(0);
  });
});

describe("WorkflowReplay", () => {
  test("returns a saved answer for an unchanged call", () => {
    const replay = new WorkflowReplay([record()]);
    const looked = replay.lookup("", 0, { prompt: "a" });
    expect(looked.hit).toBe(true);
    if (!looked.hit) return;
    expect(looked.result.text).toBe("answer: a");
    expect(looked.result.replayed).toBe(true);
    expect(looked.result.usage?.total).toBe(15);
  });

  test("a changed prompt misses and marks the answer changed", () => {
    const replay = new WorkflowReplay([record()]);
    const looked = replay.lookup("", 0, { prompt: "different" });
    expect(looked).toEqual({ hit: false, reason: "changed" });
  });

  test("the first changed call ends the saved region for that scope", () => {
    const replay = new WorkflowReplay([
      record({ key: agentKey("", 0), index: 0 }),
      record({ key: agentKey("", 1), index: 1, fingerprint: fingerprintOf({ prompt: "b" }), text: "b-answer" }),
    ]);
    // Nothing has changed yet.
    expect(replay.lookup("", 0, { prompt: "a" }).hit).toBe(true);
    // Position 1 is asked for with a different prompt: it changed, so it and
    // everything after it must run live.
    expect(replay.lookup("", 1, { prompt: "B" })).toEqual({ hit: false, reason: "changed" });
    expect(replay.lookup("", 2, { prompt: "c" })).toEqual({ hit: false, reason: "after-changed" });
  });

  test("a recorded failure is retried, not replayed", () => {
    const replay = new WorkflowReplay([record({ ok: false, text: "", error: "boom" })]);
    expect(replay.lookup("", 0, { prompt: "a" })).toEqual({ hit: false, reason: "failed" });
  });

  test("a call that never finished does not end the saved region", () => {
    const replay = new WorkflowReplay([record({ key: agentKey("", 1), index: 1 })]);
    // Position 0 was in flight when the run stopped. In a parallel fan-out
    // position 1 still finished, so its answer is good.
    expect(replay.lookup("", 0, { prompt: "a" })).toEqual({ hit: false, reason: "not-recorded" });
    expect(replay.lookup("", 1, { prompt: "a" }).hit).toBe(true);
  });

  test("a child scope replays on its own", () => {
    const replay = new WorkflowReplay([record({ key: agentKey("w0/", 0), scope: "w0/" })]);
    expect(replay.lookup("w0/", 0, { prompt: "a" }).hit).toBe(true);
    expect(replay.lookup("", 0, { prompt: "a" })).toEqual({ hit: false, reason: "not-recorded" });
  });

  test("counts what it saved and what it did not", () => {
    const replay = new WorkflowReplay([record()]);
    replay.lookup("", 0, { prompt: "a" });
    replay.lookup("", 1, { prompt: "b" });
    expect(replay.stats).toEqual({ hits: 1, misses: 1 });
    expect(replay.size).toBe(1);
  });

  test("an empty replay is not a crash", () => {
    const replay = new WorkflowReplay();
    expect(replay.lookup("", 0, { prompt: "a" })).toEqual({ hit: false, reason: "not-recorded" });
    expect(replay.size).toBe(0);
  });
});

describe("describeReplay", () => {
  test("says nothing when nothing was saved", () => {
    expect(describeReplay({ hits: 0, misses: 0 })).toBe("");
  });

  test("names both sides", () => {
    expect(describeReplay({ hits: 3, misses: 2 })).toBe("3 replayed, 2 live");
  });

  test("says only what happened", () => {
    expect(describeReplay({ hits: 3, misses: 0 })).toBe("3 replayed");
    expect(describeReplay({ hits: 0, misses: 2 })).toBe("2 live");
  });
});
