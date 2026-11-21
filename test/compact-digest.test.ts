import { describe, expect, test } from "bun:test";
import {
  clampMiddle,
  errorLines,
  evidenceLine,
  extractEvidence,
  firstLine,
  pruneMessages,
  relativise,
  renderEvidence,
  renderTranscript,
} from "../src/compact-digest";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string, calls: Array<{ name: string; arguments: unknown }> = []) => ({
  role: "assistant",
  content: [
    { type: "text", text },
    ...calls.map((call) => ({ type: "toolCall", name: call.name, arguments: call.arguments })),
  ],
});
const toolResult = (toolName: string, text: string, isError = false) => ({
  role: "toolResult",
  toolName,
  isError,
  content: [{ type: "text", text }],
});

describe("clampMiddle", () => {
  test("keeps a short text untouched", () => {
    expect(clampMiddle("hello", 100, 100)).toBe("hello");
  });

  test("keeps the head and the tail of a long text", () => {
    const text = `${"a".repeat(500)}${"b".repeat(500)}`;
    const out = clampMiddle(text, 50, 40);
    expect(out.startsWith("a".repeat(50))).toBe(true);
    expect(out.endsWith("b".repeat(40))).toBe(true);
    expect(out).toContain("chars cut");
  });

  test("normalises windows newlines", () => {
    expect(clampMiddle("a\r\nb", 10, 10)).toBe("a\nb");
  });
});

describe("firstLine", () => {
  test("skips blank leading lines", () => {
    expect(firstLine("\n\n  real text\nsecond")).toBe("real text");
  });

  test("clamps with an ellipsis", () => {
    expect(firstLine("x".repeat(40), 10)).toHaveLength(10);
  });

  test("returns empty for whitespace", () => {
    expect(firstLine("   \n  ")).toBe("");
  });
});

describe("errorLines", () => {
  test("finds error-ish lines", () => {
    const out = errorLines("all good\nTypeError: cannot read x\nmore");
    expect(out).toEqual(["TypeError: cannot read x"]);
  });

  test("drops stack frames", () => {
    const out = errorLines("Error: boom\n    at Object.<anonymous> (x.ts:1:1)");
    expect(out).toEqual(["Error: boom"]);
  });

  test("respects the cap", () => {
    expect(errorLines("error a\nerror b\nerror c\nerror d", 2)).toHaveLength(2);
  });

  test("ignores ordinary prose", () => {
    expect(errorLines("the tests pass and the build is green")).toEqual([]);
  });
});

describe("pruneMessages", () => {
  test("keeps user and assistant text with labels", () => {
    const turns = pruneMessages([user("do it"), assistant("done")]);
    expect(turns.map((turn) => turn.label)).toEqual(["USER", "ASSISTANT"]);
  });

  test("shows tool calls by name with their arguments", () => {
    const turns = pruneMessages([assistant("editing", [{ name: "edit", arguments: { path: "a.ts" } }])]);
    expect(turns.map((turn) => turn.label)).toEqual(["ASSISTANT", "CALL edit"]);
    expect(turns[1]!.text).toContain("a.ts");
  });

  test("prunes a huge tool result but keeps both ends", () => {
    const big = `${"first ".repeat(2000)}END-OF-OUTPUT`;
    const turns = pruneMessages([toolResult("bash", big)]);
    const text = turns[0]!.text;
    expect(text.length).toBeLessThan(1200);
    expect(text).toContain("first");
    expect(text).toContain("END-OF-OUTPUT");
  });

  test("marks error results", () => {
    const turns = pruneMessages([toolResult("bash", "boom", true)]);
    expect(turns[0]!.label).toBe("RESULT bash (error)");
  });

  test("total transcript is capped, keeping the newest turns", () => {
    const messages = Array.from({ length: 40 }, (_, index) => user(`message number ${index} `.repeat(40)));
    const turns = pruneMessages(messages, { maxTranscriptChars: 2000 });
    const transcript = renderTranscript(turns);
    expect(transcript.length).toBeLessThan(2600);
    expect(transcript).toContain("message number 39");
    expect(transcript).not.toContain("message number 0 ");
  });

  test("ignores messages without content", () => {
    expect(pruneMessages([{ role: "user", content: [] }])).toEqual([]);
  });

  test("survives junk input", () => {
    expect(pruneMessages([null, 42, "x", {}])).toEqual([]);
  });
});

describe("extractEvidence", () => {
  test("collects file paths from edit and write calls", () => {
    const evidence = extractEvidence([
      assistant("go", [
        { name: "edit", arguments: { path: "/repo/src/a.ts" } },
        { name: "write", arguments: { file_path: "/repo/src/b.ts" } },
      ]),
    ], "/repo");
    expect(evidence.files).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("deduplicates repeated files", () => {
    const evidence = extractEvidence([
      assistant("go", [
        { name: "edit", arguments: { path: "a.ts" } },
        { name: "edit", arguments: { path: "a.ts" } },
      ]),
    ]);
    expect(evidence.files).toEqual(["a.ts"]);
  });

  test("collects bash commands, first line only", () => {
    const evidence = extractEvidence([
      assistant("go", [{ name: "bash", arguments: { command: "bun test --bail\nmore" } }]),
    ]);
    expect(evidence.commands).toEqual(["bun test --bail"]);
  });

  test("prioritises errors from failed results", () => {
    const evidence = extractEvidence([
      toolResult("bash", "error: TS2304 cannot find name 'foo'", true),
      toolResult("read", "file content"),
    ]);
    expect(evidence.errors.join(" ")).toContain("TS2304");
  });

  test("counts tool calls and message volume", () => {
    const evidence = extractEvidence([assistant("go", [{ name: "edit", arguments: { path: "a.ts" } }]), user("x")]);
    expect(evidence.stats.messages).toBe(2);
    expect(evidence.stats.toolCalls).toBe(1);
    expect(evidence.stats.charsIn).toBeGreaterThan(0);
  });

  test("caps the lists", () => {
    const calls = Array.from({ length: 60 }, (_, index) => ({ name: "edit", arguments: { path: `f${index}.ts` } }));
    expect(extractEvidence([assistant("go", calls)]).files).toHaveLength(24);
  });
});

describe("relativise", () => {
  test("makes a path inside the cwd relative", () => {
    expect(relativise("/repo/src/a.ts", "/repo")).toBe("src/a.ts");
  });

  test("leaves an outside path alone", () => {
    expect(relativise("/other/a.ts", "/repo")).toBe("/other/a.ts");
  });

  test("normalises windows separators", () => {
    expect(relativise("C:\\repo\\a.ts", "C:/repo")).toBe("a.ts");
  });

  test("tolerates a trailing slash on the cwd", () => {
    expect(relativise("/repo/a.ts", "/repo/")).toBe("a.ts");
  });

  test("does not match a sibling folder with the same prefix", () => {
    expect(relativise("/repo-other/a.ts", "/repo")).toBe("/repo-other/a.ts");
  });
});

describe("renderEvidence", () => {
  test("is empty when nothing was recorded", () => {
    expect(renderEvidence({ files: [], commands: [], errors: [], stats: { messages: 0, toolCalls: 0, charsIn: 0, charsOut: 0 } })).toBe("");
  });

  test("renders three labelled groups", () => {
    const block = renderEvidence({
      files: ["a.ts"],
      commands: ["bun test"],
      errors: ["TypeError: x"],
      stats: { messages: 1, toolCalls: 1, charsIn: 1, charsOut: 1 },
    });
    expect(block).toContain("## Exact Evidence");
    expect(block).toContain("- a.ts");
    expect(block).toContain("- `bun test`");
    expect(block).toContain("- TypeError: x");
  });

  test("omits an empty group instead of printing a blank heading", () => {
    const block = renderEvidence({
      files: ["a.ts"],
      commands: [],
      errors: [],
      stats: { messages: 1, toolCalls: 1, charsIn: 1, charsOut: 1 },
    });
    expect(block).not.toContain("Commands run");
  });
});

describe("evidenceLine", () => {
  test("summarises the counts", () => {
    expect(
      evidenceLine({
        files: ["a", "b"],
        commands: ["c"],
        errors: [],
        stats: { messages: 1, toolCalls: 1, charsIn: 1, charsOut: 1 },
      }),
    ).toBe("2 file(s), 1 command(s)");
  });
});