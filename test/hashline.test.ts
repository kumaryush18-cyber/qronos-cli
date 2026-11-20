// Tests for hashline edits. This feature writes to real files, so the tests
// cover the failure paths as hard as the happy path: a stale tag, a line range
// past the end, two overlapping ranges, and a patch that changes nothing.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyOps, splitLines, summarize } from "../src/hashline/apply";
import { parsePatch, PatchParseError, unescapeBody } from "../src/hashline/parse";
import { countLines, fileTag, numberLines, TagStore } from "../src/hashline/tag";
import { createPatchToolExtension, fileKey, runPatch } from "../src/hashline/tool";

const SAMPLE = ["line one", "line two", "line three", "line four", "line five"].join("\n") + "\n";

describe("parsePatch", () => {
  test("parses a range replacement with its body", () => {
    const sections = parsePatch(`*** Begin Patch
[src/a.ts#a3f1]
PUT 2.=3:
+new two
+new three
*** End Patch`);
    expect(sections.length).toBe(1);
    expect(sections[0].path).toBe("src/a.ts");
    expect(sections[0].tag).toBe("a3f1");
    expect(sections[0].ops).toEqual([
      { kind: "replace", start: 2, end: 3, body: ["new two", "new three"] },
    ]);
  });

  test("parses insert before, insert after and append", () => {
    const [, ...rest] = parsePatch(`*** Begin Patch
[x.ts#0000]
PUT <1:
+first
PUT >2:
+after two
PUT >$:
+last
*** End Patch`);
    expect(rest.length).toBe(0);
    const ops = parsePatch(`*** Begin Patch
[x.ts#0000]
PUT <1:
+first
PUT >2:
+after two
PUT >$:
+last
*** End Patch`)[0].ops;
    expect(ops.map((op) => op.kind)).toEqual(["insert-before", "insert-after", "append"]);
  });

  test("parses CUT, REM and MV", () => {
    const ops = parsePatch(`*** Begin Patch
[x.ts#0000]
CUT 1.=2
REM
MV y.ts
*** End Patch`)[0].ops;
    expect(ops).toEqual([{ kind: "cut", start: 1, end: 2 }, { kind: "remove" }, { kind: "move", destination: "y.ts" }]);
  });

  test("a lone + is a blank line and ++ / +- are escapes", () => {
    const ops = parsePatch(`*** Begin Patch
[x.ts#0000]
PUT >$:
+
++literal plus
+- literal minus
*** End Patch`)[0].ops;
    expect(ops[0]).toEqual({ kind: "append", body: ["", "+literal plus", "- literal minus"] });
    expect(unescapeBody("++a")).toBe("+a");
    expect(unescapeBody("plain")).toBe("plain");
  });

  test("rejects a bad header, unknown op and missing body", () => {
    expect(() => parsePatch(`*** Begin Patch
[not-a-header]
PUT >$:
+x
*** End Patch`)).toThrow(PatchParseError);
    expect(() => parsePatch(`*** Begin Patch
[x.ts#0000]
DELETE 3
*** End Patch`)).toThrow(/unknown operation/);
    expect(() => parsePatch(`*** Begin Patch
[x.ts#0000]
PUT >$:
*** End Patch`)).toThrow();
  });

  test("unsupported oh-my-pi features give an honest message", () => {
    expect(() => parsePatch(`*** Begin Patch
[x.ts#0000]
PUT 3*:
+x
*** End Patch`)).toThrow(/block operations/);
    expect(() => parsePatch(`*** Begin Patch
[x.ts#0000]
PUT >$ @name:
+x
*** End Patch`)).toThrow();
  });

  test("a reversed range is refused", () => {
    expect(() => parsePatch(`*** Begin Patch
[x.ts#0000]
PUT 5.=2:
+x
*** End Patch`)).toThrow(/ends before it starts/);
  });
});

describe("applyOps", () => {
  test("replaces a range and keeps the rest", () => {
    const result = applyOps(SAMPLE, [{ kind: "replace", start: 2, end: 3, body: ["NEW"] }]);
    expect(result.content).toBe("line one\nNEW\nline four\nline five\n");
    expect(result.changedLines).toBeGreaterThan(0);
  });

  test("inserts before, after and at the end", () => {
    const before = applyOps(SAMPLE, [{ kind: "insert-before", at: 1, body: ["zero"] }]);
    expect(before.content.startsWith("zero\nline one")).toBe(true);

    const after = applyOps(SAMPLE, [{ kind: "insert-after", at: 5, body: ["six"] }]);
    expect(after.content).toBe(`${SAMPLE}six\n`);

    const appended = applyOps(SAMPLE, [{ kind: "append", body: ["six", "seven"] }]);
    expect(appended.content).toBe(`${SAMPLE}six\nseven\n`);
  });

  test("cuts a range", () => {
    const result = applyOps(SAMPLE, [{ kind: "cut", start: 1, end: 2 }]);
    expect(result.content).toBe("line three\nline four\nline five\n");
  });

  test("two ops keep their own line numbers (bottom-up application)", () => {
    const result = applyOps(SAMPLE, [
      { kind: "replace", start: 1, end: 1, body: ["FIRST"] },
      { kind: "replace", start: 5, end: 5, body: ["LAST"] },
    ]);
    expect(result.content).toBe("FIRST\nline two\nline three\nline four\nLAST\n");
  });

  test("CRLF files keep their line endings", () => {
    const crlf = "a\r\nb\r\nc\r\n";
    const result = applyOps(crlf, [{ kind: "replace", start: 2, end: 2, body: ["B"] }]);
    expect(result.content).toBe("a\r\nB\r\nc\r\n");
  });

  test("a file without a trailing newline stays that way", () => {
    const result = applyOps("a\nb", [{ kind: "replace", start: 2, end: 2, body: ["B"] }]);
    expect(result.content).toBe("a\nB");
  });

  test("rejects a range past the end of the file", () => {
    expect(() => applyOps(SAMPLE, [{ kind: "replace", start: 9, end: 10, body: ["x"] }])).toThrow(/past the end/);
  });

  test("rejects overlapping ranges", () => {
    expect(() =>
      applyOps(SAMPLE, [
        { kind: "replace", start: 2, end: 4, body: ["x"] },
        { kind: "cut", start: 3, end: 5 },
      ]),
    ).toThrow(/overlap/);
  });

  test("can write into an empty file", () => {
    const result = applyOps("", [{ kind: "append", body: ["hello"] }]);
    expect(result.content).toBe("hello");
  });

  test("splitLines round-trips", () => {
    for (const sample of ["", "a", "a\n", "a\r\nb\r\n", "a\nb"]) {
      const table = splitLines(sample);
      const rebuilt = table.lines.join("\n") + (table.trailingNewline && table.lines.length ? "\n" : "");
      const expected = table.crlf ? rebuilt.replace(/\n/g, "\r\n") : rebuilt;
      expect(expected).toBe(sample);
    }
  });

  test("summarize reads like a sentence", () => {
    expect(summarize([{ kind: "replace", start: 1, end: 2, body: ["x"] }], 2)).toContain("1 replace");
  });
});

describe("tags", () => {
  test("a tag is four hex characters and depends on the content", () => {
    expect(fileTag("hello")).toMatch(/^[0-9a-f]{4}$/);
    expect(fileTag("hello")).toBe(fileTag("hello"));
    expect(fileTag("hello")).not.toBe(fileTag("hello!"));
  });

  test("numberLines pads to the widest line number", () => {
    expect(numberLines("a\nb", 1)).toBe("1| a\n2| b");
    expect(numberLines("a\nb", 99)).toBe(" 99| a\n100| b");
  });

  test("countLines counts a trailing newline once", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("a")).toBe(1);
    expect(countLines("a\n")).toBe(1);
    expect(countLines("a\nb")).toBe(2);
  });

  test("TagStore reports unseen, stale and ok", () => {
    const store = new TagStore();
    expect(store.check("a.ts", "abcd", "x").ok).toBe(false);

    const seen = store.record("a.ts", "x", 1, 1);
    expect(store.check("a.ts", seen.tag, "x").ok).toBe(true);

    const stale = store.check("a.ts", seen.tag, "changed on disk");
    expect(stale).toMatchObject({ ok: false, reason: "stale" });

    // A tag from an earlier state is stale even if the store still remembers it.
    expect(store.check("a.ts", "0000", "x")).toMatchObject({ ok: false, reason: "stale" });
    store.clear();
    expect(store.check("a.ts", seen.tag, "x")).toMatchObject({ ok: false, reason: "unseen" });
  });
});

describe("runPatch (real files)", () => {
  function setup(content = SAMPLE) {
    const dir = mkdtempSync(join(tmpdir(), "qronos-patch-"));
    writeFileSync(join(dir, "a.ts"), content, "utf8");
    const store = new TagStore();
    store.record("a.ts", content, 1, countLines(content));
    return { dir, store };
  }

  test("applies a patch and reports the new tag", async () => {
    const { dir, store } = setup();
    const tag = store.get("a.ts")!.tag;
    const result = await runPatch(
      `*** Begin Patch
[a.ts#${tag}]
PUT 2.=2:
+line TWO
*** End Patch`,
      { store, cwd: () => dir },
    );
    expect(result.isError).toBeFalsy();
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("line one\nline TWO\nline three\nline four\nline five\n");
    expect(result.content[0].text).toContain("tag #");
  });

  test("refuses a stale tag and writes nothing", async () => {
    const { dir, store } = setup();
    writeFileSync(join(dir, "a.ts"), "changed\n", "utf8");
    const result = await runPatch(
      `*** Begin Patch
[a.ts#${store.get("a.ts")!.tag}]
PUT 1.=1:
+x
*** End Patch`,
      { store, cwd: () => dir },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("changed since it was read");
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("changed\n");
  });

  test("refuses a file that was never read", async () => {
    const { dir } = setup();
    const result = await runPatch(
      `*** Begin Patch
[a.ts#0000]
PUT 1.=1:
+x
*** End Patch`,
      { store: new TagStore(), cwd: () => dir },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Read the file first");
  });

  test("REM and MV work on a tagged file", async () => {
    const { dir, store } = setup();
    const tag = store.get("a.ts")!.tag;
    const moved = await runPatch(
      `*** Begin Patch
[a.ts#${tag}]
MV sub/b.ts
*** End Patch`,
      { store, cwd: () => dir },
    );
    expect(moved.isError).toBeFalsy();
    expect(existsSync(join(dir, "a.ts"))).toBe(false);
    expect(readFileSync(join(dir, "sub/b.ts"), "utf8")).toBe(SAMPLE);

    const removed = await runPatch(
      `*** Begin Patch
[sub/b.ts#${store.get("sub/b.ts")!.tag}]
REM
*** End Patch`,
      { store, cwd: () => dir },
    );
    expect(removed.isError).toBeFalsy();
    expect(existsSync(join(dir, "sub/b.ts"))).toBe(false);
  });

  test("a patch that changes nothing is an error, not a silent success", async () => {
    const { dir, store } = setup();
    const tag = store.get("a.ts")!.tag;
    const result = await runPatch(
      `*** Begin Patch
[a.ts#${tag}]
PUT 1.=1:
+line one
*** End Patch`,
      { store, cwd: () => dir },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("changed nothing");
  });

  test("a write failure is reported, not swallowed", async () => {
    const { dir, store } = setup();
    const tag = store.get("a.ts")!.tag;
    const result = await runPatch(
      `*** Begin Patch
[a.ts#${tag}]
PUT 1.=1:
+x
*** End Patch`,
      {
        store,
        cwd: () => dir,
        writeFile: async () => {
          throw new Error("disk full");
        },
      },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("disk full");
  });
});

describe("path keys (same file, different spelling)", () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "qronos-key-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), SAMPLE, "utf8");
    return { dir, store: new TagStore() };
  }

  test("fileKey makes an absolute and a relative path agree", () => {
    const { dir } = setup();
    expect(fileKey(dir, join(dir, "src", "a.ts"))).toBe("src/a.ts");
    expect(fileKey(dir, "./src/a.ts")).toBe("src/a.ts");
    expect(fileKey(dir, "src/a.ts")).toBe("src/a.ts");
  });

  test("a file outside the working directory keeps its absolute key", () => {
    const key = fileKey("/tmp/project", "/elsewhere/b.ts");
    expect(key.startsWith("/") || key.startsWith("C:")).toBe(true);
    expect(key.endsWith("b.ts")).toBe(true);
  });

  test("a read recorded by absolute path can be patched by relative path", async () => {
    const { dir, store } = setup();
    const absolute = join(dir, "src", "a.ts");
    // This is what the read hook now stores.
    store.record(fileKey(dir, absolute), SAMPLE, 1, countLines(SAMPLE));
    const tag = store.get("src/a.ts")!.tag;

    const result = await runPatch(
      `*** Begin Patch
[src/a.ts#${tag}]
PUT 2.=2:
+line TWO
*** End Patch`,
      { store, cwd: () => dir },
    );

    expect(result.isError).toBeFalsy();
    expect(readFileSync(absolute, "utf8")).toContain("line TWO");
  });

  test("a real stale tag is still reported as stale, not as unseen", async () => {
    const { dir, store } = setup();
    const absolute = join(dir, "src", "a.ts");
    store.record(fileKey(dir, absolute), SAMPLE, 1, countLines(SAMPLE));
    const tag = store.get("src/a.ts")!.tag;
    writeFileSync(absolute, "line one\nline changed\n", "utf8");

    const result = await runPatch(
      `*** Begin Patch
[src/a.ts#${tag}]
PUT 2.=2:
+line TWO
*** End Patch`,
      { store, cwd: () => dir },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("changed since it was read");
  });
});

describe("read hook uses the session folder", () => {
  test("a read in another folder is tagged from that folder, not the process one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qronos-readhook-"));
    const content = "first\nsecond\nthird\n";
    writeFileSync(join(dir, "a.ts"), content, "utf8");

    let handler: any;
    let registered: any;
    const pi = {
      on: (name: string, fn: any) => {
        if (name === "tool_result") handler = fn;
        return () => {};
      },
      registerTool: (tool: any) => {
        registered = tool;
      },
    } as any;

    createPatchToolExtension({ numberReads: true })!(pi);
    expect(handler).toBeDefined();

    const result = await handler(
      {
        toolName: "read",
        isError: false,
        input: { path: "a.ts" },
        content: [{ type: "text", text: "first\nsecond\nthird" }],
      },
      { cwd: dir },
    );

    expect(result.content[0].text).toStartWith("[a.ts#");
    expect(result.content[0].text).toContain("1| first");
    expect(result.content[0].text).toContain("3| third");

    // The tag must be the tag of the file in that folder.
    const tag = /#([0-9a-f]{4})\]/.exec(result.content[0].text)![1];
    expect(tag).toBe(fileTag(content));

    // The tool shares the hook's tag store, so the tag it showed must be accepted.
    const outcome = await registered.execute(
      "call-1",
      { patch: `*** Begin Patch\n[a.ts#${tag}]\nPUT 2.=2:\n+SECOND\n*** End Patch` },
      undefined,
      undefined,
      { cwd: dir, executeTool: async (name: string, args: any) => {
        if (name === "write") writeFileSync(args.path, args.content, "utf8");
        return { result: { content: [{ type: "text", text: "ok" }] }, isError: false };
      } } as any,
    );
    expect(outcome.isError).toBeFalsy();
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("first\nSECOND\nthird\n");
  });
});
