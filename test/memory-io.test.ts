import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMemory, loadMemoryPrompt, memoryPathsFor, subdirsForFiles } from "../src/memory-io";
import { renderMemoryPrompt } from "../src/memory";

function project(): string {
  return mkdtempSync(join(tmpdir(), "qronos-mem-"));
}

describe("memory-io: real files", () => {
  test("loads user then project memory in precedence order", () => {
    const root = project();
    const userHome = project();
    writeFileSync(join(userHome, "QRONOS.md"), "user rule");
    writeFileSync(join(root, "QRONOS.md"), "project rule");
    const m = loadMemory(root, join(userHome, "QRONOS.md"));
    expect(m.sources.map((s) => s.contents)).toEqual(["user rule", "project rule"]);
  });

  test("an absent user memory file is skipped without error", () => {
    const root = project();
    writeFileSync(join(root, "QRONOS.md"), "only project");
    const m = loadMemory(root, join(project(), "QRONOS.md"));
    expect(m.sources).toHaveLength(1);
    expect(m.missing).toEqual([]);
  });

  test("no memory anywhere yields an empty prompt, not a header", () => {
    const root = project();
    expect(loadMemoryPrompt(root, join(project(), "QRONOS.md"))).toBe("");
  });

  test("a real @import is inlined", () => {
    const root = project();
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "QRONOS.md"), "top\n@docs/style.md");
    writeFileSync(join(root, "docs", "style.md"), "use tabs");
    const prompt = loadMemoryPrompt(root, join(project(), "QRONOS.md"));
    expect(prompt).toContain("use tabs");
    expect(prompt).not.toContain("@docs/style.md");
  });

  test("a broken @import is reported", () => {
    const root = project();
    writeFileSync(join(root, "QRONOS.md"), "@docs/missing.md");
    const m = loadMemory(root, join(project(), "QRONOS.md"));
    expect(m.missing).toHaveLength(1);
  });

  test("memoryPathsFor lists the paths checked", () => {
    const root = project();
    const paths = memoryPathsFor(root, join(project(), "QRONOS.md"));
    expect(paths).toHaveLength(2);
    expect(paths[1]!.endsWith("/QRONOS.md")).toBe(true);
  });
});

describe("memory-io: directory scoping", () => {
  test("files contribute their ancestor directories", () => {
    expect(subdirsForFiles("/proj", ["src/api/x.ts", "src/y.ts"])).toEqual(["src", "src/api"]);
  });

  test("a root-level file contributes nothing", () => {
    expect(subdirsForFiles("/proj", ["README.md"])).toEqual([]);
  });

  test("a file outside the root is ignored so it cannot pull in foreign memory", () => {
    expect(subdirsForFiles("/proj", ["/other/src/x.ts"])).toEqual([]);
  });

  test("a nested QRONOS.md is loaded when the file lives under it", () => {
    const root = project();
    mkdirSync(join(root, "src", "api"), { recursive: true });
    writeFileSync(join(root, "src", "QRONOS.md"), "src rule");
    const m = loadMemory(root, join(project(), "QRONOS.md"), ["src/api/x.ts"]);
    expect(m.sources.some((s) => s.contents.includes("src rule"))).toBe(true);
    expect(m.sources.find((s) => s.contents.includes("src rule"))!.layer).toBe("directory");
  });

  test("directory memory comes after project memory so it overrides", () => {
    const root = project();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "QRONOS.md"), "project");
    writeFileSync(join(root, "src", "QRONOS.md"), "dir");
    const m = loadMemory(root, join(project(), "QRONOS.md"), ["src/a.ts"]);
    const order = m.sources.map((s) => s.layer);
    expect(order).toEqual(["project", "directory"]);
  });
});

describe("memory-io: prompt shape", () => {
  test("the rendered prompt states the precedence rule", () => {
    const root = project();
    writeFileSync(join(root, "QRONOS.md"), "rule");
    const prompt = renderMemoryPrompt(loadMemory(root, join(project(), "QRONOS.md")));
    expect(prompt).toContain("## Project memory");
    expect(prompt).toContain("Later sections override earlier ones");
  });
});
