import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consolidate, shouldSync } from "../src/memory-consolidate";
import { parseDoc } from "../src/memory-doc";
import { memoryFiles } from "../src/memory-paths";
import {
  EMPTY_STATE,
  appendJournal,
  acquireLock,
  readJournal,
  readState,
  readText,
  releaseLock,
  writeAtomic,
  writeState,
} from "../src/memory-store";

let dir: string;
let paths: ReturnType<typeof memoryFiles>;
const now = () => 1_700_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qronos-memory-sync-"));
  paths = memoryFiles(dir, `${dir}/app`, `${dir}/app`);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seed(count: number): void {
  for (let i = 0; i < count; i += 1) {
    appendJournal(paths, {
      at: now() + i,
      prompt: `prompt ${i}`,
      answer: `answer ${i}`,
      tools: ["read"],
      files: ["src/a.ts"],
      outcome: "ok",
    });
  }
}

const goodAnswer = JSON.stringify({
  decisions: ["We use bun for every script in this repo"],
  constraints: ["Tests must run with the --bail flag"],
  workflows: [],
  failures: [],
  preferences: [],
});

describe("consolidate: the happy path", () => {
  test("a good answer is written to the document", async () => {
    seed(2);
    const result = await consolidate({ paths, extract: async () => goodAnswer, now });
    expect(result.status).toBe("synced");
    expect(result.added).toBe(2);
    const doc = parseDoc(readText(paths.doc));
    expect(doc.sections.decisions).toEqual(["We use bun for every script in this repo"]);
    expect(doc.sections.constraints).toEqual(["Tests must run with the --bail flag"]);
  });

  test("the consumed rows leave the journal and state records the seq", async () => {
    seed(3);
    await consolidate({ paths, extract: async () => goodAnswer, now });
    expect(readJournal(paths)).toEqual([]);
    const state = readState(paths);
    expect(state.lastSeq).toBe(3);
    expect(state.syncs).toBe(1);
    expect(state.lastSyncAt).toBe(now());
  });

  test("rows added after a sync are picked up by the next one", async () => {
    seed(1);
    await consolidate({ paths, extract: async () => goodAnswer, now });
    seed(1);
    const result = await consolidate({
      paths,
      extract: async () => JSON.stringify({ decisions: ["A second decision that is long enough"] }),
      now,
    });
    expect(result.status).toBe("synced");
    expect(parseDoc(readText(paths.doc)).sections.decisions.length).toBe(2);
  });

  test("the model receives the system prompt and the turn text", async () => {
    seed(1);
    let seenSystem = "";
    let seenUser = "";
    await consolidate({
      paths,
      extract: async (system, user) => {
        seenSystem = system;
        seenUser = user;
        return goodAnswer;
      },
      projectName: "qronos-cli",
      now,
    });
    expect(seenSystem).toContain("durable project knowledge");
    expect(seenUser).toContain("Project: qronos-cli");
    expect(seenUser).toContain("prompt 0");
  });

  test("the lock is released after a successful sync", async () => {
    seed(1);
    await consolidate({ paths, extract: async () => goodAnswer, now });
    expect(acquireLock(paths, { now: now() })).toBe(true);
  });
});

describe("consolidate: nothing to do", () => {
  test("an empty journal makes no model call", async () => {
    let called = false;
    const result = await consolidate({
      paths,
      extract: async () => {
        called = true;
        return goodAnswer;
      },
      now,
    });
    expect(result.status).toBe("nothing-new");
    expect(called).toBe(false);
  });

  test("already consumed rows are not re-read", async () => {
    seed(2);
    writeState(paths, { ...EMPTY_STATE, lastSeq: 2 });
    let called = false;
    const result = await consolidate({
      paths,
      extract: async () => {
        called = true;
        return goodAnswer;
      },
      now,
    });
    expect(result.status).toBe("nothing-new");
    expect(called).toBe(false);
  });

  test("a running sync is skipped, not queued", async () => {
    seed(1);
    acquireLock(paths, { now: now() });
    const result = await consolidate({ paths, extract: async () => goodAnswer, now });
    expect(result.status).toBe("busy");
    releaseLock(paths);
  });
});

describe("consolidate: failures never lose memory", () => {
  beforeEach(() => {
    writeAtomic(paths.doc, "# Memory\n\n## Decisions\n- an existing decision that must survive\n");
  });

  test("a model error keeps the document and the journal", async () => {
    seed(1);
    const before = readText(paths.doc);
    const result = await consolidate({
      paths,
      extract: async () => {
        throw new Error("upstream 529");
      },
      now,
    });
    expect(result.status).toBe("model-failed");
    expect(result.reason).toContain("529");
    expect(readText(paths.doc)).toBe(before);
    expect(readJournal(paths).length).toBe(1);
    expect(readState(paths).lastSeq).toBe(0);
  });

  test("an unparseable answer keeps everything", async () => {
    seed(1);
    const before = readText(paths.doc);
    const result = await consolidate({ paths, extract: async () => "I am not JSON today", now });
    expect(result.status).toBe("bad-answer");
    expect(readText(paths.doc)).toBe(before);
    expect(readJournal(paths).length).toBe(1);
  });

  test("an empty extraction consumes the rows but adds nothing", async () => {
    seed(2);
    const before = readText(paths.doc);
    const result = await consolidate({ paths, extract: async () => "{}", now });
    expect(result.status).toBe("synced");
    expect(result.added).toBe(0);
    expect(readText(paths.doc)).toBe(before);
    expect(readJournal(paths)).toEqual([]);
    expect(readState(paths).lastSeq).toBe(2);
  });

  test("the existing document is merged, not replaced", async () => {
    seed(1);
    await consolidate({ paths, extract: async () => goodAnswer, now });
    const doc = parseDoc(readText(paths.doc));
    expect(doc.sections.decisions).toContain("an existing decision that must survive");
    expect(doc.sections.decisions).toContain("We use bun for every script in this repo");
  });

  test("an empty answer is retried once, and the second answer is used", async () => {
    seed(1);
    let calls = 0;
    const result = await consolidate({
      paths,
      extract: async () => {
        calls += 1;
        return calls === 1 ? "" : goodAnswer;
      },
      now,
    });
    expect(calls).toBe(2);
    expect(result.status).toBe("synced");
    expect(parseDoc(readText(paths.doc)).sections.decisions.length).toBeGreaterThan(0);
  });

  test("two unusable answers in a row give bad-answer, and nothing is lost", async () => {
    seed(1);
    let calls = 0;
    const before = readText(paths.doc);
    const result = await consolidate({
      paths,
      extract: async () => {
        calls += 1;
        return "not json";
      },
      now,
    });
    expect(calls).toBe(2);
    expect(result.status).toBe("bad-answer");
    expect(readText(paths.doc)).toBe(before);
    expect(readJournal(paths).length).toBe(1);
  });

  test("a model error is not retried inside the sync", async () => {
    seed(1);
    let calls = 0;
    await consolidate({
      paths,
      extract: async () => {
        calls += 1;
        throw new Error("upstream down");
      },
      now,
    });
    expect(calls).toBe(1);
  });

  test("a surprising exception becomes a status, not a throw", async () => {
    seed(1);
    const result = await consolidate({
      paths: { ...paths, journal: "/proc/qronos-nope/journal.jsonl" },
      extract: async () => goodAnswer,
      now,
    });
    expect(["nothing-new", "write-failed", "synced"]).toContain(result.status);
  });
});

describe("shouldSync", () => {
  const rows = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      seq: i + 1,
      at: i,
      prompt: `p${i}`,
      answer: `a${i}`,
      tools: [],
      files: [],
      outcome: "ok" as const,
    }));

  test("false when too few new turns have piled up", () => {
    expect(shouldSync(EMPTY_STATE, rows(1), { minTurns: 6, minIntervalMs: 0, now: 100 })).toBe(false);
  });

  test("false when the interval has not passed", () => {
    const state = { ...EMPTY_STATE, lastSyncAt: 1_000 };
    expect(shouldSync(state, rows(10), { minTurns: 1, minIntervalMs: 60_000, now: 2_000 })).toBe(false);
  });

  test("true when both conditions are met", () => {
    const state = { ...EMPTY_STATE, lastSyncAt: 1_000 };
    expect(shouldSync(state, rows(10), { minTurns: 3, minIntervalMs: 500, now: 5_000 })).toBe(true);
  });

  test("a never-synced project passes the interval check", () => {
    expect(shouldSync(EMPTY_STATE, rows(3), { minTurns: 3, minIntervalMs: 999_999, now: 1 })).toBe(true);
  });
});
