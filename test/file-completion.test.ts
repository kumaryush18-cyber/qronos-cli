import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileCompletionProvider,
  parseAtToken,
  scoreCandidate,
  subsequenceMatch,
  suggestFiles,
  trimLineRange,
  walkProjectFiles,
} from "../src/file-completion";

/** A fake list, so ranking tests never touch the filesystem. */
const deps = (files: string[]) => ({ listFiles: () => files });

const FILES = [
  "src/index.ts",
  "src/api.ts",
  "src/nested/deep.ts",
  "test/api.test.ts",
  "README.md",
  "src/components/Button.tsx",
];

describe("file-completion: token parsing", () => {
  test("finds a bare @ token", () => {
    expect(parseAtToken("@")).toBe("");
    expect(parseAtToken("@src")).toBe("src");
    expect(parseAtToken("look at @src/ap")).toBe("src/ap");
  });

  test("handles a quoted @ token", () => {
    expect(parseAtToken('@"src/my file')).toBe("src/my file");
  });

  test("ignores a plain path with no @", () => {
    expect(parseAtToken("src/api")).toBeUndefined();
    expect(parseAtToken("nothing here")).toBeUndefined();
  });

  test("an email-like token is not an @ mention", () => {
    // 'user@host' — the @ is not at a token boundary.
    expect(parseAtToken("user@host")).toBeUndefined();
  });
});

describe("file-completion: line ranges", () => {
  test("strips a #line-line suffix", () => {
    expect(trimLineRange("src/api.ts#12-40")).toBe("src/api.ts");
    expect(trimLineRange("src/api.ts#7")).toBe("src/api.ts");
  });

  test("leaves a path with no suffix alone", () => {
    expect(trimLineRange("src/api.ts")).toBe("src/api.ts");
  });
});

describe("file-completion: ranking", () => {
  test("subsequence matching", () => {
    expect(subsequenceMatch("src/api.ts", "sapi")).toBe(true);
    expect(subsequenceMatch("src/api.ts", "zzz")).toBe(false);
    expect(subsequenceMatch("src/api.ts", "")).toBe(true);
  });

  test("prefix beats basename-prefix beats substring beats subsequence", () => {
    expect(scoreCandidate("src/api.ts", "src/api")).toBe(100);
    expect(scoreCandidate("src/api.ts", "api")).toBe(80);
    expect(scoreCandidate("a/src/api.ts", "src/")).toBe(60);
    expect(scoreCandidate("src/myapi.ts", "api")).toBe(40);
    expect(scoreCandidate("src/api.ts", "spt")).toBe(20);
    expect(scoreCandidate("src/api.ts", "xyz")).toBe(0);
  });

  test("suggestions are @-prefixed and honour the query", () => {
    const items = suggestFiles("api", FILES.length ? FILES : [], deps(FILES));
    const values = items.map((i) => i.value);
    expect(values).toContain("@src/api.ts");
    expect(values.every((v) => v.startsWith("@"))).toBe(true);
  });

  test("a line-range query still matches the underlying file", () => {
    const items = suggestFiles("src/api.ts#12-40", [], deps(FILES));
    // The path is matched without the range, and the range the user typed is
    // kept on the completion so they do not have to retype it.
    expect(items.map((i) => i.value)).toContain("@src/api.ts#12-40");
    expect(items.map((i) => i.label)).toContain("src/api.ts");
  });

  test("directories are marked as such", () => {
    const items = suggestFiles("components", [], deps(["src/components/"]));
    expect(items[0]!.description).toBe("directory");
  });

  test("caps the number of suggestions", () => {
    const many = Array.from({ length: 200 }, (_, i) => `src/f${i}.ts`);
    expect(suggestFiles("src/f", [], deps(many), "", 10)).toHaveLength(10);
  });

  test("an unmatched query yields nothing", () => {
    expect(suggestFiles("zzzzz", [], deps(FILES))).toEqual([]);
  });
});

describe("file-completion: filesystem walk", () => {
  function project(): string {
    const root = mkdtempSync(join(tmpdir(), "qronos-walk-"));
    mkdirSync(join(root, "src", "nested"), { recursive: true });
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, "src", "index.ts"), "");
    writeFileSync(join(root, "src", "nested", "deep.ts"), "");
    writeFileSync(join(root, "node_modules", "pkg", "junk.js"), "");
    writeFileSync(join(root, ".git", "HEAD"), "");
    writeFileSync(join(root, "README.md"), "");
    return root;
  }

  test("lists files as repo-relative POSIX paths", () => {
    const files = walkProjectFiles(project());
    expect(files).toContain("src/index.ts");
    expect(files).toContain("src/nested/deep.ts");
    expect(files).toContain("README.md");
  });

  test("skips node_modules and .git", () => {
    const files = walkProjectFiles(project());
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
    expect(files.some((f) => f.startsWith(".git/"))).toBe(false);
  });

  test("marks directories with a trailing slash", () => {
    expect(walkProjectFiles(project())).toContain("src/");
  });

  test("is bounded by maxEntries so a huge tree cannot stall the editor", () => {
    expect(walkProjectFiles(project(), { maxEntries: 2 }).length).toBeLessThanOrEqual(2);
  });

  test("is bounded by maxDepth", () => {
    const shallow = walkProjectFiles(project(), { maxDepth: 1 });
    expect(shallow).not.toContain("src/nested/deep.ts");
  });
});

describe("file-completion: provider wrapper", () => {
  const fakeCur = (items: Array<{ value: string; label: string }>) => ({
    triggerCharacters: undefined,
    getSuggestions: async () => (items.length ? { items, prefix: "@" } : null),
    applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }),
    shouldTriggerFileCompletion: () => true,
  });

  const opts = { signal: new AbortController().signal };

  test("passes pi's own suggestions through untouched when it has some", async () => {
    const provider = createFileCompletionProvider(deps(FILES), () => "/proj")(fakeCur([{ value: "@x", label: "x" }]) as any);
    const res = await provider.getSuggestions(["@api"], 0, 4, opts);
    expect(res!.items.map((i) => i.value)).toEqual(["@x"]);
  });

  test("falls back to the fs walk when pi returns nothing (the fd-missing case)", async () => {
    const provider = createFileCompletionProvider(deps(FILES), () => "/proj")(fakeCur([]) as any);
    const res = await provider.getSuggestions(["@api"], 0, 4, opts);
    expect(res!.items.map((i) => i.value)).toContain("@src/api.ts");
    expect(res!.prefix).toBe("@api");
  });

  test("never invents suggestions for a non-@ line", async () => {
    const provider = createFileCompletionProvider(deps(FILES), () => "/proj")(fakeCur([]) as any);
    expect(await provider.getSuggestions(["just text"], 0, 9, opts)).toBeNull();
  });

  test("respects an aborted signal", async () => {
    const ac = new AbortController();
    ac.abort();
    const provider = createFileCompletionProvider(deps(FILES), () => "/proj")(fakeCur([]) as any);
    expect(await provider.getSuggestions(["@api"], 0, 4, { signal: ac.signal })).toBeNull();
  });
});
