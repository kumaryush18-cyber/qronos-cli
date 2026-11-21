import { describe, expect, test } from "bun:test";
import {
  MEMORY_DOC_FILE,
  MEMORY_JOURNAL_FILE,
  MEMORY_LESSONS_FILE,
  MEMORY_LOCK_FILE,
  MEMORY_STATE_FILE,
  MEMORY_SUMMARY_FILE,
  findRepoRoot,
  memoryFiles,
  pathHash,
  projectFolder,
  slugify,
} from "../src/memory-paths";

function fakeDeps(exists: string[]) {
  const set = new Set(exists);
  return {
    exists: (path: string) => set.has(path.replace(/\/+$/, "")),
    isDirectory: () => true,
  };
}

describe("slugify", () => {
  test("lowercases and keeps dashes", () => {
    expect(slugify("Qronos-CLI")).toBe("qronos-cli");
  });

  test("spaces and odd characters collapse to one dash", () => {
    expect(slugify("My  Project!!")).toBe("my-project");
  });

  test("leading and trailing separators are removed", () => {
    expect(slugify("__hello__")).toBe("hello");
  });

  test("an empty name falls back to project", () => {
    expect(slugify("")).toBe("project");
    expect(slugify("...")).toBe("project");
  });

  test("a very long name is cut and does not end with a dash", () => {
    const slug = slugify("a".repeat(60) + "-tail");
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("pathHash", () => {
  test("is stable and 8 hex chars", () => {
    const first = pathHash("/home/me/code/app");
    expect(first).toMatch(/^[0-9a-f]{8}$/);
    expect(pathHash("/home/me/code/app")).toBe(first);
  });

  test("differs for two different paths with the same basename", () => {
    expect(pathHash("/home/a/General")).not.toBe(pathHash("/home/b/General"));
  });
});

describe("findRepoRoot", () => {
  test("finds the folder that holds .git", () => {
    const deps = fakeDeps(["/repo/.git"]);
    expect(findRepoRoot("/repo/src/deep/dir", deps)).toBe("/repo");
  });

  test("returns cwd when there is no .git anywhere", () => {
    const deps = fakeDeps([]);
    expect(findRepoRoot("/tmp/isolated", deps)).toBe("/tmp/isolated");
  });

  test("stops at the nearest .git, not the outermost", () => {
    const deps = fakeDeps(["/outer/.git", "/outer/inner/.git"]);
    expect(findRepoRoot("/outer/inner/src", deps)).toBe("/outer/inner");
  });
});

describe("projectFolder", () => {
  test("is basename + hash", () => {
    expect(projectFolder("/repo/app", "/repo/app")).toMatch(/^app-[0-9a-f]{8}$/);
  });

  test("two projects with the same name get different folders", () => {
    expect(projectFolder("/a/General", "/a/General")).not.toBe(projectFolder("/b/General", "/b/General"));
  });
});

describe("memoryFiles", () => {
  const paths = memoryFiles("/agent", "/repo/app", "/repo/app");

  test("all files live under the project folder", () => {
    for (const file of Object.values(paths)) expect(file.startsWith(paths.root)).toBe(true);
  });

  test("memory is stored in the agent dir, never inside the repo", () => {
    expect(paths.root.startsWith("/agent/memories/")).toBe(true);
    expect(paths.root.startsWith("/repo")).toBe(false);
  });

  test("file names are the documented ones", () => {
    expect(paths.doc.endsWith(MEMORY_DOC_FILE)).toBe(true);
    expect(paths.summary.endsWith(MEMORY_SUMMARY_FILE)).toBe(true);
    expect(paths.lessons.endsWith(MEMORY_LESSONS_FILE)).toBe(true);
    expect(paths.journal.endsWith(MEMORY_JOURNAL_FILE)).toBe(true);
    expect(paths.state.endsWith(MEMORY_STATE_FILE)).toBe(true);
    expect(paths.lock.endsWith(MEMORY_LOCK_FILE)).toBe(true);
  });

  test("the same project maps to the same folder twice", () => {
    expect(memoryFiles("/agent", "/repo/app", "/repo/app").root).toBe(paths.root);
  });
});
