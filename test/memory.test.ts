import { describe, expect, test } from "bun:test";
import {
  ancestorDirs,
  memoryCandidates,
  parseImports,
  renderMemoryPrompt,
  resolveImport,
  resolveMemory,
  type ResolvedMemory,
} from "../src/memory";

const deps = (files: Record<string, string>) => ({
  readFile: (p: string) => files[p],
});

describe("memory: candidates", () => {
  test("user layer comes before project layer", () => {
    const c = memoryCandidates("/proj", "/home/u/.qronos/QRONOS.md");
    expect(c.map((x) => x.layer)).toEqual(["user", "project"]);
    expect(c[0]!.path).toBe("/home/u/.qronos/QRONOS.md");
    expect(c[1]!.path).toBe("/proj/QRONOS.md");
  });

  test("directory layers are appended after the project layer", () => {
    const c = memoryCandidates("/proj", "/u/QRONOS.md", ["src", "src/api"]);
    expect(c.map((x) => x.layer)).toEqual(["user", "project", "directory", "directory"]);
    expect(c[3]!.path).toBe("/proj/src/api/QRONOS.md");
  });

  test("dot and empty subdirs are ignored", () => {
    expect(memoryCandidates("/proj", "/u/QRONOS.md", [".", "", "./"])).toHaveLength(2);
  });
});

describe("memory: ancestorDirs", () => {
  test("lists ancestors nearest last, excluding the root", () => {
    expect(ancestorDirs("src/api/routes.ts")).toEqual(["src", "src/api"]);
  });

  test("a root-level file has no ancestors", () => {
    expect(ancestorDirs("README.md")).toEqual([]);
  });
});

describe("memory: imports", () => {
  test("parses a bare @import line", () => {
    expect(parseImports("@docs/style.md")).toEqual(["docs/style.md"]);
    expect(parseImports("  @docs/style.md  ")).toEqual(["docs/style.md"]);
  });

  test("ignores an @ in prose or mid-line", () => {
    expect(parseImports("see @docs/style.md for details")).toEqual([]);
    expect(parseImports("email me at foo@bar.com")).toEqual([]);
  });

  test("collects multiple imports", () => {
    expect(parseImports("@a.md\nsome text\n@b.md")).toEqual(["a.md", "b.md"]);
  });

  test("relative imports resolve against the importer's directory", () => {
    expect(resolveImport("/proj/docs", "style.md")).toBe("/proj/docs/style.md");
    expect(resolveImport("/proj/docs", "../root.md")).toBe("/proj/root.md");
  });

  test("absolute imports are kept as-is", () => {
    expect(resolveImport("/proj", "/etc/x.md")).toBe("/etc/x.md");
  });
});

describe("memory: resolution", () => {
  test("reads every existing layer, in order", () => {
    const m = resolveMemory(memoryCandidates("/proj", "/u/m.md"), deps({
      "/u/m.md": "user rules",
      "/proj/QRONOS.md": "project rules",
    }));
    expect(m.sources.map((s) => s.contents)).toEqual(["user rules", "project rules"]);
  });

  test("missing files are skipped silently, not reported", () => {
    const m = resolveMemory(memoryCandidates("/proj", "/u/m.md"), deps({}));
    expect(m.sources).toEqual([]);
    expect(m.missing).toEqual([]);
  });

  test("an @import is inlined into its importer", () => {
    const m = resolveMemory(memoryCandidates("/proj", "/u/m.md"), deps({
      "/proj/QRONOS.md": "top\n@docs/style.md",
      "/proj/docs/style.md": "style rules",
    }));
    const project = m.sources.find((s) => s.layer === "project")!;
    expect(project.contents).toContain("style rules");
  });

  test("a missing @import is reported so the user sees the breakage", () => {
    const m = resolveMemory(memoryCandidates("/proj", "/u/m.md"), deps({
      "/proj/QRONOS.md": "@docs/nope.md",
    }));
    expect(m.missing).toContain("/proj/docs/nope.md");
  });

  test("nested imports resolve", () => {
    const m = resolveMemory(memoryCandidates("/proj", "/u/m.md"), deps({
      "/proj/QRONOS.md": "@a.md",
      "/proj/a.md": "@b.md",
      "/proj/b.md": "deep",
    }));
    expect(m.sources[0]!.contents).toContain("deep");
  });

  test("a self-referential import does not hang", () => {
    const m = resolveMemory(memoryCandidates("/proj", "/u/m.md"), deps({
      "/proj/QRONOS.md": "@QRONOS.md",
    }));
    expect(m.cycles.length).toBeGreaterThan(0);
    expect(m.sources).toHaveLength(1);
  });

  test("a two-file cycle terminates", () => {
    const m = resolveMemory(memoryCandidates("/proj", "/u/m.md"), deps({
      "/proj/QRONOS.md": "@a.md",
      "/proj/a.md": "@QRONOS.md",
    }));
    expect(m.sources.length).toBeLessThanOrEqual(2);
  });
});

describe("memory: prompt rendering", () => {
  test("no memory renders an empty string so no tokens are spent", () => {
    expect(renderMemoryPrompt({ sources: [], missing: [], cycles: [] })).toBe("");
  });

  test("includes each source with its layer and a precedence note", () => {
    const m: ResolvedMemory = {
      sources: [
        { path: "/u/m.md", layer: "user", contents: "u" },
        { path: "/proj/QRONOS.md", layer: "project", contents: "p" },
      ],
      missing: [],
      cycles: [],
    };
    const text = renderMemoryPrompt(m);
    expect(text).toContain("## Project memory");
    expect(text).toContain("(user)");
    expect(text).toContain("(project)");
    expect(text).toContain("Later sections override earlier ones");
  });

  test("broken imports do not leak into the prompt", () => {
    const m: ResolvedMemory = {
      sources: [{ path: "/p", layer: "project", contents: "x" }],
      missing: ["/gone.md"],
      cycles: [],
    };
    expect(renderMemoryPrompt(m)).not.toContain("/gone.md");
  });
});
