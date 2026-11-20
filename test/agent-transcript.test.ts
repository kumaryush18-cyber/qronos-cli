import { describe, expect, test } from "bun:test";
import { MAX_CHARS, Transcript, clip, formatArgs } from "../src/agent-transcript";

describe("clip", () => {
  test("keeps short text as it is", () => {
    expect(clip("hello")).toBe("hello");
  });

  test("cuts long text and says how much was dropped", () => {
    const out = clip("x".repeat(MAX_CHARS + 10), 50);
    expect(out.startsWith("x".repeat(50))).toBe(true);
    expect(out).toContain("+1960 chars");
  });

  test("normalises carriage returns so a line cannot jump the cursor", () => {
    expect(clip("a\r\nb")).toBe("a\nb");
  });
});

describe("formatArgs", () => {
  test("a string argument is shown as one line", () => {
    expect(formatArgs("src/a.ts")).toBe("src/a.ts");
  });

  test("an object becomes key: value pairs", () => {
    expect(formatArgs({ path: "src/a.ts", offset: 10 })).toBe("path: src/a.ts, offset: 10");
  });

  test("long values and arrays are shortened", () => {
    const out = formatArgs({ content: "y".repeat(200), matches: [1, 2, 3] });
    expect(out).toContain("content: yyyy");
    expect(out).toContain("matches: [3]");
    expect(out.length).toBeLessThan(200);
  });

  test("nested objects do not explode", () => {
    expect(formatArgs({ opts: { deep: true } })).toBe("opts: {…}");
  });

  test("nothing becomes an empty string", () => {
    expect(formatArgs(undefined)).toBe("");
    expect(formatArgs(null)).toBe("");
  });
});

describe("Transcript", () => {
  test("records items in order with a timestamp", () => {
    const t = new Transcript();
    t.push({ kind: "task", text: "find the files", at: 1 });
    t.push({ kind: "assistant", text: "looking", at: 2 });
    expect(t.list().map((item) => item.kind)).toEqual(["task", "assistant"]);
    expect(t.list()[0]!.at).toBe(1);
  });

  test("streamed text joins the same assistant item", () => {
    const t = new Transcript();
    t.appendAssistant("Hel", 1);
    t.appendAssistant("lo", 1);
    expect(t.list()).toHaveLength(1);
    expect(t.list()[0]!.text).toBe("Hello");
  });

  test("a new turn starts a new assistant item", () => {
    const t = new Transcript();
    t.appendAssistant("first", 1);
    t.appendAssistant("second", 2);
    expect(t.list().map((item) => item.text)).toEqual(["first", "second"]);
  });

  test("thinking and text do not merge into one row", () => {
    const t = new Transcript();
    t.appendThinking("hmm", 1);
    t.appendAssistant("answer", 1);
    expect(t.list().map((item) => item.kind)).toEqual(["thinking", "assistant"]);
  });

  test("the cap drops the oldest and counts what was hidden", () => {
    const t = new Transcript(3);
    for (let n = 0; n < 5; n++) t.push({ kind: "notice", text: `n${n}` });
    expect(t.list().map((item) => item.text)).toEqual(["n2", "n3", "n4"]);
    expect(t.hiddenCount).toBe(2);
  });

  test("one huge item cannot blow up memory", () => {
    const t = new Transcript();
    t.push({ kind: "tool-result", text: "z".repeat(50_000) });
    expect(t.list()[0]!.text.length).toBeLessThan(MAX_CHARS + 40);
  });

  test("tool rows keep the tool name and the failure flag", () => {
    const t = new Transcript();
    t.push({ kind: "tool-call", text: "read", tool: "read", args: "path: src/a.ts" });
    t.push({ kind: "tool-result", text: "no such file", tool: "read", failed: true });
    const [call, result] = t.list();
    expect(call!.tool).toBe("read");
    expect(call!.args).toBe("path: src/a.ts");
    expect(result!.failed).toBe(true);
  });

  test("the last assistant text is easy to find for the row preview", () => {
    const t = new Transcript();
    t.push({ kind: "task", text: "task" });
    t.appendAssistant("the answer", 1);
    t.push({ kind: "tool-call", text: "read", tool: "read" });
    expect(t.lastAssistantText()).toBe("the answer");
  });

  test("no answer yet means an empty preview, not a crash", () => {
    expect(new Transcript().lastAssistantText()).toBe("");
  });

  test("clear empties both the items and the hidden count", () => {
    const t = new Transcript(1);
    t.push({ kind: "task", text: "a" });
    t.push({ kind: "task", text: "b" });
    t.clear();
    expect(t.size).toBe(0);
    expect(t.hiddenCount).toBe(0);
  });

  test("characters() is the total stored size", () => {
    const t = new Transcript();
    t.push({ kind: "task", text: "abc" });
    t.push({ kind: "task", text: "de" });
    expect(t.characters()).toBe(5);
  });
});
