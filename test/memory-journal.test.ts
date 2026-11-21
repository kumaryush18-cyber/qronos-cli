import { describe, expect, test } from "bun:test";
import {
  ANSWER_MAX_CHARS,
  MAX_FILES,
  PROMPT_MAX_CHARS,
  buildJournalEntry,
  normalizeFiles,
  normalizeTools,
  renderJournalEntry,
  tailClamp,
} from "../src/memory-journal";
import type { JournalEntry } from "../src/memory-store";

const CWD = "/repo/app";

describe("buildJournalEntry", () => {
  test("keeps prompt, answer, tools and files", () => {
    const entry = buildJournalEntry(
      { prompt: "fix the test", answer: "done", tools: ["read", "edit"], files: ["src/a.ts"], at: 5 },
      CWD,
    );
    expect(entry).toEqual({
      at: 5,
      prompt: "fix the test",
      answer: "done",
      tools: ["read", "edit"],
      files: ["src/a.ts"],
      outcome: "ok",
    });
  });

  test("an empty turn produces no row", () => {
    expect(buildJournalEntry({ prompt: "", answer: "", at: 1 }, CWD)).toBeUndefined();
  });

  test("a failed turn is marked", () => {
    expect(buildJournalEntry({ prompt: "x", answer: "y", outcome: "error", at: 1 }, CWD)!.outcome).toBe("error");
  });

  test("a secret in the prompt is redacted", () => {
    const entry = buildJournalEntry({ prompt: "key AKIAIOSFODNN7EXAMPLE", answer: "", at: 1 }, CWD)!;
    expect(entry.prompt).not.toContain("AKIA");
  });

  test("a long prompt is clamped", () => {
    const entry = buildJournalEntry({ prompt: "x".repeat(PROMPT_MAX_CHARS + 500), answer: "", at: 1 }, CWD)!;
    expect(entry.prompt.length).toBeLessThanOrEqual(PROMPT_MAX_CHARS);
  });

  test("a long answer keeps its tail, where the result is", () => {
    const entry = buildJournalEntry({ prompt: "x", answer: `${"filler ".repeat(400)}THE RESULT`, at: 1 }, CWD)!;
    expect(entry.answer.length).toBeLessThanOrEqual(ANSWER_MAX_CHARS);
    expect(entry.answer.endsWith("THE RESULT")).toBe(true);
  });
});

describe("normalizeFiles", () => {
  test("absolute paths inside cwd become repo-relative", () => {
    expect(normalizeFiles([`${CWD}/src/a.ts`], CWD)).toEqual(["src/a.ts"]);
  });

  test("relative paths are kept", () => {
    expect(normalizeFiles(["src/a.ts"], CWD)).toEqual(["src/a.ts"]);
  });

  test("windows separators are normalised", () => {
    expect(normalizeFiles(["src\\api\\a.ts"], CWD)).toEqual(["src/api/a.ts"]);
  });

  test("paths outside the project are dropped", () => {
    expect(normalizeFiles(["/etc/passwd", "../secrets.txt", "https://x.test/a.ts"], CWD)).toEqual([]);
  });

  test("duplicates are folded case-insensitively", () => {
    expect(normalizeFiles(["A.ts", "a.ts"], CWD)).toEqual(["A.ts"]);
  });

  test("the list is capped", () => {
    const many = Array.from({ length: MAX_FILES + 5 }, (_, i) => `f${i}.ts`);
    expect(normalizeFiles(many, CWD).length).toBe(MAX_FILES);
  });
});

describe("normalizeTools", () => {
  test("dedupes and keeps order", () => {
    expect(normalizeTools(["read", "edit", "read"])).toEqual(["read", "edit"]);
  });

  test("blanks are dropped", () => {
    expect(normalizeTools(["", "  ", "bash"])).toEqual(["bash"]);
  });

  test("the list is capped", () => {
    expect(normalizeTools(Array.from({ length: 30 }, (_, i) => `t${i}`)).length).toBe(12);
  });
});

describe("tailClamp", () => {
  test("short text is unchanged", () => {
    expect(tailClamp("short", 20)).toBe("short");
  });

  test("long text keeps the end", () => {
    const out = tailClamp("aaaa bbbb cccc END", 10);
    expect(out.startsWith("…")).toBe(true);
    expect(out.endsWith("END")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(10);
  });
});

describe("renderJournalEntry", () => {
  const entry: JournalEntry = {
    seq: 4,
    at: Date.parse("2026-01-02T03:04:00Z"),
    prompt: "do the thing",
    answer: "did the thing",
    tools: ["read"],
    files: ["src/a.ts"],
    outcome: "ok",
  };

  test("contains the sequence, files, tools and both texts", () => {
    const text = renderJournalEntry(entry);
    expect(text).toContain("#4");
    expect(text).toContain("src/a.ts");
    expect(text).toContain("read");
    expect(text).toContain("user: do the thing");
    expect(text).toContain("agent: did the thing");
  });

  test("a failed turn is labelled", () => {
    expect(renderJournalEntry({ ...entry, outcome: "error" })).toContain("turn failed");
  });

  test("an entry with no files or tools stays readable", () => {
    const text = renderJournalEntry({ ...entry, files: [], tools: [] });
    expect(text).not.toContain("files:");
    expect(text).not.toContain("tools:");
  });
});
