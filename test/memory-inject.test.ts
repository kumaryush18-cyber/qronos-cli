import { describe, expect, test } from "bun:test";
import { EMPTY_DOC, type MemoryDoc } from "../src/memory-doc";
import {
  DEFAULT_BUDGET_TOKENS,
  MAX_INJECTED_LESSONS,
  MEMORY_SECTION,
  approxTokens,
  buildMemoryBlock,
  memoryStatusLabel,
} from "../src/memory-inject";
import type { Lesson } from "../src/memory-lessons";

const paths = { doc: "/agent/memories/app-1234/MEMORY.md", lessons: "/agent/memories/app-1234/learned.md" };

function doc(sections: Partial<MemoryDoc["sections"]>): MemoryDoc {
  return { sections: { ...EMPTY_DOC.sections, ...sections }, extra: "" };
}

describe("buildMemoryBlock", () => {
  test("no memory means no block at all", () => {
    expect(buildMemoryBlock({ doc: EMPTY_DOC, lessons: [], paths })).toBe("");
  });

  test("the block says it is a hint and names both files", () => {
    const block = buildMemoryBlock({ doc: doc({ decisions: ["use bun"] }), lessons: [], paths });
    expect(block).toContain("not the current state of the repo");
    expect(block).toContain(paths.doc);
    expect(block).toContain(paths.lessons);
    expect(block).toContain(MEMORY_SECTION.length > 0 ? "Memory Guidance" : "");
  });

  test("nowhere does it claim authority over the user or the code", () => {
    const block = buildMemoryBlock({ doc: doc({ decisions: ["use bun"] }), lessons: [], paths });
    expect(block).toContain("trust the code or the user");
  });

  test("sections render as bullets", () => {
    const block = buildMemoryBlock({ doc: doc({ decisions: ["use bun", "no new tables"] }), lessons: [], paths });
    expect(block).toContain("- Decisions: use bun · no new tables");
  });

  test("lessons render newest first", () => {
    const lessons: Lesson[] = [
      { at: 2, text: "newer" },
      { at: 1, text: "older" },
    ];
    const block = buildMemoryBlock({ doc: EMPTY_DOC, lessons, paths });
    expect(block.indexOf("newer")).toBeLessThan(block.indexOf("older"));
  });

  test("a tiny budget drops the sections but keeps the header", () => {
    const block = buildMemoryBlock({
      doc: doc({ decisions: ["a long decision that costs tokens"] }),
      lessons: [{ at: 1, text: "a lesson that also costs tokens" }],
      paths,
      budgetTokens: 64,
    });
    expect(block).toContain("Memory Guidance");
    expect(block).not.toContain("a long decision");
  });

  test("the block never exceeds the budget by much", () => {
    const lessons = Array.from({ length: 50 }, (_, i) => ({ at: i, text: `lesson number ${i} `.repeat(4) }));
    const block = buildMemoryBlock({ doc: doc({ decisions: ["x"] }), lessons, paths, budgetTokens: 300 });
    expect(approxTokens(block)).toBeLessThanOrEqual(300 + 40);
  });

  test("at most MAX_INJECTED_LESSONS lessons are shown", () => {
    const lessons = Array.from({ length: 40 }, (_, i) => ({ at: i, text: `l${i}` }));
    const block = buildMemoryBlock({ doc: EMPTY_DOC, lessons, paths, budgetTokens: 8000 });
    const shown = (block.match(/^- l\d+$/gm) ?? []).length;
    expect(shown).toBe(MAX_INJECTED_LESSONS);
  });

  test("the footer tells the model how to add memory", () => {
    const block = buildMemoryBlock({ doc: doc({ decisions: ["x"] }), lessons: [], paths });
    expect(block).toContain("learn` tool");
    expect(block).toContain("/memory sync");
  });

  test("the default budget is the documented one", () => {
    expect(DEFAULT_BUDGET_TOKENS).toBe(1200);
  });
});

describe("approxTokens", () => {
  test("is chars over four, rounded up", () => {
    expect(approxTokens("")).toBe(0);
    expect(approxTokens("abcd")).toBe(1);
    expect(approxTokens("abcde")).toBe(2);
    expect(approxTokens("a".repeat(400))).toBe(100);
  });
});

describe("memoryStatusLabel", () => {
  test("counts document items plus lessons", () => {
    expect(memoryStatusLabel(doc({ decisions: ["a", "b"] }), [{ at: 1, text: "l" }])).toBe("memory 3");
  });

  test("is empty when there is nothing", () => {
    expect(memoryStatusLabel(EMPTY_DOC, [])).toBe("");
  });
});
