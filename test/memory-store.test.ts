import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryFiles } from "../src/memory-paths";
import {
  EMPTY_STATE,
  JOURNAL_MAX_ENTRIES,
  acquireLock,
  appendJournal,
  memoryExists,
  parseJournal,
  readJournal,
  readState,
  readText,
  releaseLock,
  rewriteJournal,
  serializeJournal,
  sortBySeq,
  trimJournal,
  writeAtomic,
  writeState,
  type JournalEntry,
} from "../src/memory-store";

let dir: string;
let paths: ReturnType<typeof memoryFiles>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qronos-memory-store-"));
  paths = memoryFiles(dir, `${dir}/app`, `${dir}/app`);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function entry(seq: number, overrides: Partial<JournalEntry> = {}): JournalEntry {
  return { seq, at: 1_700_000_000_000 + seq, prompt: `p${seq}`, answer: `a${seq}`, tools: [], files: [], outcome: "ok", ...overrides };
}

describe("readText / writeAtomic", () => {
  test("a write creates parent folders and is readable back", () => {
    expect(writeAtomic(paths.doc, "hello")).toBe(true);
    expect(readText(paths.doc)).toBe("hello");
  });

  test("a second write replaces the first", () => {
    writeAtomic(paths.doc, "one");
    writeAtomic(paths.doc, "two");
    expect(readText(paths.doc)).toBe("two");
  });

  test("a missing file reads as undefined", () => {
    expect(readText(paths.summary)).toBeUndefined();
  });

  test("no .tmp file is left behind", () => {
    writeAtomic(paths.doc, "x");
    expect(readText(`${paths.doc}.tmp`)).toBeUndefined();
  });

  test("a write into an impossible path returns false instead of throwing", () => {
    // A NUL byte is rejected by every supported filesystem, so this is
    // unwritable on Linux, macOS and Windows alike. `/proc` was the old probe
    // and silently became writable on Windows.
    expect(writeAtomic("bad\u0000path/x.txt", "x")).toBe(false);
  });
});

describe("state", () => {
  test("missing state is the empty state", () => {
    expect(readState(paths)).toEqual(EMPTY_STATE);
  });

  test("state round-trips", () => {
    writeState(paths, { ...EMPTY_STATE, lastSeq: 7, lastSyncAt: 123, syncs: 2, turns: 9, injectedTokens: 400 });
    const state = readState(paths);
    expect(state.lastSeq).toBe(7);
    expect(state.syncs).toBe(2);
    expect(state.injectedTokens).toBe(400);
  });

  test("broken JSON falls back to the empty state instead of throwing", () => {
    writeAtomic(paths.state, "{not json");
    expect(readState(paths)).toEqual(EMPTY_STATE);
  });

  test("an old version is reset, not migrated", () => {
    writeAtomic(paths.state, JSON.stringify({ version: 0, lastSeq: 99, syncs: 5 }));
    expect(readState(paths)).toEqual(EMPTY_STATE);
  });

  test("negative and non-numeric counters are clamped to zero", () => {
    writeAtomic(paths.state, JSON.stringify({ version: 1, lastSeq: -5, syncs: "nope", turns: null }));
    const state = readState(paths);
    expect(state.lastSeq).toBe(0);
    expect(state.syncs).toBe(0);
    expect(state.turns).toBe(0);
  });
});

describe("journal", () => {
  test("append assigns increasing seq numbers", () => {
    appendJournal(paths, { at: 1, prompt: "one", answer: "", tools: [], files: [], outcome: "ok" });
    appendJournal(paths, { at: 2, prompt: "two", answer: "", tools: [], files: [], outcome: "ok" });
    expect(readJournal(paths).map((item) => item.seq)).toEqual([1, 2]);
  });

  test("append redacts a secret that a caller forgot", () => {
    appendJournal(paths, {
      at: 1,
      prompt: "here is my key AKIAIOSFODNN7EXAMPLE",
      answer: "",
      tools: [],
      files: [],
      outcome: "ok",
    });
    expect(readJournal(paths)[0]!.prompt).not.toContain("AKIA");
  });

  test("append keeps only the newest entries at the count cap", () => {
    for (let i = 0; i < 8; i += 1) {
      appendJournal(paths, { at: i, prompt: `p${i}`, answer: "", tools: [], files: [], outcome: "ok" }, { maxEntries: 3 });
    }
    expect(readJournal(paths).map((item) => item.prompt)).toEqual(["p5", "p6", "p7"]);
  });

  test("a torn last line costs one row, not the journal", () => {
    writeAtomic(paths.journal, `${JSON.stringify(entry(1))}\n{"seq":2,"prompt":"cut`);
    expect(readJournal(paths).length).toBe(1);
  });

  test("rows with no prompt and no answer are skipped", () => {
    writeAtomic(paths.journal, `${JSON.stringify({ seq: 1, at: 1, prompt: "", answer: "" })}\n`);
    expect(readJournal(paths)).toEqual([]);
  });

  test("trimJournal keeps whole entries under the character cap", () => {
    const rows = [entry(1), entry(2), entry(3)];
    const trimmed = trimJournal(rows, 10, JSON.stringify(rows[2]!).length + 20);
    expect(trimmed.length).toBeLessThan(3);
    expect(trimmed.at(-1)!.seq).toBe(3);
  });

  test("the count cap defaults are sane", () => {
    expect(JOURNAL_MAX_ENTRIES).toBeGreaterThan(50);
  });

  test("rewriteJournal replaces the whole file", () => {
    appendJournal(paths, { at: 1, prompt: "one", answer: "", tools: [], files: [], outcome: "ok" });
    rewriteJournal(paths, [entry(9)]);
    expect(readJournal(paths).map((item) => item.seq)).toEqual([9]);
  });

  test("an empty journal serializes to an empty string", () => {
    expect(serializeJournal([])).toBe("");
  });

  test("sortBySeq is ascending and stable", () => {
    expect(sortBySeq([entry(3), entry(1), entry(2)]).map((item) => item.seq)).toEqual([1, 2, 3]);
  });

  test("parseJournal drops unknown outcome values to ok", () => {
    expect(parseJournal(`${JSON.stringify({ seq: 1, prompt: "x", outcome: "weird" })}`)[0]!.outcome).toBe("ok");
  });
});

describe("lock", () => {
  test("the first acquire succeeds and the second fails", () => {
    expect(acquireLock(paths)).toBe(true);
    expect(acquireLock(paths)).toBe(false);
  });

  test("releasing lets the next acquire through", () => {
    acquireLock(paths);
    releaseLock(paths);
    expect(acquireLock(paths)).toBe(true);
  });

  test("another pid cannot release our lock", () => {
    acquireLock(paths);
    expect(releaseLock(paths, 999_999)).toBe(false);
    expect(acquireLock(paths)).toBe(false);
  });

  test("an old lock is taken over even if the pid is alive", () => {
    acquireLock(paths, { now: 1_000, pid: process.pid });
    expect(acquireLock(paths, { now: 1_000 + 180_001, pid: process.pid })).toBe(true);
  });

  test("a lock from a dead pid is taken over immediately", () => {
    writeAtomic(paths.lock, JSON.stringify({ pid: 2_147_483_646, at: Date.now() }));
    expect(acquireLock(paths)).toBe(true);
  });

  test("a lock file with broken JSON is treated as takeable", () => {
    writeAtomic(paths.lock, "garbage");
    expect(acquireLock(paths, { now: Date.now() + 99_999_999 })).toBe(true);
  });
});

describe("memoryExists", () => {
  test("false before anything is written, true after", () => {
    expect(memoryExists(paths)).toBe(false);
    writeAtomic(paths.doc, "x");
    expect(memoryExists(paths)).toBe(true);
  });
});

describe("the files we write are plain text a human can read", () => {
  test("the journal is one JSON object per line", () => {
    appendJournal(paths, { at: 1, prompt: "one", answer: "two", tools: ["read"], files: ["a.ts"], outcome: "ok" });
    const raw = readFileSync(paths.journal, "utf8").trim();
    expect(raw.split("\n").every((line) => line.startsWith("{"))).toBe(true);
  });
});
