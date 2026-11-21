import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JOURNAL_KEEP_DAYS,
  JOURNAL_TEXT_LIMIT,
  WorkflowJournal,
  journalDir,
  journalPath,
  pruneJournals,
} from "../src/workflow-journal";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "qronos-journal-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("writing and reading", () => {
  test("entries come back in the order they were written", () => {
    const dir = tempDir();
    const journal = new WorkflowJournal(journalPath(dir, "wf_1"));
    journal.append({ kind: "run_start", at: 1, id: "wf_1", name: "audit", script: "return 1", maxAgents: 60, wallClockMs: 600_000 });
    journal.append({ kind: "phase", at: 2, name: "Review" });
    journal.append({ kind: "run_end", at: 3, ok: true, tokens: { input: 1, output: 2, total: 3 }, durationMs: 2 });

    const entries = journal.read();
    expect(entries.map((entry) => entry.kind)).toEqual(["run_start", "phase", "run_end"]);
  });

  test("a torn last line is skipped, not fatal", () => {
    const dir = tempDir();
    const path = journalPath(dir, "wf_2");
    const journal = new WorkflowJournal(path);
    journal.append({ kind: "phase", at: 1, name: "A" });
    writeFileSync(path, `${readFileSync(path, "utf8")}{"kind":"phase","at":2,"na`, "utf8");
    const entries = journal.read();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("phase");
  });

  test("a file that does not exist reads as empty", () => {
    expect(new WorkflowJournal(journalPath(tempDir(), "missing")).read()).toEqual([]);
  });

  test("finished() is false until the end entry is there", () => {
    const dir = tempDir();
    const journal = new WorkflowJournal(journalPath(dir, "wf_3"));
    journal.append({ kind: "phase", at: 1, name: "A" });
    expect(journal.finished()).toBe(false);
    journal.append({ kind: "run_end", at: 2, ok: true, tokens: { input: 0, output: 0, total: 0 }, durationMs: 1 });
    expect(journal.finished()).toBe(true);
  });

  test("the directory is created when it does not exist", () => {
    const dir = join(tempDir(), "deep", "nested");
    const journal = new WorkflowJournal(journalPath(dir, "wf_4"));
    expect(journal.append({ kind: "phase", at: 1, name: "A" })).toBe(true);
    expect(journal.read()).toHaveLength(1);
  });
});

describe("secrets", () => {
  test("a token in an agent answer is redacted before it is stored", () => {
    const dir = tempDir();
    const path = journalPath(dir, "wf_5");
    const journal = new WorkflowJournal(path);
    journal.appendAgentEnd({
      kind: "agent_end",
      at: 1,
      id: "wf-1",
      ok: true,
      durationMs: 5,
      text: "the key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 and that is all",
    });
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789");
    expect(raw).toContain("redacted");
    expect(journal.recordedAnswers().get("wf-1")?.ok).toBe(true);
  });

  test("a structured value survives redaction as valid JSON", () => {
    const dir = tempDir();
    const journal = new WorkflowJournal(journalPath(dir, "wf_6"));
    journal.appendAgentEnd({
      kind: "agent_end",
      at: 1,
      id: "wf-1",
      ok: true,
      durationMs: 1,
      data: { found: ["a.ts"], note: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
    });
    const stored = journal.recordedAnswers().get("wf-1");
    expect(Array.isArray((stored?.data as { found: string[] }).found)).toBe(true);
    expect(JSON.stringify(stored?.data)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });

  test("a long answer is capped", () => {
    const dir = tempDir();
    const journal = new WorkflowJournal(journalPath(dir, "wf_7"));
    journal.appendAgentEnd({ kind: "agent_end", at: 1, id: "wf-1", ok: true, durationMs: 1, text: "x".repeat(9000) });
    const text = journal.recordedAnswers().get("wf-1")?.text ?? "";
    expect(text.length).toBeLessThan(JOURNAL_TEXT_LIMIT + 120);
    expect(text).toContain("not stored");
  });
});

describe("replay data", () => {
  test("recordedAnswers returns one entry per agent, keeping the last", () => {
    const dir = tempDir();
    const journal = new WorkflowJournal(journalPath(dir, "wf_8"));
    journal.appendAgentEnd({ kind: "agent_end", at: 1, id: "wf-1", ok: true, durationMs: 1, text: "first" });
    journal.appendAgentEnd({ kind: "agent_end", at: 2, id: "wf-1", ok: true, durationMs: 1, text: "second" });
    expect(journal.recordedAnswers().size).toBe(1);
    expect(journal.recordedAnswers().get("wf-1")?.text).toBe("second");
  });

  test("usage travels with the recorded answer", () => {
    const dir = tempDir();
    const journal = new WorkflowJournal(journalPath(dir, "wf_9"));
    journal.appendAgentEnd({
      kind: "agent_end",
      at: 1,
      id: "wf-1",
      ok: true,
      durationMs: 1,
      usage: { input: 10, output: 5, total: 15 },
    });
    expect(journal.recordedAnswers().get("wf-1")?.usage?.total).toBe(15);
  });
});

describe("pruning", () => {
  test("an old journal beyond the newest runs is removed", () => {
    const root = tempDir();
    const dir = journalDir(root);
    mkdirSync(dir, { recursive: true });
    const ancient = (Date.now() - (JOURNAL_KEEP_DAYS + 1) * 24 * 60 * 60 * 1000) / 1000;
    // 21 fresh runs and one old one: the old one is now the 22nd newest, so its
    // age decides, and it goes.
    for (let index = 0; index < 21; index += 1) writeFileSync(journalPath(root, `wf_${index}`), "", "utf8");
    const old = journalPath(root, "wf_ancient");
    writeFileSync(old, "", "utf8");
    utimesSync(old, ancient, ancient);
    const fresh = journalPath(root, "wf_0");

    expect(pruneJournals(dir)).toBe(1);
    expect(() => readFileSync(old, "utf8")).toThrow();
    expect(readFileSync(fresh, "utf8")).toBe("");
  });

  test("a missing directory is not an error", () => {
    expect(pruneJournals(join(tempDir(), "nope"))).toBe(0);
  });

  test("a small history is never erased just because it is old", () => {
    const root = tempDir();
    const dir = journalDir(root);
    mkdirSync(dir, { recursive: true });
    const ancient = (Date.now() - (JOURNAL_KEEP_DAYS + 5) * 24 * 60 * 60 * 1000) / 1000;
    for (let index = 0; index < 3; index += 1) {
      const path = journalPath(root, `wf_${index}`);
      writeFileSync(path, "", "utf8");
      utimesSync(path, ancient, ancient);
    }
    expect(pruneJournals(dir)).toBe(0);
  });
});
